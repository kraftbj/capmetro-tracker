/**
 * Block continuation copy in the rows, for the case the board got wrong: a successor that
 * leaves this route.
 *
 * Blocks interline. Block 1010 is the contract's own worked example — 92 trips across
 * routes 1, 4 and 485 — and every weekday afternoon it hands a route 4 eastbound trip to
 * a route 1 trip starting at Bluff Springs/William Cannon, which is nowhere on route 4.
 * The row said:
 *
 *     Likely then runs the 4:56p EB from Bluff Springs/William…
 *
 * Two things wrong with that sentence, both from the same mistake. `direction_id` is a
 * per-route index, not a compass bearing: route 4 direction 1 is "4 Shady EB" and route 1
 * direction 1 is "1 Tech Ridge Park & Ride NB". Resolving the successor's direction_id
 * against the OPEN payload's route printed "EB" for a bus about to run north. And with the
 * route unnamed, the stop had no explanation and read as a join bug.
 *
 * That is the same shape as the rows-grouping regression pinned in
 * client-rows-directions.test.mjs: a key resolved against a source that does not define
 * it. There the wrong source dropped a bus; here it invents a bearing.
 *
 * The values below are the real ones — production /api/route/4.json for bus 2620 on
 * 2026-09-02, and the real route 1 catalog row from /api/routes.json.
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

/** The catalog as /api/routes.json publishes it. Route 1 direction 1 is NORTHBOUND. */
const CATALOG = [
  {
    id: '1',
    short_name: '1',
    directions: [
      { id: 0, headsign: '1 William Cannon SB' },
      { id: 1, headsign: '1 Tech Ridge Park & Ride NB' },
    ],
  },
  {
    id: '4',
    short_name: '4',
    directions: [
      { id: 0, headsign: '4 Mopac WB' },
      { id: 1, headsign: '4 Shady EB' },
    ],
  },
]

/** Bus 2620's real block, verbatim from the production payload. */
const CROSS_ROUTE_BLOCK = () => ({
  block_id: '1010',
  confidence: 'low',
  spans_routes: true,
  route_ids: ['1', '4', '485'],
  next_trip: {
    trip_id: '2997899_0076',
    route_id: '1',
    route_short_name: '1',
    direction_id: 1,
    start_time: '16:56:00',
    start_epoch: 1788386160,
    start_stop_id: '554',
    start_stop_name: 'Bluff Springs/William…',
    is_direction_flip: false,
  },
  is_last_trip: false,
})

/** The route 4 payload, which knows nothing about route 1. */
const ROUTE_4 = () => ({ route: { id: '4', directions: CATALOG[1].directions } })

const cont = (cmb, block, routes, ownRouteId = '4') =>
  cmb.rows.continuationText(block, ROUTE_4(), routes, ownRouteId)

describe('a continuation onto another route', () => {
  t('reads the bearing off the SUCCESSOR route, not the open payload', (cmb) => {
    const out = cont(cmb, CROSS_ROUTE_BLOCK(), CATALOG)
    /*
     * The regression itself. Before the fix this said EB, because route 4 direction 1 is
     * eastbound. The bus is going north.
     */
    expect(out.text).toContain('NB')
    expect(out.text).not.toContain('EB')
    expect(out.chip).toContain('NB')
    expect(out.chip).not.toContain('EB')
  })

  t('names the route, so the unfamiliar stop has an explanation', (cmb) => {
    const out = cont(cmb, CROSS_ROUTE_BLOCK(), CATALOG)
    expect(out.text).toContain('route 1')
    expect(out.text).toContain('Bluff Springs/William…')
    expect(out.chip).toContain('route 1')
  })

  t('keeps the low-confidence hedge', (cmb) => {
    const out = cont(cmb, CROSS_ROUTE_BLOCK(), CATALOG)
    expect(out.hedged).toBe(true)
    expect(out.text).toContain('the feed does not confirm this continuation')
    expect(out.text.startsWith('Likely ')).toBe(true)
  })

  t('does not claim a turnaround from two direction_ids that mean different things', (cmb) => {
    /*
     * is_direction_flip compares route 4's direction 1 with route 1's direction 1 and
     * reports false, but "becomes" would be just as wrong if the ids happened to differ:
     * across routes the comparison has no meaning. Say "then runs" either way.
     */
    const flipped = CROSS_ROUTE_BLOCK()
    flipped.next_trip.is_direction_flip = true
    expect(cont(cmb, flipped, CATALOG).text).toContain('then runs')
    expect(cont(cmb, flipped, CATALOG).text).not.toContain('becomes')
  })
})

