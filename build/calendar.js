/*
 * Stable entry point for the calendar index and watch identity.
 *
 * There is no calendar.txt in this feed, so service resolution goes through
 * calendar_dates.txt for a specific service date — never through a day-of-week rule. See
 * api-contract.md §9 and build/NOTES.md.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT_DIR } from './config.mjs';

export { buildCalendar } from './lib/calendar.mjs';

let cached = null;

function calendarIndex( outDir ) {
	if ( cached && cached.outDir === outDir ) {
		return cached.index;
	}
	const index = JSON.parse( readFileSync( join( outDir, 'calendar.json' ), 'utf8' ) );
	cached = { outDir, index };
	return index;
}

/** Service ids active on a GTFS service date ("20260819"). Empty array when none run. */
export function activeServiceIds( serviceDate, { outDir = OUT_DIR, routeId = null } = {} ) {
	const date = String( serviceDate );
	if ( routeId !== null ) {
		const route = JSON.parse(
			readFileSync( join( outDir, 'routes', String( routeId ), 'calendar.json' ), 'utf8' )
		);
		return ( route.dates[ date ]?.service_ids ?? [] ).slice();
	}
	return ( calendarIndex( outDir ).dates[ date ]?.service_ids ?? [] ).slice();
}

/** True when any service active that date spans exactly one date (api-contract.md §1). */
export function isExceptionDay( serviceDate, { outDir = OUT_DIR } = {} ) {
	return calendarIndex( outDir ).dates[ String( serviceDate ) ]?.is_exception_day ?? false;
}

/*
 * api-contract.md §9: lowercase hex of the first 16 bytes of SHA-256 over the tuple joined
 * with a single "|", in this exact order and with no whitespace. `scheduled_time` is hashed
 * verbatim, leading zero included, and direction_id serialises as a bare 0 or 1.
 */
export function watchId( { route_id: routeId, direction_id: directionId, stop_id: stopId, scheduled_time: scheduledTime, day_type: dayType } ) {
	const joined = [ routeId, String( directionId ), stopId, scheduledTime, dayType ].join( '|' );
	return createHash( 'sha256' ).update( joined, 'utf8' ).digest( 'hex' ).slice( 0, 32 );
}
