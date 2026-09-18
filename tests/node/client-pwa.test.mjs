/**
 * pwa.js, driven rather than read.
 *
 * It is four guard clauses and one call, and it had no unit test at all -- no test file in
 * the repo referenced it by name. That matters more than its size suggests, because three of
 * the four guards exist for conditions the browser suite cannot reach: the board opened from
 * a file:// URL, which is a hard requirement of this client and has no service worker at all;
 * the node sandbox in tests/node/helpers/client.mjs, which evaluates every script in
 * index.html against a minimal window and would take the whole sandbox down with a
 * ReferenceError; and an old browser with no support. The browser suite only ever exercises
 * the one path where everything is present.
 *
 * Evaluated in a vm against a fake window, the same way client-sw.test.mjs drives the worker,
 * because an assertion on the source text would pass for a file that checks `navigator` and
 * then ignores the answer.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { ROOT } from './helpers/optional.mjs'

const source = readFileSync(path.join(ROOT, 'client', 'pwa.js'), 'utf8')

/** Run pwa.js against a window built to order; report what it did. */
function run({ navigator: nav = {}, protocol = 'https:', readyState = 'complete',
               addEventListener = true, registerThrows = false, registerRejects = false } = {}) {
  const registered = []
  const listeners = {}
  const serviceWorker = {
    register(url) {
      registered.push(url)
      if (registerThrows) throw new Error('SecurityError')
      return registerRejects ? Promise.reject(new Error('nope')) : Promise.resolve({})
    },
  }
  const global = {
    navigator: nav === null ? undefined : { ...nav, ...(nav.serviceWorker === null ? {} : { serviceWorker }) },
    location: { protocol },
    document: { readyState },
  }
  if (nav === null) delete global.navigator
  if (nav && nav.serviceWorker === null) delete global.navigator.serviceWorker
  if (addEventListener) global.addEventListener = (t, fn) => { listeners[t] = fn }

  const ctx = vm.createContext({ window: global, console })
  vm.runInContext(source, ctx, { filename: 'client/pwa.js' })
  return { registered, listeners, fire: (t) => listeners[t] && listeners[t]() }
}

describe('pwa.js registers the worker, and refuses to in the cases that would break', () => {
  it('registers it relatively, so the scope follows the directory the board is served from', () => {
    /*
     * `register('sw.js')`, never `/sw.js`. The <base> bootstrap has already pointed the
     * document at the board's own directory, so the relative form lands at /sw.js in
     * production and /fresh/sw.js under the fixture server. An absolute one would claim the
     * origin root and every other board served from the same host.
     */
    const r = run()
    expect(r.registered).toEqual(['sw.js'])
  })

  it('does nothing at all from a file:// URL, which has no service workers', () => {
    /* An opaque origin is not a secure context. Opening the board from disk is a hard
       requirement of this client, not a convenience, so this cannot be allowed to throw. */
    expect(run({ protocol: 'file:' }).registered).toEqual([])
  })

  it('does nothing when there is no navigator, which is the node sandbox', () => {
    /* tests/node/helpers/client.mjs evaluates every script in index.html against a minimal
       window. A ReferenceError here would take that whole sandbox down. */
    expect(run({ navigator: null }).registered).toEqual([])
  })

  it('does nothing when the browser has no service worker support', () => {
    /*
     * Asserted on the LISTENER, not on `registered`. An unsupporting browser reaches
     * register() either way and the try/catch swallows the resulting TypeError, so both the
     * guarded and unguarded versions end with nothing registered -- the assertion could not
     * tell them apart. What the guard actually buys is returning before anything is wired
     * up at all, so a document still loading gets no `load` listener either.
     */
    const r = run({ navigator: { serviceWorker: null }, readyState: 'loading' })
    expect(r.registered).toEqual([])
    expect(Object.keys(r.listeners), 'it wired up a load listener it can never honour')
      .toEqual([])
  })

  it('does nothing when there is nothing to listen on', () => {
    expect(run({ addEventListener: false, readyState: 'loading' }).registered).toEqual([])
  })

  it('waits for load rather than competing with the first paint', () => {
    /*
     * A phone at a bus stop wants the board on screen; the offline copy can be built a
     * second later. So on a document still loading it registers on `load`, not immediately.
     */
    const r = run({ readyState: 'loading' })
    expect(r.registered, 'it registered before load').toEqual([])
    r.fire('load')
    expect(r.registered).toEqual(['sw.js'])
  })

  it('survives a register() that throws, because failing is invisible and should be', () => {
    /* SecurityError on an origin that forbids workers. A worker that will not register
       costs the reader nothing they can see -- every fetch still goes to the network. */
    expect(() => run({ registerThrows: true })).not.toThrow()
  })

  it('survives a register() that rejects, without an unhandled rejection', () => {
    expect(() => run({ registerRejects: true })).not.toThrow()
  })
})
