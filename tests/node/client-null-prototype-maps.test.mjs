/**
 * The maps a link can put a key into must not inherit from Object.prototype.
 *
 * Every one of these bugs had the same shape: an attacker-controlled string used
 * as a property name against a plain `{}`, which answers to `constructor`,
 * `valueOf`, `toString` and the rest with something truthy. The consequences
 * ranged from a blank board to one that rendered perfectly and had silently
 * stopped refreshing.
 *
 * These assert the PROTOTYPE, directly, and they exist because the end-to-end
 * tests cannot. Each of those bugs is now guarded in two places — a
 * hasOwnProperty check at the lookup as well as the null prototype behind it —
 * so reverting either one alone leaves the browser suite green. That is worth
 * having, but it means nothing in the suite noticed when a prototype came back.
 * These do.
 */
import { describe, expect, it } from 'vitest'
import { loadClient } from './helpers/client.mjs'

const loaded = loadClient(['format.js', 'adherence.js', 'states.js'])

describe('the state-preview table', () => {
  it('loads', () => {
    expect(loaded.reason).toBe(null)
  })

  it('has no prototype, so ?state=valueOf names nothing', () => {
    const table = loaded.cmb.states.STATE_SCENARIOS
    expect(Object.getPrototypeOf(table)).toBe(null)
  })

  it('still holds every scenario, with their apply functions intact', () => {
    const table = loaded.cmb.states.STATE_SCENARIOS
    /*
     * The prototype check alone would pass on an empty object, which would also
     * "fix" the bug — by removing the feature. Object.create(null) plus a copy
     * is only correct if the copy actually happened.
     */
    const names = Object.keys(table)
    expect(names.length).toBeGreaterThan(10)
    expect(names).toContain('empty')
    expect(typeof table.empty.apply).toBe('function')
    expect(table.empty.note).toBeTruthy()
  })

  it('answers undefined for the prototype members a link could name', () => {
    const table = loaded.cmb.states.STATE_SCENARIOS
    for (const key of ['valueOf', 'constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(table[key], `?state=${key} still names something`).toBeUndefined()
    }
  })

  it('is still reachable by hasOwnProperty, which app.js gates the lookup on', () => {
    /* A null-prototype object has no .hasOwnProperty of its own; app.js calls it
     * through Object.prototype, and this is the assertion that says so. */
    const table = loaded.cmb.states.STATE_SCENARIOS
    expect(Object.prototype.hasOwnProperty.call(table, 'empty')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(table, 'valueOf')).toBe(false)
  })
})
