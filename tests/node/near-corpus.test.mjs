/**
 * The nearest-stop feature over the WHOLE generated corpus, not the fixture.
 *
 * CLAUDE.md records why this file exists: the golden fixture is route 4, the
 * smallest of the six watched routes, and both bugs a previous QA pass found
 * came from route 7 and the full 2,348-stop corpus while a fixture-only run
 * reported clean. `Vehicle.predictions` is exactly the kind of field that
 * behaves on route 4 and not on route 300 — route 4 publishes 70 prediction
 * rows and route 300 publishes 608.
 *
 * These bind to a webroot the runtime job wrote, and skip with a reason when
 * there is none. tests/run-all.sh generates one before it starts.
 */
import { describe, expect, it } from 'vitest'
import { all, renderClient } from './helpers/client.mjs'
import { API, readGenerated, requireGenerated, routeFiles } from './helpers/webroot.mjs'
import { existsSync } from 'node:fs'
import path from 'node:path'

const client = renderClient([
  'format.js',
  'adherence.js',
  'states.js',
  'rows.js',
  'watch.js',
  'stopboard.js',
  'near.js',
])

const t = (name, fn) =>
  it(name, (ctx) => {
    requireGenerated(ctx)
    if (!client.cmb?.near) ctx.skip(client.reason ?? 'window.CMB.near is not defined')
    return fn(client.cmb)
  })

/** Every (stop_id, direction) the route document publishes. */
function publishedStops(doc) {
  const out = new Map()
  for (const tp of doc.timepoints || []) {
    out.set(`${tp.direction_id}/${tp.stop_id}`, tp)
    for (const m of tp.minor_stops || []) out.set(`${tp.direction_id}/${m.stop_id}`, m)
  }
  return out
}

const eachRoute = (fn) => {
  const files = routeFiles()
  expect(files.length, 'no route files in the generated webroot').toBeGreaterThan(0)
  for (const f of files) fn(readGenerated(f), path.basename(f))
}

