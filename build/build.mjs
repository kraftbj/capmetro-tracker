#!/usr/bin/env node
/*
 * GTFS static -> per-route JSON shards.
 *
 * Turns the 66 MB CapMetro GTFS static feed into small files the PHP runtime reads every
 * minute. Output layout and every judgement call are documented in build/NOTES.md.
 *
 * Output is deterministic: same feed in, byte-identical files out. Nothing here reads the
 * wall clock — `built_at` is derived from the feed's own feed_version — so CI can decide
 * "nothing changed" by looking at the working tree.
 *
 *   node build/build.mjs [--force] [--routes 4,7,5]
 */

import { createHash } from 'node:crypto';
import { OUT_DIR, SHARD_SCHEMA, STOP_NAME_MAX } from './config.mjs';
import { ingest } from './ingest.mjs';
import { Emitter } from './lib/emit.mjs';
import {
	ensureIndexes,
	hasCalendarTable,
	loadCalendarDates,
	loadFeedInfo,
	loadRouteStopTimes,
	loadRoutes,
	loadStops,
	loadTripSummaries,
} from './lib/load.mjs';
import { buildRoutePatterns } from './lib/patterns.mjs';
import { buildBlockChains } from './lib/blocks.mjs';
import { buildCalendar } from './lib/calendar.mjs';
import { buildRouteTimepoints } from './lib/timepoints.mjs';
import { feedVersionToEpoch, secondsToClock } from './lib/time.mjs';

const argv = process.argv.slice( 2 );
const force = argv.includes( '--force' );
const routeFilter = readOption( '--routes' );
const onlyRoutes = routeFilter ? new Set( routeFilter.split( ',' ).map( ( s ) => s.trim() ) ) : null;

function readOption( name ) {
	const i = argv.indexOf( name );
	return i >= 0 ? argv[ i + 1 ] : null;
}

function log( message ) {
	process.stderr.write( `[build] ${ message }\n` );
}

const warnings = [];
function warn( message ) {
	warnings.push( message );
	process.stderr.write( `[build] WARN ${ message }\n` );
}

const db = await ingest( { force } );
ensureIndexes( db );

const feedInfo = loadFeedInfo( db );
const feedVersion = String( feedInfo.feed_version ?? 'unknown' );
const builtAt = feedVersionToEpoch( feedVersion );
if ( builtAt === null ) {
	warn( `feed_version "${ feedVersion }" is not the YYMMDD_HHMM form; built_at will be null` );
}
if ( hasCalendarTable( db ) ) {
	warn( 'calendar.txt is present in this feed; the calendar index still derives only from calendar_dates.txt' );
}

log( `feed_version ${ feedVersion }, valid ${ feedInfo.feed_start_date } - ${ feedInfo.feed_end_date }` );

const stops = loadStops( db );
const routes = loadRoutes( db );
const trips = loadTripSummaries( db );
const calendarDates = loadCalendarDates( db );

log( `${ routes.length } routes, ${ trips.length } trips, ${ stops.size } stops, ${ calendarDates.length } calendar_dates rows` );

/* Stop names are contract-capped at 25 characters and must never end mid-word. */
const overlongNames = [ ...stops.values() ].filter( ( s ) => s.stop_name.length > STOP_NAME_MAX );
if ( overlongNames.length > 0 ) {
	warn(
		`${ overlongNames.length } shortened stop names exceed ${ STOP_NAME_MAX } characters, e.g. ` +
			overlongNames.slice( 0, 3 ).map( ( s ) => `${ s.stop_id }:"${ s.stop_name }"` ).join( ', ' )
	);
}

