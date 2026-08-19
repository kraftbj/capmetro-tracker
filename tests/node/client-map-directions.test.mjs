/**
 * map.js chips in BOTH mode.
 *
 * The chips carry the same shape, signed number and colour as the rows, and in BOTH mode
 * they now carry the direction too. Without it there was no way to tell which way a bus on
 * the map was heading — which is the entire reason BOTH mode exists. On route 4 the
 * 5th/Campbell stop is the turnaround, so a bus you are waiting for eastbound is a
 * westbound bus right up until it gets there.
 *
 * map.js had no test file at all. Two things here are worth pinning beyond "the tag
 * appears": the tag must be absent in single-direction mode, where it would be noise on a
 * panel already tight for width; and the chips must still fit, because the tag widens every
 * one of them on the narrowest screen this board targets.
 */
import { describe, expect, it } from 'vitest'
import { all, renderClient, textDeep } from './helpers/client.mjs'
import { goldenRoute4 } from './helpers/fixtures.mjs'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'map.js'])

const t = (name, fn) =>
  it(name, (ctx) => {
    if (!client.cmb) ctx.skip(client.reason)
    if (!client.cmb.map) ctx.skip('client scripts loaded but window.CMB.map is not defined')
    return fn(client.cmb, client.document)
  })

const draw = (cmb, document, data, direction = 'both') => {
  const host = document.createElement('section')
  cmb.map.render(host, data, { direction, status: 'ok' })
  return host
}

/** Chip text nodes, whatever class the panel gives them. */
const chipTexts = (host) =>
  all(host, 'map__chiptext')
    .map((n) => n.textContent || '')
    .filter(Boolean)

describe('a chip says which way its bus is going', () => {
  t('tags every in-service chip with a direction in BOTH mode', (cmb, document) => {
    const data = goldenRoute4()
    const texts = chipTexts(draw(cmb, document, data))
    expect(texts.length).toBeGreaterThan(0)
    const tagged = texts.filter((s) => / (NB|SB|EB|WB|A|B)$/.test(s))
    const inService = data.vehicles.filter((v) => v.in_service).length
    expect(tagged).toHaveLength(inService)
  })

  t('omits the tag in a single-direction view, where it would be noise', (cmb, document) => {
    const texts = chipTexts(draw(cmb, document, goldenRoute4(), 0))
    expect(texts.length).toBeGreaterThan(0)
    texts.forEach((s) => expect(s).not.toMatch(/ (NB|SB|EB|WB)$/))
  })

  t('leaves a deadhead chip untagged, because it has no trip to have a direction', (cmb, document) => {
    const data = goldenRoute4()
    const oos = data.vehicles.filter((v) => !v.in_service)
    expect(oos.length).toBeGreaterThan(0)
    const texts = chipTexts(draw(cmb, document, data))
    oos.forEach((v) => {
      const id = String(v.label || v.vehicle_id)
      const chip = texts.find((s) => s.includes(id))
      expect(chip, `no chip for out-of-service vehicle ${id}`).toBeTruthy()
      expect(chip).not.toMatch(/ (NB|SB|EB|WB)$/)
    })
  })

  t('falls back to A and B when no headsign carries a compass word', (cmb, document) => {
    const data = goldenRoute4()
    data.route.directions = data.route.directions.map((d) => ({ id: d.id, headsign: 'Downtown' }))
    data.vehicles.forEach((v) => {
      if (v.trip) v.trip.headsign = 'Downtown'
    })
    const tags = chipTexts(draw(cmb, document, data))
      .map((s) => / (\S+)$/.exec(s)?.[1])
      .filter((s) => s === 'A' || s === 'B')
    expect(tags.length).toBeGreaterThan(0)
  })

  t('reads the same tag the rows use for the same bus', (cmb, document) => {
    /*
     * rows.js and map.js each carried a verbatim copy of the direction lookup. That is the
     * shape that produced ISSUE-002, where the build and the runtime disagreed about one
     * stop's name. One bus reading "EB" in the rows and "B" on the map is the same bug.
     */
    const data = goldenRoute4()
    const fmt = client.cmb.fmt
    const texts = chipTexts(draw(cmb, document, data))
    data.vehicles
      .filter((v) => v.in_service && v.trip)
      .forEach((v) => {
        const id = String(v.label || v.vehicle_id)
        const chip = texts.find((s) => s.includes(id))
        expect(chip, `no chip for ${id}`).toBeTruthy()
        expect(chip.endsWith(fmt.directionTagFor(data, v.trip.direction_id))).toBe(true)
      })
  })
})

describe('the panel still says what it is', () => {
  t('labels itself a schematic rather than pretending to be a street map', (cmb, document) => {
    expect(textDeep(draw(cmb, document, goldenRoute4()))).toMatch(/no basemap|schematic/i)
  })
})
