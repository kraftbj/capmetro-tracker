/**
 * near.js — "which bus is coming to MY stop, and when".
 *
 * These tests exist because every wrong answer this panel could give is a
 * plausible one. A rider does not check a countdown against anything; they read
 * it and start walking. So the cases pinned here are the ones that produce a
 * confident number rather than an error:
 *
 *   - a bus that has already passed your stop, counted as approaching;
 *   - a bus going the other way, counted at all;
 *   - a stop matched by sequence rather than id, which route 4 breaks by running
 *     a 17-stop baseline on five services and a 19-stop one on three others;
 *   - a nearest-stop pick made from a fix too coarse to tell two stops apart;
 *   - a countdown measured against the device clock instead of generated_at.
 *
 * The last one is the quietest: a phone two minutes fast shaves two minutes off
 * every arrival on the board and nothing on screen looks wrong.
 */
import { describe, expect, it } from 'vitest'
import { all, renderClient, textDeep } from './helpers/client.mjs'
import { goldenRoute4, synthetic } from './helpers/fixtures.mjs'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'rows.js', 'near.js'])

const t = (name, fn) =>
  it(name, (ctx) => {
    if (!client.cmb) ctx.skip(client.reason)
    if (!client.cmb.near) ctx.skip('client scripts loaded but window.CMB.near is not defined')
    return fn(client.cmb, client.document)
  })

/** A stop from the golden fixture, by id, with the direction it belongs to. */
const stopById = (cmb, data, id) =>
  [0, 1]
    .flatMap((dir) => cmb.near.stopsOnRoute(data, dir))
    .find((s) => s.stop_id === String(id))

const draw = (cmb, document, data, opts) => {
  const host = document.createElement('div')
  cmb.near.render(host, data, {
    direction: 'both',
    onLocate() {},
    onClear() {},
    ...opts,
  })
  return host
}

describe('the stop list the user is snapped to', () => {
  t('carries the minor stops, not just the timepoints', (cmb) => {
    const data = goldenRoute4()
    const stops = cmb.near.stopsOnRoute(data, 0)
    const timepoints = data.timepoints.filter((tp) => tp.direction_id === 0)

    /*
     * The stop somebody is standing at is a minor one five times out of six:
     * route 4 publishes 6 timepoints and 48 stops. A timepoint-only snap would
     * put every rider several blocks from where they are.
     */
    expect(stops.length).toBeGreaterThan(timepoints.length)
    expect(stops.filter((s) => !s.is_timepoint).length).toBeGreaterThan(0)
  })

  t('keeps each stop in its own direction', (cmb) => {
    const data = goldenRoute4()

    expect(cmb.near.stopsOnRoute(data, 0).every((s) => s.direction_id === 0)).toBe(true)
    expect(cmb.near.stopsOnRoute(data, 1).every((s) => s.direction_id === 1)).toBe(true)
  })

  t('drops a stop with no coordinates rather than placing it at Null Island', (cmb) => {
    const data = goldenRoute4()
    data.timepoints[0].lat = 0
    data.timepoints[0].lon = 0

    const ids = cmb.near.stopsOnRoute(data, data.timepoints[0].direction_id).map((s) => s.stop_id)

    expect(ids).not.toContain(String(data.timepoints[0].stop_id))
  })
})

