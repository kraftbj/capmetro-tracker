/**
 * A departures document is kept for the service day it describes, not for the
 * life of the tab.
 *
 * The bug: `loadDepartures` returned early whenever `state.departures[routeId]`
 * held anything at all, so the first document a tab fetched was the only one it
 * ever had. A phone left on the counter overnight and picked up at seven still
 * answered from yesterday's schedule — every saved trip reading "the last one
 * today has gone", or times belonging to the wrong service day entirely, on the
 * surface someone consults at breakfast and has no reason to doubt.
 *
 * Two decisions carry the fix and both are asserted here directly, because both
 * have a wrong answer that looks reasonable:
 *
 *   currentServiceDate  — what "today" is, and specifically where it may NOT be
 *                         read from. The bundled fixture is a frozen capture,
 *                         not a statement about today.
 *   scheduleExpired     — OLDER, not merely different. `!==` also condemns a
 *                         document from the future, which is what a tab holds
 *                         for a few seconds either side of the service-day roll.
 */
import { describe, expect, it } from 'vitest'
import { CLIENT_SCRIPTS, bootClient } from './helpers/client.mjs'

/* The whole client, in the order index.html loads it. app.js reaches into other
 * namespaces at boot, so the list has to stay complete as the client grows —
 * which is why it is derived rather than written down here. */
const client = bootClient(CLIENT_SCRIPTS)

/*
 * No ctx.skip here. app.js failing to boot is the thing this file exists to
 * catch, and a skip would report that as a pass — the failure mode the suite has
 * already shipped once.
 */
describe('the client scripts load', () => {
  it('boots app.js and exposes the service-day decisions', () => {
    expect(client.reason).toBe(null)
    expect(client.cmb.app).toBeTruthy()
    expect(typeof client.cmb.app.currentServiceDate).toBe('function')
    expect(typeof client.cmb.app.scheduleExpired).toBe('function')
  })
})

const app = () => client.cmb.app

const dayOf = (date) => ({ service_day: { date } })

describe('what the board believes today is', () => {
  it('reads the service date off the live route payload', () => {
    expect(app().currentServiceDate({ data: dayOf('20260822') })).toBe('20260822')
  })

  /*
   * The regression that made the eviction unsafe to ship on its own. The bundled
   * fixture is a frozen capture; route 4 is the default and the only bundled
   * route, so a single failed request used to make its date "today" — and every
   * cached schedule from the actual today instantly expired, on a connection
   * that had just proved it could not fetch a replacement.
   */
  it('refuses to read today off the bundled fixture', () => {
    const state = { usingFixture: true, data: dayOf('20260819'), routeData: {} }
    expect(app().currentServiceDate(state)).toBe(null)
  })

  it('still answers from a live payload for another route while on the fixture', () => {
    const state = {
      usingFixture: true,
      data: dayOf('20260819'),
      routeData: { 800: dayOf('20260822') },
    }
    expect(app().currentServiceDate(state)).toBe('20260822')
  })

  it('falls back to the all-buses payload, then to any cached route payload', () => {
    expect(app().currentServiceDate({ all: dayOf('20260822'), routeData: {} })).toBe('20260822')
    expect(app().currentServiceDate({ routeData: { 7: dayOf('20260822') } })).toBe('20260822')
  })

  it('answers null when nothing live has been seen, so nothing is judged expired', () => {
    expect(app().currentServiceDate({ routeData: {} })).toBe(null)
    expect(app().scheduleExpired({ service_date: '20250101' }, null)).toBe(false)
  })
})

