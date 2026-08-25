/**
 * fmt.stopTimesForTrip / stopsAheadOf / arrivalPlan — the trip view's whole join.
 *
 * Each case here is a measured fact from docs/designs/trip-view.md, not a
 * hypothetical. The corpus these numbers come from is the 2026-08-19 capture
 * across all 71 routes; tests/node/trip-corpus.test.mjs re-checks them against
 * real generated output.
 */
import { describe, expect, it } from 'vitest'
import { gateClient, loadClient } from './helpers/client.mjs'

const client = loadClient(['format.js'])
const t = gateClient(client, 'fmt', it)

/* A departures document shaped exactly like contract section 16. */
const DEP = {
  service_day_start_epoch: 1000000,
  stops: [
    { stop_id: 'A', stop_name: 'Alpha', direction_id: 0, stop_sequence: 1 },
    { stop_id: 'B', stop_name: 'Bravo', direction_id: 0, stop_sequence: 2 },
    { stop_id: 'C', stop_name: 'Charlie', direction_id: 0, stop_sequence: 3 },
    { stop_id: 'B', stop_name: 'Bravo NB', direction_id: 1, stop_sequence: 9 },
  ],
  trips: [
    { id: 'T1', direction_id: 0, headsign: 'one', start_time: '00:00:00' },
    { id: 'T2', direction_id: 1, headsign: 'two', start_time: '00:10:00' },
  ],
  departures: {
    A: [[0, 0]],
    B: [[60, 0], [600, 1]],
    C: [[120, 0]],
  },
}

describe('stopTimesForTrip', () => {
  t('returns the trip in arrival order with absolute scheduled times', (fmt) => {
    expect(fmt.stopTimesForTrip(DEP, 'T1')).toEqual([
      { stop_id: 'A', stop_name: 'Alpha', scheduled_at: 1000000, ordinal: 0 },
      { stop_id: 'B', stop_name: 'Bravo', scheduled_at: 1000060, ordinal: 1 },
      { stop_id: 'C', stop_name: 'Charlie', scheduled_at: 1000120, ordinal: 2 },
    ])
  })

  t('names a stop from the trip’s own direction, not the other one', (fmt) => {
    /* Stop B is published twice, once per direction, with different names.
       T2 runs direction 1, so it must read "Bravo NB". */
    expect(fmt.stopTimesForTrip(DEP, 'T2')[0].stop_name).toBe('Bravo NB')
  })

  t('orders by arrival time, never by stops[].stop_sequence', (fmt) => {
    /* On 2,221 of 4,112 trips the consensus sequence disagrees with arrival
       order. Here D carries a LOWER stop_sequence than E but is reached later,
       which is the shape of that disagreement. */
    const dep = {
      service_day_start_epoch: 0,
      stops: [
        { stop_id: 'D', stop_name: 'Delta', direction_id: 0, stop_sequence: 2 },
        { stop_id: 'E', stop_name: 'Echo', direction_id: 0, stop_sequence: 40 },
      ],
      trips: [{ id: 'S', direction_id: 0 }],
      departures: { D: [[900, 0]], E: [[300, 0]] },
    }
    expect(fmt.stopTimesForTrip(dep, 'S').map((s) => s.stop_id)).toEqual(['E', 'D'])
  })

  t('keeps both passes of a trip that visits one stop twice', (fmt) => {
    /* 234 trips in the corpus do this; 16 had a live bus on them. */
    const dep = {
      service_day_start_epoch: 0,
      stops: [{ stop_id: 'L', stop_name: 'Loop', direction_id: 0, stop_sequence: 1 }],
      trips: [{ id: 'S', direction_id: 0 }],
      departures: { L: [[100, 0], [500, 0]] },
    }
    const stops = fmt.stopTimesForTrip(dep, 'S')
    expect(stops).toHaveLength(2)
    expect(stops.map((s) => s.scheduled_at)).toEqual([100, 500])
    expect(stops.map((s) => s.ordinal)).toEqual([0, 1])
  })

  t('returns null when service_day_start_epoch is null', (fmt) => {
    /* Contract section 16: a client that sees null must not compute absolute
       times from this document. */
    expect(fmt.stopTimesForTrip({ ...DEP, service_day_start_epoch: null }, 'T1')).toBeNull()
  })

  t('returns null for a trip the document does not carry', (fmt) => {
    expect(fmt.stopTimesForTrip(DEP, 'nope')).toBeNull()
  })

  t('returns null rather than throwing on a missing document', (fmt) => {
    expect(fmt.stopTimesForTrip(null, 'T1')).toBeNull()
    expect(fmt.stopTimesForTrip({}, 'T1')).toBeNull()
  })
})