describe('snapping a location to a stop', () => {
  t('picks the stop the fix is actually standing at', (cmb) => {
    const data = goldenRoute4()
    const stops = cmb.near.stopsOnRoute(data, 0)
    const target = stops[3]

    /* Ten metres off the target: closer to it than to anything else. */
    const found = cmb.near.nearestStop(stops, target.lat + 0.0001, target.lon, 10)

    expect(found.stop.stop_id).toBe(target.stop_id)
    expect(found.meters).toBeLessThan(30)
  })

  t('measures distance with latitude and longitude in the right proportion', (cmb) => {
    /* A degree of longitude at Austin's latitude is cos(30.3°) = 0.863 of a
       degree of latitude. A formula that treats them alike is wrong by 16%,
       which is a whole stop. */
    const oneDegLat = cmb.near.metersBetween(30.0, -97.7, 31.0, -97.7)
    const oneDegLon = cmb.near.metersBetween(30.3, -97.0, 30.3, -98.0)

    expect(oneDegLon / oneDegLat).toBeCloseTo(Math.cos((30.3 * Math.PI) / 180), 2)
  })

  t('admits when the fix cannot tell the two nearest stops apart', (cmb) => {
    const data = goldenRoute4()
    const stops = cmb.near.stopsOnRoute(data, 0)

    /* A 2km accuracy radius cannot resolve stops a few hundred metres apart. */
    const coarse = cmb.near.nearestStop(stops, stops[3].lat, stops[3].lon, 2000)
    const sharp = cmb.near.nearestStop(stops, stops[3].lat, stops[3].lon, 5)

    expect(coarse.ambiguous).toBe(true)
    expect(coarse.runnerUp).not.toBeNull()
    expect(sharp.ambiguous).toBe(false)
  })

  t('returns nothing rather than guessing when there are no stops', (cmb) => {
    expect(cmb.near.nearestStop([], 30.26, -97.74, 10)).toBeNull()
  })

  t('reaches a stop a bus adds to the baseline ladder', (cmb) => {
    /*
     * Route 333 EB really does this: 33 trips serve Brush Country/William while
     * the EB ladder, built from the baseline pattern, does not list it — the
     * stop is filed under the other direction. A rider standing there was told
     * no bus was approaching while one was on its way to them.
     *
     * Built here from the fixture so the case is covered without a generated
     * webroot; tests/node/near-corpus.test.mjs holds the real route 333.
     */
    const data = goldenRoute4()
    const onlyInDir1 = cmb.near.stopsOnRoute(data, 1)[4]
    const dir0Bus = data.vehicles.find((v) => v.in_service && v.trip.direction_id === 0)
    expect(cmb.near.stopsOnRoute(data, 0).some((s) => s.stop_id === onlyInDir1.stop_id)).toBe(false)

    dir0Bus.predictions = dir0Bus.predictions.concat([
      [dir0Bus.progress.current_stop_sequence + 1, onlyInDir1.stop_id, data.generated_at + 300],
    ])

    const reachable = cmb.near.stopsOnRoute(data, 0).find((s) => s.stop_id === onlyInDir1.stop_id)
    expect(reachable, 'a stop a bus is predicted to serve is unreachable').toBeDefined()
    expect(reachable.is_pattern_add).toBe(true)
    /* And the geometry comes from the document, not from nowhere. */
    expect(reachable.lat).toBe(onlyInDir1.lat)

    const list = cmb.near.arrivals(data, reachable, data.generated_at)
    expect(list.map((a) => a.vehicle.vehicle_id)).toContain(dir0Bus.vehicle_id)
  })
})

