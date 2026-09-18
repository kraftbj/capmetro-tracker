/**
 * The service worker, driven rather than read.
 *
 * A worker is the one piece of this client that can go wrong for somebody
 * WEEKS after a deploy, on a phone nobody has, in a state nobody can reproduce.
 * It sits in front of every request the board makes, including the live feed,
 * and CLAUDE.md is explicit about what a cache in front of that feed does: the
 * board shows stale positions while looking current. That is the failure this
 * file exists to make impossible to ship, and asserting on the SOURCE TEXT of
 * client/sw.js would not do it -- a text test passes for a worker that reads
 * `isApi` and then ignores the answer.
 *
 * So the worker is evaluated in a fake ServiceWorkerGlobalScope built here, its
 * install/activate/fetch handlers are dispatched real events, and what comes
 * back is what a browser would get. The stubs are deliberately small: a Map per
 * cache, a fetch that answers from a file table or refuses, and Request and
 * Response objects carrying only the fields the worker reads.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import vm from 'node:vm'
import { ROOT } from './helpers/optional.mjs'

const CLIENT = path.join(ROOT, 'client')
const source = readFileSync(path.join(CLIENT, 'sw.js'), 'utf8')

/* Deliberately not the origin the board is deployed to, and with a path prefix,
   because a prefix is the case that breaks a worker written with leading
   slashes -- and tests/e2e/server.mjs serves the client under exactly that. */
const SCOPE = 'https://board.example.test/fresh/'
const WORKER = SCOPE + 'sw.js'

class Res {
  constructor(body, init = {}) {
    this.body = body
    this.status = init.status ?? 200
    this.ok = this.status >= 200 && this.status < 300
    /* `basic` is what a same-origin fetch yields. The worker refuses to cache
       anything else, so the stub has to model it. */
    this.type = init.type ?? 'basic'
    /*
     * A Headers-like, not a plain object, because the worker calls
     * `.get('Content-Type')` on it -- that is how it tells the app document
     * apart from every other file the origin serves. With a plain `{}` here the
     * call throws inside the navigate handler's `.then`, the promise rejects,
     * the handler's own `.catch` serves the cached shell instead, and the whole
     * file stays green while the check it is testing does not run at all.
     */
    this._headers = init.headers ?? {}
    this.headers = {
      get: (name) => {
        const k = Object.keys(this._headers)
          .find((x) => x.toLowerCase() === String(name).toLowerCase())
        return k === undefined ? null : this._headers[k]
      },
    }
  }
  clone() {
    return new Res(this.body, { status: this.status, type: this.type, headers: this._headers })
  }
  /* The worker answers a cache miss with Response.error() rather than an empty 200. Without
     this the first test to reach that branch dies with "Response.error is not a function"
     instead of on its assertion, which is how the branch stayed untested. */
  static error() { return new Res(null, { status: 0, type: 'error' }) }
}

class Req {
  constructor(url, init = {}) {
    this.url = new URL(url, WORKER).href
    this.method = init.method ?? 'GET'
    this.mode = init.mode ?? 'no-cors'
    this.cache = init.cache ?? 'default'
  }
}

const keyOf = (x) => (typeof x === 'string' ? new URL(x, WORKER).href : x.url)

/*
 * What this origin would answer with, by extension. Only the html/not-html
 * distinction is load-bearing -- the worker adopts a navigation as the app
 * shell only when the response IS the document -- but the rest are spelled out
 * so a test cannot accidentally get text/html for a stylesheet.
 */
const TYPES = {
  '.css': 'text/css',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}
function typeOf(pathname) {
  if (pathname.endsWith('/') || pathname.endsWith('.html')) return 'text/html; charset=utf-8'
  const dot = pathname.lastIndexOf('.')
  /* An extensionless path is an app path: both vhosts answer /route/4/eb and
     friends with index.html via try_files, so the document is what comes back. */
  if (dot === -1) return 'text/html; charset=utf-8'
  return TYPES[pathname.slice(dot)] ?? 'application/octet-stream'
}