describe('when the catalog cannot answer', () => {
  /*
   * api/routes.json has not landed yet, or the board was opened from disk where there is
   * no catalog at all. app.js hands over the fallback catalog, whose directions are empty.
   * A missing bearing is a gap; a borrowed one is a lie.
   */
  const BLANK = [{ id: '1', short_name: '1', directions: [] }]

  t('omits the bearing rather than borrowing this route\'s', (cmb) => {
    for (const routes of [undefined, [], BLANK]) {
      const out = cont(cmb, CROSS_ROUTE_BLOCK(), routes)
      expect(out.text).not.toContain('EB')
      expect(out.text).not.toContain('NB')
      /* The route and the stop are still named — those came from the payload. */
      expect(out.text).toContain('route 1')
      expect(out.text).toContain('Bluff Springs/William…')
    }
  })
})

describe('a continuation that stays on this route is unchanged', () => {
  /*
   * The fix must not touch the 214 single-route blocks in the capture, which are the
   * common case. Here the open payload IS the successor's route, so it is the right
   * source and the old wording stands.
   */
  const sameRoute = (flip) => ({
    block_id: '4001',
    confidence: 'high',
    spans_routes: false,
    route_ids: ['4'],
    next_trip: {
      trip_id: '3014732_15571',
      route_id: '4',
      route_short_name: '4',
      direction_id: 0,
      start_time: '16:49:00',
      start_epoch: 1788385740,
      start_stop_id: '1368',
      start_stop_name: 'Pleasant Valley/5th',
      is_direction_flip: flip,
    },
    is_last_trip: false,
  })

  t('uses the payload vocabulary and says nothing about a route', (cmb) => {
    const out = cont(cmb, sameRoute(true), CATALOG)
    expect(out.text).toContain('WB')
    expect(out.text).not.toContain('route 4')
    expect(out.hedged).toBe(false)
  })

  t('still says "becomes" on a genuine direction flip within one route', (cmb) => {
    expect(cont(cmb, sameRoute(true), CATALOG).text.startsWith('Becomes ')).toBe(true)
    expect(cont(cmb, sameRoute(false), CATALOG).text.startsWith('Then runs ')).toBe(true)
  })

  t('still reports the end of a block', (cmb) => {
    const out = cont(cmb, { block_id: '1010', next_trip: null }, CATALOG)
    expect(out.text).toBe('Last trip of block 1010.')
  })
})

describe('the catalog actually reaches the rendered row', () => {
  /*
   * The unit tests above call continuationText directly, so they pass even if render
   * never forwards opts.routes. This is the wiring: a real payload, drawn the way the
   * board draws it, asserting on the DOM the reader sees.
   */
  t('draws the successor route and its own bearing in the row', (cmb, document) => {
    const data = goldenRoute4()
    const target = data.vehicles.find((v) => v.block && v.block.block_id === '1010')
    expect(target).toBeTruthy()
    target.block = CROSS_ROUTE_BLOCK()

    const host = document.createElement('section')
    cmb.rows.render(host, data, { direction: 'both', status: 'ok', routes: CATALOG })

    const chips = all(host, 'chip--block').map(textDeep).join(' | ')
    expect(chips).toContain('route 1')
    expect(chips).toContain('NB')

    /* And the row that carries it is the one that reads the block out loud. */
    const spoken = all(host, 'vrow__main')
      .map((n) => n.attributes?.['aria-label'] || '')
      .join(' | ')
    expect(spoken).toContain('route 1 NB')
  })
})
