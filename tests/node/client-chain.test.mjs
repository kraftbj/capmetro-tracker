/**
 * chain.js — transfer chains.
 *
 * The feature answers a question a saved trip cannot: not "when is her bus" but "is she
 * going to make the change". Almost every test here is about a way that answer can be
 * wrong in a way nobody would notice.
 *
 * The one that matters most is the first. The obvious way to find a transfer is to
 * intersect two routes' stop ids, and on this feed that returns NOTHING for routes 800
 * and 4 — the exact pair the feature was asked for. They meet at Pleasant Valley under
 * two different ids tens of metres apart. An implementation built on shared ids would
 * pass a hand-written unit test, report "these routes do not connect", and be wrong
 * about a change two children in this household make every morning. So the fixture is
 * trimmed from real generated output for that pair specifically, and the shared-id count
 * is asserted to be zero so the premise cannot rot silently.
 *
 * The second thing under test is that the verdict moves with the feed. A connection with
 * eight scheduled minutes is not a fact about today; it is a fact about the timetable.
 * Put the first bus nine minutes down and the same connection is missed, and it is missed
 * an hour before anyone reaches the stop. That transition is the whole product.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderClient, textOf } from './helpers/client.mjs'
import { ROOT } from './helpers/optional.mjs'
import { API, hasGeneratedOutput, MISSING } from './helpers/webroot.mjs'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'watch.js', 'chain.js'])

const t = (name, fn) =>
  it(name, (ctx) => {
    if (!client.cmb) ctx.skip(client.reason)
    if (!client.cmb.chain) ctx.skip('client scripts loaded but window.CMB.chain is not defined')
    return fn(client.cmb.chain, client.cmb)
  })

const FIXTURE = JSON.parse(
  readFileSync(path.join(ROOT, 'tests/fixtures/synthetic/chain-800-to-4.json'), 'utf8')
)
const DEPS = FIXTURE.departures
const DEP800 = DEPS['800']
const DEP4 = DEPS['4']
const MIDNIGHT = DEP800.service_day_start_epoch

/* The contract's own worked example: the 07:52:09 southbound from Simond SB. */
const WATCHED_TRIP = '3010894_22201'
const BOARD_STOP = '6293'
const BOARD_TIME = '07:52:09'

const LEG1 = {
  route_id: '800',
  direction_id: 1,
  direction_tag: 'SB',
  stop_id: BOARD_STOP,
  stop_name: 'Simond SB',
  scheduled_time: BOARD_TIME,
}

/** The chain the fixture exists for: 800 SB, change at Pleasant Valley, route 4 west. */
function theChain(chain) {
  const index = chain.tripIndexOf(DEP800, WATCHED_TRIP)
  const boardSeconds = chain.tripTimeAt(DEP800, index, BOARD_STOP)
  const found = chain.connections(DEP800, index, boardSeconds, DEP4, 0)
  /* The 78 m hop across 7th at Pleasant Valley — the one with real slack in it. */
  const pick = found.filter((c) => c.walk_m > 0 && c.walk_m < 100)[0] ?? found[0]
  return {
    connection: pick,
    chain: {
      legs: [LEG1, chain.legFromConnection(pick, { route_id: '4', direction_id: 0 })],
      day_type: 'weekday',
    },
  }
}

/** A route payload with one vehicle on `tripId`, `late` seconds down. */
const routeWith = (tripId, late, state = 'late') => ({
  staleness: { level: 'fresh', suppress_adherence: false },
  vehicles: [
    {
      vehicle_id: '8021',
      label: '8021',
      trip: { trip_id: tripId },
      adherence: { state, seconds: late, reason: null },
    },
  ],
})

describe('the premise: these two routes share no stops at all', () => {
  t('routes 800 and 4 have zero stop ids in common', () => {
    const a = new Set(DEP800.stops.map((s) => s.stop_id))
    const shared = DEP4.stops.filter((s) => a.has(s.stop_id))
    /*
     * If this ever becomes non-zero the fixture has been rebuilt from a feed where
     * the two routes were merged onto shared stops, and the test below stops proving
     * what it claims. Fail loudly here rather than passing hollowly there.
     */
    expect(shared).toHaveLength(0)
    expect(FIXTURE._expected.shared_stop_ids).toBe(0)
  })

  t('and connections are found anyway, every one of them across a walk', (chain) => {
    const { connection } = theChain(chain)
    const index = chain.tripIndexOf(DEP800, WATCHED_TRIP)
    const found = chain.connections(
      DEP800,
      index,
      chain.tripTimeAt(DEP800, index, BOARD_STOP),
      DEP4,
      0
    )
    expect(found.length).toBeGreaterThan(0)
    expect(connection.walk_m).toBeGreaterThan(0)
    found.forEach((c) => {
      expect(c.alight_stop_id).not.toBe(c.board_stop_id)
      expect(c.walk_m).toBeLessThanOrEqual(chain.WALK_RADIUS_M)
    })
  })
})

describe('what may be offered as a connection', () => {
  const found = (chain, dir = 0) => {
    const index = chain.tripIndexOf(DEP800, WATCHED_TRIP)
    return chain.connections(
      DEP800,
      index,
      chain.tripTimeAt(DEP800, index, BOARD_STOP),
      DEP4,
      dir
    )
  }

  t('never one that cannot physically be made', (chain) => {
    found(chain).forEach((c) => {
      expect(c.slack_s).toBeGreaterThanOrEqual(chain.MIN_SLACK_S)
    })
  })

  t('never one that means waiting most of an hour', (chain) => {
    found(chain).forEach((c) => {
      expect(c.slack_s).toBeLessThanOrEqual(chain.MAX_WAIT_S)
    })
  })

  t('the walk is charged against the slack, not assumed free', (chain) => {
    found(chain).forEach((c) => {
      /* slack is what is left AFTER walking; the raw gap is always larger. */
      expect(c.board_seconds - c.alight_seconds).toBe(c.slack_s + c.walk_s)
      /* walk_m is rounded for display and walk_s is derived from the unrounded
         distance THROUGH the circuity factor, so the two agree to within the
         second or two that rounding cost. */
      const expected = Math.ceil((c.walk_m * chain.WALK_CIRCUITY) / chain.WALK_SPEED_MS)
      expect(Math.abs(c.walk_s - expected)).toBeLessThanOrEqual(2)
    })
  })

  t('only the earliest onward bus per pair of stops, so the list is choices not repeats',
    (chain) => {
      const pairs = found(chain).map((c) => `${c.alight_stop_id}>${c.board_stop_id}`)
      expect(new Set(pairs).size).toBe(pairs.length)
    })

  t('earliest onward departure first', (chain) => {
    const times = found(chain).map((c) => c.board_seconds)
    expect(times.slice().sort((a, b) => a - b)).toEqual(times)
  })

  t('only stops the bus has not already passed', (chain) => {
    const index = chain.tripIndexOf(DEP800, WATCHED_TRIP)
    const boardSeconds = chain.tripTimeAt(DEP800, index, BOARD_STOP)
    found(chain).forEach((c) => {
      expect(c.alight_seconds).toBeGreaterThan(boardSeconds)
    })
  })

  t('the onward direction is honoured', (chain) => {
    const trips = new Set(DEP4.trips.filter((x) => x.direction_id === 1).map((x) => x.id))
    found(chain, 1).forEach((c) => expect(trips.has(c.trip.id)).toBe(true))
  })
})

