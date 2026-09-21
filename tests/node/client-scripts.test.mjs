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

/*
 * ONE NAME, ONE FUNCTION, PER FILE.
 *
 * Every client script is a single top-level closure, so two `function foo()`
 * declarations in one file are not two functions -- they are one, and it is the
 * LAST one, for every call site in the file including the ones written above it.
 * The earlier body becomes unreachable while still reading as live code, comment
 * and all.
 *
 * This file has shipped that bug twice. A merge once left a duplicate
 * `refreshTick`, and the tests exercised the copy that was not running. Then this
 * branch added a second `refreshRoute` beside the existing one: the new body --
 * the one that also refreshes the plan's schedules, with fifteen lines of comment
 * explaining why -- never executed once, and both copies carried a comment
 * claiming the two "do not drift".
 *
 * Nothing catches it at runtime, because the surviving body is usually a near
 * relative of the dead one and something else compensates. So it is caught here,
 * in the source, where it is unambiguous.
 */
describe('no client script declares one function name twice', () => {
  const declarations = (src) =>
    [...src.matchAll(/^[ \t]*function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1])

  it.each(CLIENT_SCRIPTS)('%s', (script) => {
    const src = readFileSync(path.join(ROOT, 'client', script), 'utf8')
    const names = declarations(src)
    const seen = new Map()
    for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1)
    const dupes = [...seen].filter(([, n]) => n > 1).map(([name, n]) => `${name} x${n}`)
    expect(dupes, `${script} declares the same function name more than once`).toEqual([])
  })

  it('and the scan actually found declarations, or it is asserting over nothing', () => {
    const src = readFileSync(path.join(ROOT, 'client/app.js'), 'utf8')
    expect(declarations(src).length).toBeGreaterThan(20)
    expect(declarations(src)).toContain('refreshRoute')
  })
})

/*
 * The pinned-route literal, asserted against the source text.
 *
 * Why source and not a page: two of these checks have no rendered equivalent at
 * all. Nothing looks different for a lettered id -- that guard exists to stop the
 * sort comparator going silently inert -- and nothing looks different for a
 * reformatted declaration. Ascending order is the one a browser could see, and
 * board.spec.mjs's no-catalog test does see it, but RIDDEN there is hand-typed
 * and deliberately not read out of app.js: somebody who reorders FAVORITES and
 * mirrors the new order into RIDDEN keeps that test green forever. This one reads
 * FAVORITES itself.
 *
 * Where the order is rendered, and why it is only rendered sometimes, is
 * explained once -- at that no-catalog test in board.spec.mjs.
 */
describe('the pinned route list', () => {
  const src = readFileSync(path.join(ROOT, 'client/app.js'), 'utf8')
  /*
   * Keyword- and quote-agnostic, and the ids are extracted once. Pinning `var`
   * and a single quote meant two ordinary refactors -- var to const, or a switch
   * to double quotes -- made the tests below throw `Cannot read properties of
   * null`, pointing at this file instead of at the rename. The subject is the
   * list, not the binding form it happens to be spelled with.
   */
  const literalMatch = src.match(/(?:var|let|const)\s+FAVORITES\s*=\s*\[([^\]]*)\]/)
  const ids = literalMatch
    ? (literalMatch[1].match(/['"]([^'"]+)['"]/g) || []).map((s2) => s2.slice(1, -1))
    : []

  it('is spelled the way this test expects to find it', () => {
    expect(literalMatch, 'FAVORITES is no longer a flat array literal').not.toBeNull()
    expect(ids.length, 'the literal was found but no route ids came out of it')
      .toBeGreaterThan(1)
  })

  /*
   * Number() on a non-digit id is NaN, and a NaN comparator result means "leave
   * these two where they are" -- so one lettered id turns the sort below into a
   * no-op and the order test stops being able to fail.
   * ['4','7','337','350','MetroRail','335'] sorts to itself, with 335 last: the
   * exact arrangement that test exists to catch.
   *
   * Not hypothetical. cm_sort_route_catalog has a non-numeric branch keyed on
   * ctype_digit (runtime/lib/catalog.php) and RouteCatalogTest exercises it with
   * 'MetroRail' and 'Airport'. So the numeric assumption is asserted rather than
   * assumed: pin a lettered route and it fails HERE, where whoever pins it has to
   * decide what "in order" should mean for it.
   */
  it('holds only numeric route ids, which the order check below assumes', () => {
    expect(ids.filter((id) => !/^\d+$/.test(id)),
      'a non-numeric id makes the numeric sort below a silent no-op').toEqual([])
  })

  it('is in ascending route-number order', () => {
    expect(ids, 'an addition landed out of order; the list is scanned by number')
      .toEqual([...ids].sort((a, b) => Number(a) - Number(b)))
  })

  /*
   * "Doubles a card" is true on the no-catalog path specifically: fallbackCatalog
   * maps the literal, so a repeated id becomes two entries and two buttons. With
   * a catalog loaded the picker filters the catalog instead, and a repeat in
   * FAVORITES changes nothing. Both observed in a browser.
   */
  it('holds no duplicates, which double a card on a board with no catalog', () => {
    expect(new Set(ids).size, 'a route is pinned twice').toBe(ids.length)
  })
})
