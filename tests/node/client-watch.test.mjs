/**
 * watch.js — saved trips.
 *
 * The feature exists to answer one question the owner asked for by example: "the 7:50a 800
 * SB from Simond/Berkman", from about an hour before until after the bus has gone. Stop
 * 6293 is Simond SB and it is a MINOR stop, not a timepoint, which is why the route
 * payload alone cannot answer it — its schedule block carries offsets for timepoints only,
 * and only for a window of about an hour around now.
 *
 * So resolution is a join between two documents, and almost every test here is about a way
 * that join can fail. The failures are not interchangeable. "Saved for a weekday and today
 * is Sunday", "that departure no longer exists", "the bus has not started its run yet" and
 * "it already went" all look like an empty card and call for completely different actions
 * from someone standing at a stop with a kid. Each one gets its own state and its own
 * assertion.
 *
 * The fixture is trimmed from the real route 800 build shard for service day 20260819: the
 * four southbound trips serving stop 6293 between 07:30 and 08:30. Trip 3010894_22201 at
 * 07:52:09 is the one the API contract's own example names.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { all, renderClient, textDeep } from './helpers/client.mjs'
import { ROOT } from './helpers/optional.mjs'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'watch.js'])

const t = (name, fn) =>
  it(name, (ctx) => {
    if (!client.cmb) ctx.skip(client.reason)
    if (!client.cmb.watch) ctx.skip('client scripts loaded but window.CMB.watch is not defined')
    return fn(client.cmb.watch, client.cmb)
  })

const departures = () =>
  JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/synthetic/departures-800.json'), 'utf8'))

/* The watch the contract's section 9 example describes, verbatim. */
const THE_WATCH = {
  route_id: '800',
  direction_id: 1,
  direction_tag: 'SB',
  stop_id: '6293',
  stop_name: 'Simond SB',
  scheduled_time: '07:52:09',
  day_type: 'weekday',
}

const DEP = departures()
const DUE_AT = DEP.service_day_start_epoch + 7 * 3600 + 52 * 60 + 9
const TRIP_ID = '3010894_22201'

/** A route payload carrying one vehicle on the watched trip, n seconds late. */
const routeWith = (lateSeconds, tripId = TRIP_ID) => ({
  staleness: { level: 'fresh', suppress_adherence: false },
  vehicles: [
    {
      vehicle_id: '8021',
      label: '8021',
      in_service: true,
      trip: { trip_id: tripId, route_id: '800', direction_id: 1, headsign: '800 SB' },
      adherence: {
        state: lateSeconds >= 360 ? 'very_late' : lateSeconds >= 150 ? 'late' : 'ontime',
        seconds: lateSeconds,
        glyph: lateSeconds >= 360 ? 'square' : lateSeconds >= 150 ? 'up-triangle' : 'circle',
        reason: null,
      },
    },
  ],
})

describe('the service-day clock, which is not a wall clock', () => {
  t('keeps an hour past midnight as hour 25, because 25:10 is a different trip from 01:10', (w) => {
    expect(w.clockOf(25 * 3600 + 10 * 60)).toBe('25:10:00')
    expect(w.secondsOf('25:10:00')).toBe(25 * 3600 + 10 * 60)
  })

  t('round-trips every departure in the fixture', (w) => {
    Object.keys(DEP.departures).forEach((stopId) => {
      DEP.departures[stopId].forEach((row) => {
        expect(w.secondsOf(w.clockOf(row[0]))).toBe(row[0])
      })
    })
  })

  t('returns null for a value it cannot parse rather than a plausible wrong number', (w) => {
    expect(w.secondsOf('')).toBeNull()
    expect(w.secondsOf('soon')).toBeNull()
    expect(w.secondsOf(null)).toBeNull()
  })
})

