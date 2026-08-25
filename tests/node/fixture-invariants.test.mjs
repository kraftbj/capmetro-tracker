/**
 * What the committed feeds actually contain.
 *
 * These run today, against the real 2026-08-19 capture, and they have two jobs.
 * They pin the numbers the contract quotes, so a casual fixture regeneration
 * cannot silently move the ground the rest of the suite stands on. And they
 * establish the input truth for the silent failures: if stop 1967 is not really
 * closed in this fixture, the test that says the client must strike it through
 * proves nothing.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FEEDS, SYNTHETIC, feed, readText, synthetic, tripUpdates, vehicles } from './helpers/fixtures.mjs'
import { ROOT } from './helpers/optional.mjs'

const positions = feed('vehiclepositions.json')
const updates = feed('tripupdates.json')
const alerts = feed('servicealerts.json')
const manifest = feed('MANIFEST.json')

const CAPTURE_EPOCH = 1787152239 // header timestamp of vehiclepositions.json

describe('the captured feeds still hold the shape the contract was written against', () => {
  it('reports the vehicle and trip-update volumes the manifest claims', () => {
    expect(positions.entity).toHaveLength(manifest.vehicle_count)
    expect(vehicles(positions).filter((v) => v.trip)).toHaveLength(manifest.vehicles_with_trip)
    expect(updates.entity).toHaveLength(manifest.trip_update_count)
    expect(alerts).toHaveLength(manifest.alert_count)
  })

  it('carries a one-off service on the captured date, which is the whole reason this date was chosen', () => {
    expect(manifest.service_ids_active_today).toContain('3-172')
    const calendarDates = readText(path.join(FEEDS, 'gtfs_calendar_dates.txt'))
    const rowsFor3172 = calendarDates
      .trim()
      .split('\n')
      .slice(1)
      .filter((line) => line.startsWith('3-172,'))
    expect(rowsFor3172).toHaveLength(1)
    expect(rowsFor3172[0]).toContain('20260819')
  })

  it('serves alerts as a bare Socrata array, not a GTFS-Realtime envelope, so it needs its own parser', () => {
    expect(Array.isArray(alerts)).toBe(true)
    expect(alerts[0]).not.toHaveProperty('header')
    expect(alerts[0]).not.toHaveProperty('entity')
    expect(alerts[0]).toHaveProperty('informedEntities')
    expect(alerts[0]).toHaveProperty('activePeriods')
    expect(alerts[0]).toHaveProperty('headerText')
  })

  it('gives trip updates predicted times only, with no delay field anywhere', () => {
    const stopTimeUpdates = tripUpdates(updates).flatMap((u) => u.stopTimeUpdate ?? [])
    expect(stopTimeUpdates.length).toBeGreaterThan(0)
    expect(stopTimeUpdates.some((s) => 'delay' in s)).toBe(false)
    expect(stopTimeUpdates.some((s) => s.arrival?.time || s.departure?.time)).toBe(true)
  })
})

describe('silent failure 4: an alert really does close a stop that the schedule still serves', () => {
  const closures = alerts.filter(
    (a) =>
      a.effect === 'NO_SERVICE' &&
      (a.informedEntities ?? []).some((e) => e.stopId === '1967' && e.routeId === '4'),
  )

  it('closes stop 1967 on route 4 with a NO_SERVICE alert', () => {
    expect(closures).toHaveLength(1)
  })

  it('leaves that closure open-ended, so it is active at capture time', () => {
    const [alert] = closures
    const period = alert.activePeriods[0]
    expect(Date.parse(period.start) / 1000).toBeLessThan(CAPTURE_EPOCH)
    expect(period.end).toBeNull()
  })

  it('also closes stop 1971, the second Austin High stop, so one closure is not a fluke', () => {
    const stop1971 = alerts.filter(
      (a) =>
        a.effect === 'NO_SERVICE' &&
        (a.informedEntities ?? []).some((e) => e.stopId === '1971' && e.routeId === '4'),
    )
    expect(stop1971.length).toBeGreaterThanOrEqual(1)
  })

  it('describes 29 informed entities by route alone, which must not be read as a stop closure', () => {
    const entities = alerts.flatMap((a) => a.informedEntities ?? [])
    const routeOnly = entities.filter((e) => e.routeId && !e.stopId)
    expect(entities).toHaveLength(175)
    expect(routeOnly).toHaveLength(29)
  })
})

describe('the alerts feed carries CapMetro staff PII that must be stripped at ingest', () => {
  it('embeds a staff email and full name on the alert objects', () => {
    const withPii = alerts.filter((a) => a.userEmail || a.userFullname)
    expect(withPii.length).toBeGreaterThan(0)
    expect(withPii[0].userEmail).toMatch(/@/)
  })

  it('names real people, so the privacy test has values to scan for and not just keys', () => {
    const names = new Set(alerts.map((a) => a.userFullname).filter(Boolean))
    expect(names.size).toBeGreaterThan(0)
    for (const n of names) expect(n.trim().length).toBeGreaterThan(2)
  })
})

describe('the decision table rows the real capture can and cannot exercise', () => {
  it('cancels 100 of 912 trips, none of which carries a single stop prediction', () => {
    const canceled = tripUpdates(updates).filter((u) => u.trip.scheduleRelationship === 'CANCELED')
    expect(canceled).toHaveLength(100)
    expect(canceled.every((u) => !u.stopTimeUpdate)).toBe(true)
    expect(canceled.length / updates.entity.length).toBeCloseTo(0.11, 2)
  })

  it('runs 143 of 392 vehicles as deadheads, with neither a trip nor a stop sequence', () => {
    const deadheads = vehicles(positions).filter((v) => !v.trip)
    expect(deadheads).toHaveLength(143)
    expect(deadheads.every((v) => v.currentStopSequence === undefined)).toBe(true)
  })

  it('leaves no in-service vehicle without a trip update, so row 3 is unreachable without a synthetic fixture', () => {
    // Contract section 2 says roughly 7% of active vehicle trips have no matching
    // trip update. In this capture it is 0 of 249. See tests/NOTES.md.
    const tripIds = new Set(tripUpdates(updates).map((u) => u.trip.tripId))
    const orphans = vehicles(positions).filter((v) => v.trip && !tripIds.has(v.trip.tripId))
    expect(orphans).toHaveLength(0)
    expect(synthetic('vehicle-without-trip-update.json')._expected.adherence_reason).toBe('no_trip_update')
  })

  it('leaves no in-service vehicle with a null stop sequence, so row 6b is unreachable without a synthetic fixture', () => {
    // The 143 nulls are exactly the 143 deadheads, and row 1 catches those first.
    const stranded = vehicles(positions).filter((v) => v.trip && v.currentStopSequence === undefined)
    expect(stranded).toHaveLength(0)
    expect(synthetic('vehicle-null-current-stop-sequence.json')._expected.adherence_reason).toBe('no_progress')
  })
})

describe('the synthetic fixtures encode what the real minute does not', () => {
  const cases = [
    ['after-midnight-tripupdate.json', (f) => expect(f.entity[0].tripUpdate.trip.startTime).toBe('25:10:00')],
    ['dst-spring-forward-20260308.json', (f) => expect(f.service_date).toBe('20260308')],
    ['dst-fall-back-20261101.json', (f) => expect(f.service_date).toBe('20261101')],
    ['stale-shard-route-4.json', (f) => expect(f._expected.unmatched_rate).toBe(1)],
    ['vehicle-without-trip-update.json', (f) => expect(f.positions.entity).toHaveLength(1)],
    ['canceled-trip-no-stop-updates.json', (f) => expect(f.trip_updates.entity[0].tripUpdate.stopTimeUpdate).toBeUndefined()],
    ['vehicle-null-current-stop-sequence.json', (f) => expect(f.positions.entity[0].vehicle.currentStopSequence).toBeUndefined()],
    ['frozen-feed-response.json', (f) => expect(f.http_status).toBe(200)],
    ['route-4-dead-cron.json', (f) => expect(f.staleness.suppress_adherence).toBe(true)],
  ]

  for (const [name, assertShape] of cases) {
    it(`${name} states the failure it encodes and holds that shape`, () => {
      const f = synthetic(name)
      expect(typeof f._comment).toBe('string')
      expect(f._comment.length).toBeGreaterThan(30)
      assertShape(f)
    })
  }

  it('keeps the torn fixture genuinely unparseable, so the atomic-write test has teeth', () => {
    const raw = readText(path.join(SYNTHETIC, 'torn-route-4.json'))
    expect(raw.length).toBeGreaterThan(1000)
    expect(() => JSON.parse(raw)).toThrow()
  })

  it('lists every synthetic fixture in the manifest with a one-line note', () => {
    const listed = Object.keys(synthetic('MANIFEST.json').fixtures)
    for (const [name] of cases) expect(listed).toContain(name)
    expect(listed).toContain('torn-route-4.json')
  })

  it('builds the stale shard from a different GTFS feed version than the live capture', () => {
    const shard = synthetic('stale-shard-route-4.json')
    expect(shard.feed_version).not.toBe('260818_1456')
    const shardTrips = new Set(Object.keys(shard.trips))
    const live = vehicles(positions)
      .filter((v) => v.trip?.routeId === '4')
      .map((v) => v.trip.tripId)
    expect(live.length).toBeGreaterThan(0)
    expect(live.some((id) => shardTrips.has(id))).toBe(false)
  })
})

describe('the bundled departures fixture', () => {
  it('is present, and is the route 4 document the runtime writes', () => {
    const dep = JSON.parse(
      readFileSync(path.join(ROOT, 'tests/fixtures/golden/departures-4-20260819.json'), 'utf8')
    )
    expect(dep.route_id).toBe('4')
    expect(dep.service_date).toBe('20260819')
    expect(typeof dep.service_day_start_epoch).toBe('number')
    expect(dep.trips.length).toBeGreaterThan(0)
    expect(Object.keys(dep.departures).length).toBeGreaterThan(0)
  })

  it('is bundled for file:// verbatim, with no second spelling', () => {
    /* The client copy exists because fetch() is blocked on file:// URLs. If the
       two ever differ, the board shows one thing from disk and another over
       HTTP, which is the failure mode this assertion exists to catch. */
    const src = readFileSync(path.join(ROOT, 'tests/fixtures/golden/departures-4-20260819.json'), 'utf8')
    const bundled = readFileSync(path.join(ROOT, 'client/data/departures-4-20260819.js'), 'utf8')
    expect(bundled).toContain(src.replace(/\s+$/, ''))
  })
})