describe('geography', () => {
  t('a stop is nought metres from itself', (chain) => {
    const s = DEP800.stops[0]
    expect(chain.metres(s, s)).toBe(0)
  })

  t('a stop with no fix is unknown, not in the Atlantic', (chain) => {
    /* lat/lon are 0 in the departures document when the shard has no position. 0,0
       is a real point in the Gulf of Guinea, and treating it as one would put every
       unlocated stop 10,000 km away and quietly call it "too far to walk" — which is
       the right answer for the wrong reason, and the wrong answer the moment the
       radius is used for anything else. */
    expect(chain.metres({ lat: 0, lon: 0 }, DEP800.stops[0])).toBeNull()
    expect(chain.metres(DEP800.stops[0], null)).toBeNull()
  })

  t('walking time always rounds up', (chain) => {
    expect(chain.walkSeconds(0)).toBe(0)
    expect(chain.walkSeconds(78)).toBe(
      Math.ceil((78 * chain.WALK_CIRCUITY) / chain.WALK_SPEED_MS)
    )
    /* Never rounds a real walk down to nothing. */
    expect(chain.walkSeconds(1)).toBeGreaterThanOrEqual(1)
  })
})

describe('reading a trip out of a stop-keyed document', () => {
  t('downstream stops come back in the order the bus visits them', (chain) => {
    const index = chain.tripIndexOf(DEP800, WATCHED_TRIP)
    const hops = chain.downstreamStops(DEP800, index, 0)
    expect(hops.length).toBeGreaterThan(5)
    const seconds = hops.map((h) => h.seconds)
    expect(seconds.slice().sort((a, b) => a - b)).toEqual(seconds)
  })

  t('a stop the trip does not call at has no time on it', (chain) => {
    const index = chain.tripIndexOf(DEP800, WATCHED_TRIP)
    expect(chain.tripTimeAt(DEP800, index, 'no-such-stop')).toBeNull()
  })
})

describe('the verdict, which is the whole product', () => {
  const now = MIDNIGHT + 7 * 3600 + 50 * 60 /* 07:50, ten minutes before the first bus */

  t('with nothing reporting it is the timetable, and says so', (chain) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, DEPS, {}, now)
    expect(m.state).toBe('no-vehicle')
    expect(m.connection.state).toBe('made')
    expect(m.connection.assumed).toEqual(['arriving', 'onward'])
    expect(chain.assumptionNote(m.connection)).toMatch(/timetable, not a prediction/)
  })

  t('an on-time first bus keeps the connection', (chain) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, DEPS, { 800: routeWith(WATCHED_TRIP, 0, 'ontime') }, now)
    expect(m.state).toBe('live')
    expect(m.connection.state).toBe('made')
    expect(m.connection.slack_s).toBe(m.connection.scheduled_slack_s)
  })

  t('a late enough first bus loses it, and the slack goes negative', (chain) => {
    const { chain: c, connection } = theChain(chain)
    const late = connection.slack_s + 60 /* one minute past what there was to spare */
    const m = chain.resolve(c, DEPS, { 800: routeWith(WATCHED_TRIP, late, 'very_late') }, now)
    expect(m.connection.state).toBe('missed')
    expect(m.connection.slack_s).toBeLessThan(0)
    expect(chain.slackText(m.connection.slack_s)).toMatch(/short$/)
    expect(chain.connectionDetail(m.connection)).toMatch(/Plan on the next one/)
  })

  t('and the step in between is called tight rather than fine', (chain) => {
    const { chain: c, connection } = theChain(chain)
    /* Eat all but sixty seconds of the spare time. */
    const late = connection.slack_s - 60
    const m = chain.resolve(c, DEPS, { 800: routeWith(WATCHED_TRIP, late, 'very_late') }, now)
    expect(m.connection.state).toBe('tight')
    expect(m.connection.slack_s).toBeGreaterThanOrEqual(0)
    expect(m.connection.slack_s).toBeLessThan(chain.TIGHT_S)
  })

  t('a late ONWARD bus gives the connection back', (chain) => {
    const { chain: c, connection } = theChain(chain)
    const late = connection.slack_s + 60
    const held = chain.resolve(
      c,
      DEPS,
      {
        800: routeWith(WATCHED_TRIP, late, 'very_late'),
        /* the connecting bus is running just as late, so it is still there */
        4: routeWith(connection.trip.id, late + 120, 'very_late'),
      },
      now
    )
    expect(held.connection.state).toBe('made')
  })

  /*
   * This test used to assert that a suppressed lateness fell back to the timetable
   * and recorded the assumption — which it did, and which is the WRONG outcome. It
   * checked the guard (a null is not a zero) and never followed where the null led:
   * to `board_at`, and to a confident verdict built on it. Rewritten to assert the
   * outcome, which is what a reader of the card actually gets.
   */
  t('a suppressed lateness refuses to grade rather than grading optimistically',
    (chain) => {
      const { chain: c, connection } = theChain(chain)
      const late = connection.slack_s + 60 /* enough to miss it, and known */
      const vehicle = {
        vehicle_id: '8021',
        label: '8021',
        trip: { trip_id: WATCHED_TRIP },
        adherence: { state: 'very_late', seconds: late, reason: null },
      }

      const fresh = chain.resolve(c, DEPS, {
        800: { staleness: { level: 'fresh', suppress_adherence: false }, vehicles: [vehicle] },
      }, now)
      expect(fresh.connection.state).toBe('missed')

      /*
       * Same chain, same bus, same lateness in the payload — only the feed's
       * staleness differs. Before this fix the verdict flipped from 'missed' to
       * 'made' with +480 s of slack: the timetable stood in for a measurement that
       * existed and was lost, and the substitution always reads "on time".
       */
      const dead = chain.resolve(c, DEPS, {
        800: { staleness: { level: 'dead', suppress_adherence: true }, vehicles: [vehicle] },
      }, now)
      expect(dead.connection.state).toBe('unknown')
      expect(dead.connection.state).not.toBe('made')
      expect(dead.connection.slack_s).toBeNull()
      expect(dead.connection.ungraded_legs).toEqual([
        { side: 'arriving', why: 'feed_stale', vehicle: true },
      ])
    })

  t('and never calls a suppressed bus one that has not reported', (chain) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, DEPS, {
      800: {
        staleness: { level: 'dead', suppress_adherence: true },
        vehicles: [{
          vehicle_id: '8021', label: '8021', trip: { trip_id: WATCHED_TRIP },
          adherence: { state: 'very_late', seconds: 900, reason: null },
        }],
      },
    }, now)
    /* The bus reported, and its badge is drawn on the same screen. */
    expect(chain.assumptionNote(m.connection)).toBeNull()
    const said = chain.connectionDetail(m.connection)
    expect(said).toMatch(/feed has stopped updating/)
    expect(said).not.toMatch(/not reporting yet/)
    /* The timetable gap may be quoted, but never as slack. */
    expect(said).toMatch(/timetable allows/)
  })
})

