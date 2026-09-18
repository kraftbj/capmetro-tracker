/**
 * The run that disappeared while its bus was still coming.
 *
 * Route 837, 2026-09-17. The 17:03 northbound was booked to be run by bus 8007,
 * which was 820s late finishing its southbound trip and did not take the
 * northbound run over until 17:13:56. From 17:04:30 — its scheduled time plus
 * the 90s grace — until the handover, the stop board did not list it at all. A
 * rider standing at 5th/Guadalupe was shown the 17:33 as their next bus while
 * their actual bus was ten minutes away.
 *
 * WHY IT HAPPENED. upcoming() looked the vehicle up by THIS trip's id. Nothing
 * was on the trip, so there was no lateness, so there was no predicted time and
 * `due_at` fell back to the bare schedule. The list then dropped the row for
 * being in the past. The only exemption was `coverage.state === 'overdue'`, and
 * this run was not overdue — coverageFor could see bus 8007 one run away and
 * called it `inbound`, which is the case where the bus is definitely coming.
 *
 * The payload had already answered it: 8007 published
 * `block.next_trip.trip_id == 3012264_24429` and its own lateness. That is what
 * W.timingFor now reads.
 *
 * These assertions run against tests/fixtures/capture-20260917-837/, captured
 * live off production while the bug was happening. Not a reconstruction: the
 * board really was serving this, and health.json said ok with a 47s feed age.
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

const FIX = path.join(ROOT, 'tests/fixtures/capture-20260917-837')
const load = (f) => JSON.parse(readFileSync(path.join(FIX, f), 'utf8'))

const DEP = load('departures-837.json')
const PENDING = load('route-837-pending.json')       /* 17:07:48, bus still on the SB run */
const HANDOVER = load('route-837-handover.json')     /* 17:13:56, bus now on the NB run */
const STACK = load('route-837-canceled-stack.json')  /* 17:18:56, three cancellations stacked */

/* The run that vanished, and the stop the reporter had selected. */
const TARGET = '3012264_24429'
const ORIGIN = '2112'          /* 5th/Guadalupe, where the NB trip starts */
const NB = 1
const SCHEDULED_AT = 1789682580 /* 17:03:00 */
const PREDICTOR = '8007'

/* The saved trip a rider would actually keep for this run. One copy: the stale
   test's whole point is that the SAME trip stops predicting, so a second literal
   is how one of them quietly stops being the same trip. */
const SAVED = {
  route_id: '837', stop_id: ORIGIN, direction_id: NB, scheduled_time: '17:03:00',
  day_type: 'weekday', stop_name: '5th/Guadalupe', direction_tag: 'NB',
}

const rowFor = (sb, route, stopId, tripId, now, count = 2) =>
  sb.upcoming(DEP, route, stopId, NB, now ?? route.generated_at, count)
    .find((d) => String(d.trip.id) === tripId)

/*
 * What the capture has to contain for anything below to mean what it says.
 *
 * Every assertion in this file hard-codes 820, 8007, the target trip id and the
 * stop count, and reads them back out of the fixture. If a re-capture loses one of
 * those facts, the tests keep passing while testing something else. This is the
 * same discipline fixture-invariants.test.mjs applies to feeds-20260819: pin the
 * input truth, so a fixture change fails as a fixture change.
 */
