/**
 * Task D1 and the client half of silent failure 2.
 *
 * Green and amber measured at 1.06:1 luminance in the design review, so colour
 * alone conveys nothing in grayscale or in bright sun. Every indicator carries
 * a shape and a number as well. And when the server says the data is stale, the
 * badge must drop the number rather than keep showing a plausible one.
 */
import { describe, expect, it } from 'vitest'
import { gateClient, loadClient } from './helpers/client.mjs'
import { goldenRoute4, synthetic } from './helpers/fixtures.mjs'

const client = loadClient(['format.js', 'adherence.js'])
const t = gateClient(client, 'adherence', it)

const STATE_GLYPHS = {
  early: 'left-triangle',
  ontime: 'circle',
  late: 'up-triangle',
  very_late: 'square',
  unknown: 'question',
  deadhead: 'ring',
}

const vehicle = (adherence, over = {}) => ({
  vehicle_id: '2641',
  in_service: true,
  adherence: { seconds: null, glyph: null, against: null, reason: null, ...adherence },
  ...over,
})

const FRESH = { suppress_adherence: false, level: 'fresh' }
const SUPPRESSED = { suppress_adherence: true, level: 'dead' }

describe('every adherence state draws its own shape, so the board reads in grayscale', () => {
  for (const [state, glyph] of Object.entries(STATE_GLYPHS)) {
    t(`draws ${state} as the character mapped to ${glyph}`, (ns) => {
      const drawn = ns.view(vehicle({ state, glyph }), FRESH).glyph
      expect(drawn).toBe(ns.GLYPHS[glyph])
      expect(String(drawn).length).toBeGreaterThan(0)
    })
  }

  t('uses six distinct characters, so no two states collapse into one another', (ns) => {
    const drawn = Object.entries(STATE_GLYPHS).map(([state, glyph]) => ns.view(vehicle({ state, glyph }), FRESH).glyph)
    expect(new Set(drawn).size).toBe(6)
  })

  t('falls back to a shape from the state when a payload omits the glyph', (ns) => {
    expect(ns.view(vehicle({ state: 'late', seconds: 183 }), FRESH).glyph).toBe(ns.GLYPHS['up-triangle'])
  })
})

describe('a lateness value is shown as a number, never as colour alone', () => {
  t('renders a late bus with a signed minute value', (ns) => {
    const view = ns.view(vehicle({ state: 'late', seconds: 183, glyph: 'up-triangle' }), FRESH)
    expect(view.value).toMatch(/3/)
    expect(view.value).toMatch(/^\+/)
  })

  t('renders an early bus with a minus sign rather than a different colour', (ns) => {
    const view = ns.view(vehicle({ state: 'early', seconds: -240, glyph: 'left-triangle' }), FRESH)
    expect(view.value).toMatch(/[-−]/)
  })

  t('renders an unknown lateness as a dash, never as a zero', (ns) => {
    const view = ns.view(vehicle({ state: 'unknown', reason: 'no_trip_update', glyph: 'question' }), FRESH)
    expect(view.value).not.toMatch(/^[+-]?0/)
    expect(view.seconds).toBeNull()
  })

  t('renders a deadhead as out of service, not as on time', (ns) => {
    const view = ns.view(vehicle({ state: 'deadhead', glyph: 'ring' }, { in_service: false }), FRESH)
    expect(view.value.toLowerCase()).not.toMatch(/on ?time/)
    expect(view.seconds).toBeNull()
  })
})

describe('the reason an unknown is unknown reaches the user in words', () => {
  for (const reason of ['no_trip_update', 'trip_canceled', 'no_stop_predictions', 'trip_not_in_schedule', 'stale_data', 'no_progress']) {
    t(`explains ${reason} without showing the raw enum`, (ns) => {
      const view = ns.view(vehicle({ state: 'unknown', reason, glyph: 'question' }), FRESH)
      expect(view.reasonLabel).toBeTruthy()
      expect(view.reasonLabel).not.toContain('_')
    })
  }

  t('speaks the state for a screen reader, since the glyph is decorative to one', (ns) => {
    expect(ns.view(vehicle({ state: 'unknown', reason: 'stale_data', glyph: 'question' }), FRESH).spoken)
      .toMatch(/unknown/i)
    expect(ns.view(vehicle({ state: 'deadhead', glyph: 'ring' }, { in_service: false }), FRESH).spoken)
      .toMatch(/not in service/i)
  })
})

describe('when the server suppresses adherence the client shows no number at all', () => {
  t('drops a perfectly computable lateness once suppress_adherence is set', (ns) => {
    const view = ns.view(vehicle({ state: 'late', seconds: 183, glyph: 'up-triangle' }), SUPPRESSED)
    expect(view.state).toBe('unknown')
    expect(view.seconds).toBeNull()
    expect(view.value).not.toMatch(/3/)
    expect(view.suppressed).toBe(true)
  })

  t('names staleness as the reason rather than leaving the user guessing', (ns) => {
    const view = ns.view(vehicle({ state: 'ontime', seconds: -13, glyph: 'circle' }), SUPPRESSED)
    expect(view.reason).toBe('stale_data')
    expect(view.reasonLabel).toBeTruthy()
  })

  t('still marks a deadhead as a deadhead, because that fact does not go stale', (ns) => {
    const view = ns.view(vehicle({ state: 'deadhead', glyph: 'ring' }, { in_service: false }), SUPPRESSED)
    expect(view.state).toBe('deadhead')
  })

  t('shows no number for any vehicle in the dead-cron payload', (ns) => {
    const dead = synthetic('route-4-dead-cron.json')
    for (const v of dead.vehicles) {
      const view = ns.view(v, dead.staleness)
      expect(view.seconds, `vehicle ${v.vehicle_id}`).toBeNull()
      expect(view.value).not.toMatch(/\d/)
    }
  })

  t('does show numbers on the fresh golden payload, so suppression is not simply always on', (ns) => {
    const golden = goldenRoute4()
    const withNumbers = golden.vehicles
      .map((v) => ns.view(v, golden.staleness))
      .filter((view) => view.seconds !== null)
    expect(withNumbers.length).toBeGreaterThan(0)
  })
})

describe('the payload glyph and state stay in lockstep', () => {
  it('pairs every golden vehicle glyph with its state', () => {
    for (const v of goldenRoute4().vehicles) {
      expect(v.adherence.glyph).toBe(STATE_GLYPHS[v.adherence.state])
    }
  })

  it('pairs them in the dead-cron payload too', () => {
    for (const v of synthetic('route-4-dead-cron.json').vehicles) {
      expect(v.adherence.glyph).toBe(STATE_GLYPHS[v.adherence.state])
    }
  })

  it('never carries a number without an anchoring stop to explain it', () => {
    for (const v of goldenRoute4().vehicles) {
      if (v.adherence.seconds === null) continue
      expect(v.adherence.against, 'a lateness number with no anchor is unexplainable').not.toBeNull()
      expect(v.adherence.seconds).toBe(v.adherence.against.predicted_at - v.adherence.against.scheduled_at)
    }
  })
})