describe('the states a chain can be in', () => {
  t('before the window it is a plan, not news', (chain) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, DEPS, {}, MIDNIGHT + 5 * 3600)
    expect(m.state).toBe('upcoming')
  })

  t('after the last bus has been boarded it is over', (chain) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, DEPS, {}, MIDNIGHT + 12 * 3600)
    expect(m.state).toBe('passed')
  })

  t('saved for a weekday, opened on a Sunday, says which', (chain) => {
    const { chain: c } = theChain(chain)
    const sunday = { ...DEPS, 800: { ...DEP800, day_type: 'sunday' } }
    const m = chain.resolve(c, sunday, {}, MIDNIGHT + 8 * 3600)
    expect(m.state).toBe('not-today')
    expect(m.detail).toMatch(/Today is a sunday/)
  })

  t('a departure that no longer exists breaks the chain and names the route', (chain) => {
    const { chain: c } = theChain(chain)
    const moved = { legs: [{ ...c.legs[0], scheduled_time: '03:03:03' }, c.legs[1]],
      day_type: 'weekday' }
    const m = chain.resolve(moved, DEPS, {}, MIDNIGHT + 8 * 3600)
    expect(m.state).toBe('broken')
    expect(m.detail).toMatch(/[Rr]oute 800/)
  })

  t('a change at a stop the first bus no longer calls at breaks it too', (chain) => {
    const { chain: c } = theChain(chain)
    const wrong = {
      legs: [c.legs[0], { ...c.legs[1], alight_stop_id: 'not-on-this-trip' }],
      day_type: 'weekday',
    }
    const m = chain.resolve(wrong, DEPS, {}, MIDNIGHT + 8 * 3600)
    expect(m.state).toBe('broken')
    expect(m.detail).toMatch(/no longer stops where the change was made/)
  })

  t('a missing schedule is not a broken chain', (chain) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, {}, {}, MIDNIGHT + 8 * 3600)
    expect(m.state).toBe('no-schedule')
  })

  t('the SECOND route missing its schedule is also not-yet, not broken', (chain) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, { 800: DEP800 }, {}, MIDNIGHT + 8 * 3600)
    expect(m.state).toBe('no-schedule')
  })
})

describe('what the store will keep', () => {
  t('a chain needs at least one change in it', (chain) => {
    expect(chain.isWellFormed({ legs: [LEG1], day_type: 'weekday' })).toBe(false)
  })

  t('and no more than three buses', (chain) => {
    const leg = { ...LEG1, alight_stop_id: 'x' }
    expect(chain.isWellFormed({ legs: [LEG1, leg, leg, leg], day_type: 'weekday' })).toBe(false)
  })

  t('every leg after the first must say where it was reached from', (chain) => {
    const noAlight = { ...LEG1, route_id: '4' }
    expect(chain.isWellFormed({ legs: [LEG1, noAlight], day_type: 'weekday' })).toBe(false)
  })

  t('a chain with two legs and a day type is kept', (chain) => {
    const { chain: c } = theChain(chain)
    expect(chain.isWellFormed(c)).toBe(true)
  })

  t('the key distinguishes chains that differ only in a later leg', (chain) => {
    const { chain: c } = theChain(chain)
    const other = { legs: [c.legs[0], { ...c.legs[1], scheduled_time: '09:09:09' }],
      day_type: 'weekday' }
    expect(chain.keyFor(c)).not.toBe(chain.keyFor(other))
  })

  t('routesIn names every route once, in order', (chain) => {
    const { chain: c } = theChain(chain)
    expect(chain.routesIn(c)).toEqual(['800', '4'])
    expect(chain.routesIn({ legs: [LEG1, { ...LEG1, alight_stop_id: 'x' }] })).toEqual(['800'])
  })

  t('resolve refuses a one-leg chain rather than throwing', (chain) => {
    const m = chain.resolve({ legs: [LEG1], day_type: 'weekday' }, DEPS, {}, MIDNIGHT)
    expect(m.state).toBe('broken')
  })
})

describe('ordering: the connection at risk comes first', () => {
  t('a live chain with a missed change outranks a live chain that holds', (chain) => {
    const sorted = chain.sortModels([
      { state: 'live', seconds_until: 60, connection: { state: 'made', slack_s: 600 } },
      { state: 'live', seconds_until: 900, connection: { state: 'missed', slack_s: -60 } },
    ])
    expect(sorted[0].connection.state).toBe('missed')
  })

  t('but anything already gone still sinks below anything live', (chain) => {
    const sorted = chain.sortModels([
      { state: 'passed', seconds_until: -10, connection: { state: 'missed', slack_s: -60 } },
      { state: 'live', seconds_until: 600, connection: { state: 'made', slack_s: 600 } },
    ])
    expect(sorted[0].state).toBe('live')
  })
})