describe('the capture still says what these tests assume', () => {
  t('has the target trip, uncanceled, in every snapshot', () => {
    expect(DEP.trips.some((t2) => String(t2.id) === TARGET)).toBe(true)
    for (const [label, snap] of [['pending', PENDING], ['handover', HANDOVER], ['stack', STACK]]) {
      expect(snap.schedule.canceled_trips, label).not.toContain(TARGET)
    }
  })

  t('has 8007 publishing the target as its next run, 820s late, before the handover', () => {
    const v = PENDING.vehicles.find((x) => x.vehicle_id === PREDICTOR)
    expect(v, 'bus 8007 must be in the pending snapshot').toBeDefined()
    /* On the SOUTHBOUND trip, not the target: that is the whole situation. */
    expect(v.trip.trip_id).not.toBe(TARGET)
    expect(v.trip.direction_id).toBe(0)
    expect(v.block.next_trip.trip_id).toBe(TARGET)
    expect(v.adherence.seconds).toBe(820)
    expect(v.adherence.state).toBe('very_late')
    /* high, or the predictor gate declines it and half this file is vacuous. */
    expect(v.block.confidence).toBe('high')
  })

  t('has 8007 on the target run, 681s late, after the handover', () => {
    const v = HANDOVER.vehicles.find((x) => x.vehicle_id === PREDICTOR)
    expect(v.trip.trip_id).toBe(TARGET)
    expect(v.trip.direction_id).toBe(NB)
    expect(v.adherence.seconds).toBe(681)
  })

  t('has the 16:53 canceled and 27 minutes gone in the stack snapshot', () => {
    expect(STACK.schedule.canceled_trips).toContain('3012263_24413')
    expect(STACK.schedule.canceled_trips).toContain('3012265_24385')
    expect(STACK.schedule.canceled_trips.length).toBe(7)
    const sched1653 = DEP.service_day_start_epoch + 16 * 3600 + 53 * 60
    expect(STACK.generated_at - sched1653).toBeGreaterThan(sb_CANCELED_KEEP_S())
  })

  t('serves the target at 24 northbound stops', () => {
    const serving = DEP.stops
      .filter((s2) => s2.direction_id === NB)
      .filter((s2) => client.cmb.watch.departuresAt(DEP, s2.stop_id, NB)
        .some((r) => String(r.trip.id) === TARGET))
    expect(serving.length).toBe(24)
  })
})

/* Read through the export so the number lives in one place. */
const sb_CANCELED_KEEP_S = () => client.cmb.stopboard.CANCELED_KEEP_S

describe('a pending run whose bus is still finishing the trip before', () => {
  t('is listed at its origin stop after its scheduled time has passed', (sb) => {
    const now = PENDING.generated_at
    expect(now).toBeGreaterThan(SCHEDULED_AT + sb.GRACE_S)

    const row = rowFor(sb, PENDING, ORIGIN, TARGET)
    expect(row, 'the 17:03 NB must be on the board at 5th/Guadalupe').toBeDefined()
  })

  t('is not merely kept — it is timed from the bus that will run it', (sb) => {
    const row = rowFor(sb, PENDING, ORIGIN, TARGET)

    expect(row.scheduled_at).toBe(SCHEDULED_AT)
    expect(row.predictor.vehicle_id).toBe(PREDICTOR)
    /* Nothing is on the trip. The predictor must not be passed off as one. */
    expect(row.vehicle).toBeNull()
    /* 17:03:00 + 820s, the predictor's own deviation. */
    expect(row.predicted_at).toBe(SCHEDULED_AT + 820)
    expect(row.due_at).toBe(SCHEDULED_AT + 820)
    expect(row.seconds_until).toBeGreaterThan(0)
    expect(row.from_feed).toBe(false)
  })

  t('sorts by that predicted time, so it sits ahead of the next scheduled run', (sb) => {
    const list = sb.upcoming(DEP, PENDING, ORIGIN, NB, PENDING.generated_at, 2)
    const ids = list.map((d) => String(d.trip.id))
    const later = list.find((d) => d.scheduled_at > SCHEDULED_AT && !d.canceled)

    expect(ids).toContain(TARGET)
    /*
     * The whole point of the panel: a bus whose time has passed is still the
     * next bus. Ranked by schedule it would be gone and the 17:33 would be the
     * answer, which is a twenty-minute lie.
     */
    expect(ids.indexOf(TARGET)).toBeLessThan(ids.indexOf(String(later.trip.id)))
  })

  t('says the bus has not started it yet, rather than implying it is under way', (sb) => {
    const row = rowFor(sb, PENDING, ORIGIN, TARGET)
    const text = textDeep(sb.departureRow(row)).replace(/\s+/g, ' ')

    expect(text).toContain('bus 8007')
    expect(text).toContain('becomes this run')
    expect(text).toContain('running very late')
    /* The scheduled time is what identifies the run to someone waiting for it. */
    expect(text).toContain('5:03p')
    expect(text).toContain('5:16p')
  })

  t('keeps the badge, because the clock IS scheduled plus that badge', (sb) => {
    const row = rowFor(sb, PENDING, ORIGIN, TARGET)
    const el = sb.departureRow(row)
    const badges = all(el, 'badge')

    expect(badges.length).toBe(1)
    /* 820s late. The badge and due_at - scheduled_at are the same number, which
       is the identity this file's badge rule turns on. */
    expect(textDeep(badges[0])).toContain('+14m')
    expect(row.due_at - row.scheduled_at).toBe(820)
  })

  t('speaks the same facts it prints', (sb) => {
    const row = rowFor(sb, PENDING, ORIGIN, TARGET)
    const spoken = all(sb.departureRow(row), 'sr-only').map(textDeep).join(' ')

    expect(spoken).toContain('Bus 8007')
    expect(spoken).toContain('becomes this run')
    expect(spoken).toContain('running very late')
    expect(spoken).toContain('scheduled 5:03 PM')
    /* Never the bare state, which would claim this run is already late. */
    expect(spoken).not.toMatch(/^\s*very late/)
  })

  t('holds at every northbound stop the trip still has ahead of it', (sb) => {
    const now = PENDING.generated_at
    const serving = DEP.stops
      .filter((s) => s.direction_id === NB)
      .filter((s) => client.cmb.watch.departuresAt(DEP, s.stop_id, NB)
        .some((r) => String(r.trip.id) === TARGET))

    /* Non-trivial rather than exact: the real claim is the empty `missing` list
       below, and pinning 24 here fails at the wrong name when the capture is
       re-taken. The exact count is asserted in the fixture-invariant block. */
    expect(serving.length).toBeGreaterThan(5)
    /* count 99 so the two-row trim cannot be mistaken for the drop being fixed. */
    const missing = serving.filter((s) => !rowFor(sb, PENDING, s.stop_id, TARGET, now, 99))
    expect(missing.map((s) => s.stop_id)).toEqual([])
  })
})

