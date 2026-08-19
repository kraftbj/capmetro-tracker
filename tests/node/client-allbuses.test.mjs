/**
 * allbuses.js — the fleet view.
 *
 * The panel exists to show the 143 vehicles the route boards deliberately hide,
 * so the tests that matter most are the ones about not losing a bus: every
 * vehicle in the payload must be reachable in the output, and the counts
 * printed at the top must count the things drawn below them. A fleet view that
 * says 392 over a list of 380 is worse than no fleet view.
 *
 * Numbers are computed from the payload rather than pinned, because .local/ is
 * regenerated on every run and a hardcoded 392 would fail tomorrow for a reason
 * that has nothing to do with this code. The committed trim under
 * tests/fixtures/synthetic/ is the input that is guaranteed to exist.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { all, renderClient, textDeep } from './helpers/client.mjs'
import { ROOT } from './helpers/optional.mjs'
import { synthetic } from './helpers/fixtures.mjs'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'allbuses.js'])

const t = (name, fn) =>
  it(name, (ctx) => {
    if (!client.cmb) ctx.skip(client.reason)
    if (!client.cmb.allbuses) ctx.skip('client scripts loaded but window.CMB.allbuses is not defined')
    return fn(client.cmb, client.document)
  })

const FLEET = () => synthetic('all-buses-fleet.json')

const LIVE_PATH = path.join(ROOT, '.local/webroot/api/all.json')
const live = () => JSON.parse(readFileSync(LIVE_PATH, 'utf8'))

/** The generated payload is the only input carrying 392 vehicles across 48 routes. */
const withLive = (name, fn) =>
  t(name, (cmb, document, ctx) => {
    if (!existsSync(LIVE_PATH)) return
    return fn(cmb, document, live())
  })

/*
 * The shared sandbox has no createDocumentFragment, so states.js's skeleton
 * helpers are unreachable from node — which is why no other panel's loading
 * state is asserted here. This shim is local to this file rather than a change
 * to the shared helper, which another lane owns. It only has to be appendable
 * and walkable; `all()` recurses through children either way.
 */
if (client.document && !client.document.createDocumentFragment) {
  client.document.createDocumentFragment = () => ({
    tagName: 'fragment',
    className: '',
    textContent: '',
    children: [],
    attributes: {},
    appendChild(child) {
      this.children.push(child)
      return child
    },
  })
}

const draw = (cmb, document, data, opts) => {
  const host = document.createElement('section')
  cmb.allbuses.render(host, data, { status: 'ok', onSelectRoute() {}, ...opts })
  return host
}