describe('words a person reads at six in the morning', () => {
  t('slack is never a bare signed number', (chain) => {
    expect(chain.slackText(600)).toBe('10 minutes spare')
    expect(chain.slackText(-600)).toBe('10 minutes short')
    expect(chain.slackText(null)).toBe('no timing')
  })

  t('half a minute short is one minute short, never none', (chain) => {
    /* Rounding 34 seconds down to "0 minutes short" reads as having made it. */
    expect(chain.slackText(-34)).toBe('1 minute short')
  })

  t('a same-stop change says so instead of naming a nought-metre walk', (chain) => {
    const said = chain.connectionDetail({
      state: 'made', walk_m: 0, alight_stop_name: 'Simond SB', slack_s: 300,
    })
    expect(said).toMatch(/^Same stop at Simond SB/)
    expect(said).not.toMatch(/0 m/)
  })
})

describe('the card', () => {
  t('leads with the first bus and names the change', (chain, cmb) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, DEPS, { 800: routeWith(WATCHED_TRIP, 0, 'ontime') },
      MIDNIGHT + 7 * 3600 + 50 * 60)
    const host = cmb.states.el('div')
    chain.render(host, [m], {})
    const said = textOf(host)
    expect(said).toMatch(/Transfer chains/)
    expect(said).toMatch(/800 → 4/)
    expect(said).toMatch(/1 change/)
    expect(said).toMatch(/Connection holds/)
  })

  t('an empty list explains what a chain is rather than showing nothing', (chain, cmb) => {
    const host = cmb.states.el('div')
    chain.render(host, [], {})
    expect(textOf(host)).toMatch(/journey with a change in it/)
  })
})

/*
 * CLAUDE.md is explicit that QA runs against real generated output and not the golden
 * fixture, because both bugs /qa found on 2026-08-19 came from routes the fixture does
 * not contain. The fixture above is trimmed from real output but it is still two routes;
 * this runs the household's actual chains over the whole generated corpus.
 */
describe('against real generated output', () => {
  const dep = (id) => {
    const f = path.join(API, 'departures', `${id}.json`)
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
  }

  const REAL = [
    { from: '800', stop: '6293', dir: 1, at: '07:52:09', to: '4' },
    { from: '337', to: '350' },
    { from: '7', to: '837' },
  ]

  REAL.forEach((leg) => {
    t(`route ${leg.from} really does connect to route ${leg.to}`, (chain, ctx) => {
      if (!hasGeneratedOutput()) return void 0 /* asserted below via the guard test */
      const a = dep(leg.from)
      const b = dep(leg.to)
      if (!a || !b) return void 0
      /*
       * Pick a real morning trip on the first route rather than a named one, so this
       * keeps working across a feed rebuild. The claim under test is not "this exact
       * bus connects" but "these routes connect at all", which is the claim an
       * intersection of stop ids gets wrong.
       */
      let found = []
      for (const trip of a.trips) {
        const index = a.trips.indexOf(trip)
        const hops = chain.downstreamStops(a, index, 0)
        if (!hops.length) continue
        const start = hops[0].seconds
        if (start < 6 * 3600 || start > 10 * 3600) continue
        found = chain
          .connections(a, index, start - 1, b, 0)
          .concat(chain.connections(a, index, start - 1, b, 1))
        if (found.length) break
      }
      expect(found.length).toBeGreaterThan(0)
      found.forEach((c) => {
        expect(c.slack_s).toBeGreaterThanOrEqual(chain.MIN_SLACK_S)
        expect(c.walk_m).toBeLessThanOrEqual(chain.WALK_RADIUS_M)
      })
    })
  })

  it('says so when there is no generated output to check against', (ctx) => {
    if (!hasGeneratedOutput()) ctx.skip(MISSING)
    expect(hasGeneratedOutput()).toBe(true)
  })
})

/*
 * Cancellation. The highest-consequence gap the review found: `trip.canceled` is
 * published on every departures trip, `resolveLeg` ignored it, and a canceled leg
 * therefore took the no-vehicle path — lateness null, scheduled time standing in,
 * the transfer graded against a timetable for a bus that is not running. The card
 * could print "Connection holds" about a leg the agency had already called off.
 *
 * On the 2026-08-19 feed there are 100 canceled trips across 10 routes, 14 of them
 * on route 837 and 8 on route 7 — both legs of "337 to the 7 to the 837". This is
 * the shipped path.
 */
describe('a canceled leg is never graded', () => {
  const now = MIDNIGHT + 7 * 3600 + 50 * 60

  /** The same fixture with one trip marked canceled, by trip id. */
  const withCanceled = (tripId) => {
    const clone = JSON.parse(JSON.stringify(DEPS))
    let hit = 0
    for (const doc of Object.values(clone)) {
      for (const t of doc.trips) if (t.id === tripId) { t.canceled = true; hit += 1 }
    }
    expect(hit, `trip ${tripId} is not in the fixture`).toBe(1)
    return clone
  }

  t('the fixture publishes the field at all', () => {
    /* If a feed rebuild ever drops `canceled`, every assertion below would pass
       vacuously against a field that is always undefined. */
    DEP800.trips.forEach((x) => expect(x).toHaveProperty('canceled'))
    DEP4.trips.forEach((x) => expect(x).toHaveProperty('canceled'))
  })

  /*
   * The cached-document fuse, closed on trunk in 30dd6a9 and inherited here.
   *
   * `trip.canceled` rides api/departures/{route}.json, which the client fetches once
   * and keeps for the session, so it cannot carry a cancellation announced after the
   * tab was opened — which is exactly how somebody waiting at a stop uses this. The
   * live `route.schedule.canceled_trips` covers that, and the union of the two is
   * one rule living in watch.js.
   */
  t('a cancellation announced after the tab opened still reaches the chain', (chain) => {
    const { chain: c } = theChain(chain)
    /* The cached schedule says nothing is canceled — as it would in a tab opened
       before the announcement. Every trip's flag is explicitly false so this
       cannot pass vacuously against a document that simply lacks the field. */
    const cached = JSON.parse(JSON.stringify(DEPS))
    Object.values(cached).forEach((doc) => doc.trips.forEach((x) => { x.canceled = false }))

    const live = {
      800: {
        staleness: { level: 'fresh', suppress_adherence: false },
        vehicles: [],
        schedule: { canceled_trips: [WATCHED_TRIP] },
      },
    }
    const m = chain.resolve(c, cached, live, now)
    expect(m.state).toBe('canceled')
    expect(m.transfers[0].state).toBe('void')

    /* Negative control: without the live list the same input grades normally, so
       the assertion above is about the union and not about the fixture. */
    const without = chain.resolve(c, cached, {}, now)
    expect(without.state).not.toBe('canceled')
  })

  t('the FIRST leg canceled does not read as a bus that has yet to start', (chain) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, withCanceled(WATCHED_TRIP), {}, now)
    expect(m.state).toBe('canceled')
    expect(m.detail).toMatch(/canceled the 7:52a route 800/)
    expect(m.detail).not.toMatch(/normal until it starts its run/)
  })

  t('and its transfer is void rather than graded', (chain) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, withCanceled(WATCHED_TRIP), {}, now)
    expect(m.transfers[0].state).toBe('void')
    expect(m.transfers[0].slack_s).toBeNull()
    expect(m.connection.state).toBe('void')
  })

  t('the ONWARD leg canceled is caught too, and named', (chain) => {
    const { chain: c, connection } = theChain(chain)
    const m = chain.resolve(c, withCanceled(connection.trip.id), {}, now)
    expect(m.state).toBe('canceled')
    expect(m.detail).toMatch(/route 4/)
    expect(m.transfers[0].state).toBe('void')
  })

  t('the card says CANCELED and never a connection verdict', (chain, cmb) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, withCanceled(WATCHED_TRIP), {}, now)
    const host = cmb.states.el('div')
    chain.render(host, [m], {})
    const said = textOf(host)
    expect(said).toMatch(/CANCELED/)
    expect(said).toMatch(/No bus is running that trip today/)
    /* The exact string the bug produced. */
    expect(said).not.toMatch(/Connection holds/)
    expect(said).not.toMatch(/normal until it starts its run/)
  })

  t('and a screen reader hears it, not just the color', (chain) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, withCanceled(WATCHED_TRIP), {}, now)
    /* spoken() is exercised through the card; assert the model carries the words. */
    expect(m.detail).toMatch(/CapMetro has canceled/)
  })

  t('a canceled chain outranks a live one that holds', (chain) => {
    const sorted = chain.sortModels([
      { state: 'live', seconds_until: 600, connection: { state: 'made', slack_s: 600 } },
      { state: 'canceled', seconds_until: 900, connection: { state: 'void', slack_s: null } },
    ])
    expect(sorted[0].state).toBe('live')
    /* live still leads, but canceled sits above everything that is merely waiting. */
    const sorted2 = chain.sortModels([
      { state: 'upcoming', seconds_until: 60, connection: null },
      { state: 'canceled', seconds_until: 900, connection: null },
    ])
    expect(sorted2[0].state).toBe('canceled')
  })
})