describe('once a bus is actually on the run', () => {
  t('the row is live and carries no predictor', (sb) => {
    const row = rowFor(sb, HANDOVER, ORIGIN, TARGET, HANDOVER.generated_at, 99)

    expect(row.vehicle.vehicle_id).toBe(PREDICTOR)
    expect(row.predictor).toBeNull()
    expect(row.view.state).toBe('very_late')
  })

  t('does not say "becomes this run" about a bus that already has', (sb) => {
    const row = rowFor(sb, HANDOVER, ORIGIN, TARGET, HANDOVER.generated_at, 99)
    const text = textDeep(sb.departureRow(row)).replace(/\s+/g, ' ')

    expect(text).toContain('bus 8007')
    expect(text).not.toContain('becomes this run')
  })
})

describe('the successor claim is only trusted one run out', () => {
  t('a run further down the block is left unpredicted, not confidently wrong', (sb) => {
    const now = PENDING.generated_at
    /*
     * coverageFor calls these `inbound` too, but off the weaker block-mate match
     * rather than a published next_trip. A deviation measured two or three runs
     * back says nothing useful about a departure half an hour out with layovers
     * in between, so timingFor declines to extrapolate from it.
     */
    const far = sb.upcoming(DEP, PENDING, ORIGIN, NB, now, 99)
      .filter((d) => (d.coverage || {}).state === 'inbound')
      .filter((d) => d.coverage.runs_ahead !== 1)

    expect(far.length).toBeGreaterThan(0)
    for (const d of far) {
      expect(d.predictor, `trip ${d.trip.id} is ${d.coverage.runs_ahead} runs out`).toBeNull()
      expect(d.predicted_at).toBeNull()
      expect(d.due_at).toBe(d.scheduled_at)
    }
  })
})

/*
 * The same root cause, the other panel. watch.resolve() computed due_at from the
 * same three lines, so a saved trip for the 17:03 sat on the SCHEDULED time and
 * counted down from it: AFTER_S (900s) is measured from due_at, so the card went
 * `passed` at 17:18 — two minutes after 8007 actually pulled out with the rider's
 * bus. Both panels now read one function, which is the point: CLAUDE.md's rule
 * after ISSUE-002 is that two producers of one value drift, and the first symptom
 * here would be the two panels disagreeing about one departure on one screen.
 */