const TRIP = [
  { stop_id: 'A', stop_name: 'Alpha', scheduled_at: 1000, ordinal: 0 },
  { stop_id: 'B', stop_name: 'Bravo', scheduled_at: 2000, ordinal: 1 },
  { stop_id: 'C', stop_name: 'Charlie', scheduled_at: 3000, ordinal: 2 },
]

const busAt = (stopId, scheduledAt) => ({
  in_service: true,
  trip: { trip_id: 'T1', schedule_relationship: 'SCHEDULED' },
  adherence: { state: 'late', seconds: 60, against: { stop_id: stopId, scheduled_at: scheduledAt } },
  predictions: [],
})

describe('stopsAheadOf', () => {
  t('cuts at the anchor and keeps it', (fmt) => {
    /* A bus STOPPED_AT your stop is still an arrival you can board, so the
       anchor stop itself stays in the list. */
    const out = fmt.stopsAheadOf(TRIP, busAt('B', 2000))
    expect(out.anchored).toBe(true)
    expect(out.stops.map((s) => s.stop_id)).toEqual(['B', 'C'])
  })

  t('cuts on stop_id AND scheduled_at, so a repeat stop cuts at the right pass', (fmt) => {
    /* Measured: all 249 live anchors match a departures row on both halves of
       this key, and one of them sits on a trip that visits its stop twice. */
    const loop = [
      { stop_id: 'L', stop_name: 'Loop', scheduled_at: 1000, ordinal: 0 },
      { stop_id: 'M', stop_name: 'Mid', scheduled_at: 2000, ordinal: 1 },
      { stop_id: 'L', stop_name: 'Loop', scheduled_at: 3000, ordinal: 2 },
    ]
    const out = fmt.stopsAheadOf(loop, busAt('L', 3000))
    expect(out.stops.map((s) => s.ordinal)).toEqual([2])
  })

  t('reports anchored false and keeps the whole trip when there is no anchor', (fmt) => {
    const noAnchor = { in_service: true, trip: { trip_id: 'T1' }, adherence: { state: 'unknown', seconds: null, against: null } }
    const out = fmt.stopsAheadOf(TRIP, noAnchor)
    expect(out.anchored).toBe(false)
    expect(out.stops).toHaveLength(3)
  })

  t('reports anchored false when the anchor is not in the trip', (fmt) => {
    const out = fmt.stopsAheadOf(TRIP, busAt('Z', 9999))
    expect(out.anchored).toBe(false)
    expect(out.stops).toHaveLength(3)
  })

  t('returns null when there is no trip to cut', (fmt) => {
    expect(fmt.stopsAheadOf(null, busAt('B', 2000))).toBeNull()
  })

  t('does not mutate the list it was given', (fmt) => {
    const before = JSON.stringify(TRIP)
    fmt.stopsAheadOf(TRIP, busAt('B', 2000))
    expect(JSON.stringify(TRIP)).toBe(before)
  })
})

const AHEAD = { anchored: true, stops: TRIP }

const bus = (over) => ({
  in_service: true,
  trip: { trip_id: 'T1', schedule_relationship: 'SCHEDULED' },
  adherence: { state: 'late', seconds: 60, against: { stop_id: 'A', scheduled_at: 1000 } },
  predictions: [],
  ...over,
})

