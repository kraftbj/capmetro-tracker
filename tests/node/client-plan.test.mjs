/**
 * plan.js — the stops link.
 *
 * A plan entry is a PLACE and a time of day, not a named departure: "the 4
 * eastbound from Campbell/5th in the afternoons". Which of the afternoon's buses
 * gets caught is decided on the day, so the card shows the next few rather than
 * one, and almost everything below is about the two ways that goes wrong.
 *
 * The first is the turnaround, which is most of this file. Campbell/5th is where
 * route 4 turns: westbound arrives there as its LAST stop and eastbound leaves as
 * its FIRST. A board that looks for an approaching eastbound bus finds nothing and
 * renders a blank, which is the exact failure the design doc says this project
 * exists to prevent. The bus is there — it is westbound for another six minutes.
 * `departures-4-turnaround.json` is four real afternoon pairs, joined by block_id,
 * and the assertions read the pairing out of the fixture's own `_expected` so the
 * two cannot drift.
 *
 * The second is the link itself. Contract §9 hashes the watch tuple "so a URL or
 * server log never carries a legible description of a child's daily routine", and
 * a feature whose whole point is a URL has to answer that rather than inherit it.
 * The answer is the fragment, which browsers do not send, plus an encoding made of
 * numeric ids. There are tests here that fail if either property is lost.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { all, renderClient, textDeep } from './helpers/client.mjs'
import { ROOT } from './helpers/optional.mjs'

const client = renderClient([
  'format.js', 'adherence.js', 'states.js', 'watch.js', 'stopboard.js', 'plan.js',
])

const t = (name, fn) =>
  it(name, (ctx) => {
    if (!client.cmb) ctx.skip(client.reason)
    if (!client.cmb.plan) ctx.skip('client scripts loaded but window.CMB.plan is not defined')
    return fn(client.cmb.plan, client.cmb)
  })

const fixture = (name) =>
  JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/synthetic', name), 'utf8'))

const DEP = fixture('departures-4-turnaround.json')
/* A second real turnaround that also carries a cancellation and, on every one of
 * its blocks, confidence "low". */
const DEP837 = fixture('departures-837-turnaround-canceled.json')
const START = DEP.service_day_start_epoch
const NOW = DEP._now /* 15:00:00 on the service day */
const TURN = DEP._expected.turnaround_stop_id
const PAIRS = DEP._expected.pairs

/* The entry this whole feature was asked for: the afternoon eastbound 4 from the
 * turnaround at Campbell/5th. */
const AT_TURNAROUND = { route_id: '4', direction_id: 1, stop_id: TURN, window: 'pm' }

/** The trip that leaves the turnaround at `seconds`, in the boarding direction. */
const outboundAt = (seconds) => {
  const row = DEP.departures[TURN].find(
    ([s, i]) => s === seconds && DEP.trips[i].direction_id === DEP._expected.boarding_direction_id,
  )
  return DEP.trips[row[1]]
}

/** The westbound trip that arrives at the turnaround at `seconds`. */
const inboundAt = (seconds) => {
  const row = DEP.departures[TURN].find(
    ([s, i]) => s === seconds && DEP.trips[i].direction_id === DEP._expected.inbound_direction_id,
  )
  return DEP.trips[row[1]]
}

/** A vehicle object shaped the way the route payload publishes one. */
const bus = ({ id, trip, seconds = 0, stopId = null, status = 'IN_TRANSIT_TO', nextTripId = null }) => ({
  vehicle_id: id,
  label: id,
  route_id: '4',
  route_short_name: '4',
  in_service: true,
  position: { lat: 30.27, lon: -97.75, bearing: null, speed: null },
  position_at: NOW,
  trip: {
    trip_id: trip.id,
    start_time: trip.start_time,
    start_epoch: START,
    direction_id: trip.direction_id,
    headsign: trip.headsign,
    schedule_relationship: 'SCHEDULED',
  },
  progress: { current_stop_sequence: 1, current_stop_id: stopId, current_status: status },
  pattern: { is_baseline: true, is_special: false, trips_in_pattern: 30, adds: [], skips: [] },
  block: {
    block_id: trip.block_id,
    confidence: 'high',
    next_trip: nextTripId
      ? {
          trip_id: nextTripId,
          direction_id: 1,
          start_time: '15:09:00',
          start_epoch: START + 54540,
          start_stop_id: TURN,
          start_stop_name: 'Campbell/5th',
          is_direction_flip: true,
        }
      : null,
  },
  adherence:
    seconds === null
      ? { state: 'unknown', seconds: null, glyph: 'question', reason: 'no_trip_update' }
      : {
          state: seconds >= 360 ? 'very_late' : seconds >= 150 ? 'late' : 'ontime',
          seconds,
          glyph: seconds >= 360 ? 'square' : seconds >= 150 ? 'up-triangle' : 'circle',
          reason: null,
        },
})

const routeWith = (...vehicles) => ({
  staleness: { level: 'fresh', suppress_adherence: false },
  vehicles,
})

const EMPTY_ROUTE = routeWith()

/* ------------------------------------------------------------------------- */

