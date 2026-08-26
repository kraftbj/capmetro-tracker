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
    this.headers = init.headers ?? {}
  }
  clone() {
    return new Res(this.body, { status: this.status, type: this.type, headers: this.headers })
  }
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

/** Build a scope, evaluate sw.js in it, and hand back the handlers plus the state. */
function makeScope({ files = {}, offline = false, existingCaches = [] } = {}) {
  const stores = new Map()
  for (const name of existingCaches) stores.set(name, new Map())

  const fetched = []
  function doFetch(req) {
    const url = new URL(keyOf(req))
    fetched.push(url.pathname)
    if (offline) return Promise.reject(new TypeError('Failed to fetch'))
    const body = files[url.pathname]
    if (body === undefined) return Promise.resolve(new Res('not found', { status: 404 }))
    return Promise.resolve(new Res(body))
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
      put(req, res) { m.set(keyOf(req), res); return Promise.resolve() },
      match(req) { return Promise.resolve(m.get(keyOf(req))) },
    }
  }

  const caches = {
    open: (name) => Promise.resolve(cacheFor(name)),
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name) => Promise.resolve(stores.delete(name)),
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
  async function dispatch(type, init) {
    const event = { ...init, waited: [], responded: undefined }
    event.waitUntil = (p) => event.waited.push(p)
    event.respondWith = (p) => { event.responded = p }
    handlers[type](event)
    await Promise.all(event.waited)
    if (event.responded) event.responded = await event.responded
    /* The worker writes to the cache without awaiting, on purpose: a full quota
       must not turn a successful fetch into a failed one. Let those land. */
    await new Promise((r) => setImmediate(r))
    return event
  }

  return { dispatch, stores, caches, claimed, fetched, handlers }
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
      const urls = /src:\s*url\(['"]([^'"]+)['"]\)/g
      while ((i = urls.exec(css)) !== null) out.add(path.posix.join(dir, i[1]))
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

  it('asks for each file bypassing the http cache, so it cannot precache the old release', async () => {
    /* update.sh rsyncs new client files and restarts nothing. Without
       cache: 'reload' an install can pick the PREVIOUS release out of the
       browser's own cache and freeze it as the offline copy. */
    expect(source).toContain("cache: 'reload'")
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
  let scope
  beforeEach(async () => {
    scope = makeScope({ files: served })
    await scope.dispatch('install', {})
  })

  it('does not answer an api request at all, so the browser fetches it as asked', async () => {
    for (const p of ['api/route/4.json', 'api/all.json', 'api/departures/4.json', 'api/health.json']) {
      const event = await scope.dispatch('fetch', { request: new Req(p) })
      expect(event.responded, `${p} was intercepted`).toBeUndefined()
    }
  })

  it('never has an api document in the cache, even after the board has run', async () => {
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
    const scope = makeScope({ files: served })
    await scope.dispatch('install', {})
    /* The deploy: same URL, new body, nothing restarted. */
    scope.stores.get([...scope.stores.keys()][0]) /* cache still holds the old one */
    const next = makeScope({ files: { ...served, [new URL('app.js', WORKER).pathname]: 'the new release' } })
    await next.dispatch('install', {})
    const event = await next.dispatch('fetch', { request: new Req('app.js') })
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

  it('does not cache a 404, which would freeze a missing file as a real one', async () => {
    const scope = makeScope({ files: served })
    await scope.dispatch('install', {})
    await scope.dispatch('fetch', { request: new Req('not-a-file.js') })
    expect(await scope.caches.match(new Req('not-a-file.js'))).toBeUndefined()
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