const label = (v) => String(v.label || v.vehicle_id)
const busIds = (host) => new Set((textDeep(host).match(/#[A-Za-z0-9_-]+/g) || []).map((s) => s.slice(1)))
const subText = (host) => (all(host, 'band__sub')[0] || {}).textContent || ''

describe('no bus is lost', () => {
  t('reaches every vehicle in the payload', (cmb, document) => {
    const data = FLEET()
    const drawn = busIds(draw(cmb, document, data))
    data.vehicles.forEach((v) => {
      expect(drawn.has(label(v)), `vehicle ${label(v)} is not anywhere in the output`).toBe(true)
    })
  })

  withLive('reaches every vehicle in the full generated payload, all 392 of them', (cmb, document, data) => {
    expect(data.vehicles.length).toBeGreaterThan(100)
    const drawn = busIds(draw(cmb, document, data))
    const missing = data.vehicles.filter((v) => !drawn.has(label(v))).map(label)
    expect(missing).toEqual([])
  })

  t('draws a row or a chip for a vehicle, never only a count', (cmb, document) => {
    const data = FLEET()
    const host = draw(cmb, document, data)
    const carrying = data.vehicles.filter((v) => v.in_service && v.trip)
    const deadhead = data.vehicles.filter((v) => !(v.in_service && v.trip))
    /* Attention rows repeat buses that also appear under their route, so rows
     * are at least the in-service count rather than exactly it. */
    expect(all(host, 'abrow').length).toBeGreaterThanOrEqual(carrying.length)
    expect(all(host, 'abchip')).toHaveLength(deadhead.length)
  })
})

describe('the counts describe what is drawn', () => {
  t('prints the in-service and out-of-service counts the payload carries', (cmb, document) => {
    const data = FLEET()
    const sub = subText(draw(cmb, document, data))
    const carrying = data.vehicles.filter((v) => v.in_service && v.trip).length
    const deadhead = data.vehicles.length - carrying
    expect(sub).toContain(`${data.vehicles.length} buses reporting`)
    expect(sub).toContain(`${carrying} carrying riders`)
    expect(sub).toContain(`${deadhead} not in service`)
  })

  withLive('agrees with the payload\'s own counts block on the generated file', (cmb, document, data) => {
    const sum = client.cmb.allbuses.summarize(data)
    expect(sum.total).toBe(data.counts.total)
    expect(sum.carrying).toBe(data.counts.in_service)
    expect(sum.deadhead).toBe(data.counts.deadhead)
    expect(sum.routes).toBe(data.counts.routes_active)
  })

  t('still counts when the payload carries no counts block', (cmb, document) => {
    const data = FLEET()
    delete data.counts
    const sub = subText(draw(cmb, document, data))
    expect(sub).toContain(`${data.vehicles.length} buses reporting`)
  })
})

describe('deadheads are said out loud', () => {
  t('names them, counts them, and says a rider cannot board one', (cmb, document) => {
    const data = FLEET()
    const text = textDeep(draw(cmb, document, data))
    const deadhead = data.vehicles.filter((v) => !(v.in_service && v.trip))
    expect(deadhead.length).toBeGreaterThan(0)
    expect(text).toContain('Not carrying passengers')
    expect(text).toMatch(/cannot board/i)
    expect(text).toMatch(/out of service/i)
    expect(text).toContain(`${deadhead.length} buses`)
  })

  t('separates the ones on the move from the ones parked, and never guesses', (cmb, document) => {
    const data = FLEET()
    const host = draw(cmb, document, data)
    const moving = data.vehicles.filter(
      (v) => !(v.in_service && v.trip) && v.position && v.position.speed_mps > 0,
    )
    expect(moving.length).toBeGreaterThan(0)
    expect(all(host, 'abchip--moving')).toHaveLength(moving.length)

    /* A missing speed is its own group. Folding it into "stopped" would report
     * a bus as parked on the strength of a field the feed did not send. */
    const unknown = structuredClone(data)
    unknown.vehicles.forEach((v) => {
      if (!(v.in_service && v.trip) && v.position) delete v.position.speed_mps
    })
    const host2 = draw(cmb, document, unknown)
    expect(all(host2, 'abchip--stopped')).toHaveLength(0)
    expect(all(host2, 'abchip--unknown').length).toBeGreaterThan(0)
    expect(textDeep(host2)).toMatch(/Speed not reported/)
  })

  t('spells out every chip for a screen reader, since the chip itself is two tokens', (cmb, document) => {
    const chips = all(draw(cmb, document, FLEET()), 'abchip')
    expect(chips.length).toBeGreaterThan(0)
    chips.forEach((c) => {
      expect(c.getAttribute('aria-label')).toMatch(/^Bus .+ not carrying passengers/)
    })
  })
})

describe('the exceptional leads', () => {
  t('lists exactly the very late and the unmeasurable above the fold', (cmb, document) => {
    const data = FLEET()
    const host = draw(cmb, document, data)
    const flagged = data.vehicles.filter((v) => {
      const s = v.adherence && v.adherence.state
      return v.in_service && v.trip && (s === 'very_late' || s === 'unknown')
    })
    expect(flagged.length).toBeGreaterThan(0)
    const band = all(host, 'abband--attention')[0]
    expect(band).toBeTruthy()
    const ids = busIds(band)
    flagged.forEach((v) => expect(ids.has(label(v))).toBe(true))
    expect(ids.size).toBe(flagged.length)
  })

  t('says so plainly when nothing is wrong, rather than showing an empty box', (cmb, document) => {
    const data = FLEET()
    data.vehicles.forEach((v) => {
      if (v.adherence && v.adherence.state === 'very_late') v.adherence.state = 'ontime'
    })
    const band = all(draw(cmb, document, data), 'abband--attention')[0]
    expect(all(band, 'notice')).toHaveLength(1)
    expect(textDeep(band)).toMatch(/No bus is running very late/)
  })

  withLive('orders the route groups by worst news, not by route number', (cmb, document, data) => {
    const host = draw(cmb, document, data)
    const heads = all(host, 'abroute__id').map((n) => n.textContent)
    expect(heads.length).toBeGreaterThan(5)
    const worst = (routeName) => {
      const order = { very_late: 0, late: 1, early: 2, unknown: 3, ontime: 4 }
      return Math.min(
        ...data.vehicles
          .filter((v) => v.in_service && v.trip && (v.route_short_name || v.route_id) === routeName)
          .map((v) => order[v.adherence.state] ?? 9),
      )
    }
    const severities = heads.map(worst)
    expect(severities).toEqual([...severities].sort((a, b) => a - b))
  })
})

describe('a lateness reading is never invented and never leaks', () => {
  t('shows no deviation anywhere when suppress_adherence is set', (cmb, document) => {
    const data = FLEET()
    data.staleness = {
      level: 'stale',
      oldest_feed_age_s: 940,
      schedule_age_days: 1,
      suppress_adherence: true,
      reason: 'positions feed has not updated since 9:54a',
    }
    const host = draw(cmb, document, data)
    const text = textDeep(host)

    /* Signed minutes are the only way this board writes a deviation. */
    expect(text).not.toMatch(/[+−-]\d+\s*m\b/)

    /* Nor may a state word stand in for the number. */
    all(host, 'abrow__state').forEach((n) => {
      expect(['unknown', 'not in service']).toContain(n.textContent)
    })
    all(host, 'badge__value').forEach((n) => {
      expect(['—', 'OUT']).toContain(n.textContent)
    })
    /* Nor the two clocks the deviation is the difference between. */
    expect(text).toMatch(/timing unavailable/)
    expect(text).not.toMatch(/\bpred\b/)
    expect(text).not.toContain('very late')
  })

  t('keeps the ranking honest by not ranking at all while suppressed', (cmb, document) => {
    const data = FLEET()
    data.staleness = { level: 'stale', oldest_feed_age_s: 940, suppress_adherence: true, reason: null }
    const host = draw(cmb, document, data)
    expect(textDeep(all(host, 'abband--attention')[0])).toMatch(/cannot say which buses are late/i)
    const names = all(host, 'abroute__id').map((n) => n.textContent)
    const numeric = names.map(Number).filter((n) => !Number.isNaN(n))
    expect(numeric).toEqual([...numeric].sort((a, b) => a - b))
  })

  t('reads a bus the same way the route board does', (cmb, document) => {
    const data = FLEET()
    const host = draw(cmb, document, data)
    const states = all(host, 'abrow__state').map((n) => n.textContent)
    const allowed = Object.values(client.cmb.adherence.STATE_LABEL)
    states.forEach((s) => expect(allowed).toContain(s))
  })
})

describe('nothing renders blank', () => {
  t('says something when the fleet is empty rather than drawing an empty list', (cmb, document) => {
    const data = FLEET()
    data.vehicles = []
    const host = draw(cmb, document, data)
    expect(all(host, 'notice')).toHaveLength(1)
    expect(textDeep(host)).toMatch(/no buses at all/i)
    expect(all(host, 'abrow')).toHaveLength(0)
  })

  t('survives a payload with no vehicles key at all', (cmb, document) => {
    expect(() => draw(cmb, document, {})).not.toThrow()
    expect(textDeep(draw(cmb, document, {}))).toMatch(/no buses at all/i)
  })

  t('draws skeletons while loading and a retry while broken', (cmb, document) => {
    const loading = draw(cmb, document, null, { status: 'loading' })
    expect(all(loading, 'sk').length).toBeGreaterThan(0)

    const broken = draw(cmb, document, null, { status: 'error', errorDetail: 'DNS failure' })
    expect(all(broken, 'notice--error')).toHaveLength(1)
    expect(all(broken, 'btn--retry')).toHaveLength(1)
    expect(textDeep(broken)).toContain('DNS failure')
  })
})

describe('a thin vehicle record does not take the panel down', () => {
  t('renders a vehicle with no position, no adherence and no trip', (cmb, document) => {
    const data = {
      schema: 1,
      generated_at: 1787152239,
      staleness: { level: 'fresh', suppress_adherence: false },
      vehicles: [
        { vehicle_id: '900', label: '900', in_service: false },
        {
          vehicle_id: '901',
          label: '901',
          route_id: '7',
          in_service: true,
          trip: { trip_id: 'x', direction_id: 0, start_time: '10:00:00' },
        },
      ],
    }
    let host
    expect(() => {
      host = draw(cmb, document, data)
    }).not.toThrow()
    const ids = busIds(host)
    expect(ids.has('900')).toBe(true)
    expect(ids.has('901')).toBe(true)
    /* No headsign is a stated absence, not a printed "undefined". */
    expect(textDeep(host)).not.toContain('undefined')
  })

  t('does not offer a tap target when there is nowhere to tap through to', (cmb, document) => {
    const withHandler = draw(cmb, document, FLEET())
    expect(all(withHandler, 'abroute__head')[0].tagName).toBe('button')

    const host = document.createElement('section')
    cmb.allbuses.render(host, FLEET(), { status: 'ok' })
    expect(all(host, 'abroute__head')[0].tagName).toBe('div')
  })
})