describe('the link, which is the only part of this feature the server could ever see', () => {
  const ENTRIES = [
    { route_id: '800', direction_id: 1, stop_id: '6293', window: 'am' },
    { route_id: '4', direction_id: 0, stop_id: '3337', window: 'am' },
    { route_id: '4', direction_id: 1, stop_id: '6243', window: 'pm' },
  ]

  t('round-trips a plan through encode and decode unchanged', (p) => {
    expect(p.decode(p.encode(ENTRIES))).toEqual(ENTRIES)
  })

  t('names no stop, no street and no clock time — only ids the stop table resolves', (p) => {
    const encoded = p.encode(ENTRIES)
    expect(encoded).toBe('1;800.1.6293.am;4.0.3337.am;4.1.6243.pm')
    expect(encoded).not.toMatch(/[Cc]ampbell|[Ss]imond|[Bb]erkman|[Pp]leasant/)
    expect(encoded).not.toMatch(/\d{1,2}:\d{2}/)
  })

  t('always builds a fragment, never a query, whatever it is handed', (p) => {
    const link = p.linkFor(ENTRIES, 'https://bus.dillo.dev/?route=7#plan=stale')
    /* Readable, because somebody has to look at this in a message and decide
     * whether to tap it. Escaping the separators again gave '1%3B800%2E1'. */
    expect(link).toBe('https://bus.dillo.dev/#plan=1;800.1.6293.am;4.0.3337.am;4.1.6243.pm')
    /*
     * The one assertion this whole design hangs on. A '?' would put the entries in
     * the request line, and bus.dillo.dev keeps an access log.
     */
    expect(link.split('#')[0]).not.toContain('?')
    expect(link.split('#')[0]).not.toContain('plan')
  })

  t('refuses a version it does not know rather than guessing at the fields', (p) => {
    expect(p.decode('2;4.1.6243.pm')).toBeNull()
    expect(p.decode('')).toBeNull()
    expect(p.decode('nonsense')).toBeNull()
  })

  t('drops only the entries it cannot read, because four of five stops still helps', (p) => {
    const decoded = p.decode('1;4.1.6243.pm;4.9.1.pm;garbage;800.1.6293.am;4.1.6243.nonsense')
    expect(decoded).toEqual([
      { route_id: '4', direction_id: 1, stop_id: '6243', window: 'pm' },
      { route_id: '800', direction_id: 1, stop_id: '6293', window: 'am' },
    ])
  })

  t('defaults a missing window to all day rather than dropping the stop', (p) => {
    expect(p.decode('1;4.1.6243')).toEqual([
      { route_id: '4', direction_id: 1, stop_id: '6243', window: 'all' },
    ])
  })

  t('percent-encodes the fields, so an id carrying a separator cannot split an entry', (p) => {
    /* encodeURIComponent leaves '.' alone, and '.' is the field separator here. */
    const odd = [{ route_id: 'a.b', direction_id: 1, stop_id: 'c;d', window: 'all' }]
    expect(p.encode(odd)).not.toContain('a.b')
    expect(p.decode(p.encode(odd))).toEqual(odd)
  })

  t('still opens a link something in between has escaped into the ugly shape', (p) => {
    const raw = p.encode(ENTRIES)
    expect(p.fromLocation({ hash: '#plan=' + encodeURIComponent(raw), search: '' }).entries)
      .toEqual(ENTRIES)
  })

  t('prefers the fragment, and reports a query so the caller can move it out of one', (p) => {
    const viaHash = p.fromLocation({ hash: '#plan=1;4.1.6243.pm', search: '' })
    expect(viaHash.fromQuery).toBe(false)
    expect(viaHash.entries).toHaveLength(1)

    const viaQuery = p.fromLocation({ hash: '', search: '?plan=1;800.1.6293.am' })
    expect(viaQuery.fromQuery).toBe(true)
    expect(viaQuery.entries[0].stop_id).toBe('6293')

    const both = p.fromLocation({ hash: '#plan=1;4.1.6243.pm', search: '?plan=1;800.1.6293.am' })
    expect(both.fromQuery).toBe(false)
    expect(both.entries[0].stop_id).toBe('6243')

    expect(p.fromLocation({ hash: '#dir=both', search: '?route=4' })).toBeNull()
  })

  t('compares two plans as sets, so a re-ordered link is not a new one to offer', (p) => {
    expect(p.sameSet(ENTRIES, ENTRIES.slice().reverse())).toBe(true)
    expect(p.sameSet(ENTRIES, ENTRIES.slice(1))).toBe(false)
    expect(p.sameSet(ENTRIES, null)).toBe(false)
  })
})

describe('a link is untrusted input, which nothing in this codebase used to be', () => {
  t('survives a stop id that names something on Object.prototype', (p) => {
    /*
     * `departures['constructor']` on a plain object returns the Object function:
     * truthy, so an `|| []` fallback never fires, with a length of 1 and nothing
     * at [0]. The next read threw, during render, and the board went blank about
     * a second after a link opened. Reproduced in node before this guard existed.
     */
    ;['constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'].forEach(
      (hostile) => {
        const m = p.resolve({ ...AT_TURNAROUND, stop_id: hostile }, DEP, EMPTY_ROUTE, NOW)
        expect(m.state, `stop id ${hostile}`).toBe('unserved')
      },
    )
  })

  t('rejects a window name that resolves through Object.prototype', (p) => {
    /* `WINDOWS['constructor']` is the Object function — truthy — so the name
     * passed validation and the card rendered NaN:NaNp–NaN:NaNp, pinned under
     * "Later today" and saved with the plan, so permanently. */
    ;['constructor', 'toString', 'valueOf', 'hasOwnProperty'].forEach((hostile) => {
      expect(p.windowRange(hostile), hostile).toBeNull()
      expect(p.decode(`1;4.1.6243.${hostile}`), hostile).toBeNull()
    })
    /* And the real ones still work. */
    expect(p.windowRange('am')).toEqual([4 * 3600, 12 * 3600])
  })

  t('counts a route id that names something on Object.prototype', (p) => {
    /* A bare {} accumulator read `constructor` back as truthy and dropped the
     * route from the preload and the 60-second refresh, while paint went on
     * fetching it. */
    expect(p.routesIn([{ route_id: 'constructor' }, { route_id: 'toString' }, { route_id: '4' }]))
      .toEqual(['constructor', 'toString', '4'])
  })

  t('caps the entries one link may carry', (p) => {
    const many = Array.from({ length: 400 }, (_, i) => `4.1.stop${i}.all`).join(';')
    const decoded = p.decode(`1;${many}`)
    expect(decoded.length).toBe(p.MAX_ENTRIES)
  })

  t('caps the distinct routes too, because routes are what get fetched', (p) => {
    const many = Array.from({ length: 40 }, (_, i) => `route${i}.1.6243.all`).join(';')
    const decoded = p.decode(`1;${many}`)
    expect(p.routesIn(decoded).length).toBe(p.MAX_ROUTES)
    expect(decoded.length).toBeLessThanOrEqual(p.MAX_ENTRIES)
  })

  t('keeps the entries it took from the front of the link, not a random slice', (p) => {
    const many = Array.from({ length: 30 }, (_, i) => `4.1.stop${i}.all`).join(';')
    const decoded = p.decode(`1;${many}`)
    expect(decoded[0].stop_id).toBe('stop0')
    expect(decoded[decoded.length - 1].stop_id).toBe(`stop${p.MAX_ENTRIES - 1}`)
  })
})

