/**
 * "Stopped at" checked against the feed's own coordinates.
 *
 * GTFS-RT publishes current_status beside a position and the two can disagree. Bus 2354
 * on 2026-09-02 reported STOPPED_AT stop 6243 (Campbell/5th) at 16:34 while its own
 * coordinates put it at the Pleasant Valley yard, 5,715 m away, deadheading to a run that
 * had not started yet. The board printed "stopped at stop 6243" and printed the
 * contradicting position four lines below it, in the same expanded row.
 *
 * That is what the feed looks like when a vehicle is assigned to a trip it has not begun:
 * sequence 1, STOPPED_AT, standing in for "has not departed". Read literally it is a
 * false claim about where a bus is, and it is the kind a rider acts on — "it is at my
 * stop" is the one sentence that makes somebody run for a door.
 *
 * The numbers below are the real ones from that vehicle.
 */
import { describe, expect, it } from 'vitest'
import { all, renderClient } from './helpers/client.mjs'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'rows.js'])

const t = (name, fn) =>
  it(name, (ctx) => {
    if (!client.cmb) ctx.skip(client.reason)
    if (!client.cmb.fmt) ctx.skip('client scripts loaded but window.CMB.fmt is not defined')
    return fn(client.cmb, client.document)
  })

/* Campbell/5th is a route 4 timepoint; 7th/Pleasant Valley is one of its minor stops. */
const ROUTE = () => ({
  route: { id: '4' },
  staleness: { level: 'fresh', suppress_adherence: false },
  timepoints: [
    {
      stop_id: '6243', stop_name: 'Campbell/5th', stop_sequence: 1, direction_id: 1,
      lat: 30.275026, lon: -97.764825,
      minor_stops: [
        { stop_id: '3337', stop_name: '7th/Pleasant Valley', stop_sequence: 2, lat: 30.260388, lon: -97.710078 },
      ],
    },
  ],
  vehicles: [],
})

/* Bus 2354's real report: parked at the yard, claiming to be at the west terminus. */
const bus = (over) => Object.assign({
  vehicle_id: '2354', label: '2354', route_id: '4', in_service: true,
  position: { lat: 30.25777, lon: -97.70877 },
  progress: { current_stop_sequence: 1, current_stop_id: '6243', current_status: 'STOPPED_AT' },
}, over || {})

const gap = (cmb, v, data) => cmb.fmt.stoppedAtGap(data === undefined ? ROUTE() : data, v)

describe('the contradiction is caught and measured', () => {
  t('reports the real 5.7 km gap for bus 2354', (cmb) => {
    const out = gap(cmb, bus())
    expect(out).not.toBeNull()
    expect(out.stop_id).toBe('6243')
    expect(out.stop_name).toBe('Campbell/5th')
    /* Against the independently computed haversine for those two points. */
    expect(Math.round(out.meters)).toBeGreaterThan(5700)
    expect(Math.round(out.meters)).toBeLessThan(5730)
  })

  t('resolves a minor stop too, not only a timepoint', (cmb) => {
    /* Route 4 has 6 timepoints and 48 stops. Checking only timepoints would miss the
       stop a bus is claiming to be at five times out of six. */
    const v = bus({ progress: { current_stop_sequence: 2, current_stop_id: '3337', current_status: 'STOPPED_AT' } })
    /* The yard is ~300 m from 7th/Pleasant Valley: far enough to flag, and it proves
       the minor stop was found rather than skipped. */
    const out = gap(cmb, v)
    expect(out).not.toBeNull()
    expect(out.stop_id).toBe('3337')
  })
})