describe('predictions across every generated route', () => {
  t('are published for every in-service bus', (cmb) => {
    eachRoute((doc, name) => {
      for (const v of doc.vehicles) {
        if (!v.in_service) continue
        expect(Array.isArray(v.predictions), `${name} #${v.vehicle_id}`).toBe(true)
      }
    })
  })

  t('never appear on a bus that is not in service', () => {
    eachRoute((doc, name) => {
      for (const v of doc.vehicles) {
        if (v.in_service) continue
        expect(v.predictions, `${name} #${v.vehicle_id} deadhead`).toBeUndefined()
      }
    })
  })

  t('name only stops the same document publishes somewhere', () => {
    /*
     * The join that matters: a prediction for a stop the document does not
     * carry at all is unreachable, because the client can only snap a rider to
     * a stop it can see.
     *
     * Deliberately not asserted per-direction. A non-baseline trip may add a
     * stop the direction's baseline ladder does not list (contract §2
     * pattern.adds) — route 333 EB serves Brush Country/William on 33 trips
     * while the EB ladder, built from the baseline, does not carry it. That is
     * the feed being right and the ladder being a baseline, so near.js reaches
     * those stops explicitly rather than the corpus pretending they cannot
     * happen.
     */
    let checked = 0
    let patternAdds = 0
    eachRoute((doc, name) => {
      const stops = publishedStops(doc)
      const anywhere = new Set([...stops.keys()].map((k) => k.split('/')[1]))
      for (const v of doc.vehicles) {
        if (!v.in_service || !v.predictions?.length) continue
        for (const [, stopId] of v.predictions) {
          expect(
            anywhere.has(String(stopId)),
            `${name} #${v.vehicle_id} predicts stop ${stopId}, which the document never publishes`,
          ).toBe(true)
          if (!stops.has(`${v.trip.direction_id}/${stopId}`)) patternAdds++
          checked++
        }
      }
    })
    expect(checked, 'no prediction rows were checked at all').toBeGreaterThan(0)
    /* Not zero on this corpus — if it ever is, the case below stops testing
       anything and the reachability code is dead. */
    expect(patternAdds, 'no pattern-added stop in the corpus').toBeGreaterThan(0)
  })

  t('leave no predicted stop that a rider standing there could not be snapped to', (cmb) => {
    /*
     * The rider-facing statement of the same fact, and the regression guard for
     * route 333: every stop any bus is predicted to reach must be findable in
     * that bus's direction, or somebody waiting at it is told nothing is
     * coming while a bus is on its way.
     */
    eachRoute((doc, name) => {
      for (const dir of [0, 1]) {
        const reachable = new Set(cmb.near.stopsOnRoute(doc, dir).map((s) => s.stop_id))
        for (const v of doc.vehicles) {
          if (!v.in_service || v.trip.direction_id !== dir || !v.predictions?.length) continue
          for (const [, stopId] of v.predictions) {
            expect(
              reachable.has(String(stopId)),
              `${name} #${v.vehicle_id} reaches stop ${stopId} but a rider there cannot be snapped to it`,
            ).toBe(true)
          }
        }
      }
    })
  })

  t('never point behind the bus, and always ascend', () => {
    eachRoute((doc, name) => {
      for (const v of doc.vehicles) {
        if (!v.in_service || !v.predictions?.length) continue
        const seqs = v.predictions.map(([s]) => s)
        expect(seqs, `${name} #${v.vehicle_id} out of order`).toEqual([...seqs].sort((a, b) => a - b))
        if (v.progress.current_stop_sequence !== null) {
          expect(
            Math.min(...seqs),
            `${name} #${v.vehicle_id} predicts a stop it has passed`,
          ).toBeGreaterThanOrEqual(v.progress.current_stop_sequence)
        }
      }
    })
  })

  t('stay inside the schedule window the document declares', () => {
    eachRoute((doc, name) => {
      const horizon = doc.generated_at + doc.schedule.window.after_s
      for (const v of doc.vehicles) {
        if (!v.in_service) continue
        for (const [, , at] of v.predictions || []) {
          expect(at, `${name} #${v.vehicle_id} predicts past the window`).toBeLessThanOrEqual(
            horizon,
          )
        }
      }
    })
  })

  t('are withheld entirely when the document suppresses lateness', () => {
    eachRoute((doc, name) => {
      if (!doc.staleness.suppress_adherence) return
      for (const v of doc.vehicles) {
        if (!v.in_service) continue
        expect(v.predictions, `${name} #${v.vehicle_id} on a stale document`).toEqual([])
      }
    })
  })

  t('are stripped from the fleet document', () => {
    const all = path.join(API, 'all.json')
    if (!existsSync(all)) return
    const doc = readGenerated(all)

    /* 392 vehicles' worth of predictions is ~190 KB on a 292 KB document, for a
       view that never asks when a bus reaches a stop. */
    for (const v of doc.vehicles) {
      expect(v.predictions, `all.json #${v.vehicle_id}`).toBeUndefined()
    }
  })
})

describe('a canceled trip counts down nowhere', () => {
  t('publishes no predictions for a trip the schedule says is canceled', () => {
    /*
     * Two carriers now say a trip is canceled: the cached trips[].canceled in
     * the departures document, and schedule.canceled_trips rebuilt from live
     * TripUpdates every run. Predictions are gated on the vehicle's own
     * schedule_relationship, which is a third reading of the same feed — so
     * this asserts the three cannot disagree, because the visible failure is
     * the stop board printing CANCELED while the nearest-stop panel counts down
     * to the same bus on the same screen.
     *
     * Only testable since canceled_trips started being populated: it was []
     * on every route from the day it shipped, so this invariant held vacuously.
     */
    let canceledIds = 0
    eachRoute((doc, name) => {
      const canceled = new Set((doc.schedule && doc.schedule.canceled_trips) || [])
      canceledIds += canceled.size
      for (const v of doc.vehicles) {
        if (!v.in_service || !v.trip) continue
        if (!canceled.has(v.trip.trip_id)) continue
        expect(
          v.predictions,
          `${name} #${v.vehicle_id} is on canceled trip ${v.trip.trip_id} and still counts down`,
        ).toEqual([])
      }
    })
    expect(canceledIds, 'no canceled trip in the corpus, so nothing was checked').toBeGreaterThan(0)
  })
})

