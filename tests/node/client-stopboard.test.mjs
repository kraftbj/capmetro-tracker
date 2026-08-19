/**
 * stopboard.js — the next two buses each way at one stop.
 *
 * Almost every test here defends one rule: "next" means when a bus will
 * actually arrive, not when it was scheduled to. The case that forced it, from
 * the real 2026-08-19 capture on route 800 at Simond SB at 10:10 —
 *
 *   sched 09:52   20 min late   arrives 10:12
 *   sched 10:02    6 min late   arrives 10:08   (gone)
 *   sched 10:12    on time      arrives 10:12
 *
 * Ranked by schedule, the 09:52 is filtered out for being in the past and the
 * answer is "one bus, 10:12". Ranked by arrival, two buses land in the same
 * minute and then nothing comes for twelve. A rider who acts on the first
 * answer watches two buses arrive together and then waits.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { all, renderClient, textDeep } from './helpers/client.mjs'
import { ROOT } from './helpers/optional.mjs'

const client = renderClient([
  'format.js', 'adherence.js', 'states.js', 'watch.js', 'stopboard.js',
])

const t = (name, fn) =>
  it(name, (ctx) => {
    if (!client.cmb) ctx.skip(client.reason)
    if (!client.cmb.stopboard) ctx.skip('window.CMB.stopboard is not defined')
    return fn(client.cmb.stopboard, client.cmb)
  })

const DEP = JSON.parse(
  readFileSync(path.join(ROOT, 'tests/fixtures/synthetic/departures-800.json'), 'utf8'),
)
const START = DEP.service_day_start_epoch
const at = (h, m, s = 0) => START + h * 3600 + m * 60 + s

/* The fixture's four southbound departures at 6293: 07:32:09 .. 08:02:09. */
const TRIP_0732 = '3010893_22199'
const TRIP_0752 = '3010894_22201'

/** A route payload putting `late` seconds on one trip. */
const routeWith = (perTrip, suppress = false) => ({
  staleness: { level: suppress ? 'dead' : 'fresh', suppress_adherence: suppress },
  vehicles: Object.keys(perTrip).map((tripId, i) => ({
    vehicle_id: `V${i}`,
    label: `V${i}`,
    in_service: true,
    trip: { trip_id: tripId, route_id: '800', direction_id: 1 },
    adherence: {
      state: perTrip[tripId] >= 360 ? 'very_late' : perTrip[tripId] >= 150 ? 'late' : 'ontime',
      seconds: perTrip[tripId],
      glyph: 'circle',
      reason: null,
    },
  })),
})

describe('"next" is when the bus arrives, not when it was due', () => {
  t('keeps a late bus whose scheduled time has already passed', (sb) => {
    /*
     * The 07:32 is running 25 minutes late, so at 07:50 it has not been yet.
     * A schedule-ordered list would have dropped it eighteen minutes ago.
     */
    const now = at(7, 50)
    const rows = sb.upcoming(DEP, routeWith({ [TRIP_0732]: 1500 }), '6293', 1, now, 4)
    const ids = rows.map((r) => r.trip.id)
    expect(ids).toContain(TRIP_0732)
    expect(rows.find((r) => r.trip.id === TRIP_0732).scheduled_at).toBeLessThan(now)
  })

  t('orders a late bus after an on-time one it now trails', (sb) => {
    /*
     * 07:32 running 25 late arrives 07:57. 07:52 on time arrives 07:52. The
     * earlier-scheduled bus is the LATER arrival, so schedule order is wrong.
     */
    const rows = sb.upcoming(
      DEP,
      routeWith({ [TRIP_0732]: 1500, [TRIP_0752]: 0 }),
      '6293', 1, at(7, 45), 4,
    )
    expect(rows.slice(0, 2).map((r) => r.trip.id)).toEqual([TRIP_0752, TRIP_0732])
    expect(rows[0].due_at).toBeLessThan(rows[1].due_at)
  })

  t('drops a bus that has actually been, not one that is merely overdue', (sb) => {
    const now = at(7, 55)
    const gone = sb.upcoming(DEP, routeWith({ [TRIP_0752]: 0 }), '6293', 1, now, 4)
    expect(gone.map((r) => r.trip.id)).not.toContain(TRIP_0752)

    const stillComing = sb.upcoming(DEP, routeWith({ [TRIP_0752]: 900 }), '6293', 1, now, 4)
    expect(stillComing.map((r) => r.trip.id)).toContain(TRIP_0752)
  })

  t('holds a bus for a grace window rather than blinking it away on the second', (sb) => {
    const due = at(7, 52, 9)
    const inGrace = sb.upcoming(DEP, routeWith({ [TRIP_0752]: 0 }), '6293', 1, due + 30, 4)
    expect(inGrace.map((r) => r.trip.id)).toContain(TRIP_0752)

    const past = sb.upcoming(DEP, routeWith({ [TRIP_0752]: 0 }), '6293', 1, due + sb.GRACE_S + 5, 4)
    expect(past.map((r) => r.trip.id)).not.toContain(TRIP_0752)
  })

  t('falls back to scheduled order when no bus is reporting yet', (sb) => {
    const rows = sb.upcoming(DEP, null, '6293', 1, at(7, 0), 4)
    const times = rows.map((r) => r.scheduled_at)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    rows.forEach((r) => {
      expect(r.predicted_at).toBeNull()
      expect(r.due_at).toBe(r.scheduled_at)
    })
  })
})