describe('arrivalPlan', () => {
  t('uses the feed’s own time where the feed has one', (fmt) => {
    const plan = fmt.arrivalPlan(AHEAD, bus({ predictions: [[1, 'A', 1030], [2, 'B', 2090]] }), null)
    expect(plan.reason).toBeNull()
    expect(plan.rows.slice(0, 2).map((r) => [r.predicted_at, r.source]))
      .toEqual([[1030, 'feed'], [2090, 'feed']])
  })

  t('carries forward the deviation from the LAST feed row, not the anchor', (fmt) => {
    /* The anchor says +60. The feed's last row says +90 at B. C must be
       3000+90, not 3000+60. This is the whole point of the chosen rule: the
       two answers differ by more than a minute on 76.5% of estimated stops. */
    const plan = fmt.arrivalPlan(AHEAD, bus({ predictions: [[1, 'A', 1030], [2, 'B', 2090]] }), null)
    expect(plan.rows[2]).toMatchObject({ stop_id: 'C', predicted_at: 3090, source: 'estimate' })
  })

  t('falls back to the anchor deviation before any feed row is seen', (fmt) => {
    const plan = fmt.arrivalPlan(AHEAD, bus({ predictions: [[3, 'C', 3120]] }), null)
    expect(plan.rows.map((r) => [r.predicted_at, r.source])).toEqual([
      [1060, 'estimate'],
      [2060, 'estimate'],
      [3120, 'feed'],
    ])
  })

  t('distinguishes the two passes of a repeat stop', (fmt) => {
    const loop = {
      anchored: true,
      stops: [
        { stop_id: 'L', stop_name: 'Loop', scheduled_at: 1000, ordinal: 0 },
        { stop_id: 'M', stop_name: 'Mid', scheduled_at: 2000, ordinal: 1 },
        { stop_id: 'L', stop_name: 'Loop', scheduled_at: 3000, ordinal: 2 },
      ],
    }
    const v = bus({ predictions: [[1, 'L', 1010], [2, 'M', 2020], [3, 'L', 3030]] })
    expect(fmt.arrivalPlan(loop, v, null).rows.map((r) => r.predicted_at))
      .toEqual([1010, 2020, 3030])
  })

  t('does not stall when a prediction names a stop the trip does not list', (fmt) => {
    /* Measured 0/4,525 in the corpus, but a stalled cursor would silently drop
       every later feed row, which is a bad way to be wrong. */
    const v = bus({ predictions: [[9, 'ZZZ', 1234], [2, 'B', 2090]] })
    const plan = fmt.arrivalPlan(AHEAD, v, null)
    expect(plan.rows[1]).toMatchObject({ stop_id: 'B', predicted_at: 2090, source: 'feed' })
  })

  t('produces times that never go backwards', (fmt) => {
    const v = bus({ predictions: [[1, 'A', 1030], [2, 'B', 2090]] })
    const times = fmt.arrivalPlan(AHEAD, v, null).rows.map((r) => r.predicted_at)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
  })

  const noTimes = (plan, reason) => {
    expect(plan.reason).toBe(reason)
    expect(plan.rows).toHaveLength(3)
    expect(plan.rows.every((r) => r.predicted_at === null && r.source === null)).toBe(true)
    expect(plan.rows.map((r) => r.scheduled_at)).toEqual([1000, 2000, 3000])
  }

  t('publishes no arrival time at all when the feed is stale', (fmt) => {
    const v = bus({ predictions: [[1, 'A', 1030]] })
    noTimes(fmt.arrivalPlan(AHEAD, v, { suppress_adherence: true }), 'stale_data')
  })

  t('publishes no arrival time at all for a canceled trip', (fmt) => {
    const v = bus({ trip: { trip_id: 'T1', schedule_relationship: 'CANCELED' }, predictions: [[1, 'A', 1030]] })
    noTimes(fmt.arrivalPlan(AHEAD, v, null), 'trip_canceled')
  })

  t('publishes no arrival time at all when the bus could not be located', (fmt) => {
    noTimes(fmt.arrivalPlan({ anchored: false, stops: TRIP }, bus({}), null), 'no_anchor')
  })

  t('publishes no arrival time at all when there is no deviation to carry', (fmt) => {
    const v = bus({ adherence: { state: 'unknown', seconds: null, against: { stop_id: 'A', scheduled_at: 1000 } } })
    noTimes(fmt.arrivalPlan(AHEAD, v, null), 'no_adherence')
  })

  t('publishes no arrival time at all when the prediction list is empty', (fmt) => {
    /* Section 2: the list is empty, never absent, when the board cannot stand
       behind a time. An empty list is a statement, not a gap to fill in. */
    noTimes(fmt.arrivalPlan(AHEAD, bus({ predictions: [] }), null), 'no_predictions')
  })
})

