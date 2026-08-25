/**
 * The trip view's join over the WHOLE generated corpus, not the fixture.
 *
 * CLAUDE.md records why this file exists: the golden fixture is route 4, the
 * smallest of the six watched routes, and both bugs a previous QA pass found
 * came from route 7 and the full 2,348-stop corpus while a fixture-only run
 * reported clean. Route 4 has 3 timepoints and 5 buses; route 300 has 608
 * prediction rows and route 10 has 8,825 departures.
 *
 * These bind to a webroot the runtime job wrote, and skip with a reason when
 * there is none. tests/run-all.sh generates one before it starts.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadClient } from './helpers/client.mjs'
import { API, readGenerated, requireGenerated, routeFiles } from './helpers/webroot.mjs'

const client = loadClient(['format.js'])
const t = (name, fn) =>
  it(name, (ctx) => {
    requireGenerated(ctx)
    if (!client.cmb?.fmt) ctx.skip(client.reason ?? 'window.CMB.fmt is not defined')
    return fn(client.cmb.fmt, ctx)
  })

/* Every (route doc, departures doc) pair the webroot carries. */
function eachRoute(fn) {
  const files = routeFiles()
  expect(files.length, 'no route files in the generated webroot').toBeGreaterThan(0)
  for (const f of files) {
    const route = readGenerated(f)
    const depPath = path.join(API, 'departures', `${route.route.id}.json`)
    if (!existsSync(depPath)) continue
    fn(route, readGenerated(depPath), path.basename(f))
  }
}

/* Every in-service bus with a trip, across every route. */
function eachBus(fn) {
  eachRoute((route, dep, name) => {
    for (const v of route.vehicles || []) {
      if (!v.in_service || !v.trip) continue
      fn(v, route, dep, `${name} #${v.vehicle_id}`)
    }
  })
}

describe('the trip join across every generated route', () => {
  t('resolves a stop list for every in-service bus', (fmt) => {
    let checked = 0
    eachBus((v, route, dep, where) => {
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      expect(stops, `${where}: trip ${v.trip.trip_id} not in its departures document`).not.toBeNull()
      expect(stops.length, where).toBeGreaterThan(0)
      checked++
    })
    expect(checked, 'no in-service buses found').toBeGreaterThan(0)
  })

  t('orders every stop list by scheduled time', (fmt) => {
    eachBus((v, route, dep, where) => {
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      for (let i = 1; i < stops.length; i++) {
        expect(stops[i].scheduled_at, `${where} at ordinal ${i}`)
          .toBeGreaterThanOrEqual(stops[i - 1].scheduled_at)
      }
    })
  })

  t('cuts at the anchor for every bus that has one', (fmt) => {
    /* Measured 249/249 on the 2026-08-19 capture. A drop here means the anchor
       and the departures document have stopped agreeing on a scheduled time,
       which would silently turn every trip into an unanchored one. */
    let anchored = 0
    let total = 0
    eachBus((v, route, dep) => {
      if (!v.adherence?.against) return
      total++
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      if (fmt.stopsAheadOf(stops, v).anchored) anchored++
    })
    expect(total, 'no bus in the corpus carried an adherence anchor').toBeGreaterThan(0)
    expect(anchored, `only ${anchored} of ${total} anchors matched a departures row`).toBe(total)
  })

  t('joins every prediction row positionally, losing none', (fmt) => {
    let compared = 0
    eachBus((v, route, dep, where) => {
      if (!v.predictions?.length) return
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      const plan = fmt.arrivalPlan(fmt.stopsAheadOf(stops, v), v, route.staleness)
      if (plan.reason) return
      const fromFeed = plan.rows.filter((r) => r.source === 'feed').length
      const inWindow = v.predictions.filter((p) =>
        plan.rows.some((r) => r.stop_id === String(p[1]))).length
      expect(fromFeed, `${where}: feed rows lost between predictions and the plan`).toBe(inWindow)
      compared++
    })
    expect(compared, 'no bus had both predictions and an un-refused plan').toBeGreaterThan(0)
  })

  t('never produces an arrival time that goes backwards', (fmt) => {
    let checked = 0
    eachBus((v, route, dep, where) => {
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      const plan = fmt.arrivalPlan(fmt.stopsAheadOf(stops, v), v, route.staleness)
      if (plan.reason) return
      for (let i = 1; i < plan.rows.length; i++) {
        expect(plan.rows[i].predicted_at, `${where} at ordinal ${i}`)
          .toBeGreaterThanOrEqual(plan.rows[i - 1].predicted_at)
      }
      checked++
    })
    expect(checked, 'no bus produced an un-refused plan').toBeGreaterThan(0)
  })

  t('produces an arrival time for every stop, or none at all', (fmt) => {
    /* Half a list of times is the worst outcome: a reader cannot tell which
       rows are answers and which are gaps. */
    let checked = 0
    eachBus((v, route, dep, where) => {
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      const plan = fmt.arrivalPlan(fmt.stopsAheadOf(stops, v), v, route.staleness)
      const withTime = plan.rows.filter((r) => r.predicted_at !== null).length
      expect(withTime === 0 || withTime === plan.rows.length, where).toBe(true)
      checked++
    })
    expect(checked, 'no in-service bus produced a plan').toBeGreaterThan(0)
  })

  t('publishes no arrival time anywhere when adherence is suppressed', (fmt, ctx) => {
    /*
     * Not one route in the 2026-08-19 capture carries suppress_adherence:
     * true — the feed never went stale during this run. Looping over zero
     * matching routes would make this assertion pass without ever having
     * examined anything, which is worse than not having it, so it counts
     * what it actually inspected and skips loudly instead of passing quietly
     * when that count is zero.
     *
     * The refusal path itself IS covered elsewhere: Task 3's unit tests in
     * tests/node/client-trip-format.test.mjs exercise arrivalPlan's
     * stale_data branch directly, and the ?state=trip-canceled /
     * ?state=trip-no-anchor rows in client/states.js drive the other refusal
     * reasons through the harness. This test's job is only to check the
     * corpus join, and on this capture there is no suppressed route to join.
     */
    let checked = 0
    eachBus((v, route, dep, where) => {
      if (!route.staleness?.suppress_adherence) return
      checked++
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      const plan = fmt.arrivalPlan(fmt.stopsAheadOf(stops, v), v, route.staleness)
      expect(plan.rows.every((r) => r.predicted_at === null), where).toBe(true)
    })
    if (checked === 0) {
      ctx.skip('no route in this capture has suppress_adherence true')
    }
  })
})

