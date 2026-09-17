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

const rowFor = (sb, route, stopId, tripId, now, count = 2) =>
  sb.upcoming(DEP, route, stopId, NB, now ?? route.generated_at, count)
    .find((d) => String(d.trip.id) === tripId)

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

    expect(serving.length).toBe(24)
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
  const SAVED = {
    route_id: '837', stop_id: ORIGIN, direction_id: NB, scheduled_time: '17:03:00',
    day_type: 'weekday', stop_name: '5th/Guadalupe', direction_tag: 'NB',
  }

  t('is due when the bus will really leave, not when it was booked', (sb, cmb) => {
    const m = cmb.watch.resolve(SAVED, DEP, PENDING, PENDING.generated_at)

    expect(m.scheduled_at).toBe(SCHEDULED_AT)
    expect(m.due_at).toBe(SCHEDULED_AT + 820)
    expect(m.predictor.vehicle_id).toBe(PREDICTOR)
    expect(m.vehicle).toBeNull()
    expect(m.seconds_until).toBeGreaterThan(0)
  })

  t('does not call itself gone while the bus is still on its way', (sb, cmb) => {
    const m = cmb.watch.resolve(SAVED, DEP, PENDING, PENDING.generated_at)
    /* The handover really happened at 17:13:56. The card must still be alive then. */
    const atHandover = cmb.watch.resolve(SAVED, DEP, PENDING, HANDOVER.generated_at)

    expect(m.state).not.toBe('passed')
    expect(atHandover.state).not.toBe('passed')
    /* Booked 17:03, so the old reading expired at 17:18 — before this. */
    expect(m.due_at + cmb.watch.AFTER_S).toBeGreaterThan(HANDOVER.generated_at)
  })

  t('agrees with the stop board about one departure', (sb, cmb) => {
    const m = cmb.watch.resolve(SAVED, DEP, PENDING, PENDING.generated_at)
    const row = rowFor(sb, PENDING, ORIGIN, TARGET)

    expect(m.due_at).toBe(row.due_at)
    expect(m.scheduled_at).toBe(row.scheduled_at)
    expect(m.predictor.vehicle_id).toBe(row.predictor.vehicle_id)
  })
})

/*
 * Both of these were found by a differential of the fixed client against HEAD over
 * all 71 live routes — 46,661 rendered rows — and neither was reachable from the
 * 837 capture. They are built on the real departures document so the trip and block
 * shapes stay real, with only the vehicle list synthesized, which is the pattern
 * client-stopboard.test.mjs already uses.
 */
describe('a successor that cannot be timed', () => {
  /** A bus inbound to TARGET on its block, with the adherence the caller chooses. */
  const inboundWith = (adherence, canceledTrips = []) => ({
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
        block_id: '837001', confidence: 'high',
        next_trip: { trip_id: TARGET, route_id: '837', direction_id: 1, start_time: '17:03:00' },
      },
    }],
  })

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
     * there moved the one number a rider uses to recognise which run was canceled:
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
})
