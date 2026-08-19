/*
 * Service-day clock helpers.
 *
 * Shards store arrival times as integer seconds after service-day midnight, which is what
 * GTFS clock strings really mean and which survives the 24:00:00+ rollover without special
 * cases.
 *
 * The service day anchor is api-contract.md §2's rule: noon on the service date minus twelve
 * hours, in America/Chicago. The noon-minus-12 form is required rather than convenient —
 * on a spring-forward date local midnight and the anchor are different instants, and
 * midnight-plus-offset silently shifts every time on that day by an hour.
 */

export const DEFAULT_TIME_ZONE = 'America/Chicago';

export function secondsToClock( seconds ) {
	if ( seconds === null || seconds === undefined || ! Number.isFinite( seconds ) ) {
		return null;
	}
	const total = Math.trunc( seconds );
	const h = Math.floor( total / 3600 );
	const m = Math.floor( ( total % 3600 ) / 60 );
	const s = total % 60;
	return `${ String( h ).padStart( 2, '0' ) }:${ String( m ).padStart( 2, '0' ) }:${ String( s ).padStart( 2, '0' ) }`;
}

/* "25:10:00" -> 90600. Hours may exceed 23; that is the point. */
export function clockToSeconds( clock ) {
	const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec( String( clock ?? '' ).trim() );
	if ( ! match ) {
		throw new Error( `Not a GTFS service clock: ${ JSON.stringify( clock ) }` );
	}
	return Number( match[ 1 ] ) * 3600 + Number( match[ 2 ] ) * 60 + Number( match[ 3 ] );
}

/*
 * Epoch seconds for the start of a GTFS service day: noon on that date in `timeZone`, minus
 * twelve hours. On 2026-03-08 (spring forward) this lands at 23:00 the previous evening,
 * because that service day is 23 hours long.
 */
export function serviceDayMidnight( serviceDate, timeZone = DEFAULT_TIME_ZONE ) {
	const match = /^(\d{4})(\d{2})(\d{2})$/.exec( String( serviceDate ?? '' ).trim() );
	if ( ! match ) {
		throw new Error( `Not a GTFS service date: ${ JSON.stringify( serviceDate ) }` );
	}
	const [ , year, month, day ] = match;
	const noon = zonedWallClockToEpochMs(
		Number( year ),
		Number( month ),
		Number( day ),
		12,
		0,
		0,
		timeZone
	);
	return Math.floor( noon / 1000 ) - 12 * 3600;
}

/* "20260819" + "25:10:00" -> the epoch second of 1:10am on 2026-08-20. */
export function serviceClockToEpoch( serviceDate, clock, timeZone = DEFAULT_TIME_ZONE ) {
	return serviceDayMidnight( serviceDate, timeZone ) + clockToSeconds( clock );
}

/*
 * The CapMetro feed_version encodes when the agency built the feed: YYMMDD_HHMM, local
 * Austin time. Deriving gtfs_built_at from it rather than from the clock is what keeps the
 * build byte-identical across reruns — the whole point of the feed_version gate in CI.
 */
export function feedVersionToEpoch( feedVersion, timeZone = DEFAULT_TIME_ZONE ) {
	const match = /^(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})$/.exec( String( feedVersion ?? '' ) );
	if ( ! match ) {
		return null;
	}
	const [ , yy, mm, dd, hh, mi ] = match;
	return Math.floor(
		zonedWallClockToEpochMs(
			2000 + Number( yy ),
			Number( mm ),
			Number( dd ),
			Number( hh ),
			Number( mi ),
			0,
			timeZone
		) / 1000
	);
}

/*
 * Solve for the UTC instant whose wall clock in `timeZone` is the one given. Iterating the
 * offset correction converges in one step everywhere except across a transition, where the
 * second pass settles it.
 */
function zonedWallClockToEpochMs( year, month, day, hour, minute, second, timeZone ) {
	const target = Date.UTC( year, month - 1, day, hour, minute, second );
	let epochMs = target;
	for ( let i = 0; i < 3; i++ ) {
		const drift = wallClockAsUtc( epochMs, timeZone ) - epochMs;
		const next = target - drift;
		if ( next === epochMs ) {
			break;
		}
		epochMs = next;
	}
	return epochMs;
}

function wallClockAsUtc( epochMs, timeZone ) {
	const parts = new Intl.DateTimeFormat( 'en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	} ).formatToParts( new Date( epochMs ) );
	const get = ( type ) => Number( parts.find( ( p ) => p.type === type ).value );
	return Date.UTC( get( 'year' ), get( 'month' ) - 1, get( 'day' ), get( 'hour' ), get( 'minute' ), get( 'second' ) );
}