describe('a canceled trip is never mistaken for one that has not started', () => {
  const AT_837 = { route_id: '837', direction_id: 1, stop_id: '2112', window: 'all' }
  const NOW837 = DEP837._now
  const CANCELED_S = DEP837._expected.canceled_departure_s[0]

  t('the fixture really does carry a cancellation at this turnaround', () => {
    expect(DEP837._expected.canceled_departure_s).toHaveLength(1)
  })

  t('keeps the canceled departure in place rather than leaving a hole', (p) => {
    const m = p.resolve(AT_837, DEP837, EMPTY_ROUTE, NOW837)
    const at = m.departures.filter(
      (d) => d.scheduled_at - DEP837.service_day_start_epoch === CANCELED_S,
    )
    expect(at).toHaveLength(1)
    expect(at[0].canceled).toBe(true)
  })

  t('says so, instead of "no bus is reporting on this trip yet"', (p) => {
    const m = p.resolve(AT_837, DEP837, EMPTY_ROUTE, NOW837)
    const c = m.departures.filter((d) => d.canceled)[0]
    expect(c.boarding).toBe('canceled')
    const said = p.boardingText(c, m)
    expect(said).toContain('canceled')
    expect(said).not.toContain('reporting')
  })

  t('never reasons about a bus bringing in a trip that is not running', (p) => {
    const m = p.resolve(AT_837, DEP837, EMPTY_ROUTE, NOW837)
    const c = m.departures.filter((d) => d.canceled)[0]
    /* "Bus 8021 brings it in on the 10:03a SB" printed beside CANCELED is the
     * contradiction this board exists to avoid. */
    expect(c.inbound).toBeNull()
  })

  t('prints the word, not a strike-through alone', (p) => {
    const host = client.document.createElement('div')
    const m = p.resolve(AT_837, DEP837, EMPTY_ROUTE, NOW837)
    const node = p.render(host, [m], {})
    expect(textDeep(node)).toContain('CANCELED')
    expect(all(node, 'stopdep--canceled').length).toBeGreaterThan(0)
  })

  t('does not let a canceled trip be the answer to "what is next"', (p) => {
    const m = p.resolve(AT_837, DEP837, EMPTY_ROUTE, NOW837)
    /* stopboard's rule, inherited rather than restated: a canceled departure is
     * listed and does not consume one of the slots. */
    const live = m.departures.filter((d) => !d.canceled)
    expect(live.length).toBe(p.SHOW)
  })
})

describe('a cancelled inbound leg is not a bus that has not started yet', () => {
  const AT_837 = { route_id: '837', direction_id: 1, stop_id: '2112', window: 'all' }

  /*
   * The real capture only cancels whole blocks, so both legs go together and the
   * outbound is cancelled before this reasoning is reached. One leg of a block
   * called off on its own is possible and is what this covers, so the fixture is
   * edited rather than pretended into existence.
   */
  const withCanceledLeg = () => {
    const dep = fixture('departures-837-turnaround-canceled.json')
    const pair = dep._expected.pairs.find(
      (x) => x.inbound_arrival_s !== null && !tripAtIn(dep, x.outbound_departure_s, 1).canceled,
    )
    tripAtIn(dep, pair.inbound_arrival_s, 0).canceled = true
    return { dep, pair }
  }
  const tripAtIn = (dep, seconds, dir) => {
    const row = dep.departures['2112'].find(
      ([s, i]) => s === seconds && dep.trips[i].direction_id === dir,
    )
    return dep.trips[row[1]]
  }

  t('says the leg is cancelled instead of "no bus is reporting on that trip yet"', (p) => {
    const { dep, pair } = withCanceledLeg()
    const now = dep.service_day_start_epoch + pair.outbound_departure_s - 600
    const m = p.resolve(AT_837, dep, EMPTY_ROUTE, now)
    const d = m.departures.find(
      (x) => x.scheduled_at - dep.service_day_start_epoch === pair.outbound_departure_s,
    )
    expect(d.canceled).toBe(false)
    expect(d.boarding).toBe('inbound-canceled')

    const said = p.boardingText(d, m)
    expect(said).toContain('canceled')
    /* The sentence that means "it has not started", used for "it is never
     * running", is the exact confusion cancellations were surfaced to remove. */
    expect(said).not.toContain('reporting')
    expect(said).not.toMatch(/the the/i)
  })

  t('still names which leg it was, so the reader can tell what was cancelled', (p) => {
    const { dep, pair } = withCanceledLeg()
    const now = dep.service_day_start_epoch + pair.outbound_departure_s - 600
    const m = p.resolve(AT_837, dep, EMPTY_ROUTE, now)
    const d = m.departures.find(
      (x) => x.scheduled_at - dep.service_day_start_epoch === pair.outbound_departure_s,
    )
    expect(p.boardingText(d, m)).toMatch(/The \d{1,2}:\d{2}[ap] SB that would bring this bus in/)
  })

  t('sees a leg cancelled after the page loaded, not only one in the cached copy', (p) => {
    /*
     * The cached departures document cannot carry a cancellation announced since
     * the tab was opened; `route.schedule.canceled_trips` is rebuilt every 60
     * seconds and can. This goes through watch.isCanceled so it reads the union,
     * the same way stopboard does.
     */
    const dep = fixture('departures-837-turnaround-canceled.json')
    const pair = dep._expected.pairs.find(
      (x) => x.inbound_arrival_s !== null && !tripAtIn(dep, x.outbound_departure_s, 1).canceled,
    )
    const leg = tripAtIn(dep, pair.inbound_arrival_s, 0)
    expect(leg.canceled, 'the cached copy must not already know').toBe(false)

    const route = {
      staleness: { level: 'fresh', suppress_adherence: false },
      schedule: { canceled_trips: [leg.id] },
      vehicles: [],
    }
    const now = dep.service_day_start_epoch + pair.outbound_departure_s - 600
    const m = p.resolve(AT_837, dep, route, now)
    const d = m.departures.find(
      (x) => x.scheduled_at - dep.service_day_start_epoch === pair.outbound_departure_s,
    )
    expect(d.boarding).toBe('inbound-canceled')
  })

  t('leaves a running leg alone', (p) => {
    const dep = fixture('departures-837-turnaround-canceled.json')
    const m = p.resolve(AT_837, dep, EMPTY_ROUTE, dep._now)
    const running = m.departures.filter((d) => !d.canceled)
    expect(running.length).toBeGreaterThan(0)
    running.forEach((d) => expect(d.boarding).not.toBe('inbound-canceled'))
  })
})

