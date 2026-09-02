/**
 * Who is going to run this trip — watch.coverageFor and how the stop board says it.
 *
 * The board printed "no bus reporting yet" for every departure with no vehicle joined to
 * it. That one sentence covered three states a rider acts on differently, and the harm is
 * on the record twice:
 *
 *   The first time, it covered a CANCELED trip. A kid waited for a bus that was never
 *   coming. stopboard.js:176 carries that note.
 *
 *   The second time, 2026-09-01, it covered the 16:49 run on block 4091 — a fresh
 *   pull-out with no bus assigned. The board said "no bus reporting yet" at 16:49, at
 *   16:55, at 16:59. CapMetro published the cancellation at 16:59, ten minutes after the
 *   bus was due out. For those ten minutes the sentence was identical to the one printed
 *   for a bus sitting on a normal layover.
 *
 * So the states are enumerated and each is pinned here. The one that matters most is
 * `overdue`, because it is the only warning that exists before the agency admits
 * anything — and `unknown`, because a stale feed must never be allowed to produce it.
 */
import { describe, expect, it } from 'vitest'
import { renderClient, textDeep } from './helpers/client.mjs'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'watch.js', 'stopboard.js'])

const t = (name, fn) =>
  it(name, (ctx) => {
    if (!client.cmb) ctx.skip(client.reason)
    if (!client.cmb.watch) ctx.skip('client scripts loaded but window.CMB.watch is not defined')
    return fn(client.cmb, client.document)
  })

const DAY = 1788350400 /* service day start */
const at = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number)
  return DAY + h * 3600 + m * 60
}

/*
 * Route 4's real afternoon shape on 2026-09-02, trimmed to three blocks:
 *   4090 — running; its bus is on the 16:15 WB and is due to run the 17:02 EB.
 *   4091 — a PM pull-out. Its first trip of the day is the 16:49 EB.
 *   4002 — running since morning. This is the block CapMetro canceled mid-afternoon.
 */
const DEP = () => ({
  service_day_start_epoch: DAY,
  trips: [
    { id: 'T-4090-WB', block_id: '4090', direction_id: 0, start_time: '16:15:00', headsign: '4 Mopac WB', canceled: false },
    { id: 'T-4090-EB', block_id: '4090', direction_id: 1, start_time: '17:02:00', headsign: '4 Shady EB', canceled: false },
    { id: 'T-4090-WB2', block_id: '4090', direction_id: 0, start_time: '17:57:00', headsign: '4 Mopac WB', canceled: false },
    { id: 'T-4091-EB', block_id: '4091', direction_id: 1, start_time: '16:49:00', headsign: '4 Shady EB', canceled: false },
    { id: 'T-4091-WB', block_id: '4091', direction_id: 0, start_time: '17:40:00', headsign: '4 Mopac WB', canceled: false },
    { id: 'T-4002-EB', block_id: '4002', direction_id: 1, start_time: '16:32:00', headsign: '4 Shady EB', canceled: false },
  ],
  stops: [], departures: {},
})

/** Bus 2810, out and working block 4090 on its 16:15 westbound run. */
const bus2810 = (nextTripId) => ({
  vehicle_id: '2810', label: '2810', route_id: '4', in_service: true,
  trip: { trip_id: 'T-4090-WB', direction_id: 0, start_time: '16:15:00', headsign: '4 Mopac WB' },
  block: {
    block_id: '4090', confidence: 'high', spans_routes: false, route_ids: ['4'],
    next_trip: nextTripId ? { trip_id: nextTripId, route_id: '4', route_short_name: '4', direction_id: 1 } : null,
    is_last_trip: false,
  },
})

const route = (vehicles, staleness) => ({
  route: { id: '4' },
  staleness: staleness || { level: 'fresh', suppress_adherence: false },
  vehicles: vehicles,
})

const tripById = (id) => DEP().trips.find((x) => x.id === id)

const cov = (cmb, tripId, vehicles, now, staleness) =>
  cmb.watch.coverageFor(DEP(), route(vehicles, staleness), tripById(tripId), now)

describe('a bus is already on the trip', () => {
  t('reports live and names it', (cmb) => {
    const out = cov(cmb, 'T-4090-WB', [bus2810(null)], at('16:25'))
    expect(out.state).toBe('live')
    expect(out.vehicle.vehicle_id).toBe('2810')
  })
})

describe('a bus is working the block but not this trip yet', () => {
  t('names the bus one run out, from the published successor claim', (cmb) => {
    const out = cov(cmb, 'T-4090-EB', [bus2810('T-4090-EB')], at('16:25'))
    expect(out.state).toBe('inbound')
    expect(out.vehicle.vehicle_id).toBe('2810')
    expect(out.runs_ahead).toBe(1)
  })

  t('still finds the bus further down the block, with no successor claim to read', (cmb) => {
    /* next_trip only ever names ONE hop. Two runs out there is nothing to match on, so
       the block id is what connects them — and the count comes from the trip list. */
    const out = cov(cmb, 'T-4090-WB2', [bus2810('T-4090-EB')], at('16:25'))
    expect(out.state).toBe('inbound')
    expect(out.vehicle.vehicle_id).toBe('2810')
    expect(out.runs_ahead).toBe(2)
  })

  t('declines to count runs when the bus is away on another route', (cmb) => {
    /* An interlined block is off this route for part of its day, so this route's trip
       list cannot count the gap. Null prints "is working this block" rather than a
       number invented from a partial list. */
    const away = bus2810('T-4090-EB')
    away.trip.trip_id = 'SOME-ROUTE-1-TRIP'
    const out = cov(cmb, 'T-4090-WB2', [away], at('16:25'))
    expect(out.state).toBe('inbound')
    expect(out.runs_ahead).toBeNull()
  })
})

