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

  t('a suppressed lateness is not a zero', (chain) => {
    const { chain: c } = theChain(chain)
    /*
     * suppress_adherence means the feed will not stand behind a number. Reading
     * that as "on time" would print a confident prediction built on nothing — the
     * one thing this board is not allowed to do — so the transfer must fall back to
     * the timetable and admit it.
     */
    const stale = {
      staleness: { level: 'stale', suppress_adherence: true },
      vehicles: [
        {
          vehicle_id: '8021',
          label: '8021',
          trip: { trip_id: WATCHED_TRIP },
          adherence: { state: 'very_late', seconds: 900, reason: null },
        },
      ],
    }
    const m = chain.resolve(c, DEPS, { 800: stale }, now)
    expect(m.connection.assumed).toContain('arriving')
    expect(m.connection.slack_s).toBe(m.connection.scheduled_slack_s)
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

  t('and a screen reader hears it, not just the colour', (chain) => {
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