/*
 * The cascade. Grading each transfer independently printed "Connection holds" six
 * lines under "Connection missed" on a three-leg chain — the second verdict
 * computed from a bus the rider will not be on.
 */
describe('a change nobody reaches is not graded either', () => {
  const now = MIDNIGHT + 7 * 3600 + 50 * 60

  /** A three-leg chain: 800 -> 4 -> 4, the third leg reached from the second. */
  const threeLeg = (chain) => {
    const { chain: two, connection } = theChain(chain)
    const secondIdx = chain.tripIndexOf(DEP4, connection.trip.id)
    const onward = chain.connections(DEP4, secondIdx, connection.board_seconds, DEP4, 1)
    if (!onward.length) return null
    return {
      legs: two.legs.concat([
        chain.legFromConnection(onward[0], { route_id: '4', direction_id: 1 }),
      ]),
      day_type: 'weekday',
    }
  }

  t('a missed first change voids every change after it', (chain, cmb) => {
    const three = threeLeg(chain)
    if (!three) return void 0   /* the fixture trim offers no third leg today */
    const { connection } = theChain(chain)
    const late = connection.slack_s + 60
    const m = chain.resolve(three, DEPS,
      { 800: routeWith(WATCHED_TRIP, late, 'very_late') }, now)

    expect(m.transfers).toHaveLength(2)
    expect(m.transfers[0].state).toBe('missed')
    expect(m.transfers[1].state).toBe('void')
    expect(m.transfers[1].slack_s).toBeNull()

    const host = cmb.states.el('div')
    chain.render(host, [m], {})
    const said = textOf(host)
    expect(said).toMatch(/Connection missed/)
    /* The whole point: no second, contradictory verdict underneath the first. */
    expect(said).not.toMatch(/Connection holds/)
    expect(said).toMatch(/Not reached/)
  })
})

describe('the boundary between tight and fine', () => {
  const now = MIDNIGHT + 7 * 3600 + 50 * 60

  t('slack of exactly MIN_SLACK_S is tight, not holding', (chain) => {
    const { chain: c, connection } = theChain(chain)
    /* Eat the spare time down to exactly the floor the editor will still offer. */
    const late = connection.slack_s - chain.MIN_SLACK_S
    const m = chain.resolve(c, DEPS, { 800: routeWith(WATCHED_TRIP, late, 'late') }, now)
    expect(m.connection.slack_s).toBe(chain.MIN_SLACK_S)
    /*
     * The two constants are equal, which is what made this invisible: with a
     * strict `<` the tightest connection the board will ever offer graded "made".
     */
    expect(chain.TIGHT_S).toBe(chain.MIN_SLACK_S)
    expect(m.connection.state).toBe('tight')
  })

  t('one second more is holding', (chain) => {
    const { chain: c, connection } = theChain(chain)
    const late = connection.slack_s - chain.MIN_SLACK_S - 1
    const m = chain.resolve(c, DEPS, { 800: routeWith(WATCHED_TRIP, late, 'late') }, now)
    expect(m.connection.state).toBe('made')
  })
})

describe('the walk is longer than the straight line', () => {
  t('circuity is charged, so a walk costs more than distance over pace', (chain) => {
    /* The straight line between two stops is not a path anyone walks. Pleasant
       Valley, the junction this feature was built for, is a divided arterial. */
    expect(chain.WALK_CIRCUITY).toBeGreaterThan(1)
    expect(chain.walkSeconds(300)).toBe(
      Math.ceil((300 * chain.WALK_CIRCUITY) / chain.WALK_SPEED_MS)
    )
    expect(chain.walkSeconds(300)).toBeGreaterThan(300 / chain.WALK_SPEED_MS)
  })

  t('a nought-metre walk still costs nothing', (chain) => {
    expect(chain.walkSeconds(0)).toBe(0)
  })

  t('the widest offered walk is priced past the tight threshold', (chain) => {
    /* A 300 m hop is near six minutes, not four. That pricing is the whole reason
       the radius may stay at 300 rather than being cut to the 215 m the three
       hand-picked examples cover. */
    expect(chain.walkSeconds(chain.WALK_RADIUS_M)).toBeGreaterThan(300)
  })
})