describe('the two panels tell one story', () => {
  t('never show different arrival times for the same bus at the same stop', (cmb) => {
    /*
     * near.js and stopboard.js both answer "when does this bus reach this
     * stop", on the same screen, for the same rider. Two sources for one
     * number is the failure this codebase keeps writing comments about
     * (allbuses.js on bunching, the stop-name pair in CLAUDE.md), and it is
     * invisible in a fixture: route 4 is small and mostly on time.
     *
     * Measured across this corpus, the feed's own prediction and the
     * scheduled+deviation estimate stopboard used to compute differ by over a
     * minute on 64% of comparable (stop, bus) pairs and by up to 53 minutes,
     * so agreement here is a real constraint rather than a rounding check.
     */
    let compared = 0
    /* Repeat-stop pairs seen. Not zero on this corpus; the assertion below says
       so, because a pair count of zero would make the loop-stop check vacuous. */
    let repeatPairs = 0
    eachRoute((doc, name) => {
      const rid = name.replace(/\.json$/, '')
      const depPath = path.join(API, 'departures', `${rid}.json`)
      if (!existsSync(depPath)) return
      const dep = readGenerated(depPath)
      if (dep.service_day_start_epoch === null) return

      for (const stop of dep.stops) {
        const groups = cmb.stopboard.nextAtStop(dep, doc, stop.stop_id, doc.generated_at, 4)
        for (const group of groups) {
          for (const d of group.departures) {
            if (!d.vehicle || d.canceled) continue
            if (!d.from_feed) continue
            /*
             * The stop board must be showing a number the FEED published for
             * this stop, not its own extrapolation. Compared against the set of
             * the vehicle's published times rather than against
             * fmt.predictionFor(), because that function answers "when next"
             * and a trip serving this stop twice has two right answers here --
             * 270 (stop, trip) pairs in this corpus do.
             */
            const published = (d.vehicle.predictions || [])
              .filter((p) => String(p[1]) === String(stop.stop_id))
              .map((p) => p[2])
            expect(
              published,
              `${name} stop ${stop.stop_id} bus ${d.vehicle.vehicle_id}`,
            ).toContain(d.predicted_at)

            const nearStop = cmb.near
              .stopsOnRoute(doc, d.trip.direction_id)
              .find((s) => s.stop_id === String(stop.stop_id))
            if (!nearStop) continue
            const mine = cmb.near
              .arrivals(doc, nearStop, doc.generated_at)
              .find((a) => a.vehicle.vehicle_id === d.vehicle.vehicle_id)
            if (!mine) continue
            /*
             * The two panels answer DIFFERENT questions at a stop a trip serves
             * twice: near says "when is it next here", the stop board lists each
             * scheduled departure separately. So near is never later than any of
             * the board's rows, and equals the earliest of them -- which is the
             * same number on every ordinary stop, and the honest relationship on
             * a loop. Asserting bare equality only held while both panels shared
             * the stop_id lookup that made the second pass wrong.
             */
            expect(
              mine.predicted_at,
              `${name} stop ${stop.stop_id} bus ${d.vehicle.vehicle_id}: near is later than a board row`,
            ).toBeLessThanOrEqual(d.predicted_at)
            expect(
              mine.predicted_at,
              `${name} stop ${stop.stop_id} bus ${d.vehicle.vehicle_id}: near does not match any board row`,
            ).toBe(Math.min.apply(null, published))
            compared++

            /*
             * Two rows for ONE trip at ONE stop must never share a time. That is
             * the loop-stop bug stated directly: fmt.predictionFor() matches on
             * stop_id alone and returns the soonest occurrence, so before the
             * fix both passes of a repeat-stop trip printed the first pass's
             * arrival. Two measurements on this corpus, and they are of different
             * things, so keep them apart: PRE-fix, 6 such pairs render on routes
             * 2, 30 and 383, and all 6 collapse to one time. POST-fix, 5 render,
             * on routes 30 and 383, and none collapse -- the sixth stops being a
             * pair because its second row now falls outside the grace window it
             * had been given the first pass's time to slip inside. The counter
             * below reaches 10 rather than 5 because it counts ROWS, once for
             * each side of a pair.
             *
             * The assertion above (the board's time is one the feed published)
             * cannot catch it: handing both rows the first pass's time satisfies
             * it, because that time IS in the published set.
             */
            const sameTripHere = group.departures.filter(
              (o) => o.vehicle && o.from_feed && o.trip.id === d.trip.id,
            )
            if (sameTripHere.length > 1) {
              const times = sameTripHere.map((o) => o.predicted_at)
              expect(
                new Set(times).size,
                `${name} stop ${stop.stop_id} trip ${d.trip.id}: two passes share one arrival`,
              ).toBe(times.length)
              repeatPairs++
            }
          }
        }
      }
    })
    expect(compared, 'no (stop, bus) pair was comparable across both panels').toBeGreaterThan(0)
    expect(
      repeatPairs,
      'no repeat-stop pair rendered, so the two-passes-one-time check proved nothing',
    ).toBeGreaterThan(0)
  })
})