describe('a saved trip for the same run', () => {
  t('is due when the bus will really leave, not when it was booked', (sb, cmb) => {
    const m = cmb.watch.resolve(SAVED, DEP, PENDING, PENDING.generated_at)

    expect(m.scheduled_at).toBe(SCHEDULED_AT)
    expect(m.due_at).toBe(SCHEDULED_AT + 820)
    expect(m.predictor.vehicle_id).toBe(PREDICTOR)
    expect(m.vehicle).toBeNull()
    expect(m.seconds_until).toBeGreaterThan(0)
  })

  t('does not call itself gone once the booked time plus AFTER_S has passed', (sb, cmb) => {
    /*
     * 17:19, and the instant matters. Booked 17:03 with AFTER_S of 900, the old
     * reading expired at 17:18 — so asked at 17:07 or even at the 17:13:56
     * handover this assertion passes on the very bug it is named after. It has to
     * be asked after 17:18, where the schedule-based card is `passed` and the
     * predicted one is not.
     */
    const now = SCHEDULED_AT + cmb.watch.AFTER_S + 60
    const m = cmb.watch.resolve(SAVED, DEP, PENDING, now)

    expect(now).toBeGreaterThan(SCHEDULED_AT + cmb.watch.AFTER_S)
    expect(m.state).not.toBe('passed')
    expect(m.predictor.vehicle_id).toBe(PREDICTOR)
    expect(m.due_at).toBe(SCHEDULED_AT + 820)
  })

  t('agrees with the stop board about one departure', (sb, cmb) => {
    const m = cmb.watch.resolve(SAVED, DEP, PENDING, PENDING.generated_at)
    const row = rowFor(sb, PENDING, ORIGIN, TARGET)

    expect(m.due_at).toBe(row.due_at)
    expect(m.scheduled_at).toBe(row.scheduled_at)
    expect(m.predictor.vehicle_id).toBe(row.predictor.vehicle_id)
  })

  /* What the card BUILDS, not just what resolve() computed. The model carrying a
     predictor and the card printing it are two different claims, and the second
     one is the only one a rider ever sees. */
  const drawCard = (model) => {
    const host = client.document.createElement('section')
    client.cmb.watch.render(host, [model], {})
    return host
  }

  t('leads the card with the time the bus will really leave, not the booked one', (sb, cmb) => {
    const m = cmb.watch.resolve(SAVED, DEP, PENDING, PENDING.generated_at)
    const host = drawCard(m)
    const text = textDeep(host).replace(/\s+/g, ' ')

    /*
     * The two numbers have to be the SAME departure. `seconds_until` counts to
     * due_at, so printing it beside the scheduled time read "5:03p · in 9
     * minutes" — nine minutes apart on one line. They agreed only while an
     * unstarted run had no prediction at all, which is the bug above.
     */
    expect(all(host, 'watchcard__due').map(textDeep)).toEqual(['5:16p'])
    expect(all(host, 'watchcard__until').map(textDeep)).toEqual(['in 9 minutes'])
    /* Scheduled second, and the bus scoped to what it is actually doing. */
    expect(text).toContain('Scheduled 5:03p')
    expect(text).toContain('bus 8007 has not started it yet')
    expect(text).toContain('running very late')
    /*
     * And NOT the sentence this card used to print, which says a prediction is
     * unavailable on the one card that now has one.
     */
    expect(text).not.toContain('No bus is reporting on this trip yet')
  })

  t('keeps the badge, because due_at IS scheduled plus that badge', (sb, cmb) => {
    const m = cmb.watch.resolve(SAVED, DEP, PENDING, PENDING.generated_at)
    const badges = all(drawCard(m), 'badge')

    expect(badges.length).toBe(1)
    expect(textDeep(badges[0])).toContain('+14m')
    expect(m.due_at - m.scheduled_at).toBe(820)
  })

  t('speaks it, rather than falling through to "Nothing to show"', (sb, cmb) => {
    /*
     * The spoken chain had no arm for `no-vehicle` with a predictor, so the card
     * with the most to say — a time, a badge and a named bus — reached a screen
     * reader as "Nothing to show." sr-only text is held to the same factual
     * standard as the visible text on this board.
     */
    const m = cmb.watch.resolve(SAVED, DEP, PENDING, PENDING.generated_at)
    const spoken = all(drawCard(m), 'sr-only').map(textDeep).join(' ')

    expect(spoken).not.toContain('Nothing to show')
    expect(spoken).toContain('Due 5:16 PM')
    expect(spoken).toContain('scheduled 5:03 PM')
    expect(spoken).toContain('Bus 8007 has not started it yet')
    expect(spoken).toContain('running very late')
  })
})