describe('finding the departure a saved trip names', () => {
  t('filters by the trip direction, not the stop', (w) => {
    /*
     * A stop can be served both ways. The departures document keys by stop_id alone, so
     * the direction filter has to come off the trip; getting this wrong would watch the
     * bus going the other way from the same shelter.
     */
    const rows = w.departuresAt(DEP, '6293', 1)
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach((r) => expect(r.trip.direction_id).toBe(1))
    expect(w.departuresAt(DEP, '6293', 0)).toHaveLength(0)
  })

  t('matches the exact clock the reader chose', (w) => {
    const m = w.matchDeparture(w.departuresAt(DEP, '6293', 1), '07:52:09')
    expect(m).toBeTruthy()
    expect(m.shifted).toBe(false)
    expect(m.row.trip.id).toBe(TRIP_ID)
  })

  t('accepts a small schedule shift and reports it rather than breaking', (w) => {
    /* A feed republish can move a departure a minute or two. That is the same trip. */
    const m = w.matchDeparture(w.departuresAt(DEP, '6293', 1), '07:51:00')
    expect(m.shifted).toBe(true)
    expect(m.row.trip.id).toBe(TRIP_ID)
    expect(Math.abs(m.drift)).toBeLessThanOrEqual(w.DRIFT_TOLERANCE_S)
  })

  t('refuses a shift big enough to be a different bus', (w) => {
    /*
     * 07:32 and 07:52 are both real departures here. Snapping across that gap would
     * silently watch a bus twenty minutes from the one the reader picked.
     */
    const m = w.matchDeparture(w.departuresAt(DEP, '6293', 1), '06:00:00')
    expect(m).toBeNull()
  })

  t('picks the nearest when two departures are both within tolerance', (w) => {
    const m = w.matchDeparture(w.departuresAt(DEP, '6293', 1), '07:47:00')
    expect(m.row.trip.id).toBe('3010846_22200')
  })
})

describe('resolving a watch against the live route payload', () => {
  t('reports the arrival, not just the delay, when the bus is running', (w) => {
    const m = w.resolve(THE_WATCH, DEP, routeWith(240), DUE_AT - 600)
    expect(m.state).toBe('live')
    expect(m.trip.id).toBe(TRIP_ID)
    expect(m.scheduled_at).toBe(DUE_AT)
    expect(m.predicted_at).toBe(DUE_AT + 240)
    expect(m.due_at).toBe(DUE_AT + 240)
    expect(m.view.state).toBe('late')
  })

  t('says the bus has not started its run rather than showing nothing', (w) => {
    const m = w.resolve(THE_WATCH, DEP, routeWith(0, 'some-other-trip'), DUE_AT - 600)
    expect(m.state).toBe('no-vehicle')
    expect(m.scheduled_at).toBe(DUE_AT)
  })

  t('holds off until the window opens an hour before', (w) => {
    const m = w.resolve(THE_WATCH, DEP, routeWith(0), DUE_AT - w.BEFORE_S - 60)
    expect(m.state).toBe('upcoming')
  })

  t('opens exactly at the window edge, not a minute either side', (w) => {
    expect(w.resolve(THE_WATCH, DEP, routeWith(0), DUE_AT - w.BEFORE_S + 1).state).toBe('live')
    expect(w.resolve(THE_WATCH, DEP, routeWith(0), DUE_AT - w.BEFORE_S - 1).state).toBe('upcoming')
  })

  t('counts a late bus as still coming, not gone, past its scheduled time', (w) => {
    /*
     * The bug this pins: judging "passed" against the SCHEDULE would retire a watch while
     * the bus was still ten minutes away, which is precisely when the reader needs it.
     */
    const late = 600
    const m = w.resolve(THE_WATCH, DEP, routeWith(late), DUE_AT + 300)
    expect(m.state).toBe('live')
    expect(m.seconds_until).toBe(late - 300)
  })

  t('retires the watch once the bus is properly gone', (w) => {
    const m = w.resolve(THE_WATCH, DEP, routeWith(0), DUE_AT + w.AFTER_S + 60)
    expect(m.state).toBe('passed')
  })

  t('says which day it was saved for when today is a different one', (w) => {
    const sunday = Object.assign({}, DEP, { day_type: 'sunday' })
    const m = w.resolve(THE_WATCH, sunday, routeWith(0), DUE_AT)
    expect(m.state).toBe('not-today')
    expect(m.detail).toMatch(/weekday/)
    expect(m.detail).toMatch(/sunday/i)
  })

  t('says the stop is not served rather than that the trip is missing', (w) => {
    const m = w.resolve(Object.assign({}, THE_WATCH, { stop_id: '999999' }), DEP, routeWith(0), DUE_AT)
    expect(m.state).toBe('unserved')
  })

  t('says the departure is gone from the schedule when the stop is still served', (w) => {
    const m = w.resolve(Object.assign({}, THE_WATCH, { scheduled_time: '13:15:00' }), DEP, routeWith(0), DUE_AT)
    expect(m.state).toBe('unresolved')
    expect(m.detail).toMatch(/schedule may have changed/i)
  })

  t('waits for the schedule rather than claiming the trip does not exist', (w) => {
    const m = w.resolve(THE_WATCH, null, routeWith(0), DUE_AT)
    expect(m.state).toBe('no-schedule')
  })

  t('shows no lateness at all when the feed is too stale to judge it', (w) => {
    /*
     * staleness.suppress_adherence is authoritative everywhere on this board. A saved trip
     * is the most tempting place to leak a number through, because the reader wants one.
     */
    const route = routeWith(240)
    route.staleness = { level: 'dead', suppress_adherence: true, reason: 'cron down' }
    const m = w.resolve(THE_WATCH, DEP, route, DUE_AT - 600)
    expect(m.view.state).toBe('unknown')
    expect(m.view.seconds).toBeNull()
    expect(m.predicted_at).toBeNull()
    expect(m.due_at).toBe(m.scheduled_at)
  })

  t('carries the special-run flag through, because it changes which stops are made', (w) => {
    const special = JSON.parse(JSON.stringify(DEP))
    special.trips.forEach((tr) => { if (tr.id === TRIP_ID) tr.is_special = true })
    expect(w.resolve(THE_WATCH, special, routeWith(0), DUE_AT).is_special).toBe(true)
  })
})

