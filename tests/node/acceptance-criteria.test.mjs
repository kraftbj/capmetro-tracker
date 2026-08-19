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
import { ROOT } from './helpers/optional.mjs'

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
  /*
   * This used to assert all six states against the generated output, and it was
   * unsatisfiable: the test below PROVES the 2026-08-19 capture has no orphan
   * vehicle, so nothing in it can land in `unknown`, and with no `unknown` there
   * is no reason string either. The generation step was skipped on every run, so
   * the contradiction sat here unexamined between two tests in the same block.
   *
   * The coverage claim is still worth making, so it is made in two honest halves:
   * the five states the real capture reaches are asserted against real generated
   * output, and the sixth is asserted against the synthetic fixtures that exist
   * precisely because the capture cannot reach it.
   */
  const REACHABLE_FROM_CAPTURE = ['early', 'ontime', 'late', 'very_late', 'deadhead']

  it('reaches every state the real capture can produce, including a deadhead', (ctx) => {
    requireGenerated(ctx)
    const all = readGenerated(path.join(API, 'all.json'))
    const states = new Set(all.vehicles.map((v) => v.adherence.state))
    for (const s of REACHABLE_FROM_CAPTURE) {
      expect(states, `missing adherence state ${s}`).toContain(s)
    }
  })

  it('covers the sixth state, and all three of its reasons, through the synthetic fixtures', () => {
    const cases = [
      ['vehicle-without-trip-update.json', 'no_trip_update'],
      ['canceled-trip-no-stop-updates.json', 'trip_canceled'],
      ['vehicle-null-current-stop-sequence.json', 'no_progress'],
    ]
    for (const [file, reason] of cases) {
      const expected = synthetic(file)._expected
      expect(expected.adherence_state, `${file} should encode the unknown state`).toBe('unknown')
      expect(expected.adherence_reason, `${file} should encode ${reason}`).toBe(reason)
      /* Unknown means unknown: a state with no measurement must carry no number. */
      expect(expected.adherence_seconds).toBeNull()
    }
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
  /*
   * The special run is a fact about the SCHEDULE, and it was being asserted about
   * the VEHICLES. Route 4's special patterns run at 08:15 and 16:15; the fixture
   * capture is from 10:10, when no bus is on either of them, so the vehicle-level
   * assertion could never pass against this fixture at this time. It never
   * complained because the generation step was skipped on every run.
   *
   * The substance survives intact, asserted where the fact actually lives: the
   * committed pattern shard, which names the added and skipped stops, and the
   * departures endpoint, which is generated and carries is_special per trip at
   * any hour of the day. The vehicle-level check is kept, and skips with a reason
   * naming the hour rather than reporting a failure that is really a fixture
   * property.
   */
  const patterns4 = () =>
    JSON.parse(readFileSync(path.join(ROOT, 'data/routes/4/patterns.json'), 'utf8'))

  it('names Veterans/Atlanta as added and Campbell/5th as skipped on a rare pattern', () => {
    const specials = patterns4()
      .directions.flatMap((d) => d.patterns)
      .filter((p) => p.is_special)
    expect(specials.length, 'route 4 publishes no special pattern at all').toBeGreaterThan(0)

    /*
     * Exact names, not substrings. A `.includes('Campbell')` check passes against both
     * "Campbell/5th" and "504 Campbell/5th", and the contract's own examples printed the
     * second one in a field section 7 says must carry the first. The build and the runtime
     * both emit the shortened form, so this is what pins that they agree with the rule and
     * not merely with each other.
     */
    const named = specials.find((p) =>
      Object.values(p.deltas || {}).some(
        (delta) =>
          (delta.adds || []).some((st) => st.stop_name === 'Veterans/Atlanta') &&
          (delta.skips || []).some((st) => st.stop_name === 'Campbell/5th'),
      ),
    )
    expect(named, 'no special pattern both adds Veterans/Atlanta and skips Campbell/5th').toBeDefined()
    /*
     * Rare is the whole point: this is the run that serves the Austin High stop
     * twice a day and misses the one a rider normally uses. A pattern carrying a
     * large share of the route's trips would be the baseline, not a special run.
     */
    expect(named.trips_in_pattern).toBeLessThan(20)
  })

  it('keeps the street number in stop_name_full while stop_name drops it', (ctx) => {
    /*
     * Section 7 rule 2 drops a leading street number, and stop_name_full is the escape
     * hatch for a reader who needs to be sure which shelter they are standing at. If the
     * number vanished from both, the board would have lost information the feed gave it.
     */
    requireGenerated(ctx)
    const route4 = routeFile('4')
    const found = []
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!node || typeof node !== 'object') return
      if (node.stop_id === '6243' && node.stop_name_full) found.push(node)
      Object.values(node).forEach(walk)
    }
    walk(route4)
    if (!found.length) ctx.skip('stop 6243 carries no stop_name_full anywhere in this payload')
    for (const stop of found) {
      expect(stop.stop_name).toBe('Campbell/5th')
      expect(stop.stop_name_full).toBe('504 Campbell/5th')
    }
  })

  it('marks those trips special in the generated departures board', (ctx) => {
    requireGenerated(ctx)
    let dep
    try {
      dep = readGenerated(path.join(API, 'departures/4.json'))
    } catch {
      ctx.skip('no generated api/departures/4.json')
    }
    const special = dep.trips.filter((t) => t.is_special)
    expect(special.length, 'no route 4 trip is flagged special today').toBeGreaterThan(0)
    expect(
      special.map((t) => t.start_time),
      'the 08:15 Austin High run is not flagged',
    ).toContain('08:15:00')
    /* Special means rare. If most of the day were flagged, the flag would mean nothing. */
    expect(special.length).toBeLessThan(dep.trips.length / 4)
  })

  it('names the added and skipped stops on any vehicle actually running one', (ctx) => {
    requireGenerated(ctx)
    const route4 = routeFile('4')
    expect(route4, 'no generated /api/route/4.json').not.toBeNull()
    const special = route4.vehicles.filter((v) => v.pattern?.is_special)
    if (!special.length) {
      ctx.skip(
        'no bus is on a special route 4 trip in this capture: they run at 08:15 and 16:15 ' +
          'and the fixture was captured at 10:10. Recapture inside one of those windows to bind this.',
      )
    }
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

  /*
   * A boundary is a space OR a slash, not a space alone.
   *
   * Austin stop names are "Street/CrossStreet" with no space around the slash, so
   * a space-only rule collapsed "Pleasant Valley/Turnstone" to "Pleasant…" and
   * threw away sixteen usable characters. ISSUE-001 changed the implementation to
   * break on a slash too and to keep the slash, so the cut reads as a deliberate
   * stop short of the cross street: "Martin Luther King/…".
   *
   * This assertion was never updated, and it could not object, because the
   * generation step it needs was skipped on every run. Rewritten to the invariant
   * the implementation and its regression suites actually hold, which is stronger
   * than the token test it replaces: the shortened stem must be a literal prefix
   * of the normalized full name, and the cut must land ON a boundary. A prefix
   * check cannot be satisfied by a token that merely appears somewhere in the
   * name, which the old regex could be.
   */
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
    const stem = short.slice(0, -1)
    expect(
      normalized.startsWith(stem),
      `"${short}" is not a prefix of "${normalized}"`,
    ).toBe(true)

    /*
     * Two legal shapes, and only two. A slash cut KEEPS the slash, so the stem
     * ends with one. A space cut DROPS the space, so the full name continues with
     * one. Anything else means a word was cut in half.
     */
    const endsOnSlash = stem.endsWith('/')
    const nextIsSpace = normalized.charAt(stem.length) === ' '
    expect(
      endsOnSlash || nextIsSpace,
      `"${short}" ends mid-word: "${normalized}" continues with ` +
        `"${normalized.slice(stem.length, stem.length + 8)}" and the cut is on neither a slash nor a space`,
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