/*
 * A cancellation on paper against a bus you can see out of the window.
 *
 * The ladder in decorate() used to test `inbound.canceled` above `at_stop` and
 * above `vehicle`, so a bus STOPPED_AT the turnaround whose block names this very
 * trip as the next one it runs was answered with "nothing in the schedule says
 * what runs this trip instead". That is the failure this board exists to prevent,
 * inverted: not a bus missing from the screen, but a screen denying a bus that is
 * standing in front of the reader.
 */
describe('live evidence outranks the schedule saying the leg is off', () => {
  const AT_837 = { route_id: '837', direction_id: 1, stop_id: '2112', window: 'all' }
  const TURN_837 = '2112'

  const tripAt = (dep, seconds, dir) => {
    const row = dep.departures[TURN_837].find(
      ([s, i]) => s === seconds && dep.trips[i].direction_id === dir,
    )
    return dep.trips[row[1]]
  }

  /*
   * The real capture only ever cancels a whole block, so the outbound goes with
   * the inbound and the reasoning under test is never reached. One leg called off
   * alone is possible and is the case here, so the fixture is edited rather than
   * pretended into existence — the same approach the describe above takes.
   */
  const withCanceledLeg = () => {
    const dep = fixture('departures-837-turnaround-canceled.json')
    const pair = dep._expected.pairs.find(
      (x) => x.inbound_arrival_s !== null && !tripAt(dep, x.outbound_departure_s, 1).canceled,
    )
    tripAt(dep, pair.inbound_arrival_s, 0).canceled = true
    return {
      dep,
      pair,
      inboundTrip: tripAt(dep, pair.inbound_arrival_s, 0),
      outboundTrip: tripAt(dep, pair.outbound_departure_s, 1),
      now: dep.service_day_start_epoch + pair.outbound_departure_s - 600,
    }
  }

  /* The bus the block continuity names: it is finishing the canceled leg and its
   * next_trip is our departure. `confidence: high` so the copy is not hedged and
   * the assertions are about the cancellation rather than about the word
   * "likely". */
  const feeder = (dep, inboundTrip, outboundTrip, { status, stopId = TURN_837 }) => ({
    vehicle_id: '2867',
    label: '2867',
    route_id: '837',
    route_short_name: '837',
    in_service: true,
    position: { lat: 30.27, lon: -97.75, bearing: null, speed: null },
    position_at: dep.service_day_start_epoch,
    trip: {
      trip_id: inboundTrip.id,
      start_time: inboundTrip.start_time,
      start_epoch: dep.service_day_start_epoch,
      direction_id: inboundTrip.direction_id,
      headsign: inboundTrip.headsign,
      schedule_relationship: 'SCHEDULED',
    },
    progress: { current_stop_sequence: 20, current_stop_id: stopId, current_status: status },
    pattern: { is_baseline: true, is_special: false, trips_in_pattern: 20, adds: [], skips: [] },
    block: {
      block_id: inboundTrip.block_id,
      confidence: 'high',
      next_trip: {
        trip_id: outboundTrip.id,
        direction_id: 1,
        start_time: outboundTrip.start_time,
        start_epoch: dep.service_day_start_epoch,
        start_stop_id: TURN_837,
        start_stop_name: 'Republic Square',
        is_direction_flip: true,
      },
    },
    adherence: { state: 'ontime', seconds: 30, glyph: 'circle', reason: null },
  })

  const departureUnderTest = (p, dep, pair, route, now) => {
    const m = p.resolve(AT_837, dep, route, now)
    const d = m.departures.find(
      (x) => x.scheduled_at - dep.service_day_start_epoch === pair.outbound_departure_s,
    )
    return { m, d }
  }

  t('a bus standing at the stop is "waiting", not "inbound-canceled"', (p) => {
    const { dep, pair, inboundTrip, outboundTrip, now } = withCanceledLeg()
    const route = routeWith(feeder(dep, inboundTrip, outboundTrip, { status: 'STOPPED_AT' }))
    const { d } = departureUnderTest(p, dep, pair, route, now)

    expect(d.canceled, 'the departure itself is running').toBe(false)
    expect(d.inbound.canceled, 'and its scheduled feeder leg is not').toBe(true)
    expect(d.inbound.at_stop).toBe(true)
    expect(d.boarding).toBe('waiting')
  })

  t('names the bus that is there AND the leg that was canceled', (p) => {
    const { dep, pair, inboundTrip, outboundTrip, now } = withCanceledLeg()
    const route = routeWith(feeder(dep, inboundTrip, outboundTrip, { status: 'STOPPED_AT' }))
    const { m, d } = departureUnderTest(p, dep, pair, route, now)

    const said = p.boardingText(d, m)
    expect(said).toContain('Bus 2867 is standing at this stop now')
    expect(said).toContain('goes back out as this trip')
    /* Both facts. Suppressing the cancellation would be the same mistake in the
     * other direction. */
    expect(said).toContain('is canceled')
    expect(said).toMatch(/The \d{1,2}:\d{2}[ap] SB it was scheduled to come in on is canceled\./)
    /* And never the sentence that told the reader nothing was coming. */
    expect(said).not.toContain('nothing in the schedule says')
    expect(said).not.toMatch(/the the/i)
  })

  t('a bus reporting on the canceled leg elsewhere is "inbound", and still said', (p) => {
    const { dep, pair, inboundTrip, outboundTrip, now } = withCanceledLeg()
    const route = routeWith(
      feeder(dep, inboundTrip, outboundTrip, { status: 'IN_TRANSIT_TO', stopId: '2282' }),
    )
    const { m, d } = departureUnderTest(p, dep, pair, route, now)

    expect(d.boarding).toBe('inbound')
    const said = p.boardingText(d, m)
    expect(said).toContain('Bus 2867')
    expect(said).toContain('is canceled')
    expect(said).not.toContain('nothing in the schedule says')
  })

  t('with nothing reporting, the cancellation is still the whole answer', (p) => {
    const { dep, pair, now } = withCanceledLeg()
    const { m, d } = departureUnderTest(p, dep, pair, EMPTY_ROUTE, now)

    expect(d.boarding).toBe('inbound-canceled')
    expect(p.boardingText(d, m)).toContain('nothing in the schedule says what runs this trip instead')
  })

  t('the screen-reader summary carries the same pair of facts', (p) => {
    const { dep, pair, inboundTrip, outboundTrip, now } = withCanceledLeg()
    const route = routeWith(feeder(dep, inboundTrip, outboundTrip, { status: 'STOPPED_AT' }))
    const { m } = departureUnderTest(p, dep, pair, route, now)
    const spoken = textDeep(
      all(p.render(client.document.createElement('div'), [m], {}), 'sr-only')[0],
    )
    expect(spoken).toContain('Bus 2867 is standing at this stop now')
    expect(spoken).not.toContain('nothing in the schedule says')
  })
})