/** Build a scope, evaluate sw.js in it, and hand back the handlers plus the state. */
function makeScope({ files = {}, offline = false, existingCaches = [], failDelete = false } = {}) {
  /* Set by a test AFTER install, so one response can be shaped without every precache
     fetch inheriting it -- which would make the assertion pass for the wrong reason. */
  let override = null
  const stores = new Map()
  for (const name of existingCaches) stores.set(name, new Map())

  const fetched = []
  function doFetch(req) {
    const url = new URL(keyOf(req))
    fetched.push(url.pathname)
    if (offline) return Promise.reject(new TypeError('Failed to fetch'))
    if (override) { const r = override; override = null; return Promise.resolve(r) }
    const body = files[url.pathname]
    if (body === undefined) {
      return Promise.resolve(new Res('not found', {
        status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }))
    }
    return Promise.resolve(new Res(body, { headers: { 'Content-Type': typeOf(url.pathname) } }))
  }

  function cacheFor(name) {
    if (!stores.has(name)) stores.set(name, new Map())
    const m = stores.get(name)
    return {
      addAll(reqs) {
        return Promise.all(reqs.map((r) => doFetch(r).then((res) => {
          /* Real addAll rejects the whole batch on any non-ok response. */
          if (!res.ok) throw new TypeError(`request failed: ${keyOf(r)}`)
          m.set(keyOf(r), res)
        })))
      },
      put(req, res) {
        /*
         * Deferred to a macrotask, because a real Cache.put is. With a synchronously
         * resolved promise every write lands in the same microtask drain whether or not
         * anything awaited it -- so "the write is tied to the event lifetime" could not be
         * distinguished from "the write happened to finish first", and
         * `event.waitUntil(Promise.resolve())` scored a pass.
         */
        return new Promise((resolve) => setImmediate(() => { m.set(keyOf(req), res); resolve() }))
      },
      match(req) { return Promise.resolve(m.get(keyOf(req))) },
    }
  }

  const caches = {
    open: (name) => Promise.resolve(cacheFor(name)),
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name) => (failDelete
      ? Promise.reject(new Error('quota'))
      : Promise.resolve(stores.delete(name))),
    match(req) {
      for (const m of stores.values()) {
        const hit = m.get(keyOf(req))
        if (hit) return Promise.resolve(hit)
      }
      return Promise.resolve(undefined)
    },
  }

  const handlers = {}
  const claimed = { skipWaiting: 0, claim: 0 }
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn },
    location: { href: WORKER, origin: new URL(WORKER).origin },
    skipWaiting: () => { claimed.skipWaiting++; return Promise.resolve() },
    clients: { claim: () => { claimed.claim++; return Promise.resolve() } },
  }

  const context = vm.createContext({
    self, caches, fetch: doFetch, Request: Req, Response: Res, URL, console,
  })
  vm.runInContext(source, context, { filename: 'client/sw.js' })

  /** Dispatch an event and settle everything it started. */
  async function dispatch(type, init, { settle = true } = {}) {
    const event = { ...init, waited: [], responded: undefined }
    event.waitUntil = (p) => event.waited.push(p)
    event.respondWith = (p) => { event.responded = p }
    handlers[type](event)
    await Promise.all(event.waited)
    if (event.responded) event.responded = await event.responded
    /*
     * Awaited AGAIN, because store() pushes its write during the respondWith chain -- after
     * the first Promise.all above has already run over an empty array. Without this second
     * pass, `settle: false` would prove nothing: the write would not have been awaited at
     * all and the test would be measuring the setImmediate below instead.
     */
    await Promise.all(event.waited)
    /*
     * The worker writes to the cache without awaiting into the RESPONSE, on purpose: a full
     * quota must not turn a successful fetch into a failed one. `settle: false` skips this
     * final tick so a test can prove the write completed on the strength of
     * event.waitUntil() alone -- which is the actual property, and is not provable while an
     * extra tick is handed out for free.
     */
    if (settle) await new Promise((r) => setImmediate(r))
    return event
  }

  return { dispatch, stores, caches, claimed, fetched, handlers, answerNextWith: (r) => { override = r } }
}

/* Everything the shell asks for, answered. Keys are pathnames under the prefix. */
const SHELL = (() => {
  const m = source.match(/var SHELL = \[([\s\S]*?)\];/)
  return m[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1))
})()
const served = Object.fromEntries(
  SHELL.map((u) => [new URL(u, WORKER).pathname, `body of ${u}`]),
)