const { chains, blockMeta, stats: blockStats, orphanCount } = buildBlockChains( { trips, stops, calendarDates } );
if ( orphanCount > 0 ) {
	warn( `${ orphanCount } trip(s) have no block_id and cannot be chained` );
}
if ( blockStats.invariant_breaks > 0 ) {
	/*
	 * A trip's successor differed across two co-active service sets. Every other part of
	 * this build assumes it cannot: next_trip publishes one departure time for a run that
	 * is minted once per service variant. If this ever fires, that assumption has to be
	 * revisited before the number it guards is trusted.
	 */
	warn(
		`${ blockStats.invariant_breaks } trip(s) have a successor that differs across co-active service sets`
	);
}
if ( blockStats.negative_layovers > 0 ) {
	warn(
		`${ blockStats.negative_layovers } of ${ blockStats.pairs } block successor pairs have a negative layover`
	);
}
const calendar = buildCalendar( { calendarDates, trips } );

const tripsByRoute = new Map();
for ( const trip of trips ) {
	if ( ! tripsByRoute.has( trip.route_id ) ) {
		tripsByRoute.set( trip.route_id, [] );
	}
	tripsByRoute.get( trip.route_id ).push( trip );
}

const emitter = new Emitter( OUT_DIR );
const routeIndex = [];
const usedDirs = new Map();

