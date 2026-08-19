/*
 * Stop name shortening — api-contract.md §7.
 *
 * Deterministic and applied in this exact order:
 *   1. Drop a trailing parenthetical group.
 *   2. Drop a leading street number.
 *   3. Standardize bound suffixes (Northbound -> NB, and so on).
 *   4. If still over 24 characters, truncate at the last word boundary under 24 and append
 *      U+2026. Never truncate mid-word.
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

import { STOP_NAME_TRUNCATE_AT } from '../config.mjs';

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

	if ( name === '' ) {
		/* Everything was stripped; fall back to the raw upstream name. */
		name = original;
		if ( name === '' ) {
			return '';
		}
	}

	/* 4. Word-boundary truncation. Count code points, not UTF-16 units. */
	const chars = [ ...name ];
	if ( chars.length <= STOP_NAME_TRUNCATE_AT ) {
		return name;
	}
	const head = chars.slice( 0, STOP_NAME_TRUNCATE_AT ).join( '' );
	const cut = head.lastIndexOf( ' ' );
	const kept =
		cut > 0
			? head.slice( 0, cut )
			: /* One long token: cut a character short of the budget so the ellipsis fits. */
			  chars.slice( 0, STOP_NAME_TRUNCATE_AT - 1 ).join( '' );
	return kept.replace( /\s+$/u, '' ) + ELLIPSIS;
}
