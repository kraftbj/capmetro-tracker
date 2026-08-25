/**
 * A stop id that names something on Object.prototype must not blank the board.
 *
 * `departures[stopId]` is a bare lookup on a plain object parsed from JSON, so
 * it also reaches the prototype. A stop id of `constructor` returns the Object
 * function: truthy, so the `|| []` fallback never fires, with a `.length` of 1
 * and nothing at [0]. The next line reads `rows[0][1]` and throws, and because
 * that happens during render the whole board goes blank rather than showing an
 * empty stop.
 *
 * This is reachable from a link, not only from internal state: app.js takes
 * `state.stopId = q.stop` straight off the query string, and that id flows into
 * both readers below. `?stop=constructor` is a URL anyone can send.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderClient } from './helpers/client.mjs'
import { ROOT } from './helpers/optional.mjs'

const client = renderClient([
  'format.js', 'adherence.js', 'states.js', 'watch.js', 'stopboard.js',
])

const departures = () =>
  JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/synthetic/departures-800.json'), 'utf8'))

/* Every name a bare {} lookup answers to that is not a stop. */
const PROTOTYPE_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']

describe('the client scripts load', () => {
  it('exposes both readers, so the assertions below cannot silently cover nothing', () => {
    expect(client.reason).toBe(null)
    expect(typeof client.cmb.watch.rowsFor).toBe('function')
    expect(typeof client.cmb.stopboard.directionsAt).toBe('function')
  })
})

describe('W.rowsFor, the one lookup every reader goes through', () => {
  it('returns the real rows for a stop that exists', () => {
    const dep = departures()
    const rows = client.cmb.watch.rowsFor(dep.departures, '6293')
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('returns an empty list for every prototype key rather than a function', () => {
    const dep = departures()
    for (const key of PROTOTYPE_KEYS) {
      expect(client.cmb.watch.rowsFor(dep.departures, key)).toEqual([])
    }
  })

  it('returns an empty list for a stop id that is simply not served', () => {
    expect(client.cmb.watch.rowsFor(departures().departures, '999999')).toEqual([])
  })

  it('refuses an own property whose value is not an array', () => {
    expect(client.cmb.watch.rowsFor({ '6293': 'not rows' }, '6293')).toEqual([])
  })
})

describe('the readers that take a stop id from the URL', () => {
  it('departuresAt does not throw on a prototype key', () => {
    const dep = departures()
    for (const key of PROTOTYPE_KEYS) {
      expect(() => client.cmb.watch.departuresAt(dep, key, 1)).not.toThrow()
      expect(client.cmb.watch.departuresAt(dep, key, 1)).toEqual([])
    }
    /* and still answers for a stop that is real, so this is not vacuous */
    expect(client.cmb.watch.departuresAt(dep, '6293', 1).length).toBeGreaterThan(0)
  })

  it('stopboard.directionsAt does not throw on a prototype key', () => {
    const dep = departures()
    for (const key of PROTOTYPE_KEYS) {
      expect(() => client.cmb.stopboard.directionsAt(dep, key)).not.toThrow()
      expect(client.cmb.stopboard.directionsAt(dep, key)).toEqual([])
    }
    expect(client.cmb.stopboard.directionsAt(dep, '6293').length).toBeGreaterThan(0)
  })
})