describe('how long until, in words a person reads at six in the morning', () => {
  t('uses hours and minutes for anything over an hour', (w) => {
    expect(w.untilText(2 * 3600 + 17 * 60)).toBe('in 2h 17m')
    expect(w.untilText(3 * 3600)).toBe('in 3h')
  })

  t('uses minutes inside the hour, where minutes are the unit you act on', (w) => {
    expect(w.untilText(11 * 60)).toBe('in 11 minutes')
    expect(w.untilText(60)).toBe('in 1 minute')
  })

  t('says now rather than in 0 minutes', (w) => {
    expect(w.untilText(20)).toBe('now')
    expect(w.untilText(-30)).toBe('now')
  })

  t('speaks in the past once the bus has gone', (w) => {
    expect(w.untilText(-8 * 60)).toBe('8 minutes ago')
  })
})

describe('ordering: what needs attention first', () => {
  t('puts a bus that is running ahead of one due later today', (w) => {
    const models = [
      { state: 'passed', seconds_until: -900 },
      { state: 'upcoming', seconds_until: 7200 },
      { state: 'live', seconds_until: 300 },
      { state: 'not-today' },
    ]
    expect(w.sortModels(models).map((m) => m.state))
      .toEqual(['live', 'upcoming', 'passed', 'not-today'])
  })

  t('breaks a tie by which is due soonest', (w) => {
    const models = [
      { state: 'live', seconds_until: 900 },
      { state: 'live', seconds_until: 120 },
    ]
    expect(w.sortModels(models).map((m) => m.seconds_until)).toEqual([120, 900])
  })

  t('does not mutate the array it was given', (w) => {
    const models = [{ state: 'passed' }, { state: 'live' }]
    w.sortModels(models)
    expect(models[0].state).toBe('passed')
  })
})