/*
 * A prediction is an assertion about the world, and coverageFor already refuses
 * to make one from a snapshot that stopped updating — `suppress_adherence`
 * returns `unknown` before any vehicle is looked at. timingFor reads coverage,
 * so the refusal has to carry through to the predictor as well: a dead feed and
 * a bus that is genuinely late produce the identical observation, and shifting a
 * departure by a deviation measured nobody-knows-when would read that silence as
 * news about a bus.
 */
describe('a snapshot that has stopped updating predicts nothing', () => {
  const stale = () => {
    const copy = JSON.parse(JSON.stringify(PENDING))
    copy.staleness = { level: 'dead', suppress_adherence: true, reason: 'cron down' }
    return copy
  }

  t('names no predictor and leaves the saved card on the schedule', (sb, cmb) => {
    const m = cmb.watch.resolve(SAVED, DEP, stale(), PENDING.generated_at)

    /* The same payload predicts 17:16:40 when it is fresh. */
    expect(m.predictor).toBeNull()
    expect(m.predicted_at).toBeNull()
    expect(m.due_at).toBe(SCHEDULED_AT)
  })

  t('says so through timingFor directly, whichever panel is asking', (sb, cmb) => {
    const trip = DEP.trips.find((tr) => String(tr.id) === TARGET)
    const timing = cmb.watch.timingFor(DEP, stale(), trip, SCHEDULED_AT, PENDING.generated_at)

    expect(timing.predictor).toBeNull()
    expect(timing.predicted_at).toBeNull()
    expect(timing.due_at).toBe(SCHEDULED_AT)
  })
})

/*
 * Both of these were found by a differential of the fixed client against HEAD over
 * all 71 live routes — 46,661 rendered rows — and neither was reachable from the
 * 837 capture. They are built on the real departures document so the trip and block
 * shapes stay real, with only the vehicle list synthesized, which is the pattern
 * client-stopboard.test.mjs already uses.
 */
/**
 * A bus inbound to TARGET on its block, with the adherence the caller chooses.
 *
 * At module scope because the retention tests further down need the same shape:
 * a canceled row whose block still has a bus on it is `inbound`, never
 * `overdue`, and that is exactly the row the old keep rule threw away.
 */
const inboundWith = (adherence, canceledTrips = [], confidence = 'high') => ({
  staleness: { level: 'fresh', suppress_adherence: false },
  schedule: { canceled_trips: canceledTrips },
  vehicles: [{
    vehicle_id: '9001', label: '9001', in_service: true,
    route_id: '837',
    position: { lat: 30.26, lon: -97.74 },
    position_at: 1789682850,
    trip: { trip_id: '3012136_24864', direction_id: 0, start_epoch: 1789678380 },
    adherence,
    block: {
      block_id: '837001', confidence,
      next_trip: { trip_id: TARGET, route_id: '837', direction_id: 1, start_time: '17:03:00' },
    },
  }],
})

