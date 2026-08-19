/**
 * Regression: ISSUE-001 and ISSUE-002 — stop name shortening.
 * Found by /qa on 2026-08-19.
 * Report: .gstack/qa-reports/qa-report-capmetro-tracker-2026-08-19.md
 *
 * ISSUE-001: the truncation step tested the STEM budget (24) instead of the schema CAP (25) to
 * decide whether to truncate at all, and it broke only on spaces. Austin stop names are
 * "Street/CrossStreet" with no space around the slash, so "Pleasant Valley/Turnstone" has its
 * only space at index 8 and collapsed to "Pleasant…", discarding 16 usable characters. 23 of
 * 2,348 stops were affected and 13 of those already fitted the cap untouched.
 *
 * ISSUE-002: build/lib/stop-names.mjs was missing the intercapped-ordinal step that
 * runtime/lib/stopnames.php has. The two write the same `stop_name` field, so the ladder said
 * "8Th/Lavaca" while the vehicle row said "8th/Lavaca" for one stop. Found only by running both
 * implementations over all 2,326 upstream names and diffing.
 */
import { describe, expect, it } from 'vitest'
import { shortenStopName } from '../../build/lib/stop-names.mjs'

const CAP = 25

describe('a name that already fits the cap is never truncated', () => {
	/* Every one of these is exactly 25 code points and was being cut to a single word. */
	it.each([
		'Pleasant Valley/Turnstone',
		'Bluff Springs/BitterCreek',
		'William Cannon/Branchwood',
		'William Cannon/Stagecoach',
		'Norwood Park/Brettonwoods',
		'Esperanza Crossing/Domain',
	])('leaves %s alone', (name) => {
		expect([...name]).toHaveLength(CAP)
		expect(shortenStopName(name)).toBe(name)
	})
})

describe('truncation breaks on a slash, not only on a space', () => {
	it('keeps the street when the cross street will not fit', () => {
		expect(shortenStopName('Pleasant Valley/Webberville')).toBe('Pleasant Valley/…')
	})

	it('keeps as many slash-separated parts as fit', () => {
		/* A space sits exactly on the budget here, so "Brush" survives the cut. */
		expect(shortenStopName('Convict Hill/Latta/Brush Country')).toBe('Convict Hill/Latta/Brush…')
	})

	it('still prefers a space when the space is the later boundary', () => {
		expect(shortenStopName('Lamplight Village/Metric NW Corner')).toBe('Lamplight Village/Metric…')
	})

	it('never emits a single word plus an ellipsis when more would fit', () => {
		const cut = shortenStopName('Overton Driveway/Overton Driveway')
		expect(cut).toBe('Overton Driveway/Overton…')
		expect([...cut].length).toBeGreaterThan(12)
	})
})

describe('intercapped ordinals are normalized, matching the PHP implementation', () => {
	it.each([
		['216 8Th/Lavaca', '8th/Lavaca'],
		['115 7Th/Colorado', '7th/Colorado'],
		['500 Guadalupe/5Th', 'Guadalupe/5th'],
		['5012 Airport/51St', 'Airport/51st'],
		['Airport/53Rd', 'Airport/53rd'],
		['509 11Th/Red River', '11th/Red River'],
	])('turns %s into %s', (input, expected) => {
		expect(shortenStopName(input)).toBe(expected)
	})

	it('leaves a bare capitalized word that is not an ordinal alone', () => {
		/* The lookbehind requires a digit, so "St" as a street suffix must survive. */
		expect(shortenStopName('Main St/Oak')).toBe('Main St/Oak')
	})
})

describe('the invariants the schema depends on', () => {
	it.each([
		'Pleasant Valley/Turnstone',
		'Convict Hill/Latta/Brush Country',
		'Lamplight Village/Metric NW Corner',
		'Overton Driveway/Overton Driveway',
		'501 Wells Branch/Heatherwilde',
		'Averyabsurdlylongsingletokenwithnoboundaryatall',
	])('keeps %s within the 25 character cap', (name) => {
		expect([...shortenStopName(name)].length).toBeLessThanOrEqual(CAP)
	})

	it('never ends mid-word, so a cut always lands on a boundary', () => {
		expect(shortenStopName('Pleasant Valley/Webberville')).toBe('Pleasant Valley/…')
		/*
		 * The general invariant: whatever precedes the ellipsis, the ORIGINAL name continues
		 * with a boundary at that point, so no token is ever cut in half.
		 */
		for ( const name of [
			'Pleasant Valley/Webberville',
			'Convict Hill/Latta/Brush Country',
			'Lamplight Village/Metric NW Corner',
			'Overton Driveway/Overton Driveway',
		] ) {
			const cut = shortenStopName( name )
			expect( cut.endsWith('…') ).toBe( true )
			const stem = cut.slice( 0, -1 )
			expect( name.startsWith( stem ) ).toBe( true )
			/*
			 * Two legal shapes. A slash cut KEEPS the slash, so the stem ends with it. A space
			 * cut DROPS the space, so the original continues with one. Either way no token is
			 * split: what is missing is always a whole segment.
			 */
			const endsOnSlash = stem.endsWith( '/' )
			const nextIsSpace = name.charAt( stem.length ) === ' '
			expect( endsOnSlash || nextIsSpace ).toBe( true )
		}
	})

	it('does not empty a name that is only a number', () => {
		expect(shortenStopName('12345')).toBe('12345')
	})
})
