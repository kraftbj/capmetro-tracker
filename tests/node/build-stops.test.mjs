/**
 * Contract section 7 and acceptance criterion 10: stop-name shortening.
 *
 * Four ordered rules. The one that matters visually is the last: a label may be
 * truncated, but never mid-word, because "UT Stadium SB (San Jacin" on a 412px
 * ladder is worse than an honestly shorter name.
 *
 * The build job and the runtime job both shorten names and must agree, so this
 * file is deliberately the twin of tests/php/StopNameTest.php.
 */
import { describe, expect, it } from 'vitest'
import { gate, optionalModule } from './helpers/optional.mjs'
import { goldenRoute4 } from './helpers/fixtures.mjs'

const stops = await optionalModule('build/lib/stop-names.mjs')
const t = gate(stops, ['shortenStopName'], it)

/**
 * A truncated name ends mid-word when its last surviving token is not a whole
 * word of the name it came from. "Pleasant Valley at…" is fine; "San Jacin…"
 * is the failure the rule exists to prevent. Rules 1 to 3 rewrite tokens before
 * rule 4 truncates, so the comparison is against the rewritten name; those three
 * rules are restated here rather than reused, to keep the check independent.
 */
function assertNotTruncatedMidWord(full, short) {
  expect(short.length, `"${short}" exceeds the schema cap`).toBeLessThanOrEqual(25)
  if (!short.endsWith('…')) return

  const normalized = String(full)
    .trim()
    .replace(/\s*\([^()]*\)\s*$/, '')
    .trim()
    .replace(/^\d+\s+/, '')
    .replace(/\bNorthbound\b/gi, 'NB')
    .replace(/\bSouthbound\b/gi, 'SB')
    .replace(/\bEastbound\b/gi, 'EB')
    .replace(/\bWestbound\b/gi, 'WB')
    .replace(/\s{2,}/g, ' ')
    .trim()

  const head = short.slice(0, -1).trimEnd()
  const last = head.split(/\s+/).pop()
  expect(last, `"${short}" truncated to nothing`).toBeTruthy()
  expect(
    new RegExp(`(?<!\\S)${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\S)`).test(normalized),
    `"${short}" ends mid-word: "${last}" is not a whole word of "${normalized}"`,
  ).toBe(true)
}

describe('shortening applies the four contract rules in order', () => {
  t('drops a trailing parenthetical group', (_m, fn) => {
    expect(fn('shortenStopName')('Dove Springs NB (Pleasant Valley/Stassney)')).toBe('Dove Springs NB')
  })

  t('drops a leading street number', (_m, fn) => {
    expect(fn('shortenStopName')('4999 7th/Shady')).toBe('7th/Shady')
  })

  t('standardises the four spelled-out compass suffixes', (_m, fn) => {
    expect(fn('shortenStopName')('Simond Southbound')).toBe('Simond SB')
    expect(fn('shortenStopName')('Lamar Northbound')).toBe('Lamar NB')
    expect(fn('shortenStopName')('7th Eastbound')).toBe('7th EB')
    expect(fn('shortenStopName')('Mopac Westbound')).toBe('Mopac WB')
  })

  t('drops the parenthetical before measuring length rather than after', (_m, fn) => {
    expect(fn('shortenStopName')('Dove Springs NB (Pleasant Valley/Stassney)')).not.toContain('…')
  })

  t('leaves a short name exactly as it found it', (_m, fn) => {
    expect(fn('shortenStopName')('5th/Bowie')).toBe('5th/Bowie')
  })
})

describe('a name still too long is cut at a word boundary and marked', () => {
  const inputs = [
    'UT Stadium SB (San Jacinto/Martin Luther King)',
    'Pleasant Valley at Stassney Lane Transfer Center Bay Three',
    'Highland Station Northbound Platform Two',
  ]

  for (const input of inputs) {
    t(`never ends mid-word when shortening "${input}"`, (_m, fn) => {
      assertNotTruncatedMidWord(input, fn('shortenStopName')(input))
    })
  }

  t('marks a truncated name with an ellipsis and no dangling space', (_m, fn) => {
    const out = fn('shortenStopName')('Pleasant Valley at Stassney Lane Transfer Center Bay Three')
    expect(out).toMatch(/…$/)
    expect(out).not.toMatch(/\s…$/)
  })

  t('keeps a single over-long token inside the 25-character schema cap', (_m, fn) => {
    // Rule 4 has no word boundary to fall back to here. Cutting one character
    // short of the budget and marking it keeps the result inside the cap;
    // returning the name untouched does not. The build job and
    // runtime/lib/stopnames.php must agree, because both write the same field.
    const out = fn('shortenStopName')('Supercalifragilisticexpialidocious')
    expect(out.length, `"${out}" is ${out.length} characters and would fail the schema`).toBeLessThanOrEqual(25)
  })

  t('never reduces a name with real content to nothing', (_m, fn) => {
    for (const input of ['4999 (closed)', '12345', 'Simond Southbound']) {
      expect(fn('shortenStopName')(input), `"${input}" was reduced to nothing`).not.toBe('')
    }
  })

  t('is deterministic, because a shard rebuild must be byte-identical when nothing changed', (_m, fn) => {
    const input = 'Pleasant Valley at Stassney Lane Transfer Center Bay Three'
    expect(fn('shortenStopName')(input)).toBe(fn('shortenStopName')(input))
  })
})

describe('the names already published in the golden output obey their own rule', () => {
  const golden = goldenRoute4()

  it('keeps every timepoint and minor-stop name inside the schema cap', () => {
    const names = [
      ...golden.timepoints.map((t) => t.stop_name),
      ...golden.timepoints.flatMap((t) => t.minor_stops.map((m) => m.stop_name)),
    ]
    expect(names.length).toBeGreaterThan(0)
    for (const n of names) expect(n.length, `"${n}"`).toBeLessThanOrEqual(25)
  })

  it('never truncates a timepoint name mid-word', () => {
    for (const tp of golden.timepoints) assertNotTruncatedMidWord(tp.stop_name_full, tp.stop_name)
  })

  t('reproduces every published short name from its full name', (_m, fn) => {
    for (const tp of golden.timepoints) {
      expect(fn('shortenStopName')(tp.stop_name_full), `shortening "${tp.stop_name_full}"`).toBe(tp.stop_name)
    }
  })
})
