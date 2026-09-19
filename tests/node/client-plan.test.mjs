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

  /*
   * The escaping only holds if nothing decodes the value before decode() splits
   * it. paramOf() used to percent-decode the whole parameter on the way out, so
   * a stop id of '62;93' arrived as '1;4.1.62;93.pm', the ';' was read as
   * structural, and the link resolved to stop '62' — a real stop, a different
   * place, a different bus, and nothing on screen suggesting anything was wrong.
   *
   * Every id in this feed is digits today. That is exactly why this is a test
   * and not an assumption.
   */
  describe('an id carrying the separators survives a real URL', () => {
    const NASTY = [
      { route_id: '4', direction_id: 1, stop_id: '62;93', window: 'pm' },
      { route_id: 'a.b', direction_id: 0, stop_id: '50%2F1', window: 'am' },
      { route_id: '8+0', direction_id: 1, stop_id: 'c;d.e%f+g', window: 'all' },
    ]

    t('through the fragment, which is where linkFor puts it', (p) => {
      const url = new URL(p.linkFor(NASTY, 'https://bus.dillo.dev/'))
      expect(url.hash).toContain('%3B')
      const found = p.fromLocation({ hash: url.hash, search: url.search })
      expect(found.fromQuery).toBe(false)
      expect(found.entries).toEqual(NASTY)
    })

    t('through the query string, which is the shape that gets rescued', (p) => {
      const raw = p.encode(NASTY)
      const url = new URL('https://bus.dillo.dev/?plan=' + raw)
      const found = p.fromLocation({ hash: url.hash, search: url.search })
      expect(found.fromQuery).toBe(true)
      expect(found.entries).toEqual(NASTY)
      /* `raw` is written straight back into the fragment by the caller, so it
       * has to survive being read a second time from where it lands. */
      expect(p.fromLocation({ hash: '#plan=' + found.raw, search: '' }).entries).toEqual(NASTY)
    })

    t('and the escaped-whole shape still opens, without decoding a good link twice', (p) => {
      const escaped = encodeURIComponent(p.encode(NASTY))
      expect(p.fromLocation({ hash: '#plan=' + escaped, search: '' }).entries).toEqual(NASTY)
    })
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

describe('a canceled inbound leg is not a bus that has not started yet', () => {
  const AT_837 = { route_id: '837', direction_id: 1, stop_id: '2112', window: 'all' }

  /*
   * The real capture only cancels whole blocks, so both legs go together and the
   * outbound is canceled before this reasoning is reached. One leg of a block
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

  t('says the leg is canceled instead of "no bus is reporting on that trip yet"', (p) => {
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

  t('still names which leg it was, so the reader can tell what was canceled', (p) => {
    const { dep, pair } = withCanceledLeg()
    const now = dep.service_day_start_epoch + pair.outbound_departure_s - 600
    const m = p.resolve(AT_837, dep, EMPTY_ROUTE, now)
    const d = m.departures.find(
      (x) => x.scheduled_at - dep.service_day_start_epoch === pair.outbound_departure_s,
    )
    expect(p.boardingText(d, m)).toMatch(/The \d{1,2}:\d{2}[ap] SB that would bring this bus in/)
  })

  t('sees a leg canceled after the page loaded, not only one in the cached copy', (p) => {
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

/*
 * merge(), which is what a second link does to a phone that already keeps stops.
 *
 * save() replaces, and that is correct when the reader is editing the set in
 * front of them. It is not what a second link means, and it used to be what a
 * second link did: one child's stops kept, the other child's link opened, the
 * obvious button tapped, and the first set gone with no warning and no undo.
 *
 * The caps are the interesting part, because a merge is the one operation that
 * can hit them. What is already kept must never be what gets dropped.
 */
describe('adding a second link to stops already kept', () => {
  const entry = (route, stop) => ({
    route_id: String(route), direction_id: 1, stop_id: String(stop), window: 'all',
  })

  t('keeps both sets, existing first', (p) => {
    const out = p.merge([entry(4, 6243)], [entry(800, 6293)])
    expect(out.entries).toEqual([entry(4, 6243), entry(800, 6293)])
    expect(out.added).toBe(1)
    expect(out.dropped).toBe(0)
  })

  t('does not duplicate a stop that is in both', (p) => {
    const out = p.merge([entry(4, 6243)], [entry(4, 6243), entry(800, 6293)])
    expect(out.entries).toEqual([entry(4, 6243), entry(800, 6293)])
    expect(out.added).toBe(1)
  })

  t('treats a different window at the same stop as a different entry', (p) => {
    const am = { ...entry(4, 6243), window: 'am' }
    const out = p.merge([entry(4, 6243)], [am])
    expect(out.entries).toHaveLength(2)
  })

  t('drops what is ARRIVING when the entry cap bites, never what is kept', (p) => {
    const kept = Array.from({ length: p.MAX_ENTRIES }, (_, i) => entry(4, 1000 + i))
    const out = p.merge(kept, [entry(4, 9999)])
    expect(out.entries).toEqual(kept)
    expect(out.added).toBe(0)
    expect(out.dropped, 'a dropped stop must be reported, not swallowed').toBe(1)
  })

  t('drops what is arriving when the ROUTE cap bites too', (p) => {
    const kept = Array.from({ length: p.MAX_ROUTES }, (_, i) => entry(i, 1000 + i))
    const out = p.merge(kept, [entry('newroute', 4242)])
    expect(out.entries).toEqual(kept)
    expect(out.dropped).toBe(1)
    /* A stop on a route already kept still fits: the cap is on routes, and that
     * one is paid for. */
    expect(p.merge(kept, [entry(0, 4242)]).added).toBe(1)
  })

  t('handles an empty or absent store, which is the ordinary first link', (p) => {
    expect(p.merge(null, [entry(4, 6243)]).entries).toEqual([entry(4, 6243)])
    expect(p.merge([], [entry(4, 6243)]).added).toBe(1)
    expect(p.merge([entry(4, 6243)], null).entries).toEqual([entry(4, 6243)])
  })

  t('never returns more than a link is allowed to carry', (p) => {
    const kept = Array.from({ length: p.MAX_ENTRIES }, (_, i) => entry(4, 1000 + i))
    const more = Array.from({ length: 20 }, (_, i) => entry(4, 5000 + i))
    const out = p.merge(kept, more)
    expect(out.entries.length).toBeLessThanOrEqual(p.MAX_ENTRIES)
    expect(p.routesIn(out.entries).length).toBeLessThanOrEqual(p.MAX_ROUTES)
  })
})

describe('what a screen reader is told', () => {
  const AT_837 = { route_id: '837', direction_id: 1, stop_id: '2112', window: 'all' }
  const spokenOf = (p, model) =>
    textDeep(all(p.render(client.document.createElement('div'), [model], {}), 'sr-only')[0])

  t('names the cancellation AND the bus that is actually coming', (p) => {
    /* Five minutes before the canceled 10:13, so it is the first entry on the
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
    /* Keep only the canceled departure in the boarding direction. */
    const canceledS = dep._expected.canceled_departure_s[0]
    dep.departures['2112'] = dep.departures['2112'].filter(
      ([s, i]) => dep.trips[i].direction_id === 0 || s === canceledS,
    )
    const m = p.resolve(AT_837, dep, EMPTY_ROUTE, dep.service_day_start_epoch + 10 * 3600 + 5 * 60)
    expect(spokenOf(p, m)).toContain('Nothing else is running at this stop today')
  })

  t('leads with the next bus when nothing is canceled', (p) => {
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

  t('the 837 fixture is the shape these tests need it to be', (p) => {
    /*
     * It used to be named for a claim it could not check — "every 837 block in
     * the capture is low confidence" — against a SCHEDULE document, which
     * carries no `confidence` field at all. Every confidence in this block is
     * hand-supplied by bus837(). It would have passed against a fixture with no
     * turnaround and no cancellation in it, so it now asserts the three
     * properties the tests below actually lean on.
     */
    expect(DEP837._expected.pairs.length, 'no inbound/outbound pairs to reason about')
      .toBeGreaterThan(0)
    expect(DEP837._expected.canceled_departure_s, 'no cancellation to render').toHaveLength(1)
    expect(p.resolve(AT_837, DEP837, EMPTY_ROUTE, NOW837).is_turnaround,
      'not a turnaround, so the whole block is about something else').toBe(true)
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

  /*
   * THE TWO VIEWS READ ONE RULE, OR THEY DISAGREE ABOUT ONE BUS.
   *
   * watch.js nulls a predictor whose claimant has no usable deviation — the
   * documented bus-2817 shape — so /route stops calling it a predictor and falls
   * to its coverage wording. This file's own matcher had no such filter, so it
   * still found the bus and, on a high grade, stated the continuation as FACT
   * while /route was hedging it. Same feed, same second, same vehicle, two
   * answers. Both now ask W.continuationHedged and cannot come apart.
   */
  /*
   * A bus /route WILL NOT TIME is a bus /stops may not time either.
   *
   * timingFor nulls the predictor when the claimant has no usable deviation --
   * the documented bus-2817 shape -- so the route board names the bus in its
   * coverage line and attaches no time at all. This file reached past that into
   * the raw vehicle list, called the continuation confirmed because the block
   * grade was fine, and printed "due here in 4 minutes": the booked time, with
   * no deviation to add, presented as a live estimate.
   *
   * The first version of this test asserted only that the two agree on the hedge
   * PREDICATE, which they did -- while still disagreeing about whether the bus
   * could be timed. That is the wrong invariant, and it is the one that let this
   * through.
   */
  t('does not time a bus the route board refused to time', (p) => {
    const pair = pairFor()
    const out = tripAt837(pair.outbound_departure_s, 1)
    const inb = tripAt837(pair.inbound_arrival_s, 0)
    const v = bus837('high', out.id, inb)
    v.adherence = { state: 'unknown', seconds: null, glyph: 'question', reason: 'no_trip_update' }
    const route = { staleness: { level: 'fresh', suppress_adherence: false }, vehicles: [v] }

    const m = p.resolve(AT_837, DEP837, route, NOW837)
    const d = m.departures.find((x) => x.inbound && x.inbound.vehicle)

    /* The premise: /route declined to make it a predictor. Without this the test
     * is about some other state entirely. */
    expect(d.predictor, 'a predictor, so the branch under test never ran').toBeNull()

    expect(d.inbound.confirmed, 'stated as fact what /route would not even time').toBe(false)
    expect(d.inbound.due_at, 'the booked time was dressed up as a live ETA').toBeNull()
    expect(d.inbound.seconds_until).toBeNull()

    const said = p.boardingText(d, m)
    expect(said).toContain('likely')
    expect(said, 'an ETA survived for a bus with no usable deviation').not.toContain('due here in')
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

  t('times the outbound trip from the inbound bus, and states it plainly when the feed confirmed it', (p) => {
    const out = outboundAt(PAIRS[0].outbound_departure_s)
    const inb = inboundAt(PAIRS[0].inbound_arrival_s)
    const route = routeWith(bus({ id: '2867', trip: inb, seconds: 540, nextTripId: out.id }))
    const first = p.resolve(AT_TURNAROUND, DEP, route, NOW).departures[0]
    /*
     * This assertion used to be the opposite, and the reversal is deliberate.
     *
     * It read: the board does not say by how much, because a predicted time derived from
     * another trip's lateness is an invention with a plausible face; both facts are
     * printed and the subtraction is the reader's. v0.6.1.0 settled that the other way for
     * the whole board, after a rider at 5th/Guadalupe was shown the 17:33 as their next bus
     * while their actual bus was ten minutes out -- the pending run had no predicted time,
     * so the past-time filter dropped it. The timing now lives in stopboard.upcoming(),
     * which is where this file gets its departures, so the number arrives here whether this
     * view wants it or not. Printing the booked time here while /route printed the
     * predicted one would be one departure wearing two times on two screens of one board.
     *
     * What carries the uncertainty instead is the hedge, and there is one of it.
     */
    expect(first.inbound.view.seconds).toBe(540)
    expect(first.predicted_at).toBe(first.scheduled_at + 540)
    expect(first.due_at).toBe(first.predicted_at)
    /*
     * And said as FACT here, which is the other half of the rule working. This fixture's
     * block carries `confidence: 'high'` and a next_trip pointing at this very trip, so the
     * feed has confirmed the continuation and the copy does not hedge. The hedge is driven
     * by what the feed actually says, not applied to every derived time -- the
     * schedule-only fallback above is the case that gets it.
     */
    expect(first.inbound.confirmed).toBe(true)
    expect(p.boardingText(first, { departures: [first] })).not.toContain('likely')
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

  t('keeps one that is overdue and drops one that is properly gone', (p) => {
    /*
     * Also reversed by v0.6.1.0, and for the reason the whole retention rule exists: a
     * departure whose booked time has passed and whose bus has not been is not gone, it is
     * LATE, and dropping it tells a reader their bus already left. A kid waited at a stop
     * for a bus that was never coming while the board said "no bus reporting yet".
     *
     * So the earlier pair is still at the top sixteen minutes after its booked time, and
     * the boundary is what makes that a rule rather than a leak: half an hour later it is
     * gone, and the next departure leads.
     */
    const overdue = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, START + PAIRS[1].outbound_departure_s)
    expect(overdue.departures[0].scheduled_at - START).toBe(PAIRS[0].outbound_departure_s)

    /* Well past the retention window: now it really has gone. */
    const gone = p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, START + PAIRS[0].outbound_departure_s + 40 * 60)
    expect(gone.departures[0].scheduled_at - START).not.toBe(PAIRS[0].outbound_departure_s)
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


/* ------------------------------------------------------------------------- */

describe('the two matchers that find the inbound bus have to agree', () => {
  const PAIR = PAIRS[0]
  const OUT = outboundAt(PAIR.outbound_departure_s)
  const LEG = inboundAt(PAIR.inbound_arrival_s)
  /* A leg on a DIFFERENT block, so it is not the one inboundLeg picks for OUT. */
  const OTHER_LEG = inboundAt(PAIRS[1].inbound_arrival_s)

  /*
   * `leg` is the schedule's answer (same block, other direction, latest arrival
   * before ours) and `feeder` is the feed's (whichever vehicle says next_trip is
   * our trip). They are normally the same trip and nothing checked it, so when
   * they were not, the card named a trip the bus is not on and timed the
   * departure as that trip's schedule plus a deviation measured on another.
   */
  t('does not name the scheduled leg when the feed puts the bus on a different trip', (p) => {
    const route = routeWith(
      bus({ id: 'B1', trip: OTHER_LEG, seconds: 600, nextTripId: OUT.id }))
    const m = p.resolve(AT_TURNAROUND, DEP, route, NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)

    expect(d.inbound.vehicle.vehicle_id, 'the bus is still the answer').toBe('B1')
    expect(d.inbound.trip, 'a leg the bus is not on must not be named').toBeNull()
    /* And with no leg there is no scheduled arrival to add a deviation to, so
     * there is no ETA to print — which is the number that was wrong. */
    expect(d.inbound.due_at).toBeNull()

    const said = p.boardingText(d, m)
    expect(said).not.toContain('brings it in on')
    expect(said).toContain('finishing another one first')
  })

  t('still names the leg when the feed puts the bus on exactly that trip', (p) => {
    const route = routeWith(
      bus({ id: 'B1', trip: LEG, seconds: 600, nextTripId: OUT.id }))
    const m = p.resolve(AT_TURNAROUND, DEP, route, NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)

    expect(d.inbound.trip.id).toBe(LEG.id)
    expect(d.inbound.due_at).toBe(START + PAIR.inbound_arrival_s + 600)
    expect(p.boardingText(d, m)).toContain('brings it in on')
  })

  /*
   * "Same block" alone is not a layover. Without a bound the search reaches back
   * across an interline — a block that touches this stop in the other direction
   * in the morning, goes away onto another route, and returns in the afternoon —
   * and names a leg hours old under the departure a reader is waiting for.
   */
  t('refuses an inbound leg further back than a layover can be', (p, cmb) => {
    const gap = cmb.watch.INTERLINE_GAP_S
    const arrival = PAIR.outbound_departure_s

    expect(p.inboundLeg(DEP, TURN, 1, OUT, arrival).trip.id).toBe(LEG.id)
    /* Same leg, same block, asked for by a departure far enough later that the
     * block was plausibly somewhere else in between. */
    expect(p.inboundLeg(DEP, TURN, 1, OUT, PAIR.inbound_arrival_s + gap + 1)).toBeNull()
    expect(p.inboundLeg(DEP, TURN, 1, OUT, PAIR.inbound_arrival_s + gap).trip.id).toBe(LEG.id)
  })
})

describe('a departure timed from the feed does not also wear a badge', () => {
  /*
   * The badge is only honest while it is the same number as the two times. On a
   * row timed from the feed's own prediction for THIS stop it is not: the bus is
   * ten minutes down overall and the feed models it recovering to one minute by
   * here, so a "+10m" badge sits beside "3:13p, Scheduled 3:13p" pointing the
   * other way. stopboard.js dropped the badge there and said why; this file was
   * rendering the same models and kept it, which is one departure wearing two
   * readings on two screens of one board.
   */
  const MID = '2106'                    /* 5th/Baylor, four stops along the outbound */
  const ANCHOR = '4086'                 /* where the bus actually is */
  const AT_MID = { route_id: '4', direction_id: 1, stop_id: MID, window: 'all' }
  const OUT = outboundAt(PAIRS[0].outbound_departure_s)

  const feedRoute = (overallLate, hereLate) => {
    const v = bus({ id: 'B9', trip: OUT, seconds: overallLate, stopId: ANCHOR, status: 'IN_TRANSIT_TO' })
    const stops = client.cmb.fmt.stopTimesForTrip(DEP, OUT.id)
    const anchor = stops.find((r) => r.stop_id === ANCHOR)
    const mid = stops.find((r) => r.stop_id === MID)
    v.progress.current_stop_sequence = 2
    v.adherence.against = {
      stop_id: ANCHOR, stop_name: ANCHOR,
      scheduled_at: anchor.scheduled_at, predicted_at: anchor.scheduled_at + overallLate,
    }
    v.predictions = [[4, MID, mid.scheduled_at + hereLate]]
    return routeWith(v)
  }

  t('the fixture really does produce a feed-sourced row, or the rest proves nothing', (p) => {
    const m = p.resolve(AT_MID, DEP, feedRoute(600, 60), NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)
    expect(d.from_feed, 'no feed-sourced row, so this block is vacuous').toBe(true)
    expect(d.view.state, 'and the badge it would have drawn disagrees with the time').toBe('very_late')
  })

  t('drops the badge, because it would point the other way from the times', (p) => {
    const m = p.resolve(AT_MID, DEP, feedRoute(600, 60), NOW)
    const card = p.render(client.document.createElement('div'), [m], {})
    expect(all(card, 'badge')).toHaveLength(0)
    /* And the scheduled time is printed unconditionally, because with the badge
     * gone it is the only thing left saying how late the bus is HERE. */
    expect(textDeep(card)).toContain('Scheduled')
  })

  t('says the bus state as a phrase instead, which can carry the scope', (p) => {
    const m = p.resolve(AT_MID, DEP, feedRoute(600, 60), NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)
    expect(p.boardingText(d, m)).toBe('Bus B9 is on this trip now, running very late overall.')
  })

  t('keeps the badge on an extrapolated row, where the two still agree', (p) => {
    const v = bus({ id: 'B9', trip: OUT, seconds: 600, stopId: ANCHOR })
    const m = p.resolve(AT_MID, DEP, routeWith(v), NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)
    expect(d.from_feed).toBe(false)
    expect(all(p.render(client.document.createElement('div'), [m], {}), 'badge').length)
      .toBeGreaterThan(0)
  })
})

/* ------------------------------------------------------------------------- */

/*
 * THE MUTATIONS THAT USED TO SURVIVE.
 *
 * Every test below was written because the rule it covers could be deleted from
 * plan.js and the whole suite stayed green. They are not new behavior; they are
 * the clauses that were already load-bearing and already unpinned, which is the
 * more dangerous shape — a comment explaining why something matters, above code
 * nothing would notice the loss of.
 */
describe('the clauses that nothing was holding down', () => {
  const OUT = outboundAt(PAIRS[0].outbound_departure_s)
  const LEG = inboundAt(PAIRS[0].inbound_arrival_s)

  /* A deep copy, so one edited fixture cannot leak into the next test. */
  const copyDep = () => JSON.parse(JSON.stringify(DEP))

  /*
   * `current_status === 'STOPPED_AT'` is the whole difference between a bus you
   * can see out of the window and one still driving towards you. Dropping it
   * turned every bus whose last reported stop is this one into "is standing at
   * this stop now" — a false certainty on the card built to avoid exactly that.
   */
  t('a bus heading for the turnaround is not standing at it', (p) => {
    const approaching = bus({
      id: 'B1', trip: LEG, seconds: 120, stopId: TURN,
      status: 'IN_TRANSIT_TO', nextTripId: OUT.id,
    })
    const m = p.resolve(AT_TURNAROUND, DEP, routeWith(approaching), NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)

    expect(d.inbound.at_stop).toBe(false)
    expect(d.boarding).toBe('inbound')
    expect(p.boardingText(d, m)).not.toContain('standing at this stop')
  })

  t('and the same bus, stopped, is', (p) => {
    const standing = bus({
      id: 'B1', trip: LEG, seconds: 120, stopId: TURN,
      status: 'STOPPED_AT', nextTripId: OUT.id,
    })
    const m = p.resolve(AT_TURNAROUND, DEP, routeWith(standing), NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)

    expect(d.inbound.at_stop).toBe(true)
    expect(d.boarding).toBe('waiting')
    expect(p.boardingText(d, m)).toContain('standing at this stop now')
  })

  /*
   * "Turns around here" is a claim about the STOP, so one departure that merely
   * happens to start here does not earn it. Both fixtures are pure turnarounds,
   * so `some` and `every` agree on them and the difference needed a stop built
   * to disagree: one boarding departure that starts somewhere else.
   */
  t('is not a turnaround when only SOME of its departures start here', (p) => {
    const dep = copyDep()
    const through = dep.trips.find((x) => x.id === OUT.id)
    /* Its published start is now earlier than its arrival here, so this stop is
     * somewhere it passes through rather than somewhere it begins. */
    through.start_time = '06:00:00'

    expect(p.resolve(AT_TURNAROUND, DEP, EMPTY_ROUTE, NOW).is_turnaround).toBe(true)
    expect(p.resolve(AT_TURNAROUND, dep, EMPTY_ROUTE, NOW).is_turnaround).toBe(false)
  })

  /*
   * The tie-break the comment calls the honest link. No block in either fixture
   * touches this stop twice before its departure, so "latest arrival not after
   * ours" and "earliest" pick the same row and the rule went unpinned. A block
   * that does touch it twice is an ordinary layover-then-return.
   */
  t('takes the LATEST inbound arrival on the block, not the first one found', (p) => {
    const dep = copyDep()
    const earlier = JSON.parse(JSON.stringify(LEG))
    earlier.id = LEG.id + '-earlier'
    earlier.start_time = '13:30:00'
    dep.trips.push(earlier)
    /* Same block, same direction, arriving here an hour before the real leg. */
    dep.departures[TURN].push([PAIRS[0].inbound_arrival_s - 3600, dep.trips.length - 1])

    const picked = p.inboundLeg(dep, TURN, 1, OUT, PAIRS[0].outbound_departure_s)
    expect(picked.trip.id, 'the earlier arrival won, so the tie-break is inverted')
      .toBe(LEG.id)
    expect(picked.seconds).toBe(PAIRS[0].inbound_arrival_s)
  })

  /*
   * The stop table carries a row per direction, and the two can be named
   * differently — "Simond SB" is a real one. Taking whichever row matched the id
   * first put the other direction's name on the card. Neither fixture names a
   * stop per direction, so nothing saw it.
   */
  t('names the stop in the direction being asked about', (p) => {
    const dep = copyDep()
    dep.stops.forEach(function (row) {
      if (row.stop_id === TURN) row.stop_name = 'Campbell/5th ' + (row.direction_id === 1 ? 'EB' : 'WB')
    })
    expect(p.resolve(AT_TURNAROUND, dep, EMPTY_ROUTE, NOW).stop_name).toBe('Campbell/5th EB')
  })

  /*
   * Two cards with nothing upcoming used to reach `Infinity - Infinity`, so the
   * comparator returned NaN and their order was whatever the sort did with it.
   */
  /*
   * The ordering rule around an absent departure. The `Infinity - Infinity`
   * this replaced returned NaN, which is outside sort()'s contract — but V8
   * answers `NaN > 0` exactly as it answers `0 > 0`, so no arrangement of this
   * fixture can tell the two apart, and no test here should claim to. What IS
   * observable, and is a real rule, is that a card with nothing upcoming sorts
   * below one that has a bus, and that two of them stay in the order they came.
   */
  t('sorts a stop with nothing upcoming below one that still has a bus', (p) => {
    const ended = NOW + 12 * 3600
    /* Both 'all', so they cannot differ on in_window and the comparator has to
     * reach the clause under test rather than being decided above it. */
    const a = p.resolve(
      { route_id: '4', direction_id: 1, stop_id: TURN, window: 'all' }, DEP, EMPTY_ROUTE, ended)
    const b = p.resolve(
      { route_id: '4', direction_id: 1, stop_id: '2106', window: 'all' }, DEP, EMPTY_ROUTE, ended)

    expect(a.in_window, 'decided above the clause under test').toBe(b.in_window)
    expect(a.state, 'likewise').toBe(b.state)
    expect(a.next, 'both cards must have nothing upcoming or this proves nothing').toBeFalsy()
    expect(b.next).toBeFalsy()
    /* Equal on every key, so they come back in the order they went in. */
    expect(p.sortModels([a, b]).map((m) => m.entry.stop_id)).toEqual([TURN, '2106'])
    expect(p.sortModels([b, a]).map((m) => m.entry.stop_id)).toEqual(['2106', TURN])

    /*
     * A card with a bus outranks one without, and that is decided ABOVE this
     * clause, on state: anything with nothing upcoming is `done` or `unserved`.
     * Asserted here so the ordering is pinned somewhere, and noted as belonging
     * to the rank rather than to the seconds — a test that claimed otherwise
     * would be pointing at the wrong line.
     */
    const running = p.resolve(
      { route_id: '4', direction_id: 1, stop_id: TURN, window: 'all' }, DEP, EMPTY_ROUTE, NOW)
    expect(running.next).toBeTruthy()
    expect(running.state).toBe('ok')
    expect(p.sortModels([b, running]).map((m) => m.entry.stop_id)).toEqual([TURN, '2106'])
  })
})

describe('the screen reader hears the hedge too', () => {
  const AT_837 = { route_id: '837', direction_id: 1, stop_id: '2112', window: 'all' }
  const spokenOf = (p, model) =>
    textDeep(all(p.render(client.document.createElement('div'), [model], {}), 'sr-only')[0])

  /*
   * Contract section 4 governs the CLAIM, not the medium it is made in. The
   * visual hedge was covered three times over; the spoken copy of the same
   * sentence could be deleted outright and nothing went red, which would leave a
   * screen-reader user the one reader told a low-confidence continuation as fact.
   */
  t('speaks the caveat when the continuation is not confirmed', (p) => {
    const pair = DEP837._expected.pairs[0]
    const out = DEP837.trips[DEP837.departures['2112']
      .find(([s, i]) => s === pair.outbound_departure_s && DEP837.trips[i].direction_id === 1)[1]]
    const inb = DEP837.trips[DEP837.departures['2112']
      .find(([s, i]) => s === pair.inbound_arrival_s && DEP837.trips[i].direction_id === 0)[1]]
    const v = {
      vehicle_id: '8021', label: '8021', route_id: '837', route_short_name: '837',
      in_service: true, position: { lat: 30.27, lon: -97.74, bearing: null, speed: null },
      position_at: DEP837._now,
      trip: {
        trip_id: inb.id, start_time: inb.start_time,
        start_epoch: DEP837.service_day_start_epoch, direction_id: inb.direction_id,
        headsign: inb.headsign, schedule_relationship: 'SCHEDULED',
      },
      progress: { current_stop_sequence: 4, current_stop_id: '6502', current_status: 'IN_TRANSIT_TO' },
      pattern: { is_baseline: true, is_special: false, trips_in_pattern: 40, adds: [], skips: [] },
      block: { block_id: inb.block_id, confidence: 'low', next_trip: { trip_id: out.id } },
      adherence: { state: 'late', seconds: 200, glyph: 'up-triangle', reason: null },
    }
    const m = p.resolve(AT_837, DEP837,
      { staleness: { level: 'fresh', suppress_adherence: false }, vehicles: [v] }, DEP837._now)
    const d = m.departures.find((x) => x.inbound && x.inbound.vehicle)
    expect(d.inbound.confirmed, 'nothing to caveat, so this proves nothing').toBe(false)

    const said = spokenOf(p, m)
    expect(said).toContain('likely')
    expect(said, 'the spoken line dropped the caveat the printed card carries')
      .toContain('has not confirmed which bus')
  })

  /* And the lateness, which could also be deleted from the spoken path alone. */
  t('speaks how late the next bus is', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP,
      routeWith(bus({ id: 'B1', trip: outboundAt(PAIRS[0].outbound_departure_s), seconds: 400 })), NOW)
    expect(spokenOf(p, m)).toMatch(/minutes late/)
  })
})

/* ------------------------------------------------------------------------- */

/*
 * "IS STANDING AT THIS STOP NOW" IS THE ONE SENTENCE A RIDER RUNS FOR.
 *
 * GTFS-RT publishes current_status beside a position and the two can disagree.
 * Bus 2354 on 2026-09-02 reported STOPPED_AT stop 6243 while its own coordinates
 * put it 5,715 m away at the Pleasant Valley yard, assigned to a run it had not
 * begun - and 6243 is Campbell/5th, the turnaround these cards exist for.
 * rows.js and allbuses.js already cross-check it; this view did not, so the one
 * claim that gets somebody out of the door was the one taken on trust.
 */
describe('a bus at the yard is not a bus at your stop', () => {
  const OUT = outboundAt(PAIRS[0].outbound_departure_s)
  const LEG = inboundAt(PAIRS[0].inbound_arrival_s)
  /* Campbell/5th's real coordinates, out of the fixture's own stop table. */
  const TURN_POS = DEP.stops.find((s) => s.stop_id === TURN)
  /* The Pleasant Valley yard, which is where 2354 actually was. */
  const YARD = { lat: 30.2258, lon: -97.6892 }

  /* A route payload that can place its stops, which is what lets the check fire.
   * `timepoints` is the shape fmt.stopPositions indexes. */
  const locatable = (...vehicles) => ({
    staleness: { level: 'fresh', suppress_adherence: false },
    timepoints: [{ stop_id: TURN, stop_name: TURN_POS.stop_name, lat: TURN_POS.lat, lon: TURN_POS.lon }],
    vehicles,
  })

  const standing = (position) => {
    const v = bus({ id: '2354', trip: LEG, seconds: 0, stopId: TURN, status: 'STOPPED_AT', nextTripId: OUT.id })
    v.position = Object.assign({ bearing: null, speed: null }, position)
    return v
  }

  t('the fixture can place the stop, or none of this fires', (p, cmb) => {
    const gap = cmb.fmt.stoppedAtGap(locatable(standing(YARD)), standing(YARD))
    expect(gap, 'stoppedAtGap saw nothing, so the tests below prove nothing').toBeTruthy()
    expect(Math.round(gap.meters / 100) * 100).toBeGreaterThan(1000)
  })

  t('does not say a bus is standing here when its position is at the yard', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP, locatable(standing(YARD)), NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)

    expect(d.inbound.at_stop, 'the feed said STOPPED_AT and the card believed it').toBe(false)
    expect(d.boarding).not.toBe('waiting')
    expect(p.boardingText(d, m)).not.toContain('standing at this stop')
  })

  t('still says so when the bus really is there', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP,
      locatable(standing({ lat: TURN_POS.lat, lon: TURN_POS.lon })), NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)

    expect(d.inbound.at_stop).toBe(true)
    expect(d.boarding).toBe('waiting')
    expect(p.boardingText(d, m)).toContain('standing at this stop now')
  })

  /*
   * And a payload that cannot place its stops is not evidence the bus is
   * elsewhere. Every existing fixture is this shape, so the check must fall
   * silent rather than refuse every bus on the board.
   */
  t('takes the feed at its word when the document cannot place the stop', (p) => {
    const m = p.resolve(AT_TURNAROUND, DEP, routeWith(standing(YARD)), NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)
    expect(d.inbound.at_stop).toBe(true)
    expect(d.boarding).toBe('waiting')
  })
})

/* ------------------------------------------------------------------------- */

describe('the guards and the sentences nothing was reading', () => {
  /*
   * merge() keeps two accumulators keyed by things off a link. The route one
   * decides the MAX_ROUTES cap, and on a bare `{}` a route id of `constructor`
   * reads back as the Object function rather than undefined - so the cap branch
   * never runs and the entry rides in over the limit. routesIn()'s identical
   * guard has a test; this one did not, one function away.
   */
  t('counts a route named after something on Object.prototype against the cap', (p) => {
    const full = []
    for (let i = 1; i <= p.MAX_ROUTES; i++) {
      full.push({ route_id: String(i), direction_id: 1, stop_id: '1', window: 'all' })
    }
    const hostile = { route_id: 'constructor', direction_id: 1, stop_id: '2', window: 'all' }
    const merged = p.merge(full, [hostile])

    expect(merged.entries, 'the cap let a seventh route through').toHaveLength(p.MAX_ROUTES)
    expect(merged.dropped).toBe(1)
    expect(p.routesIn(merged.entries)).not.toContain('constructor')
  })

  /*
   * The two sentences that say "no bus is visible here" were the two nothing
   * read - which on a turnaround card is the sentence that matters most, because
   * the card exists for the stop where no approaching bus can be seen. The
   * here / waiting / inbound sentences are each pinned by several tests.
   */
  t('names the bus that is on the trip, rather than any bus', (p) => {
    const out = outboundAt(PAIRS[0].outbound_departure_s)
    const m = p.resolve(AT_TURNAROUND, DEP,
      routeWith(bus({ id: '2867', trip: out, seconds: 60, stopId: '4086' })), NOW)
    const d = m.departures.find((x) => x.trip.id === out.id)

    expect(d.boarding).toBe('enroute')
    expect(p.boardingText(d, m)).toBe('Bus 2867 is on this trip now.')
  })

  t('says a turnaround with nothing reporting is missing its inbound leg too', (p) => {
    const dep = JSON.parse(JSON.stringify(DEP))
    const leg = inboundAt(PAIRS[0].inbound_arrival_s)
    /* Take the inbound leg away, so the departure has neither a bus nor a leg
     * and falls to the last rung of the ladder. */
    dep.departures[TURN] = dep.departures[TURN].filter(
      ([, i]) => dep.trips[i].id !== leg.id)

    const m = p.resolve(AT_TURNAROUND, dep, EMPTY_ROUTE, NOW)
    const d = m.departures.find((x) => x.trip.id === outboundAt(PAIRS[0].outbound_departure_s).id)

    expect(m.is_turnaround, 'not a turnaround, so the wording under test never fires').toBe(true)
    expect(d.boarding).toBe('none')
    expect(p.boardingText(d, m))
      .toBe('No bus is reporting on this trip yet, and the schedule does not say which one brings it in.')
  })

  t('and an ordinary stop with nothing reporting says that is normal', (p) => {
    const m = p.resolve(
      { route_id: '4', direction_id: 1, stop_id: '2106', window: 'all' }, DEP, EMPTY_ROUTE, NOW)
    expect(m.is_turnaround).toBe(false)
    expect(p.boardingText(m.departures[0], m))
      .toBe('No bus is reporting on this trip yet. That is normal until it starts its run.')
  })
})

/* ------------------------------------------------------------------------- */

/*
 * TWO RENDERERS OF ONE MODEL.
 *
 * CLAUDE.md states the rule for two producers of one value - stop-names.mjs
 * against stopnames.php, gtfsrt.php against CapMetro's JSON export - and the
 * reason it gives is that a divergence is invisible until the day it matters.
 * The stops view is the same shape one level up: it consumes stopboard's
 * per-departure model and then renders it again in its own vocabulary, so every
 * rendering decision stopboard documented has to be restated here correctly.
 *
 * Two of them had already come apart before anyone looked. The badge was
 * suppressed on a feed-sourced row in one renderer and not the other. The
 * section 4 hedge was computed twice and could call one departure a likelihood
 * on one screen and a fact on the other, in the same second, about the same bus.
 *
 * So this is the differential: one model, both renderers, asserting they agree
 * about the two things they are each free to get wrong. It is deliberately not
 * a copy of either one's expected text - it compares them to each other, which
 * is the only assertion that cannot be satisfied by updating one side.
 */
describe('the route row and the stop card cannot disagree about one departure', () => {
  /* Late enough that only the last pair is still upcoming, so the card holds one
   * departure and the comparison is unambiguous. */
  const LAST = PAIRS[PAIRS.length - 1]
  const LATE_NOW = START + LAST.outbound_departure_s - 120
  const OUT = outboundAt(LAST.outbound_departure_s)
  const LEG = inboundAt(LAST.inbound_arrival_s)
  /* Four stops along the outbound, because a turnaround stop is that trip's
   * FIRST stop - a bus on the trip is never ahead of it, so no feed prediction
   * for it can ever exist and a from_feed case anchored there proves nothing. */
  const MID = '2106'

  const bothRenderings = (p, cmb, route, entry) => {
    const m = p.resolve(entry, DEP, route, LATE_NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)
    expect(d, 'the departure under test is not on the card').toBeTruthy()

    /* The SAME object into both. plan.js's model is stopboard's, extended - so
     * departureRow can read it directly, which is what makes this a differential
     * rather than two fixtures that happen to look alike. */
    const routeHost = cmb.states.el('div', 'host')
    routeHost.appendChild(cmb.stopboard.departureRow(d))
    const cardHost = p.render(client.document.createElement('div'), [m], {})

    return {
      d,
      route: { text: textDeep(routeHost), badges: all(routeHost, 'badge').length },
      stops: { text: textDeep(cardHost), badges: all(cardHost, 'badge').length },
    }
  }

  const agree = (out) => {
    expect(out.stops.badges > 0, 'one renderer drew a lateness badge and the other did not')
      .toBe(out.route.badges > 0)
    expect(out.stops.text.includes('likely'),
      'one renderer hedged the continuation and the other stated it as fact')
      .toBe(out.route.text.includes('likely'))
  }

  t('when the bus on the trip is timed from the feed for this stop', (p, cmb) => {
    const rows = cmb.fmt.stopTimesForTrip(DEP, OUT.id)
    const anchor = rows[1]
    const here = rows.find((r) => r.stop_id === MID)
    const v = bus({ id: 'B9', trip: OUT, seconds: 600, stopId: anchor.stop_id })
    v.progress.current_stop_sequence = 2
    v.adherence.against = {
      stop_id: anchor.stop_id, stop_name: anchor.stop_id,
      scheduled_at: anchor.scheduled_at, predicted_at: anchor.scheduled_at + 600,
    }
    v.predictions = [[4, MID, here.scheduled_at + 60]]

    const out = bothRenderings(p, cmb, routeWith(v),
      { route_id: '4', direction_id: 1, stop_id: MID, window: 'all' })
    /* The premise. Without it the badges agree trivially and this test is a
     * pair of empty strings compared to each other. */
    expect(out.d.from_feed, 'not a feed-sourced row, so there is nothing to disagree about')
      .toBe(true)
    expect(out.d.view.state, 'and no badge would have been drawn either way').toBe('very_late')
    agree(out)
  })

  t('when nothing is on the trip and the feed confirmed which bus continues onto it', (p, cmb) => {
    const out = bothRenderings(p, cmb,
      routeWith(bus({ id: 'B1', trip: LEG, seconds: 300, nextTripId: OUT.id })), AT_TURNAROUND)
    expect(out.d.predictor, 'the route row takes its predictor branch').toBeTruthy()
    expect(out.d.inbound.confirmed).toBe(true)
    agree(out)
  })

  t('when the feed graded that continuation low', (p, cmb) => {
    const v = bus({ id: 'B1', trip: LEG, seconds: 300, nextTripId: OUT.id })
    v.block.confidence = 'low'
    const out = bothRenderings(p, cmb, routeWith(v), AT_TURNAROUND)
    expect(out.d.inbound.confirmed).toBe(false)
    agree(out)
  })

  /*
   * And the branch /route falls to when timingFor DECLINES the predictor, which
   * is where the two used to come apart hardest: the coverage wording stated the
   * continuation as fact at any confidence while the card was hedging it.
   */
  t('when the route board declined to call that bus a predictor at all', (p, cmb) => {
    const v = bus({ id: 'B1', trip: LEG, seconds: 300, nextTripId: OUT.id })
    v.block.confidence = 'low'
    v.adherence = { state: 'unknown', seconds: null, glyph: 'question', reason: 'no_trip_update' }
    const out = bothRenderings(p, cmb, routeWith(v), AT_TURNAROUND)
    expect(out.d.predictor, 'predictor still set, so the coverage branch never ran').toBeNull()
    expect(out.route.text, 'the coverage branch did not name the bus either').toContain('B1')
    agree(out)
  })

  t('when the feed named a continuation onto some other trip', (p, cmb) => {
    const out = bothRenderings(p, cmb,
      routeWith(bus({ id: 'B1', trip: LEG, seconds: 300, nextTripId: 'some-other-trip' })),
      AT_TURNAROUND)
    agree(out)
  })
})

/* ------------------------------------------------------------------------- */

/*
 * A STOP THE TRIP PASSES THROUGH IS NOT A TURNAROUND.
 *
 * The header on decorate() always said "does it START here, and if so which bus
 * is bringing it in". The gate was described and never written, so the inbound
 * reasoning ran everywhere -- and at an ordinary stop served both ways it found
 * a leg, because "same block, other direction, arrives before us, inside the
 * interline gap" is satisfied by any ordinary there-and-back.
 *
 * Stop 1368 (Pleasant Valley/5th) in the shipped fixture is that stop. All four
 * westbound departures start there; none of the three eastbound ones do, and
 * each has a westbound call on its own block 68 to 71 minutes earlier -- inside
 * INTERLINE_GAP_S, so the leg search reached it and the card named it.
 */
describe('an ordinary stop does not get the turnaround narrative', () => {
  const THROUGH = '1368'
  const AT_THROUGH = { route_id: '4', direction_id: 1, stop_id: THROUGH, window: 'all' }

  t('the fixture really is served both ways and passed through, or this proves nothing', (p) => {
    const m = p.resolve(AT_THROUGH, DEP, EMPTY_ROUTE, NOW)
    expect(m.departures.length).toBeGreaterThan(0)
    expect(m.is_turnaround, 'a turnaround, so the wrong stop was chosen').toBe(false)
    expect(m.departures.every((d) => d.starts_here === false),
      'some departure starts here, so this is not the pass-through case').toBe(true)
    /* And the leg search WOULD find one here -- same block, other direction,
     * before us, inside the gap. That is what makes the gate load-bearing. */
    const d0 = m.departures[0]
    expect(p.inboundLeg(DEP, THROUGH, 1, d0.trip, d0.scheduled_at - START),
      'no leg to suppress, so the gate is untested').toBeTruthy()
  })

  t('names no inbound leg, because the bus arrives on this very trip', (p) => {
    const m = p.resolve(AT_THROUGH, DEP, EMPTY_ROUTE, NOW)
    for (const d of m.departures) {
      expect(d.inbound, `${d.trip.id} was given an inbound leg at a pass-through stop`).toBeNull()
      expect(p.boardingText(d, m)).not.toContain('Comes in on')
      expect(p.boardingText(d, m)).not.toContain('brings it in')
    }
  })

  t('and prints no inbound ETA under a departure it could not belong to', (p) => {
    const card = p.render(client.document.createElement('div'), [p.resolve(AT_THROUGH, DEP, EMPTY_ROUTE, NOW)], {})
    expect(textDeep(card)).not.toContain('due here in')
  })

  /*
   * The bus that will run the trip next is still a fair thing to say here -- it
   * is what /route says -- so the feeder is deliberately NOT gated. Only the
   * inbound LEG, which is the turnaround-specific half, is.
   */
  t('still names the bus that will run the trip, without claiming a leg', (p) => {
    const m0 = p.resolve(AT_THROUGH, DEP, EMPTY_ROUTE, NOW)
    const target = m0.departures[0].trip
    const feeder = bus({ id: 'B7', trip: inboundAt(PAIRS[0].inbound_arrival_s), seconds: 120,
      nextTripId: target.id })
    const m = p.resolve(AT_THROUGH, DEP, routeWith(feeder), NOW)
    const d = m.departures.find((x) => x.trip.id === target.id)

    expect(d.inbound.vehicle.vehicle_id).toBe('B7')
    expect(d.inbound.trip, 'a leg was named at a pass-through stop').toBeNull()
    expect(d.inbound.due_at, 'an ETA was derived from a leg that is not ours').toBeNull()
    expect(p.boardingText(d, m)).toContain('finishing another one first')
  })
})

/*
 * A SNAPSHOT TOO OLD TO TIME IS TOO OLD TO ASSERT FROM.
 *
 * suppress_adherence means the board has decided the feed cannot say how late
 * anything is. coverageFor honours it and returns early, so /route names no bus.
 * vehicleFeeding reads route.vehicles with no such gate, so the card printed
 * "Scheduled - lateness unavailable" and, directly beneath it, a bus standing at
 * the stop and going back out as this trip, stated as fact.
 */
describe('a suppressed feed confirms nothing and places nobody', () => {
  const OUT = outboundAt(PAIRS[0].outbound_departure_s)
  const LEG = inboundAt(PAIRS[0].inbound_arrival_s)
  const stale = (...vehicles) => ({
    staleness: { level: 'stale', suppress_adherence: true, oldest_feed_age_s: 14400 },
    vehicles,
  })

  t('does not state the continuation as fact off a suppressed payload', (p) => {
    const v = bus({ id: 'B1', trip: LEG, seconds: 300, nextTripId: OUT.id })
    const m = p.resolve(AT_TURNAROUND, DEP, stale(v), NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)

    expect(d.suppressed, 'not suppressed, so this proves nothing').toBe(true)
    expect(d.inbound.confirmed).toBe(false)
    expect(p.boardingText(d, m)).toContain('likely')
  })

  t('does not say a bus is standing here on the strength of an old snapshot', (p) => {
    const v = bus({ id: 'B1', trip: LEG, seconds: 300, stopId: TURN, status: 'STOPPED_AT',
      nextTripId: OUT.id })
    const m = p.resolve(AT_TURNAROUND, DEP, stale(v), NOW)
    const d = m.departures.find((x) => x.trip.id === OUT.id)

    expect(d.inbound.at_stop).toBe(false)
    expect(d.boarding).not.toBe('waiting')
    expect(p.boardingText(d, m)).not.toContain('standing at this stop now')
  })

  t('and the card does not contradict its own lateness line', (p) => {
    const v = bus({ id: 'B1', trip: LEG, seconds: 300, stopId: TURN, status: 'STOPPED_AT',
      nextTripId: OUT.id })
    const text = textDeep(p.render(client.document.createElement('div'),
      [p.resolve(AT_TURNAROUND, DEP, stale(v), NOW)], {}))
    expect(text).toContain('lateness unavailable')
    expect(text).not.toContain('standing at this stop now')
  })
})
