/**
 * The published successor must be the next trip the block actually runs, on every date.
 *
 * This is the corpus form of build-blocks-service-day.test.mjs. The unit test pins the shape
 * on a minimised block; this one asserts the property over every route, every block and all
 * 145 dates in the committed shards, because the bug it guards was invisible in every
 * hand-made case and only showed up against the real feed.
 *
 * Two things it does deliberately:
 *
 * A GLOBAL trip table, not a per-route one. Chains are computed over every trip in the feed
 * because a block may interline across routes, so reconstructing a block from one route's
 * shard produces false failures — a successor legitimately on another route looks missing.
 * The first measurement of this bug made exactly that mistake and had to be redone.
 *
 * It accepts any id in trip_id_by_service. The successor is one physical run minted once per
 * service variant, so which id is correct depends on the date; the runtime resolves it from
 * the day's active services. What must hold here is that the run is the right one.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './helpers/optional.mjs'

const DATA = path.join(ROOT, 'data')
const routesDir = path.join(DATA, 'routes')
const present = existsSync(routesDir) && existsSync(path.join(DATA, 'calendar.json'))

const t = present ? it : it.skip

const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const secondsOf = (clock) => {
	const [ h, m, s ] = String(clock).split(':').map(Number)
	return h * 3600 + m * 60 + s
}

function corpus() {
	const trips = new Map()
	const continuation = new Map()
	for (const dir of readdirSync(routesDir)) {
		const base = path.join(routesDir, dir)
		const sp = path.join(base, 'schedule.json')
		const bp = path.join(base, 'blocks.json')
		if (!existsSync(sp) || !existsSync(bp)) continue
		for (const [ id, e ] of Object.entries(read(sp).trips ?? {})) {
			trips.set(id, {
				service_id: e.service_id,
				block_id: e.block_id ?? null,
				start_s: secondsOf(e.start_time),
			})
		}
		for (const [ id, e ] of Object.entries(read(bp).trips ?? {})) continuation.set(id, e)
	}
	const dates = read(path.join(DATA, 'calendar.json')).dates ?? {}
	const byBlock = new Map()
	for (const [ id, e ] of trips) {
		if (!e.block_id) continue
		if (!byBlock.has(e.block_id)) byBlock.set(e.block_id, [])
		byBlock.get(e.block_id).push(id)
	}
	return { trips, continuation, dates, byBlock }
}

describe('every published block continuation names the trip the block actually runs next', () => {
	t('holds across every route, block and date in the committed shards', () => {
		const { trips, continuation, dates, byBlock } = corpus()
		let examined = 0
		let multiServiceDates = 0
		const wrong = []

		for (const [ date, info ] of Object.entries(dates)) {
			const active = new Set(info.service_ids ?? [])
			if (active.size > 1) multiServiceDates++
			for (const ids of byBlock.values()) {
				const running = ids
					.filter((id) => active.has(trips.get(id).service_id))
					.sort((a, b) => trips.get(a).start_s - trips.get(b).start_s)
				for (let i = 0; i < running.length; i++) {
					const next = continuation.get(running[i])?.next_trip
					if (!next?.trip_id) continue
					examined++
					const truth = running[i + 1] ?? null
					const candidates = new Set(Object.values(next.trip_id_by_service ?? {}))
					if (!candidates.size) candidates.add(next.trip_id)
					if (!candidates.has(truth)) {
						if (wrong.length < 5) {
							wrong.push(`${date} block ${trips.get(running[i]).block_id} ` +
								`${running[i]} -> published ${[ ...candidates ].join('/')}, runs ${truth}`)
						}
					}
				}
			}
		}

		/*
		 * Guards against a green run that checked nothing. The second matters most: the bug
		 * only exists where two services are co-active, so a corpus with none of those would
		 * pass this file while the board was still wrong.
		 */
		expect(examined, 'no continuations were examined').toBeGreaterThan(0)
		expect(multiServiceDates, 'no date had two active services, so nothing was really tested')
			.toBeGreaterThan(0)

		/*
		 * Four trips in this feed genuinely chain to different successors depending on the
		 * date, which the build reports as `invariant_breaks`. They are a known property of
		 * the feed rather than a defect in the chaining, and are budgeted rather than
		 * ignored: if the number grows, the assumption that next_trip may publish one
		 * departure time needs revisiting.
		 */
		expect(wrong.length, `wrong successors:\n${wrong.join('\n')}`).toBeLessThanOrEqual(4)
	})
})