for ( const route of routes ) {
	const routeId = String( route.route_id );
	if ( onlyRoutes && ! onlyRoutes.has( routeId ) ) {
		continue;
	}
	const routeTrips = ( tripsByRoute.get( routeId ) ?? [] ).slice().sort( ( a, b ) =>
		a.trip_id < b.trip_id ? -1 : a.trip_id > b.trip_id ? 1 : 0
	);
	const dir = routeDirName( routeId );
	const base = `routes/${ dir }`;

	const { byTrip: tripStops, rowCount } = loadRouteStopTimes( db, routeId );

	/* --- 1. schedule shard ------------------------------------------------------------ */
	const stopIdTable = [];
	const stopIdIndex = new Map();
	const internStopId = ( id ) => {
		let i = stopIdIndex.get( id );
		if ( i === undefined ) {
			i = stopIdTable.length;
			stopIdIndex.set( id, i );
			stopIdTable.push( id );
		}
		return i;
	};

	const { directions: patternDirections, tripPattern } = buildRoutePatterns( {
		routeId,
		routeTrips,
		tripStops,
		stops,
	} );

	const scheduleTrips = {};
	for ( const trip of routeTrips ) {
		const stopList = tripStops.get( trip.trip_id );
		if ( ! stopList || stopList.length === 0 ) {
			warn( `route ${ routeId }: trip ${ trip.trip_id } has no stop_times` );
			continue;
		}
		scheduleTrips[ trip.trip_id ] = {
			service_id: trip.service_id,
			direction_id: trip.direction_id,
			block_id: trip.block_id,
			headsign: trip.trip_headsign ?? null,
			pattern_id: tripPattern.get( trip.trip_id ) ?? null,
			start_time: secondsToClock( stopList[ 0 ].arrival_s ),
			stops: stopList.map( ( s ) => [
				s.stop_sequence,
				internStopId( s.stop_id ),
				s.arrival_s,
				s.timepoint,
			] ),
		};
	}

	const scheduleSizes = emitter.write(
		`${ base }/schedule.json`,
		{
			schema: SHARD_SCHEMA,
			route_id: routeId,
			feed_version: feedVersion,
			/* Each stops[] row is [stop_sequence, stop_ids index, arrival seconds after
			 * service-day midnight, timepoint]. Seconds, not clock strings, so the
			 * 24:00:00+ rollover needs no special case. */
			columns: [ 'stop_sequence', 'stop_index', 'arrival_s', 'timepoint' ],
			stop_ids: stopIdTable,
			trip_count: Object.keys( scheduleTrips ).length,
			stop_time_count: rowCount,
			trips: scheduleTrips,
		},
		{ pretty: false }
	);

	/* --- 2. patterns ------------------------------------------------------------------ */
	emitter.write( `${ base }/patterns.json`, {
		schema: SHARD_SCHEMA,
		route_id: routeId,
		feed_version: feedVersion,
		directions: patternDirections,
	} );

	/* --- 3. block chains -------------------------------------------------------------- */
	const routeBlockIds = [ ...new Set( routeTrips.map( ( t ) => t.block_id ).filter( Boolean ) ) ].sort();
	const routeChains = {};
	let directionFlips = 0;
	let highConfidence = 0;
	for ( const trip of routeTrips ) {
		const chain = chains.get( trip.trip_id );
		if ( ! chain ) {
			continue;
		}
		routeChains[ trip.trip_id ] = chain;
		if ( chain.next_trip?.is_direction_flip ) {
			directionFlips++;
		}
		if ( chain.confidence === 'high' ) {
			highConfidence++;
		}
	}
	emitter.write( `${ base }/blocks.json`, {
		schema: SHARD_SCHEMA,
		route_id: routeId,
		feed_version: feedVersion,
		block_count: routeBlockIds.length,
		direction_flip_count: directionFlips,
		high_confidence_count: highConfidence,
		blocks: Object.fromEntries( routeBlockIds.map( ( id ) => [ id, blockMeta.get( id ) ] ) ),
		trips: routeChains,
	}, { pretty: false } );

	/* --- 4. calendar ------------------------------------------------------------------ */
	const routeCalendar = calendar.forRoute( routeId );
	emitter.write( `${ base }/calendar.json`, {
		schema: SHARD_SCHEMA,
		route_id: routeId,
		feed_version: feedVersion,
		...routeCalendar,
	} );

	/* --- 6. timepoints ---------------------------------------------------------------- */
	const timepoints = buildRouteTimepoints( { patternDirections, tripStops, stops } );
	for ( const message of timepoints.warnings ) {
		warn( `route ${ routeId }: ${ message }` );
	}
	emitter.write( `${ base }/timepoints.json`, {
		schema: SHARD_SCHEMA,
		route_id: routeId,
		feed_version: feedVersion,
		directions: timepoints.directions,
	} );

	routeIndex.push( {
		route_id: routeId,
		dir,
		short_name: route.route_short_name ?? null,
		long_name: route.route_long_name ?? null,
		route_type: route.route_type ?? null,
		route_color: route.route_color ?? null,
		route_text_color: route.route_text_color ?? null,
		trip_count: Object.keys( scheduleTrips ).length,
		stop_time_count: rowCount,
		block_count: routeBlockIds.length,
		direction_flip_count: directionFlips,
		service_ids: routeCalendar.service_ids,
		directions: patternDirections.map( ( d ) => ( {
			id: d.direction_id,
			headsign: dominantHeadsign( routeTrips, d.direction_id ),
			pattern_count: d.pattern_count,
			trip_count: d.trip_count,
			timepoint_count:
				timepoints.directions.find( ( t ) => t.direction_id === d.direction_id )?.timepoint_count ?? 0,
			stop_count:
				timepoints.directions.find( ( t ) => t.direction_id === d.direction_id )?.stop_count ?? 0,
		} ) ),
		bytes: scheduleSizes.bytes,
		gzip: scheduleSizes.gzip,
	} );

	log(
		`route ${ routeId.padEnd( 6 ) } trips=${ String( routeTrips.length ).padStart( 5 ) } ` +
			`rows=${ String( rowCount ).padStart( 6 ) } schedule=${ kb( scheduleSizes.bytes ) } ` +
			`gz=${ kb( scheduleSizes.gzip ) }`
	);
}

/* --- shared files -------------------------------------------------------------------- */

const stopsOut = {};
for ( const stop of stops.values() ) {
	stopsOut[ stop.stop_id ] = {
		stop_name: stop.stop_name,
		stop_name_full: stop.stop_name_full,
		lat: stop.lat,
		lon: stop.lon,
	};
}
emitter.write(
	'stops.json',
	{
		schema: SHARD_SCHEMA,
		feed_version: feedVersion,
		stop_count: stops.size,
		stops: stopsOut,
	},
	{ pretty: false }
);