describe('what the card actually says', () => {
  const draw = (models, opts) => {
    const host = client.document.createElement('section')
    client.cmb.watch.render(host, models, opts || {})
    return host
  }

  t('leads with the arrival time and says the lateness in words too', (w) => {
    const m = w.resolve(THE_WATCH, DEP, routeWith(240), DUE_AT - 600)
    const text = textDeep(draw([m]))
    expect(text).toMatch(/Simond SB/)
    expect(text).toMatch(/late/)
    expect(text).toMatch(/8021/)
  })

  t('never leaves a card blank, whatever went wrong', (w) => {
    const states = [
      w.resolve(THE_WATCH, null, null, DUE_AT),
      w.resolve(Object.assign({}, THE_WATCH, { stop_id: 'nope' }), DEP, null, DUE_AT),
      w.resolve(Object.assign({}, THE_WATCH, { scheduled_time: '13:15:00' }), DEP, null, DUE_AT),
      w.resolve(THE_WATCH, Object.assign({}, DEP, { day_type: 'sunday' }), null, DUE_AT),
      w.resolve(THE_WATCH, DEP, routeWith(0), DUE_AT + 99999),
    ]
    states.forEach((m) => {
      const card = all(draw([m]), 'watchcard')[0]
      expect(card, `no card rendered for state ${m.state}`).toBeTruthy()
      expect(textDeep(card).replace(/\s+/g, ' ').trim().length).toBeGreaterThan(20)
    })
  })

  t('says what a saved trip is for, rather than showing an empty panel', (w) => {
    expect(textDeep(draw([]))).toMatch(/No saved trips yet/i)
  })

  t('tells a screen reader everything the badge and the colour carry', (w) => {
    const m = w.resolve(THE_WATCH, DEP, routeWith(400), DUE_AT - 600)
    const spoken = all(draw([m]), 'sr-only').map((n) => n.textContent).join(' ')
    expect(spoken).toMatch(/route 800/)
    expect(spoken).toMatch(/Simond SB/)
    expect(spoken).toMatch(/late/)
  })

  t('warns that a special run does not make the usual stops', (w) => {
    const special = JSON.parse(JSON.stringify(DEP))
    special.trips.forEach((tr) => { if (tr.id === TRIP_ID) tr.is_special = true })
    const m = w.resolve(THE_WATCH, special, routeWith(0), DUE_AT - 600)
    expect(textDeep(draw([m]))).toMatch(/special run/i)
  })
})

describe('a saved trip that has been canceled', () => {
  const canceled = () => {
    const copy = JSON.parse(JSON.stringify(DEP))
    copy.trips.forEach((t) => { if (t.id === TRIP_ID) t.canceled = true })
    return copy
  }

  t('reports canceled rather than "no bus reporting yet"', (w) => {
    /*
     * A canceled trip has no vehicle, so every later check concludes the bus
     * has not started. That sentence was on screen while a kid waited.
     */
    const m = w.resolve(THE_WATCH, canceled(), routeWith(0, 'other-trip'), DUE_AT - 600)
    expect(m.state).toBe('canceled')
    expect(m.detail).toMatch(/canceled/i)
  })

  t('is canceled even inside the live window, where a bus would otherwise show', (w) => {
    const m = w.resolve(THE_WATCH, canceled(), routeWith(240), DUE_AT - 300)
    expect(m.state).toBe('canceled')
  })

  t('sorts above anything already gone but below a bus still coming', (w) => {
    const order = w.sortModels([
      { state: 'passed', seconds_until: -600 },
      { state: 'canceled', seconds_until: 300 },
      { state: 'live', seconds_until: 400 },
    ]).map((m) => m.state)
    expect(order).toEqual(['live', 'canceled', 'passed'])
  })

  t('says so on the card and to a screen reader', (w) => {
    const host = client.document.createElement('section')
    const m = w.resolve(THE_WATCH, canceled(), routeWith(0), DUE_AT - 600)
    client.cmb.watch.render(host, [m], {})
    expect(textDeep(host)).toMatch(/CANCELED/)
    expect(all(host, 'sr-only').map((n) => n.textContent).join(' ')).toMatch(/canceled/i)
  })
})