describe('a block that has not pulled out', () => {
  t('says the run is unassigned rather than implying it is late', (cmb) => {
    /* Block 4091's first trip of the day IS the 16:49. There is no earlier run to watch
       and no vehicle to name, and that is benign at 16:25. */
    const out = cov(cmb, 'T-4091-EB', [bus2810(null)], at('16:25'))
    expect(out.state).toBe('unassigned')
    expect(out.vehicle).toBeNull()
  })

  t('covers the block\'s later runs too, not just its first', (cmb) => {
    const out = cov(cmb, 'T-4091-WB', [bus2810(null)], at('16:25'))
    expect(out.state).toBe('unassigned')
  })
})

describe('the run is overdue and nothing is on its block', () => {
  /*
   * 2026-09-01 reproduced. The 16:49 has come and gone, no bus has ever reported on
   * block 4091, and CapMetro has published nothing. This is the ten-minute window.
   */
  t('is still benign in the first two minutes, when a bus may just be slow to report', (cmb) => {
    expect(cov(cmb, 'T-4091-EB', [bus2810(null)], at('16:50')).state).toBe('unassigned')
  })

  t('turns to overdue once the run is late to exist', (cmb) => {
    const out = cov(cmb, 'T-4091-EB', [bus2810(null)], at('16:55'))
    expect(out.state).toBe('overdue')
    expect(Math.round(out.overdue_s / 60)).toBe(6)
  })

  t('does NOT fire while a bus is on the block, however late it is', (cmb) => {
    /* A late bus is not a missing bus. Block 4090's 17:02 with 2810 still out stays
       inbound well past its start time. */
    const out = cov(cmb, 'T-4090-EB', [bus2810('T-4090-EB')], at('17:30'))
    expect(out.state).toBe('inbound')
  })
})

describe('what may not be claimed', () => {
  t('says nothing at all on a stale feed', (cmb) => {
    /*
     * THE guard. A dead feed and a dead bus produce the identical observation — no
     * vehicle — so a stale snapshot must never produce `overdue`. Reading the silence of
     * a broken feed as news about a bus is the failure this exists to prevent.
     */
    const stale = { level: 'stale', suppress_adherence: true }
    expect(cov(cmb, 'T-4091-EB', [], at('16:55'), stale).state).toBe('unknown')
  })

  t('says nothing before the route document has loaded', (cmb) => {
    const out = cmb.watch.coverageFor(DEP(), null, tripById('T-4091-EB'), at('16:55'))
    expect(out.state).toBe('unknown')
  })

  t('says nothing about a trip carrying no block', (cmb) => {
    const orphan = { id: 'X', block_id: null, start_time: '16:49:00', canceled: false }
    const out = cmb.watch.coverageFor(DEP(), route([]), orphan, at('16:55'))
    expect(out.state).toBe('unknown')
  })
})

describe('what the rider actually reads', () => {
  const host = () => client.cmb.states.el('div', 'host')
  const draw = (cmb, d) => {
    const h = host()
    h.appendChild(cmb.stopboard.departureRow(d))
    return textDeep(h)
  }
  const row = (coverage, extra) => Object.assign({
    trip: { id: 'T', is_special: false }, canceled: false, coverage: coverage,
    vehicle: null, view: null, suppressed: false,
    scheduled_at: at('16:49'), predicted_at: null, from_feed: false,
    due_at: at('16:49'), seconds_until: 300, is_special: false,
  }, extra || {})

  t('names the covering bus instead of "no bus reporting yet"', (cmb) => {
    const text = draw(cmb, row({ state: 'inbound', vehicle: { vehicle_id: '2810', label: '2810' }, runs_ahead: 1 }))
    expect(text).toContain('2810')
    expect(text).toContain('becomes this run')
    expect(text).not.toContain('no bus reporting yet')
  })

  t('counts the runs when the bus is further out', (cmb) => {
    const text = draw(cmb, row({ state: 'inbound', vehicle: { vehicle_id: '2621', label: '2621' }, runs_ahead: 2 }))
    expect(text).toContain('2 runs away')
  })

  t('distinguishes a pull-out with no assignment from a bus that is late', (cmb) => {
    const text = draw(cmb, row({ state: 'unassigned', vehicle: null, runs_ahead: null }))
    expect(text).toContain('no bus assigned to it yet')
    expect(text).not.toContain('no bus reporting yet')
  })

  t('warns, and does not claim a cancellation nobody published', (cmb) => {
    const text = draw(cmb, row({ state: 'overdue', vehicle: null, overdue_s: 600 }))
    expect(text).toContain('NO BUS')
    expect(text).toContain('10 minutes ago')
    expect(text).toContain('has not announced a cancellation')
    /* It must not read as CANCELED — that is a different, stronger claim. */
    expect(text).not.toContain('CapMetro has canceled')
  })

  t('falls back to the old sentence when it genuinely cannot say', (cmb) => {
    expect(draw(cmb, row({ state: 'unknown' }))).toContain('no bus reporting yet')
  })

  t('a published cancellation still outranks everything', (cmb) => {
    const text = draw(cmb, row({ state: 'overdue', overdue_s: 600 }, { canceled: true }))
    expect(text).toContain('CANCELED')
    expect(text).not.toContain('NO BUS')
  })
})

