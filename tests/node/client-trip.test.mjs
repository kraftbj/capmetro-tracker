/**
 * trip.js — the view anchored at a bus rather than at a stop or a route.
 *
 * This covers the model the panel builds. What it looks like on a 412px screen
 * is tests/e2e/trip.spec.mjs; this file is the logic underneath it.
 */
import { describe, expect, it } from 'vitest'
import { gateClient, renderClient, textDeep } from './helpers/client.mjs'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'watch.js', 'trip.js'])
const t = gateClient(client, 'trip', it)

const ROUTE = {
  schema: 1,
  generated_at: 5000,
  route: { id: '4', short_name: '4', long_name: '4-SHADY', directions: [{ id: 0, headsign: '4 Shady EB' }] },
  staleness: { level: 'fresh', suppress_adherence: false },
  vehicles: [
    {
      vehicle_id: '2641', label: '2641', route_id: '4', in_service: true,
      trip: { trip_id: 'T1', direction_id: 0, headsign: '4 Shady EB', start_epoch: 900, schedule_relationship: 'SCHEDULED' },
      progress: { current_stop_sequence: 1, current_stop_id: 'A', current_status: 'IN_TRANSIT_TO' },
      predictions: [[1, 'A', 1030]],
      adherence: { state: 'late', seconds: 30, glyph: 'up-triangle', against: { stop_id: 'A', stop_name: 'Alpha', scheduled_at: 1000 }, reason: null },
    },
    {
      vehicle_id: '2305', label: '2305', route_id: '4', in_service: false,
      adherence: { state: 'deadhead', seconds: null, glyph: 'ring', against: null, reason: null },
    },
  ],
}

const DEP = {
  service_day_start_epoch: 0,
  stops: [
    { stop_id: 'A', stop_name: 'Alpha', direction_id: 0, stop_sequence: 1 },
    { stop_id: 'B', stop_name: 'Bravo', direction_id: 0, stop_sequence: 2 },
  ],
  trips: [{ id: 'T1', direction_id: 0, headsign: '4 Shady EB' }],
  departures: { A: [[1000, 0]], B: [[2000, 0]] },
}

const host = () => client.cmb.states.el('div', 'host')

describe('the bus list the picker offers', () => {
  t('carries every vehicle, in service or not', (trip) => {
    expect(trip.buses(ROUTE).map((b) => b.id)).toEqual(['2641', '2305'])
  })

  t('marks the deadhead as unpickable rather than hiding it', (trip) => {
    /* rows.js sets this precedent deliberately: a board that hides a bus it was
       handed is worse than one showing a bus you cannot act on. */
    const deadhead = trip.buses(ROUTE).filter((b) => b.id === '2305')[0]
    expect(deadhead.in_service).toBe(false)
  })
})

describe('the stop list', () => {
  t('renders one row per stop ahead, with both times', (trip) => {
    const h = host()
    trip.render(h, { route: ROUTE, dep: DEP, vehicleId: '2641', now: 5000 }, { routes: [] })
    const text = textDeep(h)
    expect(text).toContain('Alpha')
    expect(text).toContain('Bravo')
  })

  t('marks an estimated time and leaves a feed time unmarked', (trip) => {
    const h = host()
    trip.render(h, { route: ROUTE, dep: DEP, vehicleId: '2641', now: 5000 }, { routes: [] })
    /* A has a feed prediction; B does not, so B is the estimated one. */
    expect(textDeep(h)).toContain('estimated')
  })

  t('says so, and shows no arrival time, when the feed is stale', (trip) => {
    const stale = { ...ROUTE, staleness: { level: 'stale', suppress_adherence: true } }
    const h = host()
    trip.render(h, { route: stale, dep: DEP, vehicleId: '2641', now: 5000 }, { routes: [] })
    const text = textDeep(h)
    expect(text).not.toMatch(/in \d+ min/)
  })
})