describe('whether a departures document has expired', () => {
  it('condemns a document from an earlier service day', () => {
    expect(app().scheduleExpired({ service_date: '20260821' }, '20260822')).toBe(true)
  })

  it('keeps a document from the current service day', () => {
    expect(app().scheduleExpired({ service_date: '20260822' }, '20260822')).toBe(false)
  })

  /*
   * Older, not merely different. Around the service-day roll `state.data` can
   * still be from before it while a schedule fetched a moment later is from
   * after; `!==` called the FRESHER of the two expired and re-fetched it once a
   * minute until the live payload caught up.
   */
  it('does not condemn a document from a LATER service day', () => {
    expect(app().scheduleExpired({ service_date: '20260823' }, '20260822')).toBe(false)
  })

  it('compares across a month and a year boundary, which YYYYMMDD makes safe', () => {
    expect(app().scheduleExpired({ service_date: '20260831' }, '20260901')).toBe(true)
    expect(app().scheduleExpired({ service_date: '20261231' }, '20270101')).toBe(true)
    expect(app().scheduleExpired({ service_date: '20270101' }, '20261231')).toBe(false)
  })

  it('does not throw on a missing document, and judges nothing without one', () => {
    /*
     * No document is not an expired document. There is nothing to withhold and
     * nothing to re-request; loadDepartures fetches on the absence itself.
     */
    expect(app().scheduleExpired(null, '20260822')).toBe(false)
    expect(app().scheduleExpired(undefined, '20260822')).toBe(false)
  })

  /*
   * A date the board cannot read is treated as expired: kept, but never answered
   * from, and asked for again on the timer.
   *
   * This asserted `scheduleExpired({}, ...) === false` when it was written, under
   * a heading about not throwing — two separate claims, and only the first one
   * was wanted. The comparison was `doc.service_date < today` alone, so the
   * answer came out of JS relational coercion and landed on a DIFFERENT side
   * depending on how the document was malformed: `null` and `''` and an ISO
   * `'2026-08-22'` all came back expired, while `undefined` and `'garbage'` came
   * back current and were then believed forever, never re-requested. The schema
   * requires eight digits, so any of these means the generator has already
   * broken its contract — which is precisely when the board should not be
   * guessing in the reader's favour.
   */
  it('treats a date it cannot read as expired, whichever way it is malformed', () => {
    const expired = (d) => app().scheduleExpired({ service_date: d }, '20260822')
    expect(expired(undefined)).toBe(true)
    expect(expired('garbage')).toBe(true)
    expect(expired(null)).toBe(true)
    expect(expired('')).toBe(true)
    expect(expired('2026-08-22')).toBe(true)
    expect(expired('202608222')).toBe(true)
    expect(expired({})).toBe(true)
  })

  it('still reads a well-formed date the generator actually emits', () => {
    expect(app().scheduleExpired({ service_date: '20260822' }, '20260822')).toBe(false)
    expect(app().scheduleExpired({ service_date: '20260821' }, '20260822')).toBe(true)
    /* The generator emits a string, but a number is unambiguous and orders the
     * same way once it is one; refusing it would be pedantry, not safety. */
    expect(app().scheduleExpired({ service_date: 20260821 }, '20260822')).toBe(true)
    expect(app().scheduleExpired({ service_date: 20260822 }, '20260822')).toBe(false)
  })
})

describe('which live source defines today', () => {
  /*
   * The sources refresh on different schedules. `state.all` is fetched only while
   * the every-bus view is open and then sits, so it can be hours behind. A date
   * that is too old makes nothing look expired, which lands the failure squarely
   * on the bug the eviction exists to remove — so the answer is the latest date
   * any source reports, never the first one found.
   */
  it('takes the latest date, not the first source that has one', () => {
    const state = { data: dayOf('20260821'), all: dayOf('20260819'), routeData: {} }
    expect(app().currentServiceDate(state)).toBe('20260821')
  })

  it('a stale all.json cannot drag today backwards', () => {
    const state = { all: dayOf('20260819'), routeData: { 800: dayOf('20260822') } }
    expect(app().currentServiceDate(state)).toBe('20260822')
    /* and the consequence that matters: yesterday's schedule is still condemned */
    expect(app().scheduleExpired({ service_date: '20260821' }, app().currentServiceDate(state))).toBe(true)
  })

  it('still ignores the bundled fixture even when it is the latest date', () => {
    const state = { usingFixture: true, data: dayOf('20260901'), routeData: { 4: dayOf('20260822') } }
    expect(app().currentServiceDate(state)).toBe('20260822')
  })
})


/*
 * 'loading' was the one status nothing ever cleared, and withholding is what
 * turned that from harmless into a dead surface.
 *
 * getJson is a plain fetch with no timeout. A request outstanding when a device
 * suspends may never settle — neither handler runs — so the status stays
 * 'loading' and loadDepartures returns early on it for the life of the tab.
 * Before the schedule started expiring, that left the board reading the document
 * it still held: wrong after a roll, but present. Now usableDepartures withholds
 * that document, so the reader gets an empty Next-buses band and empty saved
 * trips, and the network coming back does not help.
 */
