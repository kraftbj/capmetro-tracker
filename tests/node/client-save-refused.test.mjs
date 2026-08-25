/**
 * A save the browser refused must not be announced as a save.
 *
 * writeStore has always reported the refusal — Safari private browsing, an
 * exhausted quota, storage switched off — and add() discarded it, returning the
 * new list either way. The caller then announced "Saved the 7:50a 800 SB" and
 * switched to the saved view, where the trip was not there and nothing said why.
 * On the next load it was gone entirely.
 *
 * That is the specific failure this board is otherwise careful about: not that
 * something broke, but that the interface said it worked.
 */
import { describe, expect, it } from 'vitest'
import { bootClient } from './helpers/client.mjs'

const THE_WATCH = {
  route_id: '800',
  direction_id: 1,
  direction_tag: 'SB',
  stop_id: '6293',
  stop_name: 'Simond SB',
  scheduled_time: '07:52:09',
  day_type: 'weekday',
}

/* A fresh sandbox per test: watch.js reads and writes one localStorage key, so
 * sharing one would let an earlier test decide a later one's answer. */
const fresh = () => bootClient(['format.js', 'adherence.js', 'states.js', 'watch.js'])

describe('the client scripts load', () => {
  it('boots watch.js with a working store, so the success case is not vacuous', () => {
    const c = fresh()
    expect(c.reason).toBe(null)
    expect(typeof c.cmb.watch.add).toBe('function')
    expect(c.window.localStorage).toBeTruthy()
  })
})

describe('add() reports what the store actually did', () => {
  it('says saved, and the trip is in the list, when the write goes through', () => {
    const { cmb } = fresh()
    const res = cmb.watch.add(THE_WATCH)
    expect(res.saved).toBe(true)
    expect(res.list.length).toBe(1)
    expect(cmb.watch.list().length).toBe(1)
  })

  it('says NOT saved when localStorage refuses the write', () => {
    const c = fresh()
    c.window.localStorage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    const res = c.cmb.watch.add(THE_WATCH)
    expect(res.saved).toBe(false)
  })

  /*
   * The half that made it a silent failure rather than a visible one: the list
   * add() hands back contains the trip, because it was pushed in memory. Only
   * the flag distinguishes that from a real save, which is why the flag has to
   * exist and why the caller has to read it.
   */
  it('hands back a list containing the trip even when nothing was written', () => {
    const c = fresh()
    c.window.localStorage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    const res = c.cmb.watch.add(THE_WATCH)
    expect(res.list.length).toBe(1)
    expect(c.cmb.watch.list().length).toBe(0)
  })

  it('says saved for a duplicate, because the store already holds it', () => {
    const { cmb } = fresh()
    expect(cmb.watch.add(THE_WATCH).saved).toBe(true)
    const again = cmb.watch.add(THE_WATCH)
    expect(again.saved).toBe(true)
    expect(again.list.length).toBe(1)
  })

  it('reports a refusal on the SECOND save too, not just the first', () => {
    const c = fresh()
    expect(c.cmb.watch.add(THE_WATCH).saved).toBe(true)
    c.window.localStorage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    const other = Object.assign({}, THE_WATCH, { stop_id: '6294', scheduled_time: '08:22:09' })
    expect(c.cmb.watch.add(other).saved).toBe(false)
    expect(c.cmb.watch.list().length).toBe(1)
  })
})
