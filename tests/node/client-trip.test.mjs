/**
 * trip.js — the view anchored at a bus rather than at a stop or a route.
 *
 * This covers the model the panel builds. What it looks like on a 412px screen
 * is tests/e2e/trip.spec.mjs; this file is the logic underneath it.
 */
import { describe, expect, it } from 'vitest'
import { all, gateClient, renderClient, textDeep } from './helpers/client.mjs'

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

const DEP_GAP = {
  service_day_start_epoch: 0,
  stops: [
    { stop_id: 'A', stop_name: 'Alpha', direction_id: 0, stop_sequence: 1 },
    { stop_id: 'B', stop_name: 'Bravo', direction_id: 0, stop_sequence: 2 },
    { stop_id: 'C', stop_name: 'Charlie', direction_id: 0, stop_sequence: 3 },
  ],
  trips: [{ id: 'T2', direction_id: 0, headsign: '4 Shady EB' }],
  departures: { A: [[1000, 0]], B: [[2000, 0]], C: [[3000, 0]] },
}

/* Feed coverage with an interior gap: predicted at A, not at B, predicted
   again at C. Measured on 9 of 249 buses in the 2026-08-19 capture. */
const ROUTE_GAP = {
  schema: 1,
  generated_at: 5000,
  route: { id: '4', short_name: '4', long_name: '4-SHADY', directions: [{ id: 0, headsign: '4 Shady EB' }] },
  staleness: { level: 'fresh', suppress_adherence: false },
  vehicles: [
    {
      vehicle_id: '9001', label: '9001', route_id: '4', in_service: true,
      trip: { trip_id: 'T2', direction_id: 0, headsign: '4 Shady EB', start_epoch: 900, schedule_relationship: 'SCHEDULED' },
      progress: { current_stop_sequence: 1, current_stop_id: 'A', current_status: 'IN_TRANSIT_TO' },
      predictions: [[1, 'A', 1030], [3, 'C', 3200]],
      adherence: { state: 'late', seconds: 30, glyph: 'up-triangle', against: { stop_id: 'A', stop_name: 'Alpha', scheduled_at: 1000 }, reason: null },
    },
  ],
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
    expect(text).toMatch(/no arrival times right now/i)
    /* No predicted time at all: no arrow pairing it with the scheduled time,
       no '~' marking a projection, and no predicted-time span in the tree. */
    expect(text).not.toContain('→')
    expect(text).not.toContain('~')
    expect(all(h, 'tripstop__pred')).toHaveLength(0)
  })

  t('marks both directions when feed coverage has an interior gap', (trip) => {
    /* feed (A) -> estimate (B) -> feed (C). A latch that only ever fires once
       would mark the first transition and leave C silently unmarked as if it
       were still estimated. */
    const h = host()
    trip.render(h, { route: ROUTE_GAP, dep: DEP_GAP, vehicleId: '9001', now: 500 }, { routes: [] })
    const dividers = all(h, 'tripstops__divider').map((n) => textDeep(n))
    expect(dividers).toEqual(['Estimated stops begin here', 'CapMetro’s times begin again here'])
  })
})

describe('switching route while a bus is followed', () => {
  t('does not crash when the route is gone but a followed vehicle is still named', (trip) => {
    /* The shell nulls state.data on route change; if it forgot to also clear
       the followed bus, trip.js would be asked to render a vehicle against
       a route it no longer has. It must not throw. */
    const h = host()
    expect(() => trip.render(h, {
      route: null, dep: DEP, vehicleId: '2641', now: 5000,
      lastSeen: { vehicle: ROUTE.vehicles[0], at: 4000 },
    }, { routes: [] })).not.toThrow()
  })
})

describe('when the followed bus leaves the feed', () => {
  t('keeps the last list on screen and says when it was last seen', (trip) => {
    /* A bus vanishes for several ordinary reasons — the trip ended, it went out
       of service, the feed dropped it for one poll — and all of them happen
       while someone is reading the screen. Clearing the answer at the moment it
       is being used, with no trace of what it said, is the failure here. */
    const gone = { ...ROUTE, vehicles: [] }
    const h = host()
    trip.render(h, {
      route: gone, dep: DEP, vehicleId: '2641', now: 5000,
      lastSeen: { vehicle: ROUTE.vehicles[0], at: 4000 },
    }, { routes: [] })
    const text = textDeep(h)
    expect(text).toMatch(/no longer in the feed/i)
    expect(text).toContain('Alpha')
  })

  t('offers the picker rather than a dead end', (trip) => {
    const gone = { ...ROUTE, vehicles: [] }
    const h = host()
    trip.render(h, {
      route: gone, dep: DEP, vehicleId: '2641', now: 5000,
      lastSeen: { vehicle: ROUTE.vehicles[0], at: 4000 },
    }, { routes: [] })
    expect(textDeep(h)).toMatch(/Bus/)
  })
})