describe('a successor that cannot be timed', () => {
  t('is not named as a predictor when it has no deviation of its own', (sb, cmb) => {
    /*
     * Bus 2817 on route 466: inbound, in service, and `adherence.state` unknown
     * with reason no_trip_update. There is no number to add to the schedule, so
     * there is no prediction — and a row must not advertise a predictor that
     * produced none, because departureRow keys the shifted-time branch off
     * predicted_at and would have printed "running undefined".
     */
    const route = inboundWith({
      state: 'unknown', seconds: null, glyph: 'question', reason: 'no_trip_update',
    })
    const row = rowFor(sb, route, ORIGIN, TARGET, SCHEDULED_AT - 600, 99)

    expect(row).toBeDefined()
    expect(row.predicted_at).toBeNull()
    expect(row.predictor).toBeNull()
    expect(row.due_at).toBe(row.scheduled_at)
    /* And it still says which bus is coming, off coverage rather than a time. */
    expect(row.coverage.state).toBe('inbound')
    expect(row.coverage.vehicle.vehicle_id).toBe('9001')
    const text = textDeep(sb.departureRow(row)).replace(/\s+/g, ' ')
    expect(text).toContain('bus 9001')
    expect(text).not.toContain('undefined')
  })

  t('the control: the same bus with a deviation does predict', (sb) => {
    const route = inboundWith({ state: 'late', seconds: 300, glyph: 'up-triangle', reason: null })
    const row = rowFor(sb, route, ORIGIN, TARGET, SCHEDULED_AT - 600, 99)

    expect(row.predictor.vehicle_id).toBe('9001')
    expect(row.predicted_at).toBe(SCHEDULED_AT + 300)
  })

  t('never predicts for a canceled trip, even while a bus still claims it', (sb) => {
    /*
     * Route 800's 3010826_22741 was canceled by CapMetro while bus 8010 went on
     * publishing it in next_trip. A canceled row leads with due_at, so predicting
     * there moved the one number a rider uses to recognize which run was canceled:
     * theirs said 17:30, the board would have said 17:44.
     */
    const route = inboundWith(
      { state: 'very_late', seconds: 856, glyph: 'square', reason: null },
      [TARGET],
    )
    const row = rowFor(sb, route, ORIGIN, TARGET, SCHEDULED_AT - 600, 99)

    expect(row.canceled).toBe(true)
    expect(row.predictor).toBeNull()
    expect(row.predicted_at).toBeNull()
    /* The canceled row keeps the time it was canceled from. */
    expect(row.due_at).toBe(SCHEDULED_AT)
  })
})