describe('an overdue run stays on the board', () => {
  /*
   * Found by rendering it: GRACE_S drops a departure 90 seconds after it was due, and
   * `overdue` does not begin until 120. The warning was unreachable in the UI — the row
   * left the list half a minute before it could ever say anything.
   *
   * The disappearance is itself the harm this feature exists to fix. A run nobody
   * operated would silently drop off, and the rider would be looking at the NEXT
   * departure with nothing saying the one they came for never existed.
   */
  const depAt = (stopId, tripId, seconds) => {
    const d = DEP()
    d.stops = [{ stop_id: stopId, stop_name: 'Campbell/5th', direction_id: 1, stop_sequence: 1 }]
    d.departures = { [stopId]: [[seconds, d.trips.findIndex((t) => t.id === tripId)]] }
    return d
  }
  /* The 16:49 on block 4091, seen from its own stop. */
  const D = () => depAt('6243', 'T-4091-EB', 16 * 3600 + 49 * 60)

  t('is still listed six minutes after it was due', (cmb) => {
    const rows = cmb.stopboard.upcoming(D(), route([bus2810(null)]), '6243', 1, at('16:55'))
    expect(rows).toHaveLength(1)
    expect(rows[0].coverage.state).toBe('overdue')
  })

  t('is gone once it is old enough to be history rather than news', (cmb) => {
    const rows = cmb.stopboard.upcoming(D(), route([bus2810(null)]), '6243', 1, at('17:30'))
    expect(rows).toHaveLength(0)
  })

  t('still drops a run that a bus actually operated', (cmb) => {
    /* The control. With a bus on the block the state is inbound, not overdue, so the
       ordinary grace applies and the row leaves on time. */
    const onBlock = {
      vehicle_id: '2354', label: '2354', route_id: '4', in_service: true,
      trip: { trip_id: 'T-4091-EB', direction_id: 1, start_time: '16:49:00' },
      block: { block_id: '4091', confidence: 'high', next_trip: null, is_last_trip: false },
    }
    const rows = cmb.stopboard.upcoming(D(), route([onBlock]), '6243', 1, at('16:55'))
    expect(rows).toHaveLength(0)
  })
})

describe('an interlined block is not accused of being missing', () => {
  /*
   * "Nothing on the block" is read from THIS route's vehicle list, and a block that
   * interlines is away on another route for part of its day. Block 1010 leaves route 4 at
   * 16:19 and runs route 1 until midnight. A route 4 trip it came back for would look
   * abandoned while the bus was running fine two routes over — and a late bus reported
   * missing is the same class of lie as a missing bus reported on time.
   */
  const returning = () => {
    const d = DEP()
    /* Block 4090 leaves after its 16:15 run and comes back four hours later. */
    d.trips = d.trips.filter((t) => t.block_id !== '4090').concat([
      { id: 'T-4090-WB', block_id: '4090', direction_id: 0, start_time: '16:15:00', headsign: '4 Mopac WB', canceled: false },
      { id: 'T-4090-BACK', block_id: '4090', direction_id: 1, start_time: '20:30:00', headsign: '4 Shady EB', canceled: false },
    ])
    return d
  }

  t('says unknown, not overdue, across an interline-sized gap', (cmb) => {
    const out = cmb.watch.coverageFor(
      returning(), route([]), returning().trips.find((t) => t.id === 'T-4090-BACK'), at('20:40'))
    expect(out.state).toBe('unknown')
  })

  t('still calls it overdue across an ordinary layover', (cmb) => {
    /* The control. 16:15 to 17:02 is 47 minutes — a layover, not an excursion — so a
       block with no bus on it really is unaccounted for. */
    const out = cov(cmb, 'T-4090-EB', [], at('17:10'))
    expect(out.state).toBe('overdue')
  })

  t('always calls a pull-out overdue, since it has nowhere else to have been', (cmb) => {
    /* Block 4091's 16:49 is its first work of the day. No prior run means no excursion
       to be away on, so the gap guard never applies. This is the 2026-09-01 case. */
    const out = cov(cmb, 'T-4091-EB', [], at('16:55'))
    expect(out.state).toBe('overdue')
  })
})
