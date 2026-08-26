/**
 * A trip that reaches the same stop twice.
 *
 * The editor offers connections from `downstreamStops`, which filters to calls
 * strictly AFTER boarding. The resolver recovered the alighting time from
 * `tripTimeAt`, which returned the first row in the table. On a loop or a
 * turnaround those are different calls, so the two halves of the feature
 * disagreed about which bus the rider was on — and always in the same
 * direction, because the earlier call is the earlier time, so the slack always
 * came out too long.
 *
 * This reads the REAL generated corpus rather than the committed fixture, and
 * that is the point rather than an accident. The fixture is routes 800 and 4,
 * and neither has a trip that calls a stop twice, so no fixture-shaped test can
 * see this. Five routes in the current feed do — 270 trip-and-stop pairs —
 * which is exactly the gap CLAUDE.md describes: "a fixture-only pass reported
 * clean".
 *
 * Skips rather than fails when the corpus is absent, because it is a local
 * artifact and not everyone checking out this repo will have generated one.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './helpers/optional.mjs'
import { renderClient } from './helpers/client.mjs'

const CORPUS = path.join(ROOT, '.local/test-webroot/api/departures')
const client = renderClient(['format.js', 'adherence.js', 'states.js', 'watch.js', 'chain.js'])

/** The first (route, stop, trip) in the corpus where one trip calls a stop twice. */
function findDoubleCall() {
  for (const name of readdirSync(CORPUS).sort()) {
    const doc = JSON.parse(readFileSync(path.join(CORPUS, name), 'utf8'))
    for (const [stopId, rows] of Object.entries(doc.departures || {})) {
      const byTrip = new Map()
      for (const r of rows) byTrip.set(r[1], [...(byTrip.get(r[1]) || []), r[0]])
      for (const [tripIndex, times] of byTrip) {
        if (times.length > 1) {
          return { doc, stopId, tripIndex, times: times.slice().sort((a, b) => a - b) }
        }
      }
    }
  }
  return null
}

const t = (name, fn) =>
  it(name, (ctx) => {
    if (!existsSync(CORPUS)) ctx.skip('no generated corpus at .local/test-webroot')
    if (!client.cmb?.chain) ctx.skip(client.reason || 'chain.js did not load')
    return fn(client.cmb.chain)
  })

describe('a trip that calls the same stop twice', () => {
  t('is read at the call after boarding, not the first one in the table', (chain) => {
    const found = findDoubleCall()
    expect(found, 'the corpus should contain at least one double call').toBeTruthy()
    const { doc, stopId, tripIndex, times } = found
    const [first, second] = times

    /*
     * Board between the two calls. That is the state the editor can put a reader
     * in: downstreamStops offered the second call, so the second is the one the
     * rider actually gets off at.
     */
    const boarded = first + 1
    expect(chain.tripTimeAt(doc, tripIndex, stopId, boarded)).toBe(second)

    /* Boarding before either call still gets the first: an ordinary trip is
     * unaffected, which is what stops this fix from moving everything else. */
    expect(chain.tripTimeAt(doc, tripIndex, stopId, first - 1)).toBe(first)

    /* And with nothing to go on it still answers, rather than refusing. */
    expect(chain.tripTimeAt(doc, tripIndex, stopId, null)).toBe(first)
  })

  t('the two calls are far enough apart to change a verdict', (chain) => {
    /*
     * Guards the test above against a corpus where the two calls are seconds
     * apart and the bug would be invisible anyway. In the current feed the gap
     * is around 52 minutes, which is the difference between "holds" and a
     * connection that left without you.
     */
    const found = findDoubleCall()
    const [first, second] = found.times
    expect(second - first).toBeGreaterThan(60)
  })
})
