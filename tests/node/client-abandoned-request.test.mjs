/**
 * What happens when a request the board gave up on answers anyway.
 *
 * A schedule fetch has no deadline of its own, so one outstanding when a phone
 * suspends may never settle. `refreshTick` therefore gives up on a 'loading'
 * that survives two sweeps and lets the route be asked again — which means two
 * requests for one route can be in the air at once, and the abandoned one is the
 * OLDER document. If it is allowed to write when it lands, it overwrites the
 * newer schedule that replaced it: yesterday's times back on screen by the exact
 * route the eviction exists to close.
 *
 * The guard is two lines, one in each handler. Nothing observes them unless a
 * late answer actually arrives, so this file arranges exactly that: a fetch held
 * open, a give-up, a second fetch answered, and only then the first one
 * released. The board is booted over http with a fetch under test control —
 * there is no network here, the stub IS the server.
 */
import { describe, expect, it } from 'vitest'
import { CLIENT_SCRIPTS, bootClient } from './helpers/client.mjs'

/** A fetch whose every response is held until the test hands one back. */
function controllableFetch() {
  const pending = []
  const fetch = (url) => new Promise((resolve, reject) => {
    pending.push({ url, resolve, reject })
  })
  return {
    fetch,
    pending,
    /** Answer the Nth outstanding request with a departures document. */
    answer(i, doc) {
      pending[i].resolve({ ok: true, json: () => Promise.resolve(doc) })
      return new Promise((r) => setImmediate(r))   /* let the .then chain drain */
    },
    departures: () => pending.filter((p) => /api\/departures\//.test(p.url)),
  }
}

const dayOf = (date) => ({
  service_date: date,
  service_day_start_epoch: 0,
  stops: [],
  trips: [],
  departures: {},
})

/*
 * Route 999, for the same reason the sweep tests use it: refreshTick re-requests
 * the open route, the editor's, and every saved trip's, so seeding on route 4
 * means the tick's own retry lands on top of whatever the sweep just did and the
 * assertions read the retry instead of the give-up.
 */
const ROUTE = '999'

/*
 * A boot per test. app.js holds module state, so a shared sandbox would let one
 * test's generation counters decide another's outcome.
 */
function boot(watches) {
  const net = controllableFetch()
  const client = bootClient(CLIENT_SCRIPTS, { protocol: 'http:', fetch: net.fetch })
  expect(client.reason).toBe(null)
  const app = client.cmb.app
  /* Something live has to have been seen, or nothing is ever judged expired. */
  app.state.data = { service_day: { date: '20260822' }, route: {}, vehicles: [] }
  /*
   * Saved trips live in localStorage and the client reads them back through
   * watch.list(). Seeding the flag on state is not enough: the saved-view branch
   * of refreshTick iterates that list, so a test that forgets this exercises an
   * empty loop and passes without reaching the code it names.
   */
  if (watches) {
    client.window.localStorage.setItem('cmb.watches', JSON.stringify(watches))
    expect(client.cmb.watch.list().length).toBe(watches.length)
  }
  return { app, net, client }
}

const A_WATCH = [{
  route_id: '800',
  direction_id: 1,
  direction_tag: 'SB',
  stop_id: '6293',
  stop_name: 'Simond SB',
  scheduled_time: '07:52:09',
  day_type: 'weekday',
}]

describe('a departures request the board has given up on', () => {
  /** Drive a route to the point where its first request has been abandoned. */
  function abandonFirst(app, net) {
    app.loadDepartures(ROUTE)
    const first = net.pending.length - 1
    expect(app.state.depStatus[ROUTE]).toBe('loading')

    app.refreshTick()
    app.refreshTick()
    expect(app.state.depStatus[ROUTE]).toBeUndefined()   /* the route may be asked again */

    app.loadDepartures(ROUTE)
    const second = net.pending.length - 1
    expect(second).toBeGreaterThan(first)
    return { first, second }
  }

  it('does not overwrite the document that replaced it', async () => {
    const { app, net } = boot()
    const { first, second } = abandonFirst(app, net)

    /* The replacement answers with today's schedule. */
    await net.answer(second, dayOf('20260822'))
    expect(app.state.departures[ROUTE].service_date).toBe('20260822')

    /* Only now does the abandoned one come back, carrying yesterday. */
    await net.answer(first, dayOf('20260821'))

    expect(app.state.departures[ROUTE].service_date).toBe('20260822')
    expect(app.state.depStatus[ROUTE]).toBe('ok')
  })

  it('does not put the route back into an error state either', async () => {
    /*
     * The same guard in the other handler. A failure answering a question that
     * is no longer being asked must not mark the route errored: that status
     * blocks the retry until the next sweep, so a late rejection would cost the
     * reader a minute of a schedule the board already has in hand.
     */
    const { app, net } = boot()
    const { first, second } = abandonFirst(app, net)

    await net.answer(second, dayOf('20260822'))
    expect(app.state.depStatus[ROUTE]).toBe('ok')

    net.pending[first].reject(new Error('the network finally gave up'))
    await new Promise((r) => setImmediate(r))

    expect(app.state.depStatus[ROUTE]).toBe('ok')
    expect(app.state.departures[ROUTE].service_date).toBe('20260822')
  })

  it('lets go of the connection rather than only of the answer', () => {
    /*
     * Giving up in bookkeeping alone leaves the request outstanding. A browser
     * allows about six connections per origin, so a server that accepts and
     * never answers fills that pool with dead requests and the once-a-minute
     * poll queues behind them — the opposite of what giving up is for.
     */
    class FakeAbortController {
      constructor() { this.signal = { aborted: false } }
      abort() { this.signal.aborted = true }
    }
    const net = controllableFetch()
    const client = bootClient(CLIENT_SCRIPTS, {
      protocol: 'http:',
      fetch: net.fetch,
      AbortController: FakeAbortController,
    })
    const app = client.cmb.app
    app.state.data = { service_day: { date: '20260822' }, route: {}, vehicles: [] }

    app.loadDepartures(ROUTE)
    /*
     * This route's own controller, held onto directly. A tick abandons every
     * route that has been loading too long — the open one included — so counting
     * aborts across the board would be counting somebody else's.
     */
    const ctl = app.state.depAbort[ROUTE]
    expect(ctl).toBeTruthy()

    app.refreshTick()
    expect(ctl.signal.aborted).toBe(false)   /* one tick is patience */

    app.refreshTick()
    expect(ctl.signal.aborted).toBe(true)
    expect(app.state.depAbort[ROUTE]).toBeUndefined()
  })

  it('still works where the browser has no AbortController', () => {
    /* Feature-detected, not assumed: a missing AbortController must cost the
     * retry, not the fetch. */
    const { app, net } = boot()   /* boot() passes no AbortController at all */
    app.loadDepartures(ROUTE)
    expect(net.pending.length).toBeGreaterThan(0)
    app.refreshTick()
    app.refreshTick()
    expect(app.state.depStatus[ROUTE]).toBeUndefined()
  })
})

/*
 * A route document that failed to load must get another chance, on whatever view
 * asked for it.
 *
 * loadRouteData declines every status but 'idle' — that is what stopped the
 * saved tab spinning a fetch per repaint — and the only thing writing 'idle'
 * back was the saved view's own block. So on the every-bus view one dropped
 * request was permanent: the bus detail read "loading the route…" with nothing
 * loading and nothing that ever would. The sweep clears the failure AND asks
 * again, because clearing alone is not a retry: nothing on that view calls
 * loadRouteData during a repaint, only opening a bus detail does.
 */
describe('a route document that failed to load', () => {
  it('is asked for again on the next tick, with no saved trips and no saved view', () => {
    const { app, net } = boot()
    app.state.view = 'all'
    app.state.routeStatus['800'] = 'error'

    const before = net.pending.filter((p) => /api\/route\/800/.test(p.url)).length
    app.refreshTick()
    const after = net.pending.filter((p) => /api\/route\/800/.test(p.url)).length

    expect(after).toBeGreaterThan(before)
  })

  /*
   * On the saved view two things want to re-ask for the same route, and they
   * used to both do it in the same tick: the sweep above clears the failure and
   * asks, then the saved block wrote 'idle' straight over the 'loading' that
   * produced and asked again. Two requests a minute for one file, and because
   * loadRouteData carries no generation stamp, two answers that can land out of
   * order — the older vehicle positions winning if it does.
   *
   * The other tests in this file sit on the every-bus view, which is the one
   * view where the saved block does not run, so none of them could see this.
   */
  it('is asked for exactly once a tick when it is also a saved trip', () => {
    const { app, net } = boot(A_WATCH)
    app.state.view = 'saved'
    app.state.routeStatus['800'] = 'error'

    const count = () => net.pending.filter((p) => /api\/route\/800/.test(p.url)).length
    const before = count()
    app.refreshTick()
    expect(count() - before).toBe(1)
  })

  it('does not pile a second request onto a saved route that is merely slow', () => {
    const { app, net } = boot(A_WATCH)
    app.state.view = 'saved'
    app.state.routeStatus['800'] = 'loading'

    const count = () => net.pending.filter((p) => /api\/route\/800/.test(p.url)).length
    const before = count()
    app.refreshTick()
    app.refreshTick()
    expect(count()).toBe(before)
  })

  it('is not asked for again while it is merely loading', () => {
    const { app, net } = boot()
    app.state.view = 'all'
    app.state.routeStatus['800'] = 'loading'

    const before = net.pending.filter((p) => /api\/route\/800/.test(p.url)).length
    app.refreshTick()
    app.refreshTick()
    const after = net.pending.filter((p) => /api\/route\/800/.test(p.url)).length

    expect(after).toBe(before)
  })
})

/*
 * The state that is neither "arriving" nor "refused": a server that accepts a
 * request and never answers it.
 *
 * The board gives up on such a request and asks again, so the status cycles
 * 'loading' -> cleared -> 'loading' and never reaches 'error'. No document ever
 * arrives either, so the withheld flag is false too — and the trip view fell
 * through to its placeholder rows, which promise a resolution that is not
 * coming and are hidden from assistive technology besides. Every other way of
 * failing had been given words; this one had been given a shimmer.
 */
describe('a route whose schedule is requested and never answered', () => {
  it('is reported as failed rather than as still arriving', () => {
    const { app } = boot()
    app.state.routeId = ROUTE
    app.state.view = 'trip'

    /* Nothing has been asked yet: genuinely "arriving". */
    expect(app.state.depGen[ROUTE]).toBeUndefined()

    app.loadDepartures(ROUTE)
    app.refreshTick()
    app.refreshTick()          /* the first request is abandoned */
    app.loadDepartures(ROUTE)  /* and the second goes out */

    expect(app.state.depStatus[ROUTE]).toBe('loading')
    expect(app.state.departures[ROUTE]).toBeUndefined()
    expect(app.state.depStatus[ROUTE]).not.toBe('error')
    /* The condition the trip view reads: a generation past its first. */
    expect(app.state.depGen[ROUTE]).toBeGreaterThan(1)
  })

  it('is still reported as arriving while the first request is outstanding', () => {
    const { app } = boot()
    app.loadDepartures(ROUTE)
    expect(app.state.depGen[ROUTE]).toBe(1)
  })
})
