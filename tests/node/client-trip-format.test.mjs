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