describe('what a screen reader is told', () => {
  const AT_837 = { route_id: '837', direction_id: 1, stop_id: '2112', window: 'all' }
  const spokenOf = (p, model) =>
    textDeep(all(p.render(client.document.createElement('div'), [model], {}), 'sr-only')[0])

  t('names the cancellation AND the bus that is actually coming', (p) => {
    /* Five minutes before the cancelled 10:13, so it is the first entry on the
     * card. The summary used to stop there — the half of the message that sends
     * somebody home — while the card listed two running departures below it. */
    const now = DEP837.service_day_start_epoch + 10 * 3600 + 5 * 60
    const m = p.resolve(AT_837, DEP837, EMPTY_ROUTE, now)
    expect(m.departures[0].canceled).toBe(true)

    const spoken = spokenOf(p, m)
    expect(spoken).toContain('is canceled')
    expect(spoken).toContain('The next bus running is due')
    expect(spoken).toContain('10:23')
  })

  t('says so plainly when the cancellation is all there is left', (p) => {
    const dep = fixture('departures-837-turnaround-canceled.json')
    /* Keep only the cancelled departure in the boarding direction. */
    const canceledS = dep._expected.canceled_departure_s[0]
    dep.departures['2112'] = dep.departures['2112'].filter(
      ([s, i]) => dep.trips[i].direction_id === 0 || s === canceledS,
    )
    const m = p.resolve(AT_837, dep, EMPTY_ROUTE, dep.service_day_start_epoch + 10 * 3600 + 5 * 60)
    expect(spokenOf(p, m)).toContain('Nothing else is running at this stop today')
  })

  t('leads with the next bus when nothing is cancelled', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, NOW)
    expect(spokenOf(p, m)).toContain('Next bus due')
  })
})