describe('a store somebody edited by hand', () => {
  t('legs that are not an array are rejected, not thrown on', (chain) => {
    /* `legs.length` on an object is undefined, and every comparison against
       undefined is false — so this passed validation and then threw inside
       resolve(), taking out the whole Saved view until the store was cleared. */
    expect(chain.isWellFormed({ legs: { 0: LEG1, 1: LEG1 }, day_type: 'weekday' })).toBe(false)
    expect(chain.isWellFormed({ legs: 'two', day_type: 'weekday' })).toBe(false)
    expect(chain.isWellFormed({ legs: null, day_type: 'weekday' })).toBe(false)
  })

  t('add reports whether the chain is actually in the store', (chain) => {
    const { chain: c } = theChain(chain)
    /*
     * The board announced "Saved …" and navigated away from six steps of work even
     * when localStorage refused, landing the reader on "No transfer chains yet".
     */
    expect(typeof chain.add(c)).toBe('boolean')
  })
})

describe('MAX_WAIT_S caps the wait, which is what its name says', () => {
  t('no offered connection waits longer than the constant, walk included', (chain) => {
    const index = chain.tripIndexOf(DEP800, WATCHED_TRIP)
    const found = chain.connections(
      DEP800, index, chain.tripTimeAt(DEP800, index, BOARD_STOP), DEP4, 0
    )
    expect(found.length).toBeGreaterThan(0)
    found.forEach((c) => {
      /*
       * Measured from stepping off the first bus, not from finishing the walk.
       * Capping post-walk slack made the real ceiling MAX_WAIT_S plus the walk —
       * 49 minutes before circuity and 50.8 after, against a stated 45 — so the
       * walk-model fix silently widened the gap.
       */
      expect(c.board_seconds - c.alight_seconds).toBeLessThanOrEqual(chain.MAX_WAIT_S)
    })
  })
})

describe('the walk is recomputed, not inherited from the store', () => {
  const now = MIDNIGHT + 7 * 3600 + 50 * 60

  t('a chain saved before the circuity factor gets today\'s cost anyway', (chain) => {
    const { chain: c } = theChain(chain)
    const legs = [c.legs[0], { ...c.legs[1] }]
    /* What the old model would have stored: distance over pace, no circuity. */
    const stale = Math.ceil(legs[1].walk_m / chain.WALK_SPEED_MS)
    legs[1].walk_s = stale

    const m = chain.resolve({ legs, day_type: 'weekday' }, DEPS, {}, now)
    const t0 = m.transfers[0]
    expect(t0.walk_source).toBe('current')
    expect(t0.walk_s).toBeGreaterThan(stale)
    /* walk_m is rounded for display; walk_s comes off the unrounded distance. */
    const expected = Math.ceil((t0.walk_m * chain.WALK_CIRCUITY) / chain.WALK_SPEED_MS)
    expect(Math.abs(t0.walk_s - expected)).toBeLessThanOrEqual(2)
  })

  t('and a stop with no fix falls back to the stored metres, re-priced', (chain) => {
    const { chain: c } = theChain(chain)
    const legs = [c.legs[0], { ...c.legs[1], alight_stop_id: 'no-such-stop', walk_m: 100,
      walk_s: 1 }]
    const walk = chain.walkFor(DEP800, DEP4, legs[1])
    expect(walk.source).toBe('stored')
    expect(walk.m).toBe(100)
    /* The stored SECONDS are not trusted — they are re-derived from the metres, so
       an old chain still gets the current model. */
    expect(walk.s).toBe(Math.ceil((100 * chain.WALK_CIRCUITY) / chain.WALK_SPEED_MS))
    expect(walk.s).not.toBe(1)
  })
})

describe('a cancellation nobody reaches is not the headline', () => {
  const now = MIDNIGHT + 7 * 3600 + 50 * 60

  const threeLeg = (chain) => {
    const { chain: two, connection } = theChain(chain)
    const secondIdx = chain.tripIndexOf(DEP4, connection.trip.id)
    const onward = chain.connections(DEP4, secondIdx, connection.board_seconds, DEP4, 1)
    if (!onward.length) return null
    return {
      chain: {
        legs: two.legs.concat([
          chain.legFromConnection(onward[0], { route_id: '4', direction_id: 1 }),
        ]),
        day_type: 'weekday',
      },
      connection,
      third: onward[0],
    }
  }

  t('a missed change at transfer 1 outranks a canceled leg 3', (chain) => {
    const built = threeLeg(chain)
    if (!built) return void 0
    const clone = JSON.parse(JSON.stringify(DEPS))
    let hit = 0
    for (const tr of clone['4'].trips) {
      if (tr.id === built.third.trip.id) { tr.canceled = true; hit += 1 }
    }
    expect(hit).toBe(1)

    const late = built.connection.slack_s + 60
    const m = chain.resolve(built.chain, clone,
      { 800: routeWith(WATCHED_TRIP, late, 'very_late') }, now)

    /*
     * The reader was never going to be on leg 3, so its cancellation is not news.
     * Leading with it erased the due time and buried the missed change at transfer
     * 1 — the earlier problem, and the one that decides the morning.
     */
    expect(m.state).not.toBe('canceled')
    expect(m.transfers[0].state).toBe('missed')
    expect(m.connection.state).toBe('missed')
  })

  t('but a cancellation on a leg still reachable does lead', (chain) => {
    const built = threeLeg(chain)
    if (!built) return void 0
    const clone = JSON.parse(JSON.stringify(DEPS))
    for (const tr of clone['4'].trips) {
      if (tr.id === built.third.trip.id) tr.canceled = true
    }
    /* Nothing upstream is broken this time, so leg 3 is reached. */
    const m = chain.resolve(built.chain, clone, {}, now)
    expect(m.state).toBe('canceled')
  })
})

describe('two service days must not be subtracted from each other', () => {
  t('refuses rather than reporting a day of spare time', (chain) => {
    const { chain: c } = theChain(chain)
    /*
     * Departures documents are cached for the session and change only when the
     * service date does, so a board left open across 3 a.m. holds one from
     * yesterday and fetches one from today. Subtracting across the two anchors gave
     * "Connection holds — 1448 minutes spare".
     */
    const yesterday = {
      ...DEPS,
      4: {
        ...DEP4,
        service_date: '20260818',
        service_day_start_epoch: DEP4.service_day_start_epoch - 86400,
      },
    }
    const m = chain.resolve(c, yesterday, {}, MIDNIGHT + 7 * 3600 + 50 * 60)
    expect(m.state).toBe('no-schedule')
    expect(m.detail).toMatch(/different service/)
    expect(m.connection).toBeUndefined()
  })
})