/*
 * The memo behind stopTimesForTrip.
 *
 * Building one stop list is a full scan of dep.departures, and stopboard.js asks
 * for one per rendered row, so the result is cached against the document it came
 * from. Caching a time is a good way to render a stale one, so the invariant
 * that makes it safe is pinned here rather than left to a comment: a DIFFERENT
 * document must never be served another document's answer.
 *
 * What is deliberately NOT tested is mutating a document in place, or writing to
 * a returned row. Both would return something stale, and nothing in client/ does
 * either -- app.js assigns each departures document exactly once per route per
 * session, stopsAheadOf slices, and arrivalPlan maps into fresh objects. A test
 * asserting the broken behavior of an unreachable path would only make that path
 * look supported.
 */
describe('stopTimesForTrip caching', () => {
  t('serves a second document its own answer, not the first one’s', (fmt) => {
    const a = {
      service_day_start_epoch: 0,
      stops: [{ stop_id: 'A', stop_name: 'Alpha', direction_id: 0, stop_sequence: 1 }],
      trips: [{ id: 'SAME', direction_id: 0 }],
      departures: { A: [[100, 0]] },
    }
    const b = {
      service_day_start_epoch: 0,
      stops: [{ stop_id: 'B', stop_name: 'Bravo', direction_id: 0, stop_sequence: 1 }],
      trips: [{ id: 'SAME', direction_id: 0 }],
      departures: { B: [[900, 0]] },
    }
    /* Same trip id in both, which is what a naive trip-keyed cache gets wrong. */
    expect(fmt.stopTimesForTrip(a, 'SAME').map((s) => s.stop_id)).toEqual(['A'])
    expect(fmt.stopTimesForTrip(b, 'SAME').map((s) => s.stop_id)).toEqual(['B'])
    expect(fmt.stopTimesForTrip(a, 'SAME').map((s) => s.stop_id)).toEqual(['A'])
  })

  t('repeats a null for a trip the document does not carry', (fmt) => {
    /* Cached as null, not as absent: a miss costs the same full scan as a hit,
       and `in` distinguishes the two where a truthiness check would not. */
    const dep = {
      service_day_start_epoch: 0,
      stops: [{ stop_id: 'A', stop_name: 'Alpha', direction_id: 0, stop_sequence: 1 }],
      trips: [{ id: 'REAL', direction_id: 0 }],
      departures: { A: [[100, 0]] },
    }
    expect(fmt.stopTimesForTrip(dep, 'GHOST')).toBeNull()
    expect(fmt.stopTimesForTrip(dep, 'REAL')).toHaveLength(1)
    expect(fmt.stopTimesForTrip(dep, 'GHOST')).toBeNull()
  })

  t('is not confused by a trip id that collides with Object prototype keys', (fmt) => {
    const dep = {
      service_day_start_epoch: 0,
      stops: [{ stop_id: 'A', stop_name: 'Alpha', direction_id: 0, stop_sequence: 1 }],
      trips: [{ id: '__proto__', direction_id: 0 }],
      departures: { A: [[100, 0]] },
    }
    expect(fmt.stopTimesForTrip(dep, '__proto__').map((s) => s.stop_id)).toEqual(['A'])
    expect(fmt.stopTimesForTrip(dep, '__proto__').map((s) => s.stop_id)).toEqual(['A'])
  })
})