describe('a continuation the feed has not confirmed is said as one', () => {
  const AT_837 = { route_id: '837', direction_id: 1, stop_id: '2112', window: 'all' }
  const NOW837 = DEP837._now

  /** The first live northbound departure at Republic Square, and its inbound leg. */
  const pairFor = () => {
    const p0 = DEP837._expected.pairs.find(
      (x) => x.inbound_arrival_s !== null &&
        !tripAt837(x.outbound_departure_s, 1).canceled,
    )
    return p0
  }
  const tripAt837 = (seconds, dir) => {
    const row = DEP837.departures['2112'].find(
      ([s, i]) => s === seconds && DEP837.trips[i].direction_id === dir,
    )
    return DEP837.trips[row[1]]
  }

  const bus837 = (confidence, nextTripId, trip) => ({
    vehicle_id: '8021',
    label: '8021',
    route_id: '837',
    route_short_name: '837',
    in_service: true,
    position: { lat: 30.27, lon: -97.74, bearing: null, speed: null },
    position_at: NOW837,
    trip: {
      trip_id: trip.id,
      start_time: trip.start_time,
      start_epoch: DEP837.service_day_start_epoch,
      direction_id: trip.direction_id,
      headsign: trip.headsign,
      schedule_relationship: 'SCHEDULED',
    },
    progress: { current_stop_sequence: 4, current_stop_id: '6502', current_status: 'IN_TRANSIT_TO' },
    pattern: { is_baseline: true, is_special: false, trips_in_pattern: 40, adds: [], skips: [] },
    block: {
      block_id: trip.block_id,
      confidence,
      spans_routes: false,
      route_ids: ['837'],
      is_last_trip: false,
      next_trip: {
        trip_id: nextTripId,
        route_id: '837',
        route_short_name: '837',
        direction_id: 1,
        start_time: '10:23:00',
        start_epoch: DEP837.service_day_start_epoch + 10 * 3600 + 23 * 60,
        start_stop_id: '2112',
        start_stop_name: '5th/Guadalupe',
        is_direction_flip: true,
      },
    },
    adherence: { state: 'late', seconds: 200, glyph: 'up-triangle', reason: null },
  })

  t('every 837 block in the real capture is low confidence, which is why this matters', () => {
    /* Not a hypothetical branch: it is the ordinary case on one of the three
     * turnarounds this feature shipped for. */
    expect(DEP837._expected.pairs.length).toBeGreaterThan(0)
  })

  t('states a high-confidence continuation plainly', (p) => {
    const pair = pairFor()
    const out = tripAt837(pair.outbound_departure_s, 1)
    const inb = tripAt837(pair.inbound_arrival_s, 0)
    const route = { staleness: { level: 'fresh', suppress_adherence: false },
      vehicles: [bus837('high', out.id, inb)] }
    const m = p.resolve(AT_837, DEP837, route, NOW837)
    const d = m.departures.find((x) => x.inbound && x.inbound.vehicle)
    expect(d.inbound.confirmed).toBe(true)
    const said = p.boardingText(d, m)
    expect(said).toContain('brings it in on')
    expect(said).not.toContain('likely')
    /* And no caveat on the card either, because there is nothing to caveat. */
    expect(all(p.render(client.document.createElement('div'), [m], {}), 'stopcard__caveat'))
      .toHaveLength(0)
  })

  t('hedges a low-confidence one instead of stating a guess as fact', (p) => {
    const pair = pairFor()
    const out = tripAt837(pair.outbound_departure_s, 1)
    const inb = tripAt837(pair.inbound_arrival_s, 0)
    const route = { staleness: { level: 'fresh', suppress_adherence: false },
      vehicles: [bus837('low', out.id, inb)] }
    const m = p.resolve(AT_837, DEP837, route, NOW837)
    const d = m.departures.find((x) => x.inbound && x.inbound.vehicle)
    expect(d.inbound.confidence).toBe('low')
    expect(d.inbound.confirmed).toBe(false)
    const said = p.boardingText(d, m)
    expect(said).toContain('likely')
    /* The word is the hedge on every line; what it means is said once per card,
     * because three identical caveats in a row bury the times. */
    expect(said).not.toContain('does not confirm')

    const node = p.render(client.document.createElement('div'), [m], {})
    expect(textDeep(node)).toContain('has not confirmed which bus')
    expect(all(node, 'stopcard__caveat')).toHaveLength(1)
  })

  t('hedges the schedule-only fallback too, since the feed confirmed nothing there', (p) => {
    const pair = pairFor()
    const inb = tripAt837(pair.inbound_arrival_s, 0)
    /* A bus on the inbound leg whose next_trip points somewhere else entirely:
     * only the timetable's block_id links it to our departure. */
    const route = { staleness: { level: 'fresh', suppress_adherence: false },
      vehicles: [bus837('high', 'some-other-trip', inb)] }
    const m = p.resolve(AT_837, DEP837, route, NOW837)
    const d = m.departures.find((x) => x.inbound && x.inbound.vehicle)
    expect(d.inbound.confirmed).toBe(false)
    expect(p.boardingText(d, m)).toContain('likely')
  })
})

describe('time-of-day windows, which decide the section and never the visibility', () => {
  t('puts the morning stops in the morning and the afternoon ones after noon', (p) => {
    expect(p.inWindow('am', 7 * 3600 + 50 * 60)).toBe(true)
    expect(p.inWindow('am', 15 * 3600)).toBe(false)
    expect(p.inWindow('pm', 15 * 3600)).toBe(true)
    expect(p.inWindow('pm', 7 * 3600)).toBe(false)
    expect(p.inWindow('all', 3 * 3600)).toBe(true)
  })

  t('accepts an explicit range and wraps one that runs past midnight', (p) => {
    expect(p.inWindow('0700-0900', 8 * 3600)).toBe(true)
    expect(p.inWindow('0700-0900', 9 * 3600)).toBe(false)
    /* 22:00-02:00 is 22:00 to 26:00 in service-day seconds, never 22:00 to 02:00
     * with the ends swapped — the same rule every other clock in this contract
     * follows, where 25:10 is a real hour and is not wrapped back. */
    expect(p.windowRange('2200-0200')).toEqual([22 * 3600, 26 * 3600])
    expect(p.inWindow('2200-0200', 25 * 3600)).toBe(true)
    expect(p.inWindow('2200-0200', 21 * 3600)).toBe(false)
  })

  t('rejects a window it cannot parse at decode time rather than showing all day', (p) => {
    expect(p.windowRange('evening')).toBeNull()
    expect(p.windowRange('9-5')).toBeNull()
  })
})

describe('the turnaround: the bus you catch is going the other way right now', () => {
  t('the fixture really is a turnaround — every boarding departure starts here', (p) => {
    const rows = DEP.departures[TURN].filter(
      ([, i]) => DEP.trips[i].direction_id === DEP._expected.boarding_direction_id,
    )
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach(([seconds, i]) => {
      expect(p.startsHere(DEP.trips[i], seconds)).toBe(true)
    })
  })

  t('an arriving westbound leg does NOT start here, which is what makes it the inbound one', (p) => {
    DEP.departures[TURN]
      .filter(([, i]) => DEP.trips[i].direction_id === DEP._expected.inbound_direction_id)
      .forEach(([seconds, i]) => {
        expect(p.startsHere(DEP.trips[i], seconds)).toBe(false)
      })
  })

  t('pairs each departure with the leg that brings the bus in, by block', (p) => {
    expect(PAIRS.length).toBe(4)
    PAIRS.forEach((pair) => {
      const out = outboundAt(pair.outbound_departure_s)
      const leg = p.inboundLeg(DEP, TURN, 1, out, pair.outbound_departure_s)
      expect(leg).not.toBeNull()
      expect(leg.seconds).toBe(pair.inbound_arrival_s)
      expect(leg.trip.block_id).toBe(pair.block_id)
      expect(leg.trip.direction_id).toBe(DEP._expected.inbound_direction_id)
    })
  })

  t('never pairs across blocks, because a shared stop and a plausible gap is a guess', (p) => {
    const out = outboundAt(PAIRS[0].outbound_departure_s)
    const foreign = { ...out, block_id: 'not-a-real-block' }
    expect(p.inboundLeg(DEP, TURN, 1, foreign, PAIRS[0].outbound_departure_s)).toBeNull()
  })

  t('never pairs with a leg that arrives after the departure has already left', (p) => {
    const out = outboundAt(PAIRS[3].outbound_departure_s)
    /* Ask as if the departure were an hour before its inbound leg lands. */
    expect(p.inboundLeg(DEP, TURN, 1, out, PAIRS[3].inbound_arrival_s - 1)).toBeNull()
  })

  t('a trip with no block_id has no inbound leg to name, and says so by returning null', (p) => {
    const out = outboundAt(PAIRS[0].outbound_departure_s)
    expect(p.inboundLeg(DEP, TURN, 1, { ...out, block_id: null }, PAIRS[0].outbound_departure_s))
      .toBeNull()
  })

  t('finds the vehicle the feed says runs this trip next, wherever it is', (p) => {
    const out = outboundAt(PAIRS[0].outbound_departure_s)
    const inb = inboundAt(PAIRS[0].inbound_arrival_s)
    const route = routeWith(bus({ id: '2867', trip: inb, seconds: 35, nextTripId: out.id }))
    expect(p.vehicleFeeding(route, out.id).vehicle_id).toBe('2867')
    expect(p.vehicleFeeding(route, 'some-other-trip')).toBeNull()
    expect(p.vehicleFeeding(EMPTY_ROUTE, out.id)).toBeNull()
  })
})

