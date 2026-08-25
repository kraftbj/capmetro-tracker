/**
 * The sandboxes load the client by reading index.html. This is what stops that
 * reading from being quietly wrong.
 *
 * A derived list has one failure mode a hand-written one does not: it can come
 * back SHORTER than reality and nothing complains. A sandbox missing a script
 * does not error — the client simply has one fewer namespace on window.CMB, and
 * whichever test needed it skips or asserts against undefined. That is a green
 * suite covering less than it says it does, which is the failure this project
 * has already shipped twice.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './helpers/optional.mjs'
import { CLIENT_SCRIPTS } from './helpers/client.mjs'

const html = readFileSync(path.join(ROOT, 'client/index.html'), 'utf8')

describe('the client script list the sandboxes load', () => {
  it('names every script index.html loads, in the order it loads them', () => {
    /*
     * Counted independently of the helper's own parser, so a bug in that parser
     * cannot make this agree with itself. `data/` is the bundled fixture, which
     * the sandboxes leave out on purpose.
     */
    const inPage = (html.replace(/<!--[\s\S]*?-->/g, '').match(/<script[^>]*\bsrc=/g) || []).length
    const fixtures = (html.replace(/<!--[\s\S]*?-->/g, '').match(/<script[^>]*\bsrc="data\//g) || []).length
    expect(CLIENT_SCRIPTS.length).toBe(inPage - fixtures)
  })

  it('ends at app.js, which is the one script that runs rather than defines', () => {
    expect(CLIENT_SCRIPTS[CLIENT_SCRIPTS.length - 1]).toBe('app.js')
  })

  it('carries the namespaces app.js reaches for at boot', () => {
    /* Not the whole list — these are the ones whose absence has actually broken
     * this suite, each as an unreadable "Cannot read properties of undefined". */
    for (const s of ['format.js', 'states.js', 'watch.js', 'stopboard.js', 'trip.js', 'urls.js']) {
      expect(CLIENT_SCRIPTS).toContain(s)
    }
  })

  it('leaves out the bundled fixture, which is a frozen capture', () => {
    expect(CLIENT_SCRIPTS.some((s) => s.startsWith('data/'))).toBe(false)
  })
})
