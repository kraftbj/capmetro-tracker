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

/**
 * The same helper, plus a feed prediction for stop 6293 on one trip — so the
 * row's time and the vehicle's anchor deviation disagree, which is the case the
 * panel had no coverage for.
 */
const routeWithFeed = (tripId, lateSeconds, predictedAt, stopId = '6293') => {
  const route = routeWith({ [tripId]: lateSeconds })
  route.vehicles[0].predictions = [[9, stopId, predictedAt]]
  /*
   * A stop-board row's vehicle always carries an anchor when it carries
   * predictions, and the panel now needs one: locating a departure among a
   * trip's stops means knowing where the bus is.
   *
   * That is structural rather than lucky. runtime/lib/join.php only fills
   * `predictions` when the feed is not suppressed, `current_stop_sequence` is
   * known, a trip update exists and the trip is not canceled -- so every
   * `adherence` reason that nulls `against` also empties the list, save one.
   * The exception (`no_stop_predictions`, when the feed's anchor lands on a
   * stop_sequence the shard has no scheduled time for) has zero instances in
   * the 2026-08-19 capture, and a trip missing from the shard has no board row
   * at all, because runtime/lib/departures.php builds the board from that same
   * shard. This fixture previously supplied predictions with no `against`,
   * which no board row can be in.
   *
   * The anchor sits at an EARLIER stop, and its predicted_at is derived from
   * the lateness rather than stated independently. Two reasons, both real.
   * runtime/lib/adherence.php computes `seconds` as predicted_at minus
   * scheduled_at, so those three numbers cannot disagree in real output --
   * anchoring at the asserted stop and stating both produced a fixture claiming
   * -189s beside a declared +1200. And a bus whose anchor IS the stop you are
   * asking about is not the scenario this block exists for: the whole point is
   * a deviation measured somewhere else, which is why the two numbers differ.
   */
  const anchor = firstStopOf(tripId)
  route.vehicles[0].adherence.against = {
    stop_id: anchor.stop_id,
    stop_name: anchor.stop_id,
    scheduled_at: anchor.scheduled_at,
    predicted_at: anchor.scheduled_at + lateSeconds,
  }
  return route
}

/** The trip's first stop, from the fixture: where the bus is measured against. */
function firstStopOf(tripId) {
  const ti = DEP.trips.findIndex((t) => t.id === tripId)
  let best = null
  for (const [stopId, rows] of Object.entries(DEP.departures)) {
    for (const [seconds, idx] of rows) {
      if (idx === ti && (best === null || seconds < best.seconds)) {
        best = { stop_id: stopId, seconds }
      }
    }
  }
  return { stop_id: best.stop_id, scheduled_at: START + best.seconds }
}

/** The fixture's own scheduled arrival for one trip at one stop. */
function scheduledAtOf(tripId, stopId) {
  const ti = DEP.trips.findIndex((t) => t.id === tripId)
  const row = (DEP.departures[stopId] || []).find((r) => r[1] === ti)
  return row ? START + row[0] : null
}