describe('one answer per direction the stop is served in', () => {
  t('returns a single direction for a one-way stop', (sb) => {
    const groups = sb.nextAtStop(DEP, null, '6293', at(7, 0), 2)
    expect(groups).toHaveLength(1)
    expect(groups[0].direction_id).toBe(1)
    expect(groups[0].tag).toBe('SB')
  })

  t('returns both for a stop served both ways, which 164 real stops are', (sb) => {
    /* Transit centers and turnarounds. Route 4's own turnaround is one. */
    const two = JSON.parse(JSON.stringify(DEP))
    two.trips.push({
      id: 'NB-1', direction_id: 0, headsign: '800 Mueller NB',
      start_time: '07:40:00', block_id: 'b', is_special: false,
    })
    two.departures['6293'].push([7 * 3600 + 45 * 60, two.trips.length - 1])
    const groups = sb.nextAtStop(two, null, '6293', at(7, 0), 2)
    expect(groups.map((g) => g.direction_id)).toEqual([0, 1])
    expect(groups.map((g) => g.tag)).toEqual(['NB', 'SB'])
  })

  t('gives exactly two per direction, the next and the one after', (sb) => {
    const groups = sb.nextAtStop(DEP, null, '6293', at(7, 0), 2)
    expect(groups[0].departures).toHaveLength(2)
    expect(groups[0].departures[0].due_at).toBeLessThan(groups[0].departures[1].due_at)
  })

  t('returns nothing for a stop this route does not serve', (sb) => {
    expect(sb.nextAtStop(DEP, null, 'not-a-stop', at(7, 0), 2)).toEqual([])
  })

  t('does not throw on a null schedule or a null stop', (sb) => {
    expect(sb.nextAtStop(null, null, '6293', at(7, 0), 2)).toEqual([])
    expect(sb.nextAtStop(DEP, null, null, at(7, 0), 2)).toEqual([])
  })
})

describe('what the panel says', () => {
  const draw = (dep, route, now, opts) => {
    const host = client.document.createElement('section')
    client.cmb.stopboard.render(host, dep, route, now, opts || { stopId: '6293' })
    return host
  }

  t('leads with the arrival time and names the bus', (sb) => {
    const host = draw(DEP, routeWith({ [TRIP_0752]: 240 }), at(7, 45))
    const text = textDeep(host)
    expect(text).toMatch(/Simond SB/)
    expect(all(host, 'nextbus').length).toBeGreaterThan(0)
    expect(text).toMatch(/late/)
  })

  t('says a bus is merely scheduled rather than letting it read as on time', (sb) => {
    const text = textDeep(draw(DEP, null, at(7, 45)))
    expect(text).toMatch(/no bus reporting yet/i)
    expect(text).not.toMatch(/on time/i)
  })

  t('omits the scheduled time when it matches the prediction', (sb) => {
    /* "10:12, scheduled 10:12" is noise on the line being scanned fastest. */
    const onTime = textDeep(draw(DEP, routeWith({ [TRIP_0752]: 0 }), at(7, 45)))
    const late = textDeep(draw(DEP, routeWith({ [TRIP_0752]: 600 }), at(7, 45)))
    expect(late).toMatch(/scheduled/)
    expect(onTime.match(/scheduled 7:52a/) || []).toHaveLength(0)
  })

  t('prints no lateness anywhere when the feed is too stale to judge it', (sb) => {
    const host = draw(DEP, routeWith({ [TRIP_0752]: 600 }, true), at(7, 45))
    expect(textDeep(host)).toMatch(/lateness unavailable/i)
    expect(textDeep(host)).not.toMatch(/[+−-]\d+m/)
  })

  t('says the day is done rather than showing an empty column', (sb) => {
    const host = draw(DEP, null, at(23, 59))
    expect(textDeep(host)).toMatch(/nothing further today/i)
  })

  t('offers a stop picker when no stop has been chosen', (sb) => {
    const host = draw(DEP, null, at(7, 45), { stopId: null, onPick() {} })
    expect(all(host, 'stoplist__item').length).toBeGreaterThan(0)
  })

  t('warns that a special run skips stops', (sb) => {
    const special = JSON.parse(JSON.stringify(DEP))
    special.trips.forEach((tr) => { if (tr.id === TRIP_0752) tr.is_special = true })
    expect(textDeep(draw(special, null, at(7, 45)))).toMatch(/special run/i)
  })

  t('speaks every departure to a screen reader', (sb) => {
    const host = draw(DEP, routeWith({ [TRIP_0752]: 240 }), at(7, 45))
    const spoken = all(host, 'sr-only').map((n) => n.textContent).join(' ')
    expect(spoken).toMatch(/scheduled/)
    expect(all(host, 'nextbus').length).toBeLessThanOrEqual(spoken.split('scheduled').length - 1 + 1)
  })
})