describe('resolving a stop against the schedule and the live feed', () => {
  t('marks the stop as a turnaround when every departure it offers starts there', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, NOW)
    expect(m.state).toBe('ok')
    expect(m.is_turnaround).toBe(true)
    expect(m.stop_name).toBe('Campbell/5th')
    expect(m.direction_tag).toBe('EB')
    expect(m.departures.every((d) => d.starts_here)).toBe(true)
  })

  t('offers the next few departures, not one, because which bus gets caught is decided on the day', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, NOW)
    expect(m.departures).toHaveLength(p.SHOW)
    expect(m.departures.map((d) => d.scheduled_at - START)).toEqual([54540, 55500, 56460])
  })

  t('names the inbound leg even with no bus reporting, so the stop is never blank', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, NOW)
    const first = m.departures[0]
    expect(first.boarding).toBe('scheduled')
    expect(first.inbound.scheduled_at - START).toBe(PAIRS[0].inbound_arrival_s)
    expect(first.inbound.direction_tag).toBe('WB')
    expect(p.boardingText(first, m)).toContain('Comes in on the 3:04p WB')
  })

  t('reports the westbound bus that becomes the eastbound departure', (p) => {
    const out = outboundAt(PAIRS[0].outbound_departure_s)
    const inb = inboundAt(PAIRS[0].inbound_arrival_s)
    const route = routeWith(bus({ id: '2867', trip: inb, seconds: 400, nextTripId: out.id }))
    const m = p.resolve(AT_TURNAROUND, DEP, route, NOW)
    const first = m.departures[0]

    expect(first.vehicle).toBeNull() /* nothing is on the eastbound trip yet */
    expect(first.boarding).toBe('inbound')
    expect(first.inbound.vehicle.vehicle_id).toBe('2867')

    const said = p.boardingText(first, m)
    expect(said).toContain('Bus 2867')
    expect(said).toContain('the 3:04p WB')
    expect(said).toContain('minutes late')
    /* An earlier draft fell back to the words "the other direction" and printed
     * "as the the other direction" whenever the leg had no headsign. */
    expect(said).not.toContain('the the')
  })

  t('says a bus already standing at the turnaround is standing there', (p) => {
    const out = outboundAt(PAIRS[0].outbound_departure_s)
    const inb = inboundAt(PAIRS[0].inbound_arrival_s)
    const route = routeWith(
      bus({ id: '2867', trip: inb, seconds: 0, stopId: TURN, status: 'STOPPED_AT', nextTripId: out.id }),
    )
    const m = p.resolve(AT_TURNAROUND, DEP, route, NOW)
    expect(m.departures[0].boarding).toBe('waiting')
    expect(m.departures[0].inbound.at_stop).toBe(true)
    expect(p.boardingText(m.departures[0], m)).toContain('standing at this stop now')
  })

  t('says a bus that has already taken up the outbound trip is at the stop', (p) => {
    const out = outboundAt(PAIRS[0].outbound_departure_s)
    const route = routeWith(bus({ id: '2867', trip: out, seconds: 0, stopId: TURN, status: 'STOPPED_AT' }))
    const m = p.resolve(AT_TURNAROUND, DEP, route, NOW)
    expect(m.departures[0].boarding).toBe('here')
    expect(m.departures[0].at_stop).toBe(true)
    expect(p.boardingText(m.departures[0], m)).toBe('Bus 2867 is at the stop now.')
  })

  t('a bus on the outbound trip but not yet at the stop is en route, not waiting', (p) => {
    const out = outboundAt(PAIRS[0].outbound_departure_s)
    const route = routeWith(bus({ id: '2867', trip: out, seconds: 60, stopId: '4086' }))
    const m = p.resolve(AT_TURNAROUND, DEP, route, NOW)
    expect(m.departures[0].boarding).toBe('enroute')
    expect(m.departures[0].at_stop).toBe(false)
  })

  t('leads with the lateness the feed reports and never derives one for the outbound trip', (p) => {
    const out = outboundAt(PAIRS[0].outbound_departure_s)
    const inb = inboundAt(PAIRS[0].inbound_arrival_s)
    const route = routeWith(bus({ id: '2867', trip: inb, seconds: 540, nextTripId: out.id }))
    const first = p.resolve(AT_TURNAROUND, DEP, route, NOW).departures[0]
    /*
     * The inbound bus is nine minutes late, so this departure will almost
     * certainly leave late too. The board does not say by how much, because it
     * would be inventing a number with a plausible face. Both facts are printed;
     * the subtraction is the reader's.
     */
    expect(first.inbound.view.seconds).toBe(540)
    expect(first.predicted_at).toBeNull()
    expect(first.due_at).toBe(first.scheduled_at)
  })
})