describe('a row never argues with itself', () => {
  /*
   * The arrival time comes from the agency's per-stop prediction; the badge
   * comes from the deviation measured at whatever stop the bus is currently
   * approaching. Those are different numbers — across the corpus they differ by
   * more than two minutes on a third of rendered rows — so a row that shows
   * both invites a subtraction that does not come out.
   *
   * The real example that made this concrete: a bus 11 minutes late at its
   * anchor, arriving 15:32 against a 15:27 schedule. Badge says 11, the times
   * say 5. And in 325 cases across the corpus they point opposite ways: a time
   * three minutes EARLY beside a late badge.
   */
  const NOW = at(7, 25)
  /*
   * TRIP_0732 is scheduled 08:20:00 at stop 6441. Its anchor is the trip's first
   * stop, 5926 at 07:30, where the bus is 20 minutes late — which would
   * extrapolate this stop to 08:40. The feed says it reaches 6441 at 08:17,
   * three minutes EARLY. Opposite signs, which is the 325-row case.
   *
   * The asserted stop is late in the trip on purpose. An earlier one cannot
   * carry this scenario: the anchor is already predicted at 07:50, so a feed
   * time before that would put the bus at a later stop before it reached its
   * first — 247 of 249 in-service vehicles in the capture have predictions[0]
   * AT the anchor, and none has an anchor predicted after its first prediction.
   * Real precedent for the shape asserted here: route 1 bus 2602 is +76s at its
   * anchor and 148s early at stop 4046 further along. Measured corpus-wide,
   * 1,082 prediction rows across 88 vehicles are early at their own stop while
   * their bus is late at its anchor, so this is the common case rather than a
   * contrived one.
   */
  const STOP = '6441'
  const FEED_AT = at(8, 17)

  t('takes its time from the feed when the feed has one', (sb) => {
    const rows = sb.upcoming(DEP, routeWithFeed(TRIP_0732, 1200, FEED_AT, STOP), STOP, 1, NOW, 4)
    const row = rows.find((r) => r.trip.id === TRIP_0732)

    expect(row.from_feed).toBe(true)
    expect(row.due_at).toBe(FEED_AT)
    /* And NOT the extrapolation, which is what it would have been before. */
    expect(row.due_at).not.toBe(row.scheduled_at + 1200)
  })

  t('shows no anchor badge on a row whose time came from the feed', (sb) => {
    const rows = sb.upcoming(DEP, routeWithFeed(TRIP_0732, 1200, FEED_AT, STOP), STOP, 1, NOW, 4)
    const row = rows.find((r) => r.trip.id === TRIP_0732)
    const node = sb.departureRow(row)

    /*
     * The badge is the signed number a reader would check the two times
     * against. With the times sourced elsewhere it can only contradict them.
     */
    expect(all(node, 'badge')).toHaveLength(0)
    expect(textDeep(node)).not.toMatch(/[+−-]\d+m/)
  })

  t('still shows the badge on an extrapolated row, where the two agree', (sb) => {
    /* No predictions at all, so the time IS scheduled + deviation and the badge
       is exactly the difference between the two times printed. */
    const rows = sb.upcoming(DEP, routeWith({ [TRIP_0732]: 1200 }), STOP, 1, NOW, 4)
    const row = rows.find((r) => r.trip.id === TRIP_0732)
    const node = sb.departureRow(row)

    expect(row.from_feed).toBe(false)
    expect(row.due_at).toBe(row.scheduled_at + 1200)
    expect(all(node, 'badge').length).toBeGreaterThan(0)
  })

  t('always prints the scheduled time on a feed-sourced row', (sb) => {
    /*
     * With the badge gone, the scheduled time is the only thing left saying how
     * late the bus is HERE — so it is printed even when the difference is under
     * the minute that would normally suppress it as noise.
     */
    const almostOnTime = at(8, 20, 40)   /* 40s late: under the 60s noise cut */
    const rows = sb.upcoming(DEP, routeWithFeed(TRIP_0732, 1200, almostOnTime, STOP), STOP, 1, NOW, 4)
    const node = sb.departureRow(rows.find((r) => r.trip.id === TRIP_0732))

    expect(textDeep(node)).toContain('scheduled')
  })

  t('scopes the bus state to the bus rather than to this stop', (sb) => {
    const rows = sb.upcoming(DEP, routeWithFeed(TRIP_0732, 1200, FEED_AT, STOP), STOP, 1, NOW, 4)
    const node = sb.departureRow(rows.find((r) => r.trip.id === TRIP_0732))
    const text = textDeep(node)

    /*
     * "running very late" is a fact about the bus and survives; a bare "very
     * late" next to a time that is early at this stop does not. A bus recovering
     * six minutes between its anchor and here is the feed doing its job, not a
     * contradiction — but only the scoped wording says so.
     */
    expect(text).toContain('running very late')
  })

  t('speaks the same split to a screen reader', (sb) => {
    const rows = sb.upcoming(DEP, routeWithFeed(TRIP_0732, 1200, FEED_AT, STOP), STOP, 1, NOW, 4)
    const node = sb.departureRow(rows.find((r) => r.trip.id === TRIP_0732))
    const spoken = all(node, 'sr-only').map(textDeep).join(' ')

    /* The spoken line used to carry the same contradiction as the visual one. */
    expect(spoken).toContain('is running very late overall')
    expect(spoken).not.toMatch(/\d+ minutes late, scheduled/)
  })
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
    /*
     * Asserted as the RELATIVE order of the two trips this test is about, not as the
     * first two rows of the list. Every trip in this fixture sits on its own
     * single-trip block, so one with no vehicle reads as a pull-out that never
     * happened and rides along as an overdue row — a true statement about the
     * fixture, and nothing to do with the ordering rule under test here.
     */
    const ids = rows.map((r) => r.trip.id)
    expect(ids).toContain(TRIP_0752)
    expect(ids).toContain(TRIP_0732)
    expect(ids.indexOf(TRIP_0752)).toBeLessThan(ids.indexOf(TRIP_0732))
    const late = rows.find((r) => r.trip.id === TRIP_0732)
    const ontime = rows.find((r) => r.trip.id === TRIP_0752)
    expect(ontime.due_at).toBeLessThan(late.due_at)
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

/*
 * Cancellations.
 *
 * On 2026-08-19 a canceled trip was invisible to this client. It rendered as
 * "scheduled · no bus reporting yet", which a reader correctly parses as "it
 * has not started yet" when it means "it is never coming". A kid waited at a
 * stop that no other bus serves that day.
 *
 * Cancellation is not rare on this system: 100 of 912 trip updates in the
 * committed capture, and 187 system-wide live that afternoon with 17 on route 4
 * alone, on a day carrying a route-wide reduced-service alert.
 */
describe('a canceled trip is never mistaken for one that has not started', () => {
  const cancel = (dep, tripId) => {
    const copy = JSON.parse(JSON.stringify(dep))
    copy.trips.forEach((t) => { if (t.id === tripId) t.canceled = true })
    return copy
  }

  t('does not count a canceled departure toward the two being asked for', (sb) => {
    /*
     * "Your 5:40 is canceled, the 5:57 is running" is the useful answer, so the
     * canceled one rides along without consuming a slot.
     */
    const dep = cancel(DEP, TRIP_0732)
    const rows = sb.upcoming(dep, null, '6293', 1, at(7, 0), 2)
    expect(rows.filter((r) => !r.canceled)).toHaveLength(2)
    expect(rows.map((r) => r.trip.id)).toContain(TRIP_0732)
  })

  t('keeps it in place rather than leaving a hole in the timetable', (sb) => {
    const dep = cancel(DEP, TRIP_0732)
    const rows = sb.upcoming(dep, null, '6293', 1, at(7, 0), 2)
    /* Still first: it is still the earliest thing that was going to happen. */
    expect(rows[0].trip.id).toBe(TRIP_0732)
    expect(rows[0].canceled).toBe(true)
  })

  t('never lets a canceled trip be the answer to "what is next"', (sb) => {
    const dep = cancel(DEP, TRIP_0732)
    const groups = sb.nextAtStop(dep, null, '6293', at(7, 0), 2)
    const first = groups[0].departures.filter((d) => !d.canceled)[0]
    expect(first.trip.id).not.toBe(TRIP_0732)
  })

  t('says the word CANCELED, not just a strike-through', (sb) => {
    /*
     * A struck-out time is ambiguous at a glance and silent to a screen reader,
     * and this is the one line that must not be misread.
     */
    const host = client.document.createElement('section')
    client.cmb.stopboard.render(host, cancel(DEP, TRIP_0732), null, at(7, 0), { stopId: '6293' })
    const text = textDeep(host)
    expect(text).toMatch(/CANCELED/)
    expect(text).toMatch(/No bus is coming for it/i)
  })

  t('does not say "no bus reporting yet" about a canceled trip', (sb) => {
    /* The exact sentence that was on screen while someone waited. */
    const host = client.document.createElement('section')
    const dep = cancel(DEP, TRIP_0732)
    dep.trips.forEach((t) => { t.canceled = true })
    client.cmb.stopboard.render(host, dep, null, at(7, 0), { stopId: '6293' })
    expect(textDeep(host)).not.toMatch(/no bus reporting yet/i)
  })

  t('speaks the cancellation to a screen reader', (sb) => {
    const host = client.document.createElement('section')
    client.cmb.stopboard.render(host, cancel(DEP, TRIP_0732), null, at(7, 0), { stopId: '6293' })
    const spoken = all(host, 'sr-only').map((n) => n.textContent).join(' ')
    expect(spoken).toMatch(/canceled/i)
    expect(spoken).toMatch(/no bus is running this trip/i)
  })
})

/*
 * A stop this trip serves TWICE.
 *
 * This is the regression pin for the bug the panel actually had. It used to ask
 * fmt.predictionFor(), which matches on stop_id alone and returns the SOONEST
 * occurrence -- the right answer to near.js's question and the wrong one here,
 * because a stop board row is a scheduled departure and a loop trip has two of
 * them at the same stop. Both rows got the first pass's time.
 *
 * It lives at the panel level on purpose. The corpus test in trip-corpus
 * exercises arrivalPlan, which was already correct before the fix and stays
 * green without it; only a test that goes through upcoming() can fail when
 * stopboard.js regresses. Verified by reverting client/stopboard.js: this
 * block fails, and nothing else in the suite does.
 *
 * The fixture is built here rather than added to departures-800.json because
 * no committed fixture has a repeat stop, and the 800 board is asserted on
 * elsewhere by exact departure times.
 */
const LOOP_START = 1787115600
const LOOP_DEP = {
  service_day_start_epoch: LOOP_START,
  route_id: 'L',
  service_date: '20260819',
  stops: [
    { stop_id: 'L1', stop_name: 'Loop Rd', direction_id: 1, stop_sequence: 1 },
    { stop_id: 'MID', stop_name: 'Midway', direction_id: 1, stop_sequence: 2 },
  ],
  trips: [{ id: 'LT', direction_id: 1, headsign: 'L loop', is_special: false }],
  /* L1 at 00:10 and again at 00:30; MID once between them. */
  departures: { L1: [[600, 0], [1800, 0]], MID: [[1200, 0]] },
}

/* Distinct feed times for the two passes: +1 min on the first, +5 on the second. */
const LOOP_FIRST = LOOP_START + 600 + 60
const LOOP_SECOND = LOOP_START + 1800 + 300

const loopRoute = () => ({
  staleness: { level: 'fresh', suppress_adherence: false },
  vehicles: [{
    vehicle_id: 'LV', label: 'LV', in_service: true,
    trip: { trip_id: 'LT', route_id: 'L', direction_id: 1, schedule_relationship: 'SCHEDULED' },
    progress: { current_stop_sequence: 1, current_stop_id: 'L1', current_status: 'IN_TRANSIT_TO' },
    predictions: [[1, 'L1', LOOP_FIRST], [2, 'MID', LOOP_START + 1200 + 120], [3, 'L1', LOOP_SECOND]],
    adherence: {
      state: 'ontime', seconds: 60, glyph: 'circle', reason: null,
      against: { stop_id: 'L1', stop_name: 'Loop Rd', scheduled_at: LOOP_START + 600, predicted_at: LOOP_FIRST },
    },
  }],
})

describe('a stop this trip serves twice', () => {
  t('gives each pass the feed time the feed published for it', (sb) => {
    const rows = sb.upcoming(LOOP_DEP, loopRoute(), 'L1', 1, LOOP_START + 500, 6)
    expect(rows).toHaveLength(2)

    /* Both rows are the same trip at the same stop. Before the fix they carried
       the same predicted_at -- the first pass's -- which is the whole defect. */
    expect(rows.map((r) => r.scheduled_at)).toEqual([LOOP_START + 600, LOOP_START + 1800])
    expect(rows.map((r) => r.predicted_at)).toEqual([LOOP_FIRST, LOOP_SECOND])
    expect(rows.every((r) => r.from_feed)).toBe(true)
  })

  t('never hands the two passes one time', (sb) => {
    const rows = sb.upcoming(LOOP_DEP, loopRoute(), 'L1', 1, LOOP_START + 500, 6)
    expect(rows[0].predicted_at).not.toBe(rows[1].predicted_at)
  })

  t('renders the second pass against its own scheduled time, not the first', (sb) => {
    /* The failure mode was a row printing an arrival 20 minutes before its own
       scheduled departure, which reads as a wildly early bus. */
    const rows = sb.upcoming(LOOP_DEP, loopRoute(), 'L1', 1, LOOP_START + 500, 6)
    const second = rows[1]
    expect(second.predicted_at).toBeGreaterThan(second.scheduled_at)
  })
})
