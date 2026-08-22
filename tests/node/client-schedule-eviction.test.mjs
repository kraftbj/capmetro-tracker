/**
 * A departures document is kept for the service day it describes, not for the
 * life of the tab.
 *
 * The bug: `loadDepartures` returned early whenever `state.departures[routeId]`
 * held anything at all, so the first document a tab fetched was the only one it
 * ever had. A phone left on the counter overnight and picked up at seven still
 * answered from yesterday's schedule — every saved trip reading "the last one
 * today has gone", or times belonging to the wrong service day entirely, on the
 * surface someone consults at breakfast and has no reason to doubt.
 *
 * Two decisions carry the fix and both are asserted here directly, because both
 * have a wrong answer that looks reasonable:
 *
 *   currentServiceDate  — what "today" is, and specifically where it may NOT be
 *                         read from. The bundled fixture is a frozen capture,
 *                         not a statement about today.
 *   scheduleExpired     — OLDER, not merely different. `!==` also condemns a
 *                         document from the future, which is what a tab holds
 *                         for a few seconds either side of the service-day roll.
 */
import { describe, expect, it } from 'vitest'
import { bootClient } from './helpers/client.mjs'

const client = bootClient([
  'format.js', 'adherence.js', 'states.js', 'allbuses.js', 'watch.js',
  'stopboard.js', 'map.js', 'ladder.js', 'rows.js', 'near.js', 'app.js',
])

/*
 * No ctx.skip here. app.js failing to boot is the thing this file exists to
 * catch, and a skip would report that as a pass — the failure mode the suite has
 * already shipped once.
 */
describe('the client scripts load', () => {
  it('boots app.js and exposes the service-day decisions', () => {
    expect(client.reason).toBe(null)
    expect(client.cmb.app).toBeTruthy()
    expect(typeof client.cmb.app.currentServiceDate).toBe('function')
    expect(typeof client.cmb.app.scheduleExpired).toBe('function')
  })
})

const app = () => client.cmb.app

const dayOf = (date) => ({ service_day: { date } })

describe('what the board believes today is', () => {
  it('reads the service date off the live route payload', () => {
    expect(app().currentServiceDate({ data: dayOf('20260822') })).toBe('20260822')
  })

  /*
   * The regression that made the eviction unsafe to ship on its own. The bundled
   * fixture is a frozen capture; route 4 is the default and the only bundled
   * route, so a single failed request used to make its date "today" — and every
   * cached schedule from the actual today instantly expired, on a connection
   * that had just proved it could not fetch a replacement.
   */
  it('refuses to read today off the bundled fixture', () => {
    const state = { usingFixture: true, data: dayOf('20260819'), routeData: {} }
    expect(app().currentServiceDate(state)).toBe(null)
  })

  it('still answers from a live payload for another route while on the fixture', () => {
    const state = {
      usingFixture: true,
      data: dayOf('20260819'),
      routeData: { 800: dayOf('20260822') },
    }
    expect(app().currentServiceDate(state)).toBe('20260822')
  })

  it('falls back to the all-buses payload, then to any cached route payload', () => {
    expect(app().currentServiceDate({ all: dayOf('20260822'), routeData: {} })).toBe('20260822')
    expect(app().currentServiceDate({ routeData: { 7: dayOf('20260822') } })).toBe('20260822')
  })

  it('answers null when nothing live has been seen, so nothing is judged expired', () => {
    expect(app().currentServiceDate({ routeData: {} })).toBe(null)
    expect(app().scheduleExpired({ service_date: '20250101' }, null)).toBe(false)
  })
})

describe('whether a departures document has expired', () => {
  it('condemns a document from an earlier service day', () => {
    expect(app().scheduleExpired({ service_date: '20260821' }, '20260822')).toBe(true)
  })

  it('keeps a document from the current service day', () => {
    expect(app().scheduleExpired({ service_date: '20260822' }, '20260822')).toBe(false)
  })

  /*
   * Older, not merely different. Around the service-day roll `state.data` can
   * still be from before it while a schedule fetched a moment later is from
   * after; `!==` called the FRESHER of the two expired and re-fetched it once a
   * minute until the live payload caught up.
   */
  it('does not condemn a document from a LATER service day', () => {
    expect(app().scheduleExpired({ service_date: '20260823' }, '20260822')).toBe(false)
  })

  it('compares across a month and a year boundary, which YYYYMMDD makes safe', () => {
    expect(app().scheduleExpired({ service_date: '20260831' }, '20260901')).toBe(true)
    expect(app().scheduleExpired({ service_date: '20261231' }, '20270101')).toBe(true)
    expect(app().scheduleExpired({ service_date: '20270101' }, '20261231')).toBe(false)
  })

  it('does not throw on a missing document or a missing service_date', () => {
    expect(app().scheduleExpired(null, '20260822')).toBe(false)
    expect(app().scheduleExpired({}, '20260822')).toBe(false)
  })
})
