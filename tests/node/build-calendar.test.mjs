/**
 * Contract section 9: per-route calendar resolution.
 *
 * This feed has no calendar.txt. Every service is enumerated date by date, and
 * there is no single "weekday" service: 1-172 covers 95 weekdays over 42 routes
 * while 9-172 covers 99 weekdays over 32. A saved watch that resolves by day of
 * week therefore returns the wrong trip on the 8 of 145 dates that carry a
 * one-off service, and 2026-08-19 is deliberately one of them.
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { gate, optionalModule } from './helpers/optional.mjs'
import { FEEDS, readText } from './helpers/fixtures.mjs'

const calendar = await optionalModule('build/lib/calendar.mjs')
const t = gate(calendar, ['buildCalendar'], it)

/** The committed calendar_dates.txt, as the build job's row shape. */
function calendarDates() {
  const [header, ...rows] = readText(path.join(FEEDS, 'gtfs_calendar_dates.txt')).trim().split('\n')
  const cols = header.trim().split(',')
  return rows.map((line) => {
    const values = line.trim().split(',')
    const row = Object.fromEntries(cols.map((c, i) => [c, values[i]]))
    return { service_id: row.service_id, date: row.date, exception_type: Number(row.exception_type) }
  })
}

/** Minimal trips, enough to attribute services to routes. */
const TRIPS = [
  { trip_id: 't1', route_id: '800', service_id: '3-172' },
  { trip_id: 't2', route_id: '800', service_id: '9-172' },
  { trip_id: 't3', route_id: '4', service_id: '3-172' },
  { trip_id: 't4', route_id: '1', service_id: '1-172' },
]

const build = () => calendar.mod.buildCalendar({ calendarDates: calendarDates(), trips: TRIPS })

describe('the committed calendar really is date-enumerated with no weekday rule', () => {
  it('lists every service date explicitly as an added exception', () => {
    const rows = calendarDates()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.exception_type === 1)).toBe(true)
  })

  it('runs service 3-172 on exactly one date, which is the captured one', () => {
    const dates = calendarDates().filter((r) => r.service_id === '3-172').map((r) => r.date)
    expect(dates).toEqual(['20260819'])
  })
})

describe('a service that runs on exactly one date makes that date an exception day', () => {
  t('marks 2026-08-19 an exception day and names 3-172 as the one-off', (mod) => {
    const { global } = build()
    expect(global.dates['20260819'].is_exception_day).toBe(true)
    expect(global.dates['20260819'].one_off_service_ids).toContain('3-172')
  })

  t('counts the one-off dates the fixture README claims', () => {
    const { global } = build()
    expect(global.exception_dates).toContain('20260819')
    expect(global.exception_dates.length).toBe(8)
  })

  t('does not mark an ordinary weekday as an exception day', () => {
    const { global } = build()
    const ordinary = Object.keys(global.dates).find((d) => !global.dates[d].is_exception_day)
    expect(ordinary).toBeDefined()
    expect(global.dates[ordinary].one_off_service_ids).toEqual([])
  })
})

describe('resolution is per route, because no service covers the whole system', () => {
  t('gives route 800 a different active service set on 20260819 than on 20260820', () => {
    const { forRoute } = build()
    const route800 = forRoute('800')
    expect(route800.dates['20260819'].service_ids).not.toEqual(route800.dates['20260820'].service_ids)
  })

  t('keeps route 800 in service on both dates, so a saved watch survives the change', () => {
    const { forRoute } = build()
    const route800 = forRoute('800')
    expect(route800.dates['20260819'].service_ids.length).toBeGreaterThan(0)
    expect(route800.dates['20260820'].service_ids.length).toBeGreaterThan(0)
  })

  t('does not attribute a service to a route that runs no trips on it', () => {
    const { forRoute } = build()
    expect(forRoute('4').service_ids).not.toContain('1-172')
    expect(forRoute('1').service_ids).toContain('1-172')
  })

  t('marks the captured date an exception day for route 800 as well as globally', () => {
    const { forRoute } = build()
    expect(forRoute('800').dates['20260819'].is_exception_day).toBe(true)
  })
})

describe('the calendar is the only definition of service, so its bounds must be real', () => {
  t('spans a contiguous range with a first and last date', () => {
    const { global } = build()
    expect(global.first_date).toMatch(/^\d{8}$/)
    expect(global.last_date).toMatch(/^\d{8}$/)
    expect(Number(global.last_date)).toBeGreaterThan(Number(global.first_date))
    expect(global.date_count).toBe(145)
  })

  t('honours an exception_type of 2 by removing that date rather than ignoring the row', () => {
    // The committed feed has none, but a future republish may, and silently
    // ignoring a removal would keep a cancelled service day on the board.
    const rows = [
      { service_id: '3-172', date: '20260819', exception_type: 1 },
      { service_id: '3-172', date: '20260819', exception_type: 2 },
    ]
    const { global } = calendar.mod.buildCalendar({ calendarDates: rows, trips: TRIPS })
    expect(global.dates['20260819']?.service_ids ?? []).not.toContain('3-172')
  })
})