describe('an announced cancellation is not an unannounced no-show', () => {
  t('stops riding the overdue window, which was never meant for it', (sb) => {
    const now = STACK.generated_at
    const canceled = sb.upcoming(DEP, STACK, ORIGIN, NB, now, 99).filter((d) => d.canceled)

    expect(canceled.length).toBeGreaterThan(0)
    for (const d of canceled) {
      const gone = now - d.due_at
      expect(gone, `canceled ${d.trip.id} is ${Math.round(gone / 60)} min past`)
        .toBeLessThan(sb.CANCELED_KEEP_S)
    }
    expect(sb.CANCELED_KEEP_S).toBeLessThan(sb.OVERDUE_KEEP_S)
  })

  t('drops the 16:53, which had been on the board 27 minutes', (sb) => {
    const list = sb.upcoming(DEP, STACK, ORIGIN, NB, STACK.generated_at, 99)
    const ids = list.map((d) => String(d.trip.id))

    /* 3012263_24413, booked 16:53, canceled, and 27 minutes gone at this snapshot. */
    expect(ids).not.toContain('3012263_24413')
    /* The recent one stays: a rider who just missed it still learns why. */
    expect(ids).toContain('3012265_24385')
  })

  t('still keeps a cancellation whose time has not come', (sb) => {
    const list = sb.upcoming(DEP, STACK, ORIGIN, NB, STACK.generated_at, 99)
    const ahead = list.filter((d) => d.canceled && d.due_at > STACK.generated_at)

    expect(ahead.length).toBeGreaterThan(0)
    /* And it does not consume one of the two live answers being asked for. */
    const two = sb.upcoming(DEP, STACK, ORIGIN, NB, STACK.generated_at, 2)
    expect(two.filter((d) => !d.canceled && (d.coverage || {}).state !== 'overdue').length).toBe(2)
  })

  /*
   * The other half of the rewritten keep rule, and the half the 837 capture
   * cannot reach. Every canceled row in that snapshot whose time had passed was
   * also `overdue`, so it was exempt either way and only the LENGTH of the
   * window changed. A cancellation on a block that still has a bus on it is
   * `inbound` — never `overdue` — and the old rule offered it no exemption at
   * all: it dropped 90 seconds after its time, taking the only sentence that
   * explained why nothing came with it. That is the same silence CANCELED_KEEP_S
   * exists to fill, so the rule now keys off the cancellation and not off a
   * coverage state that happened to coincide with it.
   */
  const stillOnTheBlock = (canceledTrips) =>
    inboundWith({ state: 'very_late', seconds: 856, glyph: 'square', reason: null }, canceledTrips)

  t('keeps one whose block still has a bus on it, which used to vanish at 90 seconds', (sb, cmb) => {
    const route = stillOnTheBlock([TARGET])
    const now = SCHEDULED_AT + 300
    const row = sb.upcoming(DEP, route, ORIGIN, NB, now, 99)
      .find((d) => String(d.trip.id) === TARGET)

    /* Past GRACE_S, and not overdue, which is what made it disappear. */
    expect(now - SCHEDULED_AT).toBeGreaterThan(sb.GRACE_S)
    expect(cmb.watch.coverageFor(DEP, route, row.trip, now).state).toBe('inbound')
    expect(row.canceled).toBe(true)
    expect(textDeep(sb.departureRow(row))).toContain('CANCELED')
  })

  t('drops it on its own clock, not the overdue one', (sb) => {
    const route = stillOnTheBlock([TARGET])
    const listAt = (now) => sb.upcoming(DEP, route, ORIGIN, NB, now, 99)
      .some((d) => String(d.trip.id) === TARGET)

    /* The boundary itself, against the exported constant rather than 600. */
    expect(listAt(SCHEDULED_AT + sb.CANCELED_KEEP_S - 1)).toBe(true)
    expect(listAt(SCHEDULED_AT + sb.CANCELED_KEEP_S + 1)).toBe(false)
    /* And it is gone well inside the window an unannounced no-show would get. */
    expect(listAt(SCHEDULED_AT + sb.OVERDUE_KEEP_S - 1)).toBe(false)
  })

  t('keeps it on a stale feed too, because a cancellation is published, not inferred', (sb) => {
    /*
     * suppress_adherence makes coverageFor say `unknown` about everything, so a
     * stale feed is the other route to a canceled row with no overdue exemption.
     * isCanceled does not read staleness at all and should not: CapMetro SAID
     * this trip is not running, and a snapshot going quiet does not unsay it.
     */
    const route = stillOnTheBlock([TARGET])
    route.staleness = { level: 'dead', suppress_adherence: true, reason: 'cron down' }
    const row = sb.upcoming(DEP, route, ORIGIN, NB, SCHEDULED_AT + 300, 99)
      .find((d) => String(d.trip.id) === TARGET)

    expect(row).toBeDefined()
    expect(row.canceled).toBe(true)
    expect(row.coverage.state).toBe('unknown')
  })
})

/*
 * §4 of the contract: the client never presents a `low` confidence continuation
 * as fact. This is the first place where the grade governs a CLOCK and not just
 * a sentence, so the rule needed restating there — see the §4 note on hedged
 * departure times. The time stands, because refusing it puts a fifth of these
 * runs (1,811 of 8,859 measured live) back on a scheduled time already gone; the
 * sentence hedges instead.
 */
