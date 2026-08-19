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
import { renderClient } from './helpers/client.mjs'
import { API, readGenerated, requireGenerated, routeFiles } from './helpers/webroot.mjs'
import { existsSync } from 'node:fs'
import path from 'node:path'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'rows.js', 'near.js'])

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