describe('which buses are coming, and when', () => {
  t('reads the arrival time the feed published for that exact stop', (cmb) => {
    const data = goldenRoute4()
    const vehicle = data.vehicles.find((v) => v.in_service && v.predictions.length)
    const [seq, stopId, predictedAt] = vehicle.predictions[2]
    const stop = stopById(cmb, data, stopId)

    const list = cmb.near.arrivals(data, stop, data.generated_at)
    const mine = list.find((a) => a.vehicle.vehicle_id === vehicle.vehicle_id)

    expect(mine.predicted_at).toBe(predictedAt)
    expect(mine.seconds).toBe(predictedAt - data.generated_at)
    expect(mine.stops_away).toBe(seq - vehicle.progress.current_stop_sequence)
  })

  t('never lists a bus that has already passed the stop', (cmb) => {
    const data = goldenRoute4()

    /*
     * The server builds predictions only from stops at or ahead of the bus, so
     * presence in the list IS the approach — there is no separate test to get
     * wrong. Pinned here because the guarantee lives across two files: if the
     * runtime ever published passed stops, this client would count them.
     */
    for (const dir of [0, 1]) {
      for (const stop of cmb.near.stopsOnRoute(data, dir)) {
        for (const a of cmb.near.arrivals(data, stop, data.generated_at)) {
          const rowSeq = a.vehicle.predictions.find((p) => String(p[1]) === stop.stop_id)[0]
          expect(rowSeq).toBeGreaterThanOrEqual(a.vehicle.progress.current_stop_sequence)
        }
      }
    }
  })

  t('never lists a bus running the other direction', (cmb) => {
    const data = goldenRoute4()

    for (const dir of [0, 1]) {
      for (const stop of cmb.near.stopsOnRoute(data, dir)) {
        for (const a of cmb.near.arrivals(data, stop, data.generated_at)) {
          expect(a.vehicle.trip.direction_id).toBe(dir)
        }
      }
    }
  })

  t('matches a stop by id, not by sequence', (cmb) => {
    /*
     * Route 4 runs a 17-stop baseline on five services and a 19-stop one on
     * three others, so one physical stop does not carry one sequence across all
     * trips. Matching on sequence reads the wrong row and produces a confident
     * time for a stop somewhere else on the line.
     */
    const data = goldenRoute4()
    const vehicle = data.vehicles.find((v) => v.in_service && v.predictions.length > 1)
    const [, stopId, predictedAt] = vehicle.predictions[1]
    const stop = stopById(cmb, data, stopId)

    /* Shift every sequence on this vehicle; the id lookup must be unmoved. */
    vehicle.predictions = vehicle.predictions.map(([seq, id, at]) => [seq + 100, id, at])
    vehicle.progress.current_stop_sequence += 100

    const mine = cmb.near
      .arrivals(data, stop, data.generated_at)
      .find((a) => a.vehicle.vehicle_id === vehicle.vehicle_id)

    expect(mine.predicted_at).toBe(predictedAt)
  })

  t('sorts soonest first', (cmb) => {
    const data = goldenRoute4()
    let checked = 0
    for (const dir of [0, 1]) {
      for (const stop of cmb.near.stopsOnRoute(data, dir)) {
        const list = cmb.near.arrivals(data, stop, data.generated_at)
        if (list.length > 1) checked++
        for (let i = 1; i < list.length; i++) {
          expect(list[i].predicted_at).toBeGreaterThanOrEqual(list[i - 1].predicted_at)
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  t('reports no stops-away rather than zero when the feed does not place the bus', (cmb) => {
    const data = goldenRoute4()
    const vehicle = data.vehicles.find((v) => v.in_service && v.predictions.length)
    const stop = stopById(cmb, data, vehicle.predictions[0][1])
    vehicle.progress.current_stop_sequence = null

    const mine = cmb.near
      .arrivals(data, stop, data.generated_at)
      .find((a) => a.vehicle.vehicle_id === vehicle.vehicle_id)

    /* "0 stops away" means "it is here". Not knowing is a different fact. */
    expect(mine.stops_away).toBeNull()
  })
})

describe('the countdown', () => {
  t('is measured against generated_at, never the device clock', (cmb, document) => {
    const data = goldenRoute4()
    const vehicle = data.vehicles.find((v) => v.in_service && v.predictions.length)
    const stop = stopById(cmb, data, vehicle.predictions[0][1])

    const list = cmb.near.arrivals(data, stop, data.generated_at)
    const bySeconds = list[0].predicted_at - data.generated_at

    expect(list[0].seconds).toBe(bySeconds)
    /* And the fixture is old enough that a device-clock countdown would be
       wildly negative rather than subtly wrong, so this is a real distinction. */
    expect(list[0].predicted_at - Math.floor(Date.now() / 1000)).not.toBe(list[0].seconds)
  })

  t('says "due" rather than a rounded zero inside the last minute', (cmb) => {
    expect(cmb.near.countdown(0)).toBe('due')
    expect(cmb.near.countdown(59)).toBe('due')
    expect(cmb.near.countdown(-30)).toBe('due')
    expect(cmb.near.countdown(60)).toBe('1 min')
    expect(cmb.near.countdown(700)).toBe('12 min')
  })

  t('spells the countdown out for a screen reader', (cmb) => {
    expect(cmb.near.countdownSpoken(0)).toBe('due now')
    expect(cmb.near.countdownSpoken(60)).toBe('in 1 minute')
    expect(cmb.near.countdownSpoken(180)).toBe('in 3 minutes')
  })

  t('writes walking distance in units Austin uses', (cmb) => {
    expect(cmb.near.walk(30)).toBe('100 ft')
    /* Inside a phone fix's own error, a distance is a false precision. */
    expect(cmb.near.walk(4)).toBe('here')
    expect(cmb.near.walk(1609.344)).toBe('1.0 mi')
  })
})

describe('what the panel renders', () => {
  t('offers, rather than demands, a location on first paint', (cmb, document) => {
    const host = draw(cmb, document, goldenRoute4(), { geo: null })
    const text = textDeep(host)

    expect(text).toContain('Use my location')
    /* The pitch has to say where the fix goes, because the honest answer is
       "nowhere" and that is the reason to tap it. */
    expect(text).toContain('Stays in this browser')
  })

  t('names the stop and the walk to it once located', (cmb, document) => {
    const data = goldenRoute4()
    const stop = cmb.near.stopsOnRoute(data, 0)[2]
    const host = draw(cmb, document, data, {
      direction: 0,
      geo: { status: 'ok', lat: stop.lat, lon: stop.lon, accuracy: 8 },
    })
    const text = textDeep(host)

    expect(text).toContain(stop.stop_name_full || stop.stop_name)
    expect(text).toContain('away')
  })

  t('publishes no arrival time at all when the feed is too stale to have one', (cmb, document) => {
    const dead = synthetic('route-4-dead-cron.json')
    const stop = cmb.near.stopsOnRoute(dead, 0)[2]
    const host = draw(cmb, document, dead, {
      direction: 0,
      geo: { status: 'ok', lat: stop.lat, lon: stop.lon, accuracy: 8 },
    })
    const text = textDeep(host)

    /*
     * Silent failure: a countdown outlives the data it was computed from more
     * confidently than any other number on the board. The server empties the
     * list; the panel must say why rather than showing a bare "nothing coming",
     * which reads as "no bus is due" instead of "the board cannot tell".
     */
    expect(text).toContain('No arrival times while the feed is behind')
    /* Scoped to the arrivals list: the staleness sentence legitimately says
       "49 min old", and a whole-panel match would forbid saying so. */
    expect(all(host, 'near__arrivals')).toHaveLength(0)
    expect(all(host, 'near__when')).toHaveLength(0)
  })

  t('separates "nothing is coming" from "the board cannot tell"', (cmb, document) => {
    const data = goldenRoute4()
    data.vehicles.forEach((v) => {
      if (v.in_service) v.predictions = []
    })
    const stop = cmb.near.stopsOnRoute(data, 0)[2]
    const host = draw(cmb, document, data, {
      direction: 0,
      geo: { status: 'ok', lat: stop.lat, lon: stop.lon, accuracy: 8 },
    })

    expect(textDeep(host)).toContain('No bus is approaching this stop')
  })

  t('says a declined permission was declined, not that nothing is coming', (cmb, document) => {
    const host = draw(cmb, document, goldenRoute4(), {
      geo: { status: 'error', error: { code: 1 } },
    })
    const text = textDeep(host)

    expect(text).toContain('permission was declined')
    expect(text).toContain('Nothing was sent anywhere')
  })

  t('warns when the fix is too coarse to have picked the right stop', (cmb, document) => {
    const data = goldenRoute4()
    const stop = cmb.near.stopsOnRoute(data, 0)[2]
    const host = draw(cmb, document, data, {
      direction: 0,
      geo: { status: 'ok', lat: stop.lat, lon: stop.lon, accuracy: 3000 },
    })

    expect(textDeep(host)).toContain('not precise enough')
  })

  t('answers for both directions when the board is not filtered to one', (cmb, document) => {
    const data = goldenRoute4()
    const stop = cmb.near.stopsOnRoute(data, 0)[2]
    const host = draw(cmb, document, data, {
      direction: 'both',
      geo: { status: 'ok', lat: stop.lat, lon: stop.lon, accuracy: 8 },
    })

    /* A rider stands between a pair of stops, one per direction, and which one
       they want depends on where they are going — not on which is 4m closer. */
    expect(all(host, 'near__stop').length).toBe(2)
  })
})

describe('what the panel refuses to answer', () => {
  t('does not snap somebody who is nowhere near the route', (cmb, document) => {
    /*
     * nearestStop() is a minimum over a list and a minimum has no notion of
     * "too far". A desktop browser geolocating by IP can land tens of
     * kilometres out, and the panel would hand that person a countdown for an
     * Austin stop rendered exactly like a correct answer.
     */
    const data = goldenRoute4()
    const host = draw(cmb, document, data, {
      direction: 0,
      geo: { status: 'ok', lat: 32.7767, lon: -96.797, accuracy: 20 }, // Dallas
    })
    const text = textDeep(host)

    expect(text).toContain('do not look like you are on this route')
    expect(all(host, 'near__when')).toHaveLength(0)
    expect(all(host, 'near__arrivals')).toHaveLength(0)
  })

  t('marks no vehicle row when the fix is too far away', (cmb) => {
    const data = goldenRoute4()
    const ids = cmb.near.highlightedVehicleIds(data, {
      direction: 0,
      geo: { status: 'ok', lat: 32.7767, lon: -96.797, accuracy: 20 },
    })

    expect(ids).toEqual([])
  })

  t('says a fix has gone stale rather than answering for where you were', (cmb, document) => {
    /*
     * Somebody opens the board at the stop, boards the bus, and half an hour
     * later the panel is still confidently answering for the corner they left.
     * Nothing on screen looks broken, which is exactly why it has to say so.
     */
    const data = goldenRoute4()
    const stop = cmb.near.stopsOnRoute(data, 0)[2]
    const old = draw(cmb, document, data, {
      direction: 0,
      geo: {
        status: 'ok',
        lat: stop.lat,
        lon: stop.lon,
        accuracy: 8,
        at: Date.now() - cmb.near.FIX_MAX_AGE_MS - 1000,
      },
    })
    const fresh = draw(cmb, document, data, {
      direction: 0,
      geo: { status: 'ok', lat: stop.lat, lon: stop.lon, accuracy: 8, at: Date.now() },
    })

    expect(textDeep(old)).toContain('Your location was taken')
    expect(textDeep(fresh)).not.toContain('Your location was taken')
    /* The times still show — the fix being old is a caveat, not a refusal. */
    expect(all(old, 'near__when').length).toBeGreaterThan(0)
  })

  t('names the direction even when the board is filtered to one', (cmb, document) => {
    /*
     * Austin's two kerbs face each other across the street, well inside GPS
     * error, so a single-direction board is where the panel is MOST likely to
     * have picked the wrong side. Naming a stop with no direction there was the
     * one place a rider could be confidently sent to the opposite kerb.
     */
    const data = goldenRoute4()
    const stop = cmb.near.stopsOnRoute(data, 0)[2]
    const host = draw(cmb, document, data, {
      direction: 0,
      geo: { status: 'ok', lat: stop.lat, lon: stop.lon, accuracy: 8 },
    })

    expect(all(host, 'dirtag').length).toBe(1)
  })

  t('does not blame the reader when the browser refused a file:// page', (cmb, document) => {
    /*
     * A browser that will not grant a permission to an opaque file:// origin
     * reports the same code 1 a person tapping "Block" produces. Telling
     * somebody they declined when their browser decided for them sends them
     * hunting through settings they never touched. file:// IS a secure context
     * in Chromium — verified — so this is about the permission, not the API.
     */
    const data = goldenRoute4()
    const asFile = textDeep(
      draw(cmb, document, data, {
        geo: { status: 'error', error: { code: 1 } },
        window: { location: { protocol: 'file:' } },
      }),
    )
    const asHttps = textDeep(
      draw(cmb, document, data, {
        geo: { status: 'error', error: { code: 1 } },
        window: { location: { protocol: 'https:' } },
      }),
    )

    expect(asFile).toContain('open from a file on disk')
    expect(asHttps).toContain('permission was declined')
    expect(asHttps).not.toContain('open from a file on disk')
  })

  t('never asks at all when the page is not a secure context', (cmb, document) => {
    expect(cmb.near.canAsk({ navigator: { geolocation: {} }, isSecureContext: false }))
      .toBe('insecure')
    expect(cmb.near.canAsk({ navigator: {}, isSecureContext: true })).toBe('unsupported')
    expect(cmb.near.canAsk({ navigator: { geolocation: {} }, isSecureContext: true })).toBe('ok')

    const text = textDeep(draw(cmb, document, goldenRoute4(), { geo: { status: 'insecure' } }))
    expect(text).toContain('cannot ask for your location')
    expect(text).toContain('https')
  })

  t('tells a location failure apart from a browser that cannot locate at all', (cmb, document) => {
    const data = goldenRoute4()
    const say = (geo) => textDeep(draw(cmb, document, data, { geo }))

    /* Each branch says something different, because each has a different fix. */
    expect(say({ status: 'error', error: { code: 2 } })).toContain('could not get a fix')
    expect(say({ status: 'error', error: { code: 3 } })).toContain('took too long')
    expect(say({ status: 'unsupported' })).toContain('no location support')
    /* And none of them implies anything about the buses. */
    for (const geo of [{ status: 'error', error: { code: 2 } }, { status: 'unsupported' }]) {
      expect(say(geo)).not.toContain('No bus is approaching')
    }
  })
})

describe('one arrival time, not two', () => {
  t('agrees with the stop board about when a bus reaches a stop', (cmb) => {
    /*
     * near.js and stopboard.js both answer "when does this bus reach this
     * stop". Before predictions existed there was one answer; publishing a
     * second source risked two panels on one screen disagreeing about the same
     * bus. Measured across the corpus, the feed's own prediction and the
     * scheduled+deviation extrapolation differ by over a minute on 64% of
     * comparable pairs — so this is a real divergence, not a rounding one.
     *
     * Both now read fmt.predictionFor() first, so the accessor is shared and
     * this test fails the moment either grows its own copy.
     */
    const data = goldenRoute4()
    const vehicle = data.vehicles.find((v) => v.in_service && v.predictions.length)
    let checked = 0

    for (const [, stopId, predictedAt] of vehicle.predictions) {
      const viaFmt = cmb.fmt.predictionFor(vehicle, stopId)
      const stop = stopById(cmb, data, stopId)
      expect(viaFmt.predicted_at).toBe(predictedAt)
      if (!stop) continue
      const mine = cmb.near
        .arrivals(data, stop, data.generated_at)
        .find((a) => a.vehicle.vehicle_id === vehicle.vehicle_id)
      if (!mine) continue
      expect(mine.predicted_at).toBe(viaFmt.predicted_at)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })
})

describe('the marked vehicle row', () => {
  t('names the soonest arrival at the nearest stop', (cmb) => {
    const data = goldenRoute4()
    const stop = cmb.near.stopsOnRoute(data, 0)[2]
    const opts = {
      direction: 0,
      geo: { status: 'ok', lat: stop.lat, lon: stop.lon, accuracy: 8 },
    }

    const ids = cmb.near.highlightedVehicleIds(data, opts)
    const expected = cmb.near.arrivals(data, stop, data.generated_at)[0]

    expect(ids).toEqual(expected ? [expected.vehicle.vehicle_id] : [])
  })

  t('marks nothing at all until a location has been given', (cmb) => {
    const data = goldenRoute4()

    expect(cmb.near.highlightedVehicleIds(data, { direction: 0, geo: null })).toEqual([])
    expect(
      cmb.near.highlightedVehicleIds(data, { direction: 0, geo: { status: 'error' } }),
    ).toEqual([])
  })

  t('marks the row without reordering the list', (cmb, document) => {
    const data = goldenRoute4()
    const stop = cmb.near.stopsOnRoute(data, 0)[2]
    const ids = cmb.near.highlightedVehicleIds(data, {
      direction: 0,
      geo: { status: 'ok', lat: stop.lat, lon: stop.lon, accuracy: 8 },
    })

    const order = (highlightVehicleIds) => {
      const host = document.createElement('section')
      cmb.rows.render(host, data, { direction: 0, status: 'ok', highlightVehicleIds })
      return all(host, 'vrow').map((r) => r.className)
    }

    /*
     * Rows run in route order so they line up with the ladder beside them.
     * Promoting your bus to the top would break that correspondence, which is
     * the whole reason the order exists — so the marker must be a marker and
     * nothing more.
     */
    expect(order(ids).length).toBe(order([]).length)
    expect(order(ids).filter((c) => c.includes('is-yours')).length).toBe(ids.length)
    expect(order([]).some((c) => c.includes('is-yours'))).toBe(false)
  })

  t('writes the mark into the row label, not colour alone', (cmb, document) => {
    const data = goldenRoute4()
    const stop = cmb.near.stopsOnRoute(data, 0)[2]
    const ids = cmb.near.highlightedVehicleIds(data, {
      direction: 0,
      geo: { status: 'ok', lat: stop.lat, lon: stop.lon, accuracy: 8 },
    })
    if (!ids.length) return

    const host = document.createElement('section')
    cmb.rows.render(host, data, { direction: 0, status: 'ok', highlightVehicleIds: ids })

    const labels = all(host, 'vrow__main').map((n) => n.getAttribute('aria-label') || '')
    expect(labels.filter((l) => l.includes('next bus at your nearest stop')).length).toBe(1)
    expect(textDeep(host)).toContain('next at your stop')
  })
})
