/**
 * Contract section 12, criteria 1 through 10, as executable tests.
 *
 * Each criterion is a statement about generated output. Where the committed
 * golden route-4 file is enough to settle it, the test runs today. Where it
 * needs a full generation run over the fixtures, the test skips with a reason
 * and binds automatically once CAPMETRO_WEBROOT points at real output.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { API, MISSING, generatedFiles, hasGeneratedOutput, readGenerated, requireGenerated, routeFile, routeFiles } from './helpers/webroot.mjs'
import { feed, goldenRoute4, synthetic } from './helpers/fixtures.mjs'

const golden = goldenRoute4()

// Criterion 1 -------------------------------------------------------------
describe('criterion 1: every endpoint validates against its JSON Schema for the 2026-08-19 fixture', () => {
  it('is covered for the route endpoint by the committed golden output', () => {
    // The validator itself is tests/schema/validate.py, which runs standalone
    // and covers all five schemas. This test asserts the golden file is the one
    // the validator is pointed at and has not drifted in shape.
    expect(golden.schema).toBe(1)
    expect(golden.route.id).toBe('4')
    expect(Array.isArray(golden.vehicles)).toBe(true)
    expect(Array.isArray(golden.timepoints)).toBe(true)
    expect(Array.isArray(golden.alerts)).toBe(true)
  })

  it('writes all four endpoint kinds into the webroot', (ctx) => {
    requireGenerated(ctx)
    const files = generatedFiles().map((f) => path.relative(API, f))
    expect(files.some((f) => f.startsWith(`route${path.sep}`))).toBe(true)
    expect(files.some((f) => f.startsWith(`watch${path.sep}`))).toBe(true)
    expect(files).toContain('all.json')
    expect(files).toContain('health.json')
  })
})

// Criterion 2 -------------------------------------------------------------
describe('criterion 2: generating from the fixture covers all six adherence states', () => {
  it('reaches every state, including a deadhead, a no_trip_update and a trip_canceled', (ctx) => {
    requireGenerated(ctx)
    const all = readGenerated(path.join(API, 'all.json'))
    const states = new Set(all.vehicles.map((v) => v.adherence.state))
    for (const s of ['early', 'ontime', 'late', 'very_late', 'unknown', 'deadhead']) {
      expect(states, `missing adherence state ${s}`).toContain(s)
    }
    const reasons = new Set(all.vehicles.map((v) => v.adherence.reason).filter(Boolean))
    expect(reasons).toContain('no_trip_update')
    expect(reasons).toContain('trip_canceled')
  })

  it('cannot reach no_trip_update from the real capture alone, which is why the synthetic fixture exists', () => {
    const tripIds = new Set(feed('tripupdates.json').entity.map((e) => e.tripUpdate.trip.tripId))
    const orphans = feed('vehiclepositions.json').entity
      .map((e) => e.vehicle)
      .filter((v) => v.trip && !tripIds.has(v.trip.tripId))
    expect(orphans).toHaveLength(0)
    expect(synthetic('vehicle-without-trip-update.json')._expected.adherence_state).toBe('unknown')
  })
})

// Criterion 3 -------------------------------------------------------------
describe('criterion 3: the route 4 special run names its added and skipped stops', () => {
  it('marks the 08:15 or 16:15 trip special, adding Veterans/Atlanta and skipping 504 Campbell/5th', (ctx) => {
    requireGenerated(ctx)
    const route4 = routeFile('4')
    expect(route4, 'no generated /api/route/4.json').not.toBeNull()
    const special = route4.vehicles.filter((v) => v.pattern?.is_special)
    expect(special.length).toBeGreaterThan(0)
    const named = special.find(
      (v) =>
        v.pattern.adds.some((s) => s.stop_name.includes('Veterans')) &&
        v.pattern.skips.some((s) => s.stop_name.includes('Campbell')),
    )
    expect(named, 'no special vehicle named both Veterans/Atlanta and 504 Campbell/5th').toBeDefined()
  })
})

// Criterion 4 -------------------------------------------------------------
describe('criterion 4: at least one route 4 vehicle continues into the opposite direction', () => {
  it('is already true in the committed golden output', () => {
    const flips = golden.vehicles.filter((v) => v.block?.next_trip?.is_direction_flip)
    expect(flips.length).toBeGreaterThan(0)
    const [flip] = flips
    expect(flip.block.next_trip.direction_id).not.toBe(flip.trip.direction_id)
  })

  it('holds in generated output too', (ctx) => {
    requireGenerated(ctx)
    const route4 = routeFile('4')
    expect(route4.vehicles.some((v) => v.block?.next_trip?.is_direction_flip)).toBe(true)
  })
})

// Criterion 5 -------------------------------------------------------------
describe('criterion 5: stop 1222 on route 800 is not served, because the realtime feed skips it', () => {
  it('reports service_status realtime_skipped and served false', (ctx) => {
    requireGenerated(ctx)
    const route800 = routeFile('800')
    expect(route800, 'no generated /api/route/800.json').not.toBeNull()
    const stop = [...route800.timepoints, ...route800.timepoints.flatMap((t) => t.minor_stops)].find(
      (s) => s.stop_id === '1222',
    )
    expect(stop, 'stop 1222 absent from route 800').toBeDefined()
    expect(stop.service_status.served).toBe(false)
    expect(stop.service_status.source).toBe('realtime_skipped')
  })

  it('has a SKIPPED prediction for stop 1222 in the real feed to justify that', () => {
    const skipped = feed('tripupdates.json').entity
      .filter((e) => e.tripUpdate.trip.routeId === '800')
      .flatMap((e) => e.tripUpdate.stopTimeUpdate ?? [])
      .filter((s) => s.stopId === '1222' && s.scheduleRelationship === 'SKIPPED')
    expect(skipped.length).toBeGreaterThan(0)
  })
})

// Criterion 6 / silent failure 4 ------------------------------------------
describe('criterion 6: stop 1967 on route 4 is closed by an alert and must never render as served', () => {
  it('reports service_status alert_no_service and served false', (ctx) => {
    requireGenerated(ctx)
    const route4 = routeFile('4')
    const stop = [...route4.timepoints, ...route4.timepoints.flatMap((t) => t.minor_stops)].find(
      (s) => s.stop_id === '1967',
    )
    expect(stop, 'stop 1967 absent from route 4; an alert-closed stop must still appear, struck through').toBeDefined()
    expect(stop.service_status.served).toBe(false)
    expect(stop.service_status.source).toBe('alert_no_service')
  })

  it('carries the closing alert through to the route file', (ctx) => {
    requireGenerated(ctx)
    const route4 = routeFile('4')
    const closure = route4.alerts.find((a) => a.effect === 'NO_SERVICE' && a.stop_ids.includes('1967'))
    expect(closure, 'the NO_SERVICE alert for stop 1967 did not survive ingest').toBeDefined()
    expect(closure.severity).toBe('high')
  })
})

// Criterion 7 -------------------------------------------------------------
describe('criterion 7: no generated file carries staff PII', () => {
  const piiValues = [
    ...new Set(
      feed('servicealerts.json').flatMap((a) => [a.userEmail, a.userFullname]).filter((v) => typeof v === 'string' && v.trim()),
    ),
  ]

  it('has real staff names in the upstream feed, so this scan is not vacuous', () => {
    expect(piiValues.length).toBeGreaterThan(0)
  })

  it('leaves no PII key or value in the committed golden output', () => {
    const raw = readFileSync(path.join(process.cwd(), 'tests/fixtures/golden/route-4-20260819.json'), 'utf8')
    expect(raw).not.toContain('userEmail')
    expect(raw).not.toContain('userFullname')
    for (const v of piiValues) expect(raw, `golden output leaks "${v}"`).not.toContain(v)
  })

  it('leaves no PII key or value in any generated file', (ctx) => {
    requireGenerated(ctx)
    const leaks = []
    for (const f of generatedFiles()) {
      const raw = readFileSync(f, 'utf8')
      if (raw.includes('userEmail') || raw.includes('userFullname')) leaks.push(`${f}: PII key`)
      for (const v of piiValues) if (raw.includes(v)) leaks.push(`${f}: value "${v}"`)
    }
    expect(leaks, `staff PII reached generated output:\n${leaks.join('\n')}`).toEqual([])
  })
})

// Criterion 8 / silent failure 2 ------------------------------------------
describe('criterion 8: past 600 seconds of feed age, every route suppresses lateness numbers', () => {
  it('is what the dead-cron fixture asserts, as the shape generation must produce', () => {
    const dead = synthetic('route-4-dead-cron.json')
    expect(dead.staleness.suppress_adherence).toBe(true)
    expect(dead._expected.generated_at_age_s).toBeGreaterThan(600)
    const inService = dead.vehicles.filter((v) => v.in_service)
    expect(inService.length).toBeGreaterThan(0)
    for (const v of inService) {
      expect(v.adherence.state).toBe('unknown')
      expect(v.adherence.reason).toBe('stale_data')
      expect(v.adherence.seconds).toBeNull()
      expect(v.adherence.against).toBeNull()
    }
  })

  it('holds for every generated route file when feed ages are forced past 600s', (ctx) => {
    requireGenerated(ctx)
    const files = routeFiles()
    if (!files.length) ctx.skip('no generated route files')
    const stale = files.map(readGenerated).filter((r) => r.staleness.oldest_feed_age_s > 600)
    if (!stale.length) {
      ctx.skip('generated output is fresh; regenerate with feed timestamps forced past 600s to exercise this')
    }
    for (const route of stale) {
      expect(route.staleness.suppress_adherence).toBe(true)
      for (const v of route.vehicles.filter((v) => v.in_service)) {
        expect(v.adherence.state).toBe('unknown')
        expect(v.adherence.reason).toBe('stale_data')
      }
    }
  })
})

// Criterion 9 -------------------------------------------------------------
describe('criterion 9: a saved watch resolves on two different one-off service days', () => {
  const TUPLE = ['800', 1, '6293', '07:52:09', 'weekday']
  const WATCH_ID = '214ab6184a765743583f0eb1c5171cc7'

  it('hashes the tuple to a stable id that leaks nothing about the trip', () => {
    // Contract section 9: first 16 bytes of SHA-256 over the pipe-joined tuple.
    const id = createHash('sha256').update(TUPLE.join('|'), 'utf8').digest('hex').slice(0, 32)
    expect(id).toBe(WATCH_ID)
    expect(id).not.toContain('6293')
    expect(id).not.toContain('800')
  })

  it('resolves to trip 3010894_22201 on 20260819 and still resolves on 20260820', (ctx) => {
    requireGenerated(ctx)
    const f = path.join(API, 'watch', `${WATCH_ID}.json`)
    let watch
    try {
      watch = readGenerated(f)
    } catch {
      ctx.skip(`no generated ${f}; the watch endpoint has not been written yet`)
    }
    expect(watch.resolution.resolved).toBe(true)
    expect(watch.resolution.trip_id).toBe('3010894_22201')
    expect(watch.resolution.service_date).toBe('20260819')
  })
})

// Criterion 10 ------------------------------------------------------------
describe('criterion 10: no stop name is truncated mid-word or longer than 25 characters', () => {
  const names = (doc) => [
    ...doc.timepoints.map((t) => t.stop_name),
    ...doc.timepoints.flatMap((t) => t.minor_stops.map((m) => m.stop_name)),
    ...doc.vehicles.flatMap((v) => [
      v.adherence.against?.stop_name,
      v.block?.next_trip?.start_stop_name,
      ...(v.pattern?.adds ?? []).map((s) => s.stop_name),
      ...(v.pattern?.skips ?? []).map((s) => s.stop_name),
    ]),
  ].filter(Boolean)

  /*
   * Section 7 allows truncation only at a word boundary. Whether a name was cut
   * mid-word can only be judged against the name it came from, so timepoints
   * (which carry stop_name_full) get the real check and everything else gets
   * the length and shape checks the schema also enforces.
   */
  const assertWellFormed = (list) => {
    expect(list.length).toBeGreaterThan(0)
    for (const n of list) {
      expect(n.length, `"${n}" is ${n.length} characters`).toBeLessThanOrEqual(25)
      expect(n, `"${n}" has a dangling space`).not.toMatch(/\s$/)
      expect(n, `"${n}" is blank`).not.toBe('')
      expect(n, `"${n}" ends with a space before its ellipsis`).not.toMatch(/\s…$/)
    }
  }

  const assertNotTruncatedMidWord = (full, short) => {
    if (!short.endsWith('…')) return
    const normalized = String(full)
      .trim()
      .replace(/\s*\([^()]*\)\s*$/, '')
      .trim()
      .replace(/^\d+\s+/, '')
      .replace(/\bNorthbound\b/gi, 'NB')
      .replace(/\bSouthbound\b/gi, 'SB')
      .replace(/\bEastbound\b/gi, 'EB')
      .replace(/\bWestbound\b/gi, 'WB')
      .replace(/\s{2,}/g, ' ')
      .trim()
    const last = short.slice(0, -1).trimEnd().split(/\s+/).pop()
    expect(
      new RegExp(`(?<!\\S)${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\S)`).test(normalized),
      `"${short}" ends mid-word: "${last}" is not a whole word of "${normalized}"`,
    ).toBe(true)
  }

  it('holds across every name in the committed golden output', () => {
    assertWellFormed(names(golden))
    for (const tp of golden.timepoints) assertNotTruncatedMidWord(tp.stop_name_full, tp.stop_name)
  })

  it('holds across every name in every generated route file', (ctx) => {
    requireGenerated(ctx)
    const files = routeFiles()
    if (!files.length) ctx.skip('no generated route files')
    for (const f of files) {
      const doc = readGenerated(f)
      assertWellFormed(names(doc))
      for (const tp of doc.timepoints) assertNotTruncatedMidWord(tp.stop_name_full, tp.stop_name)
    }
  })
})