emitter.write( 'calendar.json', {
	schema: SHARD_SCHEMA,
	feed_version: feedVersion,
	...calendar.global,
} );

routeIndex.sort( ( a, b ) => ( a.route_id < b.route_id ? -1 : a.route_id > b.route_id ? 1 : 0 ) );

emitter.write( 'manifest.json', {
	schema: SHARD_SCHEMA,
	feed_version: feedVersion,
	built_at: builtAt,
	feed_start_date: feedInfo.feed_start_date ? String( feedInfo.feed_start_date ) : null,
	feed_end_date: feedInfo.feed_end_date ? String( feedInfo.feed_end_date ) : null,
	generator: 'build/build.mjs',
	counts: {
		routes: routeIndex.length,
		trips: trips.length,
		stops: stops.size,
		stop_times: routeIndex.reduce( ( n, r ) => n + r.stop_time_count, 0 ),
		service_dates: calendar.global.date_count,
		service_ids: calendar.global.service_count,
		exception_dates: calendar.global.exception_dates.length,
		block_chains: blockStats.chain_count,
		block_successor_pairs: blockStats.pairs,
		block_negative_layovers: blockStats.negative_layovers,
		trips_without_block_id: orphanCount,
	},
	warnings: warnings.slice().sort(),
	routes: routeIndex,
} );

const removed = emitter.prune();
if ( removed.length > 0 ) {
	log( `pruned ${ removed.length } stale file(s)` );
}

/* --- report ---------------------------------------------------------------------------- */

const totals = [ ...emitter.written.values() ].reduce(
	( acc, e ) => ( { bytes: acc.bytes + e.bytes, gzip: acc.gzip + e.gzip } ),
	{ bytes: 0, gzip: 0 }
);
log(
	`wrote ${ emitter.written.size } files, ${ kb( totals.bytes ) } raw / ${ kb( totals.gzip ) } gzipped, into ${ OUT_DIR }`
);
if ( warnings.length > 0 ) {
	log( `${ warnings.length } warning(s)` );
}

function kb( bytes ) {
	return bytes >= 1048576 ? `${ ( bytes / 1048576 ).toFixed( 2 ) }MB` : `${ ( bytes / 1024 ).toFixed( 1 ) }KB`;
}

function dominantHeadsign( routeTrips, directionId ) {
	const counts = new Map();
	for ( const trip of routeTrips ) {
		const dir = trip.direction_id === null ? 0 : trip.direction_id;
		if ( dir !== directionId || ! trip.trip_headsign ) {
			continue;
		}
		counts.set( trip.trip_headsign, ( counts.get( trip.trip_headsign ) ?? 0 ) + 1 );
	}
	const ranked = [ ...counts.entries() ].sort( ( a, b ) =>
		b[ 1 ] - a[ 1 ] || ( a[ 0 ] < b[ 0 ] ? -1 : 1 )
	);
	return ranked[ 0 ]?.[ 0 ] ?? null;
}

/*
 * Route ids become directory names. Most are plain, but the contract warns some are
 * non-numeric, so anything outside a safe set is escaped and disambiguated with a hash of
 * the original id. The mapping is recorded as `dir` in the manifest.
 */
function routeDirName( routeId ) {
	const safe = routeId.replace( /[^A-Za-z0-9._-]/g, '_' );
	const needsHash = safe !== routeId || safe === '' || safe.startsWith( '.' );
	const name = needsHash
		? `${ safe || 'route' }-${ createHash( 'sha1' ).update( routeId ).digest( 'hex' ).slice( 0, 6 ) }`
		: safe;
	const claimed = usedDirs.get( name );
	if ( claimed !== undefined && claimed !== routeId ) {
		throw new Error( `route directory collision: ${ routeId } and ${ claimed } both map to ${ name }` );
	}
	usedDirs.set( name, routeId );
	return name;
}