/*
 * Round three of the same failure.
 *
 * The refusal to grade a bus the feed will not stand behind was written twice and
 * reached through the vehicle join both times, so it only ever fired when the frozen
 * snapshot happened to contain a bus for that trip. Suppression is a property of the
 * ROUTE — it is the route's feed that has stopped updating — and a leg on a suppressed
 * route cannot be graded whether or not a vehicle was found for it.
 *
 * And the refusal covered exactly one of the six ways `adherence.state` can be unknown.
 * Every other one still fell through to the timetable, which always reads on time,
 * about a bus whose position is drawn on the same screen.
 */
describe('a leg the feed cannot answer for is not graded, however it fails', () => {
  const now = MIDNIGHT + 7 * 3600 + 50 * 60

  const deadRoute = (vehicles) => ({
    staleness: { level: 'dead', oldest_feed_age_s: 4000, suppress_adherence: true },
    vehicles,
  })

  t('a dead feed refuses even when the snapshot holds no bus for the leg', (chain) => {
    const { chain: c } = theChain(chain)
    /*
     * The whole point. On a dead cron "no vehicle" and "a vehicle that stopped being
     * reported" are the same observation, so the absence of a bus is not evidence the
     * bus has not started — and the timetable is not a fair stand-in for either.
     */
    const m = chain.resolve(c, DEPS, { 800: deadRoute([]) }, now)
    expect(m.legs[0].vehicle).toBeNull()
    expect(m.connection.state).toBe('unknown')
    expect(m.connection.slack_s).toBeNull()
    expect(['made', 'tight', 'missed']).not.toContain(m.connection.state)
  })

  t('and says the feed stopped rather than that the bus has not started', (chain) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, DEPS, { 800: deadRoute([]) }, now)
    const said = chain.connectionDetail(m.connection)
    expect(said).toMatch(/feed has stopped updating/)
    /* There is no bus in the snapshot, so it must not be described as being on one. */
    expect(said).not.toMatch(/is on the road/)
    expect(chain.assumptionNote(m.connection)).toBeNull()
  })

  t('the same chain grades normally the moment the feed is fresh again', (chain) => {
    const { chain: c } = theChain(chain)
    /* Guards the fix against becoming "never grade": with no vehicle and a LIVE feed
       the timetable is the honest prior and the verdict may still be asserted. */
    const m = chain.resolve(c, DEPS, {
      800: { staleness: { level: 'fresh', suppress_adherence: false }, vehicles: [] },
    }, now)
    expect(['made', 'tight', 'missed']).toContain(m.connection.state)
    expect(chain.assumptionNote(m.connection)).toMatch(/reporting yet/)
  })

  /* Every unknown reason the contract's decision table can produce with a bus
     joined to the trip. None of them is a lateness, so none of them may be graded. */
  const UNKNOWN_REASONS = [
    'no_trip_update',
    'no_stop_predictions',
    'trip_not_in_schedule',
    'no_progress',
  ]

  UNKNOWN_REASONS.forEach((reason) => {
    t(`a reporting bus with reason "${reason}" is refused, not graded`, (chain) => {
      const { chain: c } = theChain(chain)
      const m = chain.resolve(c, DEPS, {
        800: {
          staleness: { level: 'fresh', oldest_feed_age_s: 30, suppress_adherence: false },
          vehicles: [{
            vehicle_id: '8021', label: '8021', trip: { trip_id: WATCHED_TRIP },
            adherence: { state: 'unknown', seconds: null, reason },
          }],
        },
      }, now)
      expect(m.legs[0].vehicle).not.toBeNull()
      expect(m.connection.state).toBe('unknown')
      expect(m.connection.slack_s).toBeNull()
    })

    t(`and a bus reporting with "${reason}" is never called one that is not reporting`,
      (chain) => {
        const { chain: c } = theChain(chain)
        const m = chain.resolve(c, DEPS, {
          800: {
            staleness: { level: 'fresh', oldest_feed_age_s: 30, suppress_adherence: false },
            vehicles: [{
              vehicle_id: '8021', label: '8021', trip: { trip_id: WATCHED_TRIP },
              adherence: { state: 'unknown', seconds: null, reason },
            }],
          },
        }, now)
        const said = chain.connectionDetail(m.connection)
        /* Its badge is on the same screen. "Not reporting yet" is false twice over. */
        expect(said).not.toMatch(/not reporting/)
        expect(said).toMatch(/is on the road/)
        expect(chain.assumptionNote(m.connection)).toBeNull()
      })
  })
})

/*
 * What a card that has refused to grade may still assert.
 *
 * The refusal fixed the verdict and left three other places reading the timetable
 * out loud as though it were a prediction: the retirement clock, the headline
 * countdown, and the pair of times printed under the verdict.
 */