describe('what must not be flagged', () => {
  t('says nothing when the bus really is at the stop', (cmb) => {
    const v = bus({ position: { lat: 30.275026, lon: -97.764825 } })
    expect(gap(cmb, v)).toBeNull()
  })

  t('tolerates ordinary GPS drift at the stop', (cmb) => {
    /* ~100 m off. A bus at a stop is not pinned to its sign, and a board that cried
       contradiction at every fix would be noise. */
    const v = bus({ position: { lat: 30.275926, lon: -97.764825 } })
    expect(gap(cmb, v)).toBeNull()
  })

  t('only questions STOPPED_AT, which is the claim about presence', (cmb) => {
    /* IN_TRANSIT_TO says nothing about distance — being far from the stop you are
       heading to is the normal case, not a contradiction. */
    for (const status of ['IN_TRANSIT_TO', 'INCOMING_AT']) {
      const v = bus({ progress: { current_stop_sequence: 1, current_stop_id: '6243', current_status: status } })
      expect(gap(cmb, v)).toBeNull()
    }
  })

  t('says nothing when the bus reports no usable position', (cmb) => {
    /* 0/0 is the Gulf of Guinea, the feed's "no position recorded". Treating it as a
       real point would put every such bus 10,000 km from its stop and flag them all. */
    expect(gap(cmb, bus({ position: { lat: 0, lon: 0 } }))).toBeNull()
    expect(gap(cmb, bus({ position: null }))).toBeNull()
  })

  t('says nothing about a stop this document cannot place', (cmb) => {
    /*
     * Absence of evidence gets no sentence. A stop we cannot locate is not a stop the
     * bus is far from — and api/all.json carries no stops at all (contract section 8),
     * so the fleet view must stay silent rather than accuse every bus on it.
     */
    const v = bus({ progress: { current_stop_sequence: 1, current_stop_id: '9999', current_status: 'STOPPED_AT' } })
    expect(gap(cmb, v)).toBeNull()
    expect(gap(cmb, bus(), null)).toBeNull()
    expect(gap(cmb, bus(), { vehicles: [] })).toBeNull()
  })
})

describe('what the row says', () => {
  const draw = (cmb, document, v) => {
    const data = ROUTE()
    data.vehicles = [v]
    const host = document.createElement('section')
    cmb.rows.render(host, data, { direction: 'both', status: 'ok', routes: [] })
    return host
  }
  const textOf = (node) =>
    [node.textContent || '', ...(node.children || []).map(textOf)].join(' ')

  t('prints the measured distance instead of repeating the false claim', (cmb, document) => {
    const v = bus({
      in_service: true,
      trip: { trip_id: 'T', direction_id: 1, start_time: '16:49:00', headsign: '4 Shady EB', start_epoch: 1788385740, schedule_relationship: 'SCHEDULED' },
      adherence: { state: 'ontime', seconds: 0, glyph: 'circle', against: null, reason: null },
    })
    const host = draw(cmb, document, v)
    /*
     * Scoped to the compact line, because the detail deliberately still prints the
     * feed's claim before contradicting it: a reader comparing this board against
     * CapMetro's own app has to see the same sentence plus the reason it cannot hold.
     */
    const compact = all(host, 'vrow__l2').map(textOf).join(' ')
    expect(compact).toContain('from stop')
    expect(compact).toContain('6243')
    expect(compact).not.toContain('stopped at')

    const text = textOf(host)
    expect(text).toContain('But the position says')
    /* The claim itself is not hidden, only demoted out of the glanceable line. */
    expect(text).toContain('stopped at stop 6243')
  })

  t('leaves an honest "stopped at" alone', (cmb, document) => {
    const v = bus({
      position: { lat: 30.275026, lon: -97.764825 },
      in_service: true,
      trip: { trip_id: 'T', direction_id: 1, start_time: '16:49:00', headsign: '4 Shady EB', start_epoch: 1788385740, schedule_relationship: 'SCHEDULED' },
      adherence: { state: 'ontime', seconds: 0, glyph: 'circle', against: null, reason: null },
    })
    const text = textOf(draw(cmb, document, v))
    expect(text).toContain('stopped at stop')
    expect(text).not.toContain('But the position says')
  })
})

describe('distance reads like a person wrote it', () => {
  t('metres under a kilometre, kilometres above', (cmb) => {
    expect(cmb.fmt.distance(5715)).toBe('5.7 km')
    expect(cmb.fmt.distance(240)).toBe('240 m')
    expect(cmb.fmt.distance(1000)).toBe('1 km')
    expect(cmb.fmt.distance(null)).toBeNull()
    expect(cmb.fmt.distance(Infinity)).toBeNull()
  })
})
