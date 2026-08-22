/**
 * Regression: a block split by direction across two co-active services chained NB to NB.
 * Found on 2026-08-21 from a screenshot: every route 837 northbound bus said its next run
 * was another northbound one, 2.5 hours later, on a route that runs every ~15 minutes.
 *
 * A service_id in this feed is NOT a service day. calendar_dates puts SEVERAL on one date,
 * and CapMetro splits a physical block across them by direction: block 837001 keeps its
 * northbound trips under 9-172 and its southbound trips under 5-172, and both run on a
 * Friday. Chaining on (block_id, service_id) therefore saw half a block and skipped the
 * return leg physically in between.
 *
 * Measured over the whole feed with a global trip table (blocks interline across routes, so
 * a per-route view is not enough to judge this): 92,418 of 539,513 published continuations
 * named the wrong successor — 17.1%. After the fix, 4, and those four are surfaced by the
 * build's own invariant warning rather than resolved silently.
 *
 * The error was self-reporting and was read as something else: skipping the return leg
 * inflates the gap it is graded on, so the wrong successors came out `low` with reasons
 * `layover_too_long` and `stops_too_far_apart`. For the 837 case the published handoff was
 * 88 minutes and 12 km; the true one is 32 minutes and 0 m.
 */
import { describe, expect, it } from 'vitest'
import { gate, optionalModule } from './helpers/optional.mjs'

const blocks = await optionalModule('build/lib/blocks.mjs')
const t = gate(blocks, ['buildBlockChains'], it)

/* Two stops 0 m apart: the handoff geometry is not what this file is about. */
const STOPS = new Map([
  ['A', { stop_id: 'A', stop_name: 'Terminal A', lat: 30.25, lon: -97.75 }],
  ['B', { stop_id: 'B', stop_name: 'Terminal B', lat: 30.25, lon: -97.75 }],
])

const trip = (id, serviceId, directionId, startS, endS) => ({
  trip_id: id,
  route_id: '837',
  service_id: serviceId,
  direction_id: directionId,
  block_id: '837001',
  first_stop_id: directionId === 1 ? 'A' : 'B',
  last_stop_id: directionId === 1 ? 'B' : 'A',
  first_arrival_s: startS,
  last_departure_s: endS,
})

/*
 * The real shape, minimised: one block, northbound trips on 9-172 and southbound on 5-172,
 * both active on the same date. 1-172 is a second weekday variant of the southbound half,
 * active on a different date — that is what makes the successor's id date-dependent.
 */
const TRIPS = [
  trip('NB_1700', '9-172', 1, 61200, 66600), //  17:00 -> 18:30 NB
  trip('SB_1837_fri', '5-172', 0, 67020, 72000), //  18:37 -> 20:00 SB, Friday variant
  trip('SB_1837_mon', '1-172', 0, 67020, 72000), //  18:37 -> 20:00 SB, Monday variant
  trip('NB_1933', '9-172', 1, 70380, 75600), //  19:33 -> 21:00 NB
]

const CALENDAR = [
  { service_id: '9-172', date: '20260821', exception_type: 1 },
  { service_id: '5-172', date: '20260821', exception_type: 1 },
  { service_id: '9-172', date: '20260824', exception_type: 1 },
  { service_id: '1-172', date: '20260824', exception_type: 1 },
]

const build = () =>
  blocks.mod.buildBlockChains({ trips: TRIPS, stops: STOPS, calendarDates: CALENDAR })

describe('a block split by direction across co-active services', () => {
  t('chains the northbound trip to the southbound run, not to the next northbound one', () => {
    const { chains } = build()
    const next = chains.get('NB_1700').next_trip
    expect(next).not.toBeNull()
    /* The bug: this was NB_1933, 2.5 hours later, in the same direction. */
    expect(next.direction_id).toBe(0)
    expect(next.start_time).toBe('18:37:00')
    expect(next.is_direction_flip).toBe(true)
  })

  t('grades the handoff on the real gap, not the one created by skipping a leg', () => {
    const { chains } = build()
    const rec = chains.get('NB_1700')
    /* 18:37 minus 18:30. Skipping the southbound leg made this 63 minutes. */
    expect(rec.layover_s).toBe(420)
    expect(rec.handoff_distance_m).toBe(0)
    expect(rec.grade_reasons).not.toContain('stops_too_far_apart')
    expect(rec.grade_reasons).not.toContain('layover_too_long')
    expect(rec.confidence).toBe('high')
  })

  t('carries the successor id for every service variant, because it is date-dependent', () => {
    const { chains } = build()
    const byService = chains.get('NB_1700').next_trip.trip_id_by_service
    /* Same run, minted once per variant: Friday's id is not Monday's. */
    expect(byService).toEqual({ '5-172': 'SB_1837_fri', '1-172': 'SB_1837_mon' })
  })

  t('keeps one chain per co-active set, not one per service', () => {
    const { blockMeta } = build()
    const meta = blockMeta.get('837001')
    expect(Object.keys(meta.chains).sort()).toEqual(['1-172+9-172', '5-172+9-172'])
    expect(meta.chains['5-172+9-172']).toEqual(['NB_1700', 'SB_1837_fri', 'NB_1933'])
  })

  t('does not report an invariant break when only the id varies', () => {
    expect(build().stats.invariant_breaks).toBe(0)
  })

  t('reports an invariant break when a successor genuinely differs across sets', () => {
    /*
     * The guard that stops this fix from hiding a worse problem. If a feed ever chains one
     * trip to successors that differ in WHEN they leave, publishing a single start_time
     * would be the same class of error this file exists to remove, so the build says so.
     */
    const skewed = TRIPS.map((x) =>
      x.trip_id === 'SB_1837_mon' ? { ...x, first_arrival_s: 68000 } : x
    )
    const { stats } = blocks.mod.buildBlockChains({
      trips: skewed,
      stops: STOPS,
      calendarDates: CALENDAR,
    })
    expect(stats.invariant_breaks).toBeGreaterThan(0)
  })
})