describe('a stop board row never argues with itself', () => {
  t('shows no badge that contradicts the two times printed beside it', (cmb) => {
    /*
     * The row prints an arrival time, a scheduled time, and a badge. A reader
     * can subtract the first two — and once the arrival came from the feed
     * while the badge still came from the anchor deviation, the answer stopped
     * matching. Measured over this corpus before the fix: 1,438 of 4,205
     * rendered rows off by more than two minutes, and 325 where the badge and
     * the times pointed in OPPOSITE directions — a time three minutes early
     * beside a late badge.
     *
     * The rule now is that a row shows the badge only when the badge and the
     * time are the same computation, so the subtraction always comes out.
     */
    let rendered = 0
    let withBadge = 0
    eachRoute((doc, name) => {
      const rid = name.replace(/\.json$/, '')
      const depPath = path.join(API, 'departures', `${rid}.json`)
      if (!existsSync(depPath)) return
      const dep = readGenerated(depPath)
      if (dep.service_day_start_epoch === null) return

      for (const stop of dep.stops) {
        for (const group of cmb.stopboard.nextAtStop(dep, doc, stop.stop_id, doc.generated_at, 2)) {
          for (const d of group.departures) {
            if (!d.vehicle || d.canceled || d.suppressed || d.predicted_at === null) continue
            rendered++
            const node = cmb.stopboard.departureRow(d)
            if (!all(node, 'badge').length) continue
            withBadge++

            /* What the two printed times say, against what the badge asserts. */
            const shown = d.predicted_at - d.scheduled_at
            if (d.view.seconds === null) continue
            expect(
              Math.abs(shown - d.view.seconds),
              `${name} stop ${stop.stop_id} bus ${d.vehicle.vehicle_id}: badge says ` +
                `${d.view.seconds}s, the printed times say ${shown}s`,
            ).toBeLessThanOrEqual(1)
          }
        }
      }
    })
    expect(rendered, 'no rows were rendered at all').toBeGreaterThan(0)
    /* Not zero either — otherwise the assertion above is vacuous and the badge
       could have been dropped everywhere without anything noticing. */
    expect(withBadge, 'no row kept its badge, so nothing was actually checked').toBeGreaterThan(0)
  })
})

describe('the client answers a rider standing at a real stop, on every route', () => {
  t('finds arrivals whose buses are all headed the rider\'s way', (cmb) => {
    let routesWithAnAnswer = 0
    eachRoute((doc, name) => {
      for (const dir of [0, 1]) {
        const stops = cmb.near.stopsOnRoute(doc, dir)
        if (!stops.length) continue
        for (const stop of stops) {
          const list = cmb.near.arrivals(doc, stop, doc.generated_at)
          if (!list.length) continue
          routesWithAnAnswer++
          for (const a of list) {
            expect(a.vehicle.trip.direction_id, `${name} ${stop.stop_id}`).toBe(dir)
            expect(a.predicted_at, `${name} ${stop.stop_id}`).toBeGreaterThan(0)
          }
          /* Soonest first, on real data rather than a hand-built list. */
          const times = list.map((a) => a.predicted_at)
          expect(times, `${name} ${stop.stop_id} unsorted`).toEqual([...times].sort((a, b) => a - b))
        }
      }
    })
    expect(routesWithAnAnswer, 'no stop anywhere in the corpus had an arrival').toBeGreaterThan(0)
  })

  t('snaps to a stop on every route that publishes one', (cmb) => {
    eachRoute((doc, name) => {
      const stops = cmb.near.stopsOnRoute(doc, 0).concat(cmb.near.stopsOnRoute(doc, 1))
      if (!stops.length) return
      /* Stand exactly at a published stop: the snap must return that stop. */
      const target = stops[Math.floor(stops.length / 2)]
      const found = cmb.near.nearestStop(
        cmb.near.stopsOnRoute(doc, target.direction_id),
        target.lat,
        target.lon,
        8,
      )
      expect(found, `${name} found no stop`).not.toBeNull()
      expect(found.meters, `${name} snapped ${found.meters}m from a stop it is standing on`).toBeLessThan(1)
    })
  })
})
