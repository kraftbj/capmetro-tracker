/**
 * Contract section 4: block continuation confidence.
 *
 * The feature that motivated the whole app is "this eastbound bus becomes your
 * westbound one". It is verified on route 4 only, so everywhere else the grade
 * has to be honest: presenting a guessed continuation as fact is worse than
 * showing none, because a rider acts on it.
 */
import { describe, expect, it } from 'vitest'
import { gate, optionalModule } from './helpers/optional.mjs'
import { goldenRoute4 } from './helpers/fixtures.mjs'

const blocks = await optionalModule('build/lib/blocks.mjs')
const t = gate(blocks, ['buildBlockChains'], it)

const STOPS = new Map([
  ['1368', { stop_id: '1368', stop_name: 'Pleasant Valley/5th', lat: 30.257443, lon: -97.710596 }],
  // ~111 m north: the paired directional stop across the street.
  ['3337', { stop_id: '3337', stop_name: '7th/Pleasant Valley', lat: 30.258443, lon: -97.710596 }],
  // ~400 m north: a different corner entirely.
  ['9999', { stop_id: '9999', stop_name: 'Somewhere Else', lat: 30.261043, lon: -97.710596 }],
])

const trip = (over = {}) => ({
  trip_id: 'A',
  route_id: '4',
  service_id: '3-172',
  direction_id: 1,
  block_id: '4004',
  first_stop_id: '1368',
  first_arrival_s: 36000,
  last_stop_id: '1368',
  last_departure_s: 39000,
  ...over,
})

/** Grade the pair (predecessor, successor) and return the predecessor's chain entry. */
function grade(successorOver = {}, predecessorOver = {}) {
  const pred = trip({ trip_id: 'A', ...predecessorOver })
  const succ = trip({
    trip_id: 'B',
    direction_id: 0,
    first_arrival_s: 39780, // 13-minute layover
    ...successorOver,
  })
  const { chains } = blocks.mod.buildBlockChains({ trips: [pred, succ], stops: STOPS })
  return chains.get('A')
}

describe('a continuation is graded high only when all three conditions hold', () => {
  t('grades a same-route, same-stop, thirteen-minute layover as high', () => {
    expect(grade().confidence).toBe('high')
  })

  t('grades a paired directional stop across the street as high, since it is inside 150 metres', () => {
    const result = grade({ first_stop_id: '3337' })
    expect(result.handoff_distance_m).toBeLessThanOrEqual(150)
    expect(result.confidence).toBe('high')
  })

  t('grades a successor stop 400 metres away as low', () => {
    const result = grade({ first_stop_id: '9999' })
    expect(result.confidence).toBe('low')
    expect(result.grade_reasons).toContain('stops_too_far_apart')
  })

  t('grades a twenty-second layover as low, because that is a data artefact and not a layover', () => {
    const result = grade({ first_arrival_s: 39020 })
    expect(result.confidence).toBe('low')
    expect(result.grade_reasons).toContain('layover_too_short')
  })

  t('grades a forty-five-minute layover as low, because the bus has probably been reassigned', () => {
    const result = grade({ first_arrival_s: 39000 + 2700 })
    expect(result.confidence).toBe('low')
    expect(result.grade_reasons).toContain('layover_too_long')
  })

  t('accepts the exact layover boundaries the contract names as inclusive', () => {
    expect(grade({ first_arrival_s: 39000 + 60 }).confidence).toBe('high')
    expect(grade({ first_arrival_s: 39000 + 1800 }).confidence).toBe('high')
  })

  t('grades a successor on another route as low, because interlining is unverified', () => {
    const result = grade({ route_id: '663' })
    expect(result.confidence).toBe('low')
    expect(result.grade_reasons).toContain('successor_on_different_route')
  })

  t('grades a trip with no block_id as low rather than chaining it on a guess', () => {
    const { chains } = blocks.mod.buildBlockChains({ trips: [trip({ block_id: null })], stops: STOPS })
    const entry = chains.get('A')
    expect(entry.confidence).toBe('low')
    expect(entry.next_trip).toBeNull()
    expect(entry.grade_reasons).toContain('missing_block_id')
  })
})

describe('the last trip of a block is a confident statement, not an uncertain one', () => {
  t('grades a chain of one as high with a null next_trip', () => {
    const { chains } = blocks.mod.buildBlockChains({ trips: [trip()], stops: STOPS })
    expect(chains.get('A')).toMatchObject({ confidence: 'high', next_trip: null })
  })
})

describe('chains are keyed on block and service together, not block alone', () => {
  t('does not chain two trips that share a block_id but run on different service days', () => {
    // CapMetro reuses block ids across all eight service variants. Grouping on
    // block_id alone interleaves them and produces negative layovers.
    const { chains, stats } = blocks.mod.buildBlockChains({
      trips: [trip({ trip_id: 'A', service_id: '3-172' }), trip({ trip_id: 'B', service_id: '9-172', first_arrival_s: 39780 })],
      stops: STOPS,
    })
    expect(chains.get('A').next_trip).toBeNull()
    expect(stats.negative_layovers).toBe(0)
  })

  t('produces no negative layover from a well-formed chain', () => {
    const { stats } = blocks.mod.buildBlockChains({
      trips: [trip({ trip_id: 'A' }), trip({ trip_id: 'B', first_arrival_s: 39780 })],
      stops: STOPS,
    })
    expect(stats.negative_layovers).toBe(0)
  })
})

describe('the direction flip is what the whole feature exists to show', () => {
  t('marks a successor in the opposite direction as a flip', () => {
    expect(grade().next_trip.is_direction_flip).toBe(true)
  })

  t('does not mark a successor continuing the same direction as a flip', () => {
    expect(grade({ direction_id: 1 }).next_trip.is_direction_flip).toBe(false)
  })

  t('renders an after-midnight successor start time without wrapping it at 24:00', () => {
    const result = grade({ first_arrival_s: 25 * 3600 + 10 * 60 }, { last_departure_s: 25 * 3600 })
    expect(result.next_trip.start_time).toBe('25:10:00')
  })
})

describe('the golden route 4 output already carries the continuations the contract promises', () => {
  const golden = goldenRoute4()

  it('names at least one next trip that flips direction', () => {
    const flip = golden.vehicles.find((v) => v.block?.next_trip?.is_direction_flip)
    expect(flip).toBeDefined()
    expect(flip.block.confidence).toBe('high')
    expect(flip.block.next_trip.start_stop_name).toBeTruthy()
    expect(flip.block.next_trip.start_epoch).toBeGreaterThan(flip.trip.start_epoch)
    expect(flip.block.next_trip.direction_id).not.toBe(flip.trip.direction_id)
  })

  it('never carries a next_trip without a confidence grade', () => {
    for (const v of golden.vehicles) {
      if (!v.block) continue
      expect(['high', 'low']).toContain(v.block.confidence)
    }
  })
})