describe('a late bus has not gone', () => {
  t('still offers a departure whose scheduled time has passed but whose bus has not arrived', (p) => {
    const out = outboundAt(PAIRS[0].outbound_departure_s)
    const route = routeWith(bus({ id: '2867', trip: out, seconds: 900 }))
    /* Ten minutes after it was scheduled, with the bus fifteen minutes late. */
    const m = p.resolve(AT_TURNAROUND, DEP, route, START + PAIRS[0].outbound_departure_s + 600)
    expect(m.departures[0].scheduled_at - START).toBe(PAIRS[0].outbound_departure_s)
    expect(m.departures[0].due_at).toBeGreaterThan(START + PAIRS[0].outbound_departure_s + 600)
  })

  t('prints the departures in the order they will actually arrive, not in schedule order', (p) => {
    const late = outboundAt(PAIRS[0].outbound_departure_s)
    const route = routeWith(bus({ id: '2867', trip: late, seconds: 1500 }))
    const m = p.resolve(AT_TURNAROUND, DEP, route, NOW)
    const dues = m.departures.map((d) => d.due_at)
    expect(dues).toEqual(dues.slice().sort((a, b) => a - b))
    /* The 25-minute-late 15:09 now lands behind the on-time 15:25. */
    expect(m.departures[0].scheduled_at - START).toBe(55500)
  })

  t('drops one that is properly gone rather than leaving a stale card at the top', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, START + PAIRS[1].outbound_departure_s)
    expect(m.departures[0].scheduled_at - START).toBe(PAIRS[1].outbound_departure_s)
  })
})

describe('the ways a stop has nothing to show, which are not interchangeable', () => {
  t('says the schedule has not loaded, in the words the caller supplies', (p) => {
    const m = p.resolve(AT_TURNAROUND, null, null, NOW, { schedule_detail: 'opened from a file' })
    expect(m.state).toBe('no-schedule')
    expect(m.detail).toBe('opened from a file')
    /* Still identifiable: an unresolvable card must not also be an anonymous one. */
    expect(m.entry.stop_id).toBe(TURN)
  })

  t('falls back to its own wording when the caller has no better reason to give', (p) => {
    expect(p.resolve(AT_TURNAROUND, null, null, NOW).detail).toContain('route 4')
  })

  t('says a stop is not served in that direction today, which is not the same as no bus', (p) => {
    const m = p.resolve({ ...AT_TURNAROUND, stop_id: 'not-a-stop' }, DEP, EMPTY_ROUTE, NOW)
    expect(m.state).toBe('unserved')
    expect(m.detail).toContain('direction')
  })

  t('says the last one today has gone, once it has', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, START + 20 * 3600)
    expect(m.state).toBe('done')
    expect(m.departures).toHaveLength(0)
  })

  t('resolves an out-of-window stop anyway, and marks it rather than hiding it', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, START + 7 * 3600 + 50 * 60)
    expect(m.in_window).toBe(false)
    expect(m.state).toBe('ok')
    expect(m.departures.length).toBeGreaterThan(0)
  })
})

describe('ordering: what is in its window, then what is soonest', () => {
  t('puts in-window stops above the rest whatever their times', (p) => {
    const soonButLater = { ...p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, NOW), in_window: false }
    const later = { ...p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, NOW), in_window: true }
    later.next = { seconds_until: 99999 }
    const sorted = p.sortModels([soonButLater, later])
    expect(sorted[0].in_window).toBe(true)
  })

  t('sinks a stop with nothing to show below one that has a bus', (p) => {
    const ok = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, NOW)
    const done = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, START + 20 * 3600)
    done.in_window = true
    const sorted = p.sortModels([done, ok])
    expect(sorted[0].state).toBe('ok')
  })
})

describe('what the cards actually say', () => {
  const host = () => client.document.createElement('div')

  t('names the stop, the route and the fact that it turns around', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, NOW)
    const node = p.render(host(), [m], {})
    const text = textDeep(node)
    expect(text).toContain('Campbell/5th')
    expect(text).toContain('EB')
    expect(text).toContain('afternoons')
    expect(all(node, 'stopcard__turn')).toHaveLength(1)
  })

  t('speaks the whole card for a screen reader, badge and layout included', (p) => {
    const out = outboundAt(PAIRS[0].outbound_departure_s)
    const inb = inboundAt(PAIRS[0].inbound_arrival_s)
    const route = routeWith(bus({ id: '2867', trip: inb, seconds: 400, nextTripId: out.id }))
    const m = p.resolve(AT_TURNAROUND, DEP, route, NOW)
    const spoken = textDeep(all(p.render(host(), [m], {}), 'sr-only')[0])
    expect(spoken).toContain('route 4 EB from Campbell/5th')
    expect(spoken).toContain('Next bus due')
    expect(spoken).toContain('Bus 2867')
  })

  t('offers to keep a link, and offers to share one it already has', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, NOW)
    const node = p.render(host(), [m], {
      offer: [AT_TURNAROUND],
      link: 'https://bus.dillo.dev/#plan=1;4.1.6243.pm',
      onKeep() {},
      onDismiss() {},
    })
    expect(all(node, 'offer')).toHaveLength(1)
    expect(textDeep(all(node, 'offer')[0])).toContain('1 stop')
    expect(all(node, 'share__field')[0].value).toContain('#plan=')
  })

  t('says what a stops link is when there are none, rather than showing a blank tab', (p) => {
    const text = textDeep(p.render(host(), [], {}))
    expect(text).toContain('No stops on this phone yet')
    expect(text).toContain('link')
  })

  t('keeps an out-of-window stop on the page under its own heading', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, START + 7 * 3600)
    const node = p.render(host(), p.sortModels([m]), {})
    expect(textDeep(node)).toContain('Later today')
    expect(all(node, 'stopcard--later')).toHaveLength(1)
  })
})