describe('a departures fetch that never settles', () => {
  /*
   * Route 999 on purpose. refreshTick sweeps every cached status and then
   * re-requests the routes the board can currently answer for — the open route,
   * the editor's, and every saved trip's. A route that is none of those is swept
   * and not re-asked, which is what isolates the sweep from the retry: seeded on
   * route 4 these assertions read the status the RETRY had just set, not the one
   * the sweep left, and reported a hang that was really a recovery.
   */
  const ROUTE = '999'
  const seed = (status) => {
    const st = app().state
    st.routeId = '4'
    st.editor.route_id = null
    ;[st.depStatus, st.depStuck, st.depGen].forEach((m) => Object.keys(m).forEach((k) => delete m[k]))
    if (status) st.depStatus[ROUTE] = status
    return st
  }

  it('is given up on, so the route can be asked again', () => {
    const st = seed('loading')
    st.depGen[ROUTE] = 1

    app().refreshTick()
    expect(st.depStatus[ROUTE]).toBe('loading')   /* one tick is patience, not a hang */

    app().refreshTick()
    expect(st.depStatus[ROUTE]).toBeUndefined()   /* the guard that blocked every retry is gone */
  })

  /*
   * Giving up is only safe because the abandoned request is disowned first.
   * Without this the first fetch lands eventually and writes its document over
   * whatever the retry already put there — an older schedule replacing a newer
   * one, which is the bug this whole file exists to prevent, arriving by the
   * back door.
   */
  it('disowns the abandoned request rather than letting it write late', () => {
    const st = seed('loading')
    st.depGen[ROUTE] = 1

    app().refreshTick()
    app().refreshTick()

    expect(st.depGen[ROUTE]).toBe(2)
  })

  it('leaves a status that is not loading alone', () => {
    const st = seed('ok')

    app().refreshTick()
    app().refreshTick()
    app().refreshTick()

    expect(st.depStatus[ROUTE]).toBe('ok')
    expect(st.depGen[ROUTE]).toBeUndefined()
  })

  /*
   * The strikes belong to the request, not to the route. A route that once
   * loaded slowly must not carry a strike for the rest of the session and then
   * be abandoned in the middle of a perfectly healthy fetch later on.
   *
   * Both branches, because only one of them was ever wrong. Clearing happened on
   * the error/stale path, which is the path where the status was being deleted
   * anyway; a fetch that straddled a tick and then SUCCEEDED left its strike
   * behind, so the next request on that route met the give-up after one sweep
   * instead of two — on exactly the connection that had already shown it was
   * slow. Asserting only the 'stale' case tested the half that worked.
   */
  for (const after of ['ok', 'stale', 'error']) {
    it(`forgets the strikes once the request ends in '${after}'`, () => {
      const st = seed('loading')
      app().refreshTick()
      expect(st.depStuck[ROUTE]).toBe(1)

      st.depStatus[ROUTE] = after
      app().refreshTick()
      expect(st.depStuck[ROUTE]).toBeUndefined()
    })
  }

  it('gives a second slow request the full grace, not the remainder of the first', () => {
    const st = seed('loading')
    app().refreshTick()          /* strike one against request A */
    st.depStatus[ROUTE] = 'ok'   /* A lands, late but fine */
    app().refreshTick()

    /* B goes out later, on the same route. It gets two sweeps of its own. */
    st.depStatus[ROUTE] = 'loading'
    app().refreshTick()
    expect(st.depStatus[ROUTE]).toBe('loading')
    app().refreshTick()
    expect(st.depStatus[ROUTE]).toBeUndefined()
  })
})

/*
 * The other operand. scheduleExpired holds a document's date to eight digits;
 * `today` is the value it is compared against, and it fails in the unsafe
 * direction — whatever sorts highest becomes today, and one malformed value
 * there makes every well-formed document look current, which is the bug the
 * eviction exists to remove. Not reachable from the generator, which formats
 * 'Ymd'; asserted because an asymmetry is how the next person concludes one of
 * the two does not matter.
 */
describe('what the board will accept as today', () => {
  const src = (date) => ({ data: { service_day: { date: date } }, all: null, routeData: {} })

  it('ignores a source whose date is not a service date', () => {
    expect(app().currentServiceDate(src('2026-08-22'))).toBe(null)
    expect(app().currentServiceDate(src('garbage'))).toBe(null)
    expect(app().currentServiceDate(src(''))).toBe(null)
  })

  it('does not let a malformed source outrank a good one', () => {
    /* 'zzzz' sorts above any digit, so an unfiltered max would return it and
     * nothing would ever be judged expired again. */
    const state = {
      data: { service_day: { date: 'zzzz' } },
      all: { service_day: { date: '20260822' } },
      routeData: {},
    }
    expect(app().currentServiceDate(state)).toBe('20260822')
  })

  it('still takes the latest of several real dates', () => {
    const state = {
      data: { service_day: { date: '20260821' } },
      all: { service_day: { date: '20260822' } },
      routeData: {},
    }
    expect(app().currentServiceDate(state)).toBe('20260822')
  })
})