describe('the shell list and what index.html actually loads', () => {
  /*
   * sw.js cannot derive this list: it is shipped verbatim to a browser and there
   * is no build step in this project. So the list is hand-written there and
   * derived HERE, from the same three places the browser reads -- the tags in
   * index.html, the @import chain in the CSS, and the url() in the font sheet.
   *
   * A missing entry is invisible in every other test: the board opens offline
   * with one script absent, one namespace undefined on window.CMB, and renders
   * nothing. That looks like a bug in the code rather than a hole in an array.
   */
  const html = readFileSync(path.join(CLIENT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')

  const referenced = () => {
    const out = new Set([
      /* The document has two URLs and both are real: nginx serves the directory
         index, and the e2e server and every file:// link name the file. */
      './',
      'index.html',
    ])
    let m
    const scripts = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi
    while ((m = scripts.exec(html)) !== null) out.add(m[1])
    const linked = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi
    while ((m = linked.exec(html)) !== null) out.add(m[1])

    /* The CSS the tags do not name: @import chains, then the font files. */
    const follow = (file, dir) => {
      const css = readFileSync(path.join(CLIENT, file), 'utf8')
      const imports = /@import\s+url\(['"]([^'"]+)['"]\)/g
      let i
      while ((i = imports.exec(css)) !== null) {
        const next = path.posix.join(dir, i[1])
        out.add(next)
        follow(next, path.posix.dirname(next))
      }
      /*
       * Every url() inside every src:, not just a url() sitting first. A real @font-face is
       * commonly `src: local('X'), url('y.woff2') format('woff2')`, and fallback lists carry
       * several. The old pattern required url() immediately after src: and captured only the
       * first, so a font referenced either way was silently not required in SHELL -- and the
       * one test written to make a missing shell entry loud stayed green while the offline
       * board lost that font. Unquoted url(x.woff2) is legal CSS and is accepted too.
       */
      const decls = /src\s*:\s*([^;}]+)/g
      let d
      while ((d = decls.exec(css)) !== null) {
        const urls = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g
        while ((i = urls.exec(d[1])) !== null) out.add(path.posix.join(dir, i[1]))
      }
    }
    follow('styles.css', '.')

    /* And the icons, which nothing in the HTML names: the manifest does. An
       installed board that opens offline still has a launcher and a task
       switcher asking for them. */
    const manifest = JSON.parse(readFileSync(path.join(CLIENT, 'manifest.webmanifest'), 'utf8'))
    for (const icon of manifest.icons) out.add(icon.src)

    return out
  }

  it('caches every file the board loads, and nothing it does not', () => {
    expect([...SHELL].sort()).toEqual([...referenced()].sort())
  })

  it('spells every one of them relatively', () => {
    /* An absolute entry precaches the origin root rather than the directory the
       board is served from, so under the e2e prefix the install 404s and fails. */
    for (const u of SHELL) expect(u, `${u} is absolute`).not.toMatch(/^([a-z]+:)?\//i)
  })

  it('carries a cache version that was bumped the last time this list changed', () => {
    /*
     * client/sw.js says "bump VERSION when the SHELL list changes", and nothing
     * enforced it. This does, the same way the repo already pins the CSP
     * bootstrap hash and the installed systemd units: a fingerprint of the list
     * committed next to the thing it is supposed to move with.
     *
     * Why it matters, precisely: network-first means a stale file is never
     * SERVED, so an unbumped version cannot show old code. What it does is
     * leave a REMOVED entry in the cache forever, because the cache is only
     * ever dropped wholesale on a version change. The date-stamped fixtures in
     * this list (data/route-4-*.js, data/departures-4-*.js) are ~84 KB together
     * and their names change every time the golden capture is retaken, so the
     * first real occurrence of this is already scheduled.
     *
     * When this fails: bump VERSION in client/sw.js, then put the new digest
     * below. Both, in that order -- the digest is the record of what the bump
     * was for.
     */
    const digest = createHash('sha256').update(JSON.stringify(SHELL)).digest('hex').slice(0, 12)
    const version = source.match(/var VERSION = '([^']+)'/)
    expect(version, 'client/sw.js no longer declares a VERSION').not.toBeNull()
    expect({ version: version[1], shell: digest }).toEqual({
      version: 'v1',
      shell: 'c31c99998b71',
    })
  })

  it('lists no api document, which is the rule this worker exists under', () => {
    for (const u of SHELL) expect(u).not.toMatch(/(^|\/)api\//)
  })
})

describe('installing', () => {
  it('precaches the whole shell under a versioned cache name', async () => {
    const scope = makeScope({ files: served })
    await scope.dispatch('install', {})
    const [name] = [...scope.stores.keys()]
    expect(name).toMatch(/^dillo-bus-board-v\d+$/)
    expect([...scope.stores.get(name).keys()].sort())
      .toEqual(SHELL.map((u) => new URL(u, WORKER).href).sort())
  })

  it('precaches every shell entry, and asks for each one exactly once', async () => {
    /*
     * This replaced an assertion on the source text -- `toContain("cache:
     * 'reload'")` -- which is the shape this file's header calls worthless, and
     * which pinned a decision that has since been reversed for costing ~290 KB
     * of re-download on every first visit. What actually has to hold is that
     * the install asks for the whole shell and nothing twice; that the copies
     * it gets are current is a property of the vhost headers, pinned in
     * tests/node/deploy-vhost-headers.test.mjs where it can be checked.
     */
    const scope = makeScope({ files: served })
    await scope.dispatch('install', {})
    const asked = scope.fetched
    const wanted = SHELL.map((u) => new URL(u, WORKER).pathname)
    expect([...asked].sort()).toEqual([...wanted].sort())
    expect(asked.length, 'a shell entry was fetched more than once').toBe(new Set(asked).size)
  })

  it('fails the whole install when one file is missing, rather than half-caching', async () => {
    const short = { ...served }
    delete short[new URL('trip.js', WORKER).pathname]
    const scope = makeScope({ files: short })
    await expect(scope.dispatch('install', {})).rejects.toThrow()
  })

  it('takes over immediately, since nothing it serves is stale by design', async () => {
    const scope = makeScope({ files: served })
    await scope.dispatch('install', {})
    expect(scope.claimed.skipWaiting).toBe(1)
  })
})

describe('activating', () => {
  it('drops its own older caches and claims the open pages', async () => {
    const scope = makeScope({
      files: served,
      existingCaches: ['dillo-bus-board-v0', 'dillo-bus-board-v1'],
    })
    await scope.dispatch('activate', {})
    expect([...scope.stores.keys()]).not.toContain('dillo-bus-board-v0')
    expect(scope.claimed.claim).toBe(1)
  })

  it('leaves a cache belonging to something else on the origin alone', async () => {
    /* An origin can host more than one thing. Deleting every cache on it is a
       worker reaching outside its own scope. */
    const scope = makeScope({ files: served, existingCaches: ['someone-elses-cache'] })
    await scope.dispatch('activate', {})
    expect([...scope.stores.keys()]).toContain('someone-elses-cache')
  })
})

describe('the live feed, which is never cached', () => {
  /*
   * The api path is SERVED here, and that is load-bearing rather than tidiness. With only
   * the shell in the table an api request 404s, cacheable() refuses it whatever the worker
   * does, and "never has an api document in the cache" cannot fail from the isApi rule it
   * is named for -- confirmed by stubbing isApi() to false and watching it pass.
   */
  const withFeed = { ...served, [new URL('api/route/4.json', WORKER).pathname]: '{"live":true}' }
  let scope
  beforeEach(async () => {
    scope = makeScope({ files: withFeed })
    await scope.dispatch('install', {})
  })

  it('does not answer an api request at all, so the browser fetches it as asked', async () => {
    for (const p of ['api/route/4.json', 'api/all.json', 'api/departures/4.json', 'api/health.json']) {
      const event = await scope.dispatch('fetch', { request: new Req(p) })
      expect(event.responded, `${p} was intercepted`).toBeUndefined()
    }
  })

  it('never has an api document in the cache, even after the board has run', async () => {
    /* The fixture MUST answer for the api path. With only SHELL entries served, the request
       404s and cacheable() refuses it whatever the worker does -- so this assertion could
       not fail from the isApi rule it is named for. Verified: with isApi() stubbed to false
       it still passed; with the path served it correctly reports a cached api url. */
    await scope.dispatch('fetch', { request: new Req('api/route/4.json') })
    for (const store of scope.stores.values()) {
      for (const url of store.keys()) expect(url).not.toMatch(/\/api\//)
    }
  })

  it('leaves a cross-origin request alone too', async () => {
    const event = await scope.dispatch('fetch', { request: new Req('https://elsewhere.test/x.js') })
    expect(event.responded).toBeUndefined()
  })

  it('leaves anything that is not a GET alone', async () => {
    const event = await scope.dispatch('fetch', { request: new Req('app.js', { method: 'POST' }) })
    expect(event.responded).toBeUndefined()
  })
})

describe('with a network', () => {
  it('serves a script from the network, not from the cache, so a deploy lands', async () => {
    /*
     * One scope, installed once, whose cache therefore holds the OLD app.js
     * when the fetch happens. That is the whole test: update.sh rsyncs a new
     * body to the same URL and restarts nothing, so the worker is never
     * reinstalled and the stale copy is sitting right there to be served.
     *
     * An earlier version of this built a second scope and installed into it,
     * which precached the new body -- cache-first and network-first both
     * returned 'the new release' and the test passed for the worker it exists
     * to forbid. Verified by making the generic branch cache-first: this now
     * fails, and did not before.
     */
    const files = { ...served }
    const scope = makeScope({ files })
    await scope.dispatch('install', {})
    /* The deploy: same URL, new body, nothing reinstalled, nothing restarted. */
    files[new URL('app.js', WORKER).pathname] = 'the new release'
    const event = await scope.dispatch('fetch', { request: new Req('app.js') })
    expect(event.responded.body).toBe('the new release')
  })

  it('refreshes the cached copy as it goes, so the offline floor keeps up', async () => {
    const files = { ...served }
    const scope = makeScope({ files })
    await scope.dispatch('install', {})
    files[new URL('app.js', WORKER).pathname] = 'the new release'
    await scope.dispatch('fetch', { request: new Req('app.js') })
    const cached = await scope.caches.match(new Req('app.js'))
    expect(cached.body).toBe('the new release')
  })

  it('serves a font from the cache without asking, because fonts are immutable', async () => {
    const scope = makeScope({ files: served })
    await scope.dispatch('install', {})
    const before = scope.fetched.length
    const event = await scope.dispatch('fetch', { request: new Req('fonts/ibm-plex-sans.woff2') })
    expect(event.responded.body).toBe('body of fonts/ibm-plex-sans.woff2')
    expect(scope.fetched.length, 'the font went to the network').toBe(before)
  })

  it('keeps the worker alive until the copy is actually written', async () => {
    /*
     * The write must not be awaited into the RESPONSE -- a full quota would then turn a
     * successful fetch into a failed one -- but it must still extend the event's lifetime,
     * or the browser may terminate the worker as soon as respondWith settles and drop the
     * write with nothing anywhere to observe. Two different things; the code needs both.
     *
     * Proved by settling ONLY the waitUntil promises and then reading the cache. The earlier
     * version asserted `event.waited.length > 0`, which shows waitUntil was CALLED and
     * nothing about what was handed to it -- `event.waitUntil(Promise.resolve())` passed it.
     * Reading the cache back makes the promise's identity the thing under test.
     */
    const files = { ...served }
    const scope = makeScope({ files })
    await scope.dispatch('install', {})
    files[new URL('app.js', WORKER).pathname] = 'the newest release'

    const event = await scope.dispatch('fetch', { request: new Req('app.js') }, { settle: false })
    expect(event.waited.length, 'the cache write was not tied to the event lifetime')
      .toBeGreaterThan(0)
    const cached = await scope.caches.match(new Req('app.js'))
    expect(cached.body, 'waitUntil resolved without the write having landed')
      .toBe('the newest release')
  })

  it('does not cache a 404, which would freeze a missing file as a real one', async () => {
    const scope = makeScope({ files: served })
    await scope.dispatch('install', {})
    await scope.dispatch('fetch', { request: new Req('not-a-file.js') })
    expect(await scope.caches.match(new Req('not-a-file.js'))).toBeUndefined()
  })

  it('adopts a navigation to the board as the offline shell', async () => {
    /*
     * The positive half, and it is here to keep the negative half below honest.
     * Without this, an `isDocument` that throws or returns false for everything
     * loses the shell update silently: the navigate handler's own `.catch`
     * answers from the cache the install already filled, so every offline test
     * still passes and nothing notices that no navigation is ever stored.
     */
    const files = { ...served }
    const scope = makeScope({ files })
    await scope.dispatch('install', {})
    /* What the vhosts do: every app path is answered with the one document. */
    files[new URL('route/4/eb', WORKER).pathname] = 'the new document'
    await scope.dispatch('fetch', { request: new Req('route/4/eb', { mode: 'navigate' }) })
    const shell = await scope.caches.match(new URL('./', WORKER).href)
    expect(shell.body, 'a navigation to an app path did not refresh the shell').toBe('the new document')
  })

  it('does not adopt a navigation to a non-document as the offline shell', async () => {
    /*
     * A navigation is not necessarily a navigation TO THE BOARD. A top-level
     * link from any site to /favicon.svg, or a redirect landing on
     * /styles.css, is a navigate-mode request this origin answers 200. Adopting
     * it replaced the offline board with that file on the device, persisted
     * after the tab closed, and healed only on the next successful ONLINE
     * navigation -- which is exactly when the cache is not wanted. Reproduced
     * against the unfixed worker: an offline navigation afterwards returned
     * `body{}` as text/css.
     */
    const scope = makeScope({ files: served })
    await scope.dispatch('install', {})
    const before = await scope.caches.match(new URL('./', WORKER).href)

    const event = await scope.dispatch('fetch', { request: new Req('styles.css', { mode: 'navigate' }) })
    /* Still served to the reader who asked for it -- this is not about refusing. */
    expect(event.responded.body).toBe('body of styles.css')

    const after = await scope.caches.match(new URL('./', WORKER).href)
    expect(after.body, 'the stylesheet replaced the app shell').toBe(before.body)
  })
})

describe('an older cache that outlived its eviction', () => {
  /*
   * activate deletes older dillo-bus-board-* caches, but that delete sits in a
   * Promise.all inside waitUntil whose rejection is neither caught nor allowed to
   * stop activation. One transient storage error and v1 survives the bump to v2.
   *
   * That matters because CacheStorage.match() iterates every cache on the origin
   * in CREATION order and returns the first hit, so the OLDEST survivor answers.
   * The worker would then serve the previous release's shell offline for the life
   * of that device -- activate only fires on a version change, so it never
   * retries -- and nothing on the device or the server could see it.
   */
  async function withStaleOlderCache() {
    const online = makeScope({ files: served })
    await online.dispatch('install', {})
    const filled = online.stores

    const offline = makeScope({ files: served, offline: true })
    /* Created FIRST, so CacheStorage order puts it ahead of the real one. */
    const stale = await offline.caches.open('dillo-bus-board-v0')
    await stale.put(new URL('./', WORKER).href, new Res('THE PREVIOUS RELEASE', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }))
    await stale.put(new Req('app.js'), new Res('the previous app.js'))
    for (const [name, store] of filled) {
      const c = await offline.caches.open(name)
      for (const [url, res] of store) await c.put(url, res)
    }
    return offline
  }

  it('serves the document from its own cache, not from the older survivor', async () => {
    const scope = await withStaleOlderCache()
    const event = await scope.dispatch('fetch', {
      request: new Req('route/4/eb', { mode: 'navigate' }),
    })
    expect(event.responded.body, 'the offline board came out of a previous release\'s cache')
      .toBe('body of ./')
  })

  it('serves a script from its own cache, not from the older survivor', async () => {
    const scope = await withStaleOlderCache()
    const event = await scope.dispatch('fetch', { request: new Req('app.js') })
    expect(event.responded.body).toBe('body of app.js')
  })
})

describe('with no network', () => {
  /** A scope that installs online and then loses the network. */
  async function installedThenOffline() {
    const online = makeScope({ files: served })
    await online.dispatch('install', {})
    const cached = online.stores
    const offline = makeScope({ files: served, offline: true })
    /* Hand the offline scope the caches the online one filled. */
    for (const [name, store] of cached) {
      const c = await offline.caches.open(name)
      for (const [url, res] of store) await c.put(url, res)
    }
    return offline
  }

  it('opens the board at the root', async () => {
    const scope = await installedThenOffline()
    const event = await scope.dispatch('fetch', {
      request: new Req('./', { mode: 'navigate' }),
    })
    expect(event.responded.body).toBe('body of ./')
    expect(event.responded.status).toBe(200)
  })

  it('opens the board at a shareable path nothing has ever cached', async () => {
    /*
     * /fresh/route/4/eb is not a file and never will be; both vhosts answer it
     * with index.html. The worker has to do the same, from the copy it holds of
     * the directory index, or every link anyone has sent is dead offline.
     */
    const scope = await installedThenOffline()
    for (const p of ['route/4/eb', 'buses', 'trip/7/2641', 'saved']) {
      const event = await scope.dispatch('fetch', { request: new Req(p, { mode: 'navigate' }) })
      expect(event.responded.status, `${p} did not open offline`).toBe(200)
      expect(event.responded.body).toBe('body of ./')
    }
  })

  it('serves every script and the stylesheet from the cache', async () => {
    const scope = await installedThenOffline()
    for (const u of ['app.js', 'urls.js', 'styles.css', 'data/route-4-20260819.js']) {
      const event = await scope.dispatch('fetch', { request: new Req(u) })
      expect(event.responded.body, `${u} was not served offline`).toBe(`body of ${u}`)
    }
  })

  it('still refuses to answer for the feed, so the board knows it is offline', async () => {
    /*
     * The point. Offline, api/route/4.json must FAIL, because failing is how
     * app.js knows to fall back to the bundled fixture and show its "Sample
     * data" banner. A cached answer here is the board quietly showing where the
     * buses were the last time it had signal.
     */
    const scope = await installedThenOffline()
    const event = await scope.dispatch('fetch', { request: new Req('api/route/4.json') })
    expect(event.responded).toBeUndefined()
  })

  it('says so in words when nothing has been cached yet', async () => {
    const scope = makeScope({ files: served, offline: true })
    const event = await scope.dispatch('fetch', { request: new Req('./', { mode: 'navigate' }) })
    expect(event.responded.status).toBe(503)
    expect(event.responded.body).toContain('offline')
  })
})

describe('the branches that only run when something has already gone wrong', () => {
  it('still claims open pages when evicting an old cache fails', async () => {
    /*
     * `.then(claim)` chained after an uncaught Promise.all meant one rejected delete skipped
     * clients.claim() entirely, so every page open at that moment stayed uncontrolled until
     * its next navigation -- no offline floor in the meantime, for a reason with nothing to
     * do with the reader. fromCache() already anticipates this same rejection for the
     * surviving-cache half of the problem; this is the other half.
     */
    const scope = makeScope({ files: served, existingCaches: ['dillo-bus-board-v0'], failDelete: true })
    await scope.dispatch('install', {})
    await scope.dispatch('activate', {})
    expect(scope.claimed.claim, 'a failed eviction cost us the claim').toBe(1)
  })

  it('does not adopt a redirected navigation as the offline shell', async () => {
    /*
     * For a navigate request the Fetch spec leaves tainting `basic`, so a chain ending at
     * another origin passes cacheable()'s type check AND isDocument()'s type check -- it is
     * ok, basic and text/html. And a cached response carrying redirected===true, returned
     * to a navigation, is turned into a network error by the browser: adopting one means
     * the offline board fails to OPEN rather than falling back, which is worse than serving
     * the wrong page.
     */
    const scope = makeScope({ files: served })
    await scope.dispatch('install', {})
    const before = await scope.caches.match(new URL('./', WORKER).href)

    const redirected = new Res("somebody else's page", {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
    redirected.redirected = true
    scope.answerNextWith(redirected)

    const event = await scope.dispatch('fetch', {
      request: new Req('route/4/eb', { mode: 'navigate' }),
    })
    /* Still handed to the reader -- this is about what we KEEP, not what we serve. */
    expect(event.responded.body).toBe("somebody else's page")

    const after = await scope.caches.match(new URL('./', WORKER).href)
    expect(after.body, 'a redirected response became the offline shell').toBe(before.body)
  })

  it('serves /index.html the refreshed document, not the one frozen at install', async () => {
    /*
     * SHELL carries BOTH `./` and `index.html`, deliberately, as two real URLs for one
     * document. But navigations are only ever STORED under `./`, and `index.html` is written
     * only by install's addAll -- which re-runs only when this file's own bytes change, and
     * the header says plainly that it does not do so for ordinary code changes.
     *
     * So reading the requested URL first answered a cold `/index.html` from the copy taken
     * at install and never refreshed since. Measured before the fix: `./` and app.js at
     * release 5, `/index.html` at release 1. The same document, four releases apart, and
     * only for the reader who typed the filename.
     */
    const files = { ...served }
    const online = makeScope({ files })
    await online.dispatch('install', {})

    /* Four ordinary online visits, each a newer release of the document. */
    for (const release of ['r2', 'r3', 'r4', 'r5']) {
      files[new URL('./', WORKER).pathname] = release
      files[new URL('route/4/eb', WORKER).pathname] = release
      await online.dispatch('fetch', { request: new Req('route/4/eb', { mode: 'navigate' }) })
    }

    const offline = makeScope({ files: served, offline: true })
    for (const [name, store] of online.stores) {
      const c = await offline.caches.open(name)
      for (const [url, res] of store) await c.put(url, res)
    }

    const event = await offline.dispatch('fetch', {
      request: new Req('index.html', { mode: 'navigate' }),
    })
    expect(event.responded.body, '/index.html answered from the install-time copy').toBe('r5')
  })

  it('answers an uncached font with an error rather than rejecting', async () => {
    /*
     * The font branch was the only one in the file that could hand respondWith a REJECTED
     * promise: cache miss plus no network and it threw instead of degrading. Every other
     * branch catches. A missing typeface is bounded damage, but a branch that fails
     * differently from its three siblings for no stated reason is how the next person
     * reasons wrongly about all four.
     */
    const scope = makeScope({ files: {}, offline: true })
    const event = await scope.dispatch('fetch', { request: new Req('fonts/ibm-plex-sans.woff2') })
    await expect(Promise.resolve(event.responded)).resolves.toBeDefined()
    expect(event.responded.status, 'an uncached offline font should be an error response').toBe(0)
  })

  it('answers an uncached offline asset with an error, never an empty 200', async () => {
    /*
     * An empty 200 for a stylesheet or a script renders an unstyled or broken board and
     * reads as a code bug; a failed request is something the page already knows how to be
     * honest about. The branch said so in a comment and nothing checked it -- replacing
     * Response.error() with an empty 200 left the suite green.
     */
    const scope = makeScope({ files: {}, offline: true })
    const event = await scope.dispatch('fetch', { request: new Req('app.js') })
    expect(event.responded.status).toBe(0)
    expect(event.responded.body, 'an empty 200 would render a broken board silently').toBeNull()
  })

  it('refuses to cache an opaque cross-origin response', async () => {
    /*
     * cacheable()'s `res.type === 'basic'` clause, which had no coverage at all -- deleting
     * it left every test green, because the stub always produced `basic`. An opaque
     * response caches as a 0-status body that later reads back as a successful EMPTY file:
     * an unstyled board or a missing namespace, presenting as a code bug.
     *
     * Shaped per-request rather than scope-wide: making every fetch opaque would poison
     * install too, and the assertion would then pass because the cache was never correctly
     * filled in the first place.
     */
    const scope = makeScope({ files: served })
    await scope.dispatch('install', {})
    scope.answerNextWith(new Res('opaque body', { type: 'opaque' }))
    await scope.dispatch('fetch', { request: new Req('app.js') })
    const cached = await scope.caches.match(new Req('app.js'))
    expect(cached.body, 'an opaque response was written into the cache').toBe('body of app.js')
  })

  it('declines a percent-encoded api path, which a raw substring test cannot see', async () => {
    /*
     * `/api%2Froute/4.json` arrives with the escape intact, so `pathname.indexOf('/api/')`
     * does not match and the request would have been handled -- and cached -- as an ordinary
     * asset. Nothing the client builds spells a URL that way and this origin 404s it, so it
     * is a guard rather than a live hole; but the rule it enforces is the one this project
     * treats as absolute.
     */
    const scope = makeScope({ files: served })
    await scope.dispatch('install', {})
    const event = await scope.dispatch('fetch', { request: new Req('api%2Froute/4.json') })
    expect(event.responded, 'the worker answered for an encoded api path').toBeUndefined()
  })
})
