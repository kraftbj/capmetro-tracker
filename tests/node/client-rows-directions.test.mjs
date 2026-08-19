/**
 * rows.js in BOTH mode, where the vehicle list groups by direction.
 *
 * The grouping exists so the columns line up with the ladders beneath them. Left as one
 * time-ordered list, the rows flowed into the desktop two-column grid alternating
 * southbound, northbound, southbound, northbound, so neither column matched the ladder
 * under it and the pairing read as noise.
 *
 * Grouping introduced a way to lose a bus, which the flat list did not have: a vehicle
 * whose direction_id is missing from route.directions has no group to land in. Verified
 * against the real route 4 payload — trimming the published directions to one took the
 * rows from six to four, one of the two lost buses in service, while the header above went
 * on counting all six. That is the worst failure this board can have, because a bus that
 * is not drawn reads exactly like a bus that is not running.
 *
 * So the first test here is a count invariant, not a fixture constant: whatever the payload
 * says, every bus it hands over gets a row.
 */
import { describe, expect, it } from 'vitest'
import { all, renderClient, textDeep } from './helpers/client.mjs'
import { goldenRoute4 } from './helpers/fixtures.mjs'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'rows.js'])

const t = (name, fn) =>
  it(name, (ctx) => {
    if (!client.cmb) ctx.skip(client.reason)
    if (!client.cmb.rows) ctx.skip('client scripts loaded but window.CMB.rows is not defined')
    return fn(client.cmb, client.document)
  })

const draw = (cmb, document, data, direction = 'both') => {
  const host = document.createElement('section')
  cmb.rows.render(host, data, { direction, status: 'ok' })
  return host
}

/** Every vehicle the payload expects to see drawn, in service or not. */
const drawable = (data) => (data.vehicles || []).filter((v) => v.trip || !v.in_service)

describe('every bus in the payload gets a row', () => {
  t('draws one row per vehicle on the unmodified payload', (cmb, document) => {
    const data = goldenRoute4()
    expect(all(draw(cmb, document, data), 'vrow')).toHaveLength(drawable(data).length)
  })

  t('keeps every bus visible when route.directions omits a direction it reports', (cmb, document) => {
    /*
     * The regression, pinned. Before the fix this drew 4 rows for 6 buses. It is written
     * against a count computed from the payload rather than the literal 6, so it keeps
     * meaning the same thing if the fixture is ever recaptured.
     */
    const data = goldenRoute4()
    const reported = new Set(data.vehicles.filter((v) => v.trip).map((v) => v.trip.direction_id))
    expect(reported.size).toBeGreaterThan(1)

    data.route.directions = data.route.directions.slice(0, 1)
    expect(all(draw(cmb, document, data), 'vrow')).toHaveLength(drawable(data).length)
  })

  t('keeps every bus visible when route.directions is absent entirely', (cmb, document) => {
    const data = goldenRoute4()
    delete data.route.directions
    expect(all(draw(cmb, document, data), 'vrow')).toHaveLength(drawable(data).length)
  })

  t('never claims more buses in the header than it draws as rows', (cmb, document) => {
    const data = goldenRoute4()
    data.route.directions = data.route.directions.slice(0, 1)
    const host = draw(cmb, document, data)
    const claimed = Number(/(\d+)/.exec(textDeep(host))?.[1])
    const inService = data.vehicles.filter((v) => v.in_service).length
    expect(claimed).toBe(inService)
    const oos = data.vehicles.length - inService
    expect(all(host, 'vrow')).toHaveLength(claimed + oos)
  })
})

describe('the groups pair with the ladders below them', () => {
  t('draws one block per direction, in ladder order', (cmb, document) => {
    const data = goldenRoute4()
    const host = draw(cmb, document, data)
    const groups = all(host, 'dirgroup')
    expect(groups).toHaveLength(2)
    expect(all(host, 'dirtag').map((n) => n.textContent)).toEqual(['WB', 'EB'])
  })

  t('puts every bus in the group matching its own direction_id', (cmb, document) => {
    /*
     * Counting groups proves nothing about pairing. This walks each group, reads the
     * vehicle id off each row, and checks that vehicle's own direction against the group's.
     */
    const data = goldenRoute4()
    const byId = new Map(data.vehicles.map((v) => [String(v.label || v.vehicle_id), v]))
    const host = draw(cmb, document, data)
    const order = client.cmb.fmt.directionsForRows(data)

    const groups = all(host, 'dirgroup')
    groups.forEach((group, i) => {
      const dir = order[i]
      all(group, 'vrow').forEach((row) => {
        const text = textDeep(row)
        const match = [...byId.keys()].find((id) => text.includes(id))
        expect(match, `no known vehicle id in row text: ${text}`).toBeTruthy()
        expect(byId.get(match).trip.direction_id).toBe(dir.id)
      })
    })
  })

  t('omits a direction group entirely rather than drawing an empty one', (cmb, document) => {
    const data = goldenRoute4()
    data.vehicles.forEach((v) => {
      if (v.trip) v.trip.direction_id = 0
    })
    expect(all(draw(cmb, document, data), 'dirgroup')).toHaveLength(1)
  })

  t('gives every row a unique detail id across groups', (cmb, document) => {
    /*
     * Rows are keyed `dir.id + '-' + i`, so index alone would collide between groups and
     * the first group's disclosure would open the second group's panel.
     */
    const host = draw(cmb, document, goldenRoute4())
    const ids = all(host, 'vrow')
      .flatMap((row) => all(row, 'vrow__main'))
      .map((n) => n.getAttribute('aria-controls'))
      .filter(Boolean)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })

  t('renders a readable group header when the contract sends a null headsign', (cmb, document) => {
    const data = goldenRoute4()
    data.route.directions = data.route.directions.map((d) => ({ id: d.id, headsign: null }))
    all(draw(cmb, document, data), 'dirgroup').forEach((group) => {
      expect(textDeep(group).trim()).not.toBe('')
      expect(all(group, 'dirtag')[0].textContent).toMatch(/^(A|B|NB|SB|EB|WB)$/)
    })
  })
})

describe('single-direction mode is still a flat list', () => {
  t('draws no direction groups when one direction is selected', (cmb, document) => {
    const host = draw(cmb, document, goldenRoute4(), 0)
    expect(all(host, 'dirgroup')).toHaveLength(0)
    expect(all(host, 'vrow').length).toBeGreaterThan(0)
  })
})
