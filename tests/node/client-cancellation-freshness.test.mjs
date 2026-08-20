/**
 * Regression: a cancellation announced after the page loaded never reached the board.
 * Found while reviewing the three open client PRs on 2026-08-20.
 *
 * 0.4.0.0 shipped cancellation as `canceled` on each trip in
 * api/departures/{route}.json. But contract section 16 declares that document free
 * of realtime fields precisely so it can be cached to the end of the service day,
 * and the client fetches it once per session and keeps it. The two facts are
 * incompatible, and the cached copy is the side that loses.
 *
 * So the feature worked when you opened the page AFTER the cancellation published,
 * and not when you left the page open -- which is how somebody waiting at a stop
 * actually uses it. A trip canceled at 10:05 for a 10:13 departure could not reach
 * a tab opened at 07:00. That is the same failure the cancellation work existed to
 * close, on a longer fuse.
 *
 * `schedule.canceled_trips` was published in the same release and rebuilt from live
 * TripUpdates on every generator run -- and never read by the client at all. These
 * tests pin that both carriers are consulted. Every case below passes trip.canceled
 * as FALSE, so each one fails against the pre-fix code.
 */
import { describe, expect, it } from 'vitest'
import { renderClient } from './helpers/client.mjs'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'watch.js', 'stopboard.js'])

/*
 * Skip only when the client cannot be loaded at all, which is the repo's
 * convention for a file that does not exist yet. Deliberately NOT skipping on a
 * missing watch.isCanceled: a test that skips itself when the thing it defends
 * is absent reports green against the very bug it exists to catch. The cases
 * below reach the behaviour through stopboard.upcoming() and watch.resolve(),
 * which exist either way, so they fail rather than vanish.
 */
const t = (name, fn) =>
	it(name, (ctx) => {
		if (!client.cmb) ctx.skip(client.reason)
		fn(client.cmb)
	})

/* One stop, one trip, one departure at 10:13 on a service day starting at midnight. */
const DAY = 1787200000
const AT = 47580 /* 13:13 in service seconds; arbitrary, only consistency matters */
const TRIP = { id: '3014797_15228', direction_id: 0, canceled: false }

const departures = {
	service_date: '20260820',
	day_type: 'weekday',
	service_day_start_epoch: DAY,
	trips: [TRIP],
	departures: { 938: [[AT, 0]] },
}

const routeWith = (canceledTrips) => ({
	route_id: '4',
	staleness: { level: 'fresh', suppress_adherence: false },
	vehicles: [],
	schedule: { canceled_trips: canceledTrips },
})

describe('a cancellation that arrives after the departures document was cached', () => {
	t('exposes a helper that reads both carriers', (cmb) => {
		expect(typeof cmb.watch.isCanceled).toBe('function')
	})

	t('is seen when only the live route payload knows about it', (cmb) => {
		/* The exact shape of the bug: the cached document says nothing is wrong. */
		expect(TRIP.canceled).toBe(false)
		expect(cmb.watch.isCanceled(TRIP, routeWith(['3014797_15228']))).toBe(true)
	})

	t('is still seen when only the cached document knows about it', (cmb) => {
		/* A trip canceled before the page loaded that has since aged out of the
		   -15/+45 minute schedule window. The union has to keep this one. */
		const stale = { id: 'aged_out', direction_id: 0, canceled: true }
		expect(cmb.watch.isCanceled(stale, routeWith([]))).toBe(true)
	})

	t('is not invented when neither carrier lists it', (cmb) => {
		expect(cmb.watch.isCanceled(TRIP, routeWith(['some_other_trip']))).toBe(false)
	})

	t('survives a numeric id on either side', (cmb) => {
		/* GTFS ids are strings by contract, but the feed has handed us numbers
		   before and an === comparison would silently miss every one. */
		expect(cmb.watch.isCanceled({ id: 12345, canceled: false }, routeWith(['12345']))).toBe(true)
		expect(cmb.watch.isCanceled({ id: '12345', canceled: false }, routeWith([12345]))).toBe(true)
	})

	t('does not throw when the route has not loaded, or has no schedule', (cmb) => {
		expect(cmb.watch.isCanceled(TRIP, null)).toBe(false)
		expect(cmb.watch.isCanceled(TRIP, {})).toBe(false)
		expect(cmb.watch.isCanceled(TRIP, { schedule: {} })).toBe(false)
		expect(cmb.watch.isCanceled(null, routeWith(['x']))).toBe(false)
	})
})

describe('the stop board reads the live list, not only the cached one', () => {
	t('marks the departure canceled from the route payload alone', (cmb) => {
		const rows = cmb.stopboard.upcoming(
			departures, routeWith(['3014797_15228']), '938', 0, DAY + AT - 600, 2
		)
		expect(rows.length).toBeGreaterThan(0)
		expect(rows[0].canceled).toBe(true)
	})

	t('leaves it alone when the live list names a different trip', (cmb) => {
		const rows = cmb.stopboard.upcoming(
			departures, routeWith(['not_this_one']), '938', 0, DAY + AT - 600, 2
		)
		expect(rows[0].canceled).toBe(false)
	})
})

describe('a saved trip reads the live list too', () => {
	t('resolves to the canceled state from the route payload alone', (cmb) => {
		const watch = {
			route_id: '4', stop_id: '938', direction_id: 0,
			day_type: 'weekday', scheduled_time: cmb.watch.clockOf(AT),
		}
		const model = cmb.watch.resolve(watch, departures, routeWith(['3014797_15228']), DAY + AT - 600)
		expect(model.state).toBe('canceled')
		expect(model.detail).toMatch(/canceled/i)
	})
})