/*
 * arrivalPlan's positional join, over the whole corpus.
 *
 * NOT the regression pin for the stop-board loop bug -- that lives in
 * tests/node/client-stopboard.test.mjs, because the defect was in stopboard.js
 * calling fmt.predictionFor() and this block passes with or without that fix.
 * What this pins is the property the fix RELIES on: that arrivalPlan gives the
 * two passes of a repeat-stop trip their own times, across real output rather
 * than a constructed loop.
 *
 * 270 (stop, trip) pairs in this capture are stops a trip serves TWICE, and 19
 * of them had a live bus at capture time. A lookup keyed on stop_id alone hands
 * both departures the first pass's predicted time: measured here before the
 * fix, 6 rendered stop-board rows carried the wrong arrival, the worst by 51
 * minutes, and three of the six threw away a distinct time CapMetro had
 * published for the second pass.
 *
 * The positional join is what makes the two passes distinguishable, so this
 * asserts the property the join exists for, over real generated output rather
 * than a synthetic loop.
 */
describe('arrivalPlan at a stop a trip serves twice', () => {
  t('gives each pass its own scheduled time and its own arrival', (fmt) => {
    let pairsChecked = 0
    let distinct = 0
    eachBus((v, route, dep, where) => {
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      const plan = fmt.arrivalPlan(fmt.stopsAheadOf(stops, v), v, route.staleness)
      if (plan.reason) return
      const seen = Object.create(null)
      for (const r of plan.rows) {
        if (seen[r.stop_id] === undefined) { seen[r.stop_id] = r; continue }
        pairsChecked++
        const first = seen[r.stop_id]
        /* Two visits to one stop are two different arrivals. Equal times would
           mean the join collapsed them, which is the bug this pins. */
        expect(r.scheduled_at, `${where} ${r.stop_id} scheduled`)
          .not.toBe(first.scheduled_at)
        if (r.predicted_at !== first.predicted_at) distinct++
      }
    })
    /* Not zero on this corpus. If it ever is, this test stops testing anything
       and the count below is what says so. */
    expect(pairsChecked, 'no repeat-stop pair found in the corpus').toBeGreaterThan(0)
    expect(distinct, 'every repeat-stop pair collapsed to one time').toBeGreaterThan(0)
  })
})