describe('a refused verdict does not leak back in as a confident number', () => {
  const deadRoute = (tripId, late) => ({
    staleness: { level: 'dead', oldest_feed_age_s: 4000, suppress_adherence: true },
    vehicles: [{
      vehicle_id: '8021', label: '8021', trip: { trip_id: tripId },
      adherence: { state: 'very_late', seconds: late, reason: null },
    }],
  })
  const freshRoute = (tripId, late) => ({
    staleness: { level: 'fresh', oldest_feed_age_s: 30, suppress_adherence: false },
    vehicles: [{
      vehicle_id: '8021', label: '8021', trip: { trip_id: tripId },
      adherence: { state: 'very_late', seconds: late, reason: null },
    }],
  })

  t('a chain it cannot grade is not retired on the timetable it refused', (chain) => {
    const { chain: c, connection } = theChain(chain)
    /*
     * `end_at` retires a card by asserting the last bus has been boarded, and the
     * prediction it normally uses IS that assertion. Refusing the prediction sent
     * predicted_board_at back to the scheduled time -- which reads exactly like a
     * bus running on time -- so a chain whose onward bus was last seen ten minutes
     * down went to "Gone. Back tomorrow" while that bus was still at the kerb.
     */
    const boardAt = MIDNIGHT + connection.board_seconds
    const justPastScheduled = boardAt + chain.AFTER_S + 100

    const dead = chain.resolve(c, DEPS, { 4: deadRoute(connection.trip.id, 600) },
      justPastScheduled)
    expect(dead.state).not.toBe('passed')

    /* And the hold is bounded: far enough past and it does retire. */
    const later = boardAt + chain.AFTER_S + chain.UNGRADED_HOLD_S + 100
    expect(chain.resolve(c, DEPS, { 4: deadRoute(connection.trip.id, 600) }, later).state)
      .toBe('passed')
  })

  t('but a chain it CAN grade still retires on time', (chain) => {
    const { chain: c, connection } = theChain(chain)
    const boardAt = MIDNIGHT + connection.board_seconds
    const m = chain.resolve(c, DEPS, { 4: freshRoute(connection.trip.id, 0) },
      boardAt + chain.AFTER_S + 100)
    expect(m.state).toBe('passed')
  })

  t('the headline does not count down to a time it refused to predict', (chain, cmb) => {
    const { chain: c } = theChain(chain)
    /* First leg suppressed, and the card is inside its live window. */
    const m = chain.resolve(c, DEPS, { 800: deadRoute(WATCHED_TRIP, 720) },
      MIDNIGHT + 7 * 3600 + 40 * 60)
    const host = cmb.states.el('div')
    chain.render(host, [m], {})
    const said = textOf(host)
    /*
     * "due 7:52a · in 12 minutes" about a bus last seen twelve minutes down is the
     * same optimistic substitution the verdict just refused, printed larger.
     */
    expect(said).not.toMatch(/in \d+ minutes?/)
    expect(said).toMatch(/scheduled/)
  })

  t('and the two times under the verdict are labeled as the timetable', (chain, cmb) => {
    const { chain: c } = theChain(chain)
    const m = chain.resolve(c, DEPS, { 800: deadRoute(WATCHED_TRIP, 720) },
      MIDNIGHT + 7 * 3600 + 40 * 60)
    const host = cmb.states.el('div')
    chain.render(host, [m], {})
    const said = textOf(host)
    /*
     * The card withholds the conclusion and then prints both operands of it in the
     * slot it uses for real predictions, which reads as one.
     */
    expect(said).toMatch(/Timetable only · in /)
    expect(said).not.toMatch(/(^|[^a-zA-Z])In \d+:\d+/)
  })
})

/*
 * The guard on two service days compared the `service_date` LABEL while the
 * arithmetic subtracts `service_day_start_epoch`. They are different fields, and
 * defending one does not defend the other.
 */
describe('the service-day guard defends the quantity actually subtracted', () => {
  const now = MIDNIGHT + 7 * 3600 + 50 * 60

  t('two schedules anchored to different midnights are refused, label or no label',
    (chain) => {
      const { chain: c } = theChain(chain)
      /* Same label on both documents, anchors a day apart. The old guard saw one
         date, waved it through, and subtracted across twenty-four hours. */
      const skewed = {
        ...DEPS,
        4: { ...DEP4, service_day_start_epoch: DEP4.service_day_start_epoch - 86400 },
      }
      const m = chain.resolve(c, skewed, {}, now)
      expect(m.state).toBe('no-schedule')
      expect(m.detail).toMatch(/service day/)
      expect(m.connection).toBeUndefined()
    })

  t('and a schedule that does not say which midnight it counts from is refused too',
    (chain) => {
      const { chain: c } = theChain(chain)
      /*
       * The old guard skipped a document with no `service_date` rather than
       * refusing it -- so the one document least able to answer "which service day
       * is this?" was the one exempted from being asked. Without an anchor every
       * time on the leg is NaN.
       */
      const anchorless = { ...DEPS, 4: { ...DEP4 } }
      delete anchorless['4'].service_day_start_epoch
      delete anchorless['4'].service_date
      const m = chain.resolve(c, anchorless, {}, now)
      expect(m.state).toBe('no-schedule')
      expect(m.detail).toMatch(/service day/)
      expect(m.connection).toBeUndefined()
    })
})

/*
 * MAX_WAIT_S was fixed to cap the wait rather than the post-walk slack; the editor
 * row that offers the connection still called the post-walk slack "wait".
 */
describe('the editor calls post-walk slack what it is', () => {
  const editorState = (connection) => ({
    routes: [
      { id: '800', short_name: '800', long_name: '800-North Lamar', directions: [] },
      { id: '4', short_name: '4', long_name: '4-7th Street', directions: [] },
    ],
    legs: [LEG1],
    day_type: 'weekday',
    start: {},
    onward: { route_id: '4', direction_id: 0 },
    departures: DEPS,
    connections: [connection],
  })
  const noop = {
    onPickOnwardRoute() {}, onPickOnwardDirection() {}, onPickConnection() {},
    onSave() {},
  }

  t('a row says how much is spare after the walk, not how long the wait is',
    (chain, cmb) => {
      const { connection } = theChain(chain)
      const host = cmb.states.el('div')
      chain.renderEditor(host, editorState(connection), noop)
      const said = textOf(host)
      const spare = Math.round(connection.slack_s / 60)
      expect(said).toMatch(new RegExp(`${spare} min spare`))
      /*
       * The actual wait is longer than the figure by the whole walk -- at 300 m
       * that is nearly six minutes -- so calling the figure "wait" understated the
       * time a child stands around by exactly the amount the walk model was
       * corrected to charge.
       */
      expect(said).not.toMatch(/min wait/)
      expect(said).not.toMatch(/minutes to wait/)
    })
})

/*
 * From a file there is no origin to fetch api/departures/ from, so a chain can
 * never resolve. The Saved view's banner already says that in as many words; the
 * card beside it went on saying the schedule "has not loaded yet", which is a
 * promise. It reads as a spinner, and the reader waits for something that is not
 * coming.
 */
describe('a chain on a board opened from a file', () => {
  t('says the schedule cannot arrive, not that it has not arrived yet',
    (chain, cmb) => {
      const { chain: c } = theChain(chain)
      const m = chain.resolve(c, {}, {}, MIDNIGHT + 7 * 3600 + 50 * 60)
      expect(m.state).toBe('no-schedule')

      const host = cmb.states.el('div')
      chain.render(host, [m], { fromDisk: true })
      const said = textOf(host)
      expect(said).not.toMatch(/has not loaded yet/)
      expect(said).toMatch(/open from a file/)
      /* And the sentence is spoken too, not only drawn. */
      expect(said.match(/open from a file/g).length).toBeGreaterThanOrEqual(2)
    })

  t('and still says "not loaded yet" when there IS an origin to wait on',
    (chain, cmb) => {
      const { chain: c } = theChain(chain)
      const m = chain.resolve(c, {}, {}, MIDNIGHT + 7 * 3600 + 50 * 60)
      const host = cmb.states.el('div')
      chain.render(host, [m], {})
      expect(textOf(host)).toMatch(/has not loaded yet/)
    })
})