describe('a continuation the build could only grade low', () => {
  const LATE = { state: 'very_late', seconds: 820, glyph: 'square', reason: null }

  t('is still timed — the grade is about the chaining, not whether the bus exists', (sb) => {
    const row = rowFor(sb, inboundWith(LATE, [], 'low'), ORIGIN, TARGET, SCHEDULED_AT + 300, 99)

    expect(row, 'a low-graded continuation must not drop the row').toBeDefined()
    expect(row.predictor.vehicle_id).toBe('9001')
    expect(row.predicted_at).toBe(SCHEDULED_AT + 820)
    expect(row.predictor_hedged).toBe(true)
  })

  t('says "likely", and says the feed does not confirm it', (sb) => {
    const row = rowFor(sb, inboundWith(LATE, [], 'low'), ORIGIN, TARGET, SCHEDULED_AT + 300, 99)
    const text = textDeep(sb.departureRow(row)).replace(/\s+/g, ' ')

    expect(text).toContain('likely becomes this run')
    expect(text).toContain('the feed does not confirm this')
  })

  t('marks the line for a glance, not by colour alone', (sb) => {
    const row = rowFor(sb, inboundWith(LATE, [], 'low'), ORIGIN, TARGET, SCHEDULED_AT + 300, 99)
    const hedged = all(sb.departureRow(row), 'nextbus__bus--hedged')

    expect(hedged.length).toBe(1)
    /* And the words carry it too, so the marking is never the only channel. */
    expect(textDeep(hedged[0])).toContain('does not confirm')
  })

  t('hedges the spoken line too', (sb) => {
    const row = rowFor(sb, inboundWith(LATE, [], 'low'), ORIGIN, TARGET, SCHEDULED_AT + 300, 99)
    const spoken = all(sb.departureRow(row), 'sr-only').map(textDeep).join(' ')

    expect(spoken).toContain('likely becomes')
    expect(spoken).toContain('does not confirm this continuation')
  })

  t('the control: a high-graded continuation is stated plainly', (sb) => {
    const row = rowFor(sb, inboundWith(LATE, [], 'high'), ORIGIN, TARGET, SCHEDULED_AT + 300, 99)
    const text = textDeep(sb.departureRow(row)).replace(/\s+/g, ' ')

    expect(row.predictor_hedged).toBe(false)
    expect(text).toContain('becomes this run')
    expect(text).not.toContain('likely becomes')
    expect(text).not.toContain('does not confirm')
    expect(all(sb.departureRow(row), 'nextbus__bus--hedged').length).toBe(0)
  })

  t('the real capture is high-graded, so the rest of this file is not vacuous', () => {
    const v = PENDING.vehicles.find((x) => x.vehicle_id === PREDICTOR)
    expect(v.block.confidence).toBe('high')
  })
})

/*
 * The block index is memoized on the departures document's identity, which is the
 * one thing that makes it safe: a document is immutable once fetched and replaced
 * wholesale at the service-day roll. These pin both halves — that a second
 * document is not served the first one's index, and that callers cannot corrupt
 * the cache through the array they are handed.
 */
describe('the block index memo', () => {
  t('answers a different departures document from its own trips', (sb, cmb) => {
    const first = cmb.watch.tripsInBlock(DEP, '837001')
    expect(first.length).toBeGreaterThan(1)

    /* A different document, same block id, one trip. */
    const other = { service_day_start_epoch: DEP.service_day_start_epoch, trips: [
      { id: 'X_1', block_id: '837001', direction_id: 1, start_time: '06:00:00' },
    ] }
    expect(cmb.watch.tripsInBlock(other, '837001').map((t2) => t2.id)).toEqual(['X_1'])
    /* And back again, so the memo is a cache and not a one-shot. */
    expect(cmb.watch.tripsInBlock(DEP, '837001').length).toBe(first.length)
  })

  t('hands out a fresh array, so a caller cannot sort the index itself', (sb, cmb) => {
    const a = cmb.watch.tripsInBlock(DEP, '837001')
    expect(a.length).toBeGreaterThan(1)
    a.length = 0
    expect(cmb.watch.tripsInBlock(DEP, '837001').length).toBeGreaterThan(1)
  })

  t('keeps each block in running order', (sb, cmb) => {
    const seq = cmb.watch.tripsInBlock(DEP, '837001')
    const times = seq.map((t2) => t2.start_time)
    expect(times.slice().sort()).toEqual(times)
    for (const t2 of seq) expect(String(t2.block_id)).toBe('837001')
  })

  t('is empty for a block the document does not have', (sb, cmb) => {
    expect(cmb.watch.tripsInBlock(DEP, 'no-such-block')).toEqual([])
    expect(cmb.watch.tripsInBlock(DEP, null)).toEqual([])
  })
})
