/*
 * Stop name shortening — api-contract.md §7.
 *
 * Deterministic and applied in this exact order:
 *   1. Drop a trailing parenthetical group.
 *   2. Drop a leading street number.
 *   3. Standardize bound suffixes (Northbound -> NB, and so on).
 *   3b. Normalize intercapped ordinals (8Th -> 8th).
 *   4. If still over 25 characters (the schema cap), truncate at the last boundary under 24 and
 *      append U+2026. A boundary is a space OR a slash; Austin names are "Street/CrossStreet"
 *      with no space around the slash. Never truncate mid-word.
 *
 * This MUST stay behaviourally identical to runtime/lib/stopnames.php: both write the same
 * `stop_name` field, the build for static ladder rows and the runtime for live vehicle rows,
 * and a client that saw two spellings of one stop would be a visible bug.
 *
 * Two edge cases §7 does not cover, resolved the same way in both implementations:
 *   - A single token longer than the budget has no word boundary to fall back to. Leaving it
 *     whole would blow the schema's 25-character cap, so it is cut one character short of the
 *     budget and marked. A mid-word cut is bad; an invalid document is worse.
 *   - A step that would reduce the name to nothing is skipped, so "12345" stays "12345"
 *     rather than becoming "".
 */

import { STOP_NAME_MAX, STOP_NAME_TRUNCATE_AT } from '../config.mjs';

const ELLIPSIS = '…';

const BOUND_SUFFIXES = [
	[ /\bNorthbound\b/gu, 'NB' ],
	[ /\bSouthbound\b/gu, 'SB' ],
	[ /\bEastbound\b/gu, 'EB' ],
	[ /\bWestbound\b/gu, 'WB' ],
];

export function shortenStopName( fullName ) {
	const original = String( fullName ?? '' ).trim();
	let name = original;

	/* 1. Trailing parenthetical group. */
	name = name.replace( /\s*\([^)]*\)\s*$/u, '' ).trim();

	/* 2. Leading street number, unless that empties the name. */
	const stripped = name.replace( /^\d+\s+/u, '' ).trim();
	if ( stripped !== '' ) {
		name = stripped;
	}

	/* 3. Bound suffixes. */
	for ( const [ pattern, abbreviation ] of BOUND_SUFFIXES ) {
		name = name.replace( pattern, abbreviation );
	}
	name = name.replace( /\s+/gu, ' ' ).trim();

	/*
	 * 3b. Intercapped ordinals. Upstream title-cases every word, so "8Th/Lavaca" and "48Th Half"
	 * arrive capitalized mid-token. The lookbehind requires a digit with no intervening space, so
	 * "Main St" and a bare "Nd" are untouched and only 8Th -> 8th, 2Nd -> 2nd, 3Rd -> 3rd,
	 * 1St -> 1st and their multi-digit forms change. Never changes length, so it is safe before
	 * truncation. Must match runtime/lib/stopnames.php step 4 exactly: a differential run over
	 * all 2,326 upstream names caught this missing here, which would have rendered the same stop
	 * as "8Th/Lavaca" on the ladder and "8th/Lavaca" on the vehicle row.
	 */
	name = name.replace( /(?<=[0-9])(St|Nd|Rd|Th)\b/g, ( m ) => m.toLowerCase() );

	if ( name === '' ) {
		/* Everything was stripped; fall back to the raw upstream name. */
		name = original;
		if ( name === '' ) {
			return '';
		}
	}

	/* 4. Word-boundary truncation. Count code points, not UTF-16 units. */
	const chars = [ ...name ];

	/*
	 * A name that already fits the schema cap is returned untouched. The cap is
	 * STOP_NAME_MAX; the smaller STOP_NAME_TRUNCATE_AT is the budget for the STEM when an
	 * ellipsis has to be appended. Testing the stem budget here instead of the cap truncated
	 * 13 real stops that fit exactly, turning "Bluff Springs/BitterCreek" into "Bluff…".
	 */
	if ( chars.length <= STOP_NAME_MAX ) {
		return name;
	}

	/*
	 * Austin stop names are "Street/CrossStreet" with no space around the slash, so a space is
	 * often the wrong and sometimes the only boundary: "Pleasant Valley/Turnstone" has one
	 * space, at index 8. Break on a slash too, and keep the slash so the cut reads as a
	 * deliberate stop short of the cross street.
	 */
	/*
	 * Budgets differ by boundary kind because the kept text differs. Cutting AT a space drops
	 * it, so a space at index i keeps i characters and i may reach STOP_NAME_TRUNCATE_AT. A
	 * slash is kept, so a slash at index i keeps i + 1 characters and i must stop one earlier.
	 * Searching only the first STOP_NAME_TRUNCATE_AT characters missed a space sitting exactly
	 * on the budget and needlessly dropped a whole cross street.
	 */
	const spaceWindow = chars.slice( 0, STOP_NAME_TRUNCATE_AT + 1 ).join( '' );
	const slashWindow = chars.slice( 0, STOP_NAME_TRUNCATE_AT ).join( '' );
	const lastSpace = spaceWindow.lastIndexOf( ' ' );
	const lastSlash = slashWindow.lastIndexOf( '/' );
	let kept;
	if ( lastSlash > 0 && lastSlash > lastSpace ) {
		kept = chars.slice( 0, lastSlash + 1 ).join( '' );
	} else if ( lastSpace > 0 ) {
		kept = chars.slice( 0, lastSpace ).join( '' );
	} else {
		/* One long token: cut a character short of the budget so the ellipsis fits. */
		kept = chars.slice( 0, STOP_NAME_TRUNCATE_AT - 1 ).join( '' );
	}
	return kept.replace( /\s+$/u, '' ) + ELLIPSIS;
}
