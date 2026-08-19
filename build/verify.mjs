#!/usr/bin/env node
/*
 * Post-build assertions against the emitted shards.
 *
 * These are the targets the design doc and the API contract already measured against the
 * real feed. Run after build.mjs; a non-zero exit means the shards disagree with a
 * documented fact and something needs a human.
 *
 *   node build/verify.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { OUT_DIR, STOP_NAME_MAX } from './config.mjs';

/*
 * Facts measured against this exact feed. When CapMetro republishes (roughly three times a
 * year) route 4 may genuinely stop having 9 patterns, so those assertions soften to
 * informational reports rather than blocking the rebuild forever. Structural invariants —
 * name lengths, ladder coverage, referential integrity — assert on every feed.
 */
const PINNED_FEED_VERSION = '260818_1456';

let failures = 0;
let checks = 0;
let pinned = true;

function read( relPath ) {
	return JSON.parse( readFileSync( join( OUT_DIR, relPath ), 'utf8' ) );
}

function check( label, actual, expected ) {
	checks++;
	const ok = JSON.stringify( actual ) === JSON.stringify( expected );
	if ( ! ok ) {
		failures++;
	}
	const mark = ok ? 'PASS' : 'FAIL';
	const detail = ok ? `${ fmt( actual ) }` : `expected ${ fmt( expected ) }, got ${ fmt( actual ) }`;
	process.stdout.write( `${ mark }  ${ label }: ${ detail }\n` );
}

/* Assert only while the feed matches the version these numbers were measured against. */
function checkPinned( label, actual, expected ) {
	if ( ! pinned ) {
		process.stdout.write( `SKIP  ${ label }: ${ fmt( actual ) } (was ${ fmt( expected ) })\n` );
		return;
	}
	check( label, actual, expected );
}

function report( label, value ) {
	process.stdout.write( `----  ${ label }: ${ fmt( value ) }\n` );
}

function fmt( value ) {
	return typeof value === 'string' ? value : JSON.stringify( value );
}

if ( ! existsSync( join( OUT_DIR, 'manifest.json' ) ) ) {
	process.stderr.write( `No manifest at ${ OUT_DIR }. Run: npm run build\n` );
	process.exit( 1 );
}

const manifest = read( 'manifest.json' );
pinned = manifest.feed_version === PINNED_FEED_VERSION;
process.stdout.write( `feed_version ${ manifest.feed_version }, built_at ${ manifest.built_at }\n` );
process.stdout.write(
	pinned
		? `Feed matches the pinned version; measured targets are enforced.\n\n`
		: `Feed differs from pinned ${ PINNED_FEED_VERSION }; measured targets are reported, not enforced.\n\n`
);

/* ---- Target 1: route 4 trip patterns ------------------------------------------------- */
process.stdout.write( '# Route 4 trip patterns\n' );
const r4patterns = read( 'routes/4/patterns.json' );
const r4all = r4patterns.directions.flatMap( ( d ) => d.patterns );
checkPinned( 'route 4 distinct patterns', r4all.length, 9 );

const r4schedule = read( 'routes/4/schedule.json' );

/*
 * §2's `trips_in_pattern` is "how many trips share this stop signature TODAY", so the
 * two-trip claim is a per-service-date count. Service 3-172 is the 2026-08-19 fixture date.
 */
const SERVICE = '3-172';
const twoTrip = r4all.filter( ( p ) => ( p.trips_by_service[ SERVICE ] ?? 0 ) === 2 );
report( `route 4 patterns with exactly 2 trips on ${ SERVICE } (both directions)`, twoTrip.length );
checkPinned(
	`route 4 direction 0 patterns with exactly 2 trips on ${ SERVICE }`,
	twoTrip.filter( ( p ) => p.direction_id === 0 ).length,
	2
);

const austinHigh = twoTrip.filter( ( p ) => {
	const baselineId = r4patterns.directions.find( ( d ) => d.direction_id === p.direction_id )
		.baseline_by_service[ SERVICE ];
	const delta = p.deltas[ baselineId ];
	return delta.adds.some( ( s ) => s.stop_id === '1977' ) && delta.skips.some( ( s ) => s.stop_id === '6243' );
} );
checkPinned( 'of those, patterns adding 1977 and skipping 6243', austinHigh.length, 2 );

for ( const pattern of austinHigh ) {
	const baselineId = r4patterns.directions.find( ( d ) => d.direction_id === pattern.direction_id )
		.baseline_by_service[ SERVICE ];
	const delta = pattern.deltas[ baselineId ];
	checkPinned(
		`pattern ${ pattern.pattern_id } (dir ${ pattern.direction_id }) adds`,
		delta.adds.map( ( s ) => `${ s.stop_id } ${ s.stop_name }` ),
		[ '1977 Veterans/Atlanta' ]
	);
	checkPinned(
		`pattern ${ pattern.pattern_id } (dir ${ pattern.direction_id }) skips`,
		delta.skips.map( ( s ) => `${ s.stop_id } ${ s.stop_name }` ),
		[ '6243 Campbell/5th' ]
	);
	const deps = pattern.trip_ids
		.filter( ( id ) => r4schedule.trips[ id ]?.service_id === SERVICE )
		.map( ( id ) => r4schedule.trips[ id ].start_time.slice( 0, 5 ) )
		.sort();
	report( `pattern ${ pattern.pattern_id } departures on ${ SERVICE }`, deps.join( ', ' ) );
}
const dir0Special = austinHigh.find( ( p ) => p.direction_id === 0 );
checkPinned(
	'the direction 0 special departs 08:15 and 16:15',
	dir0Special?.trip_ids
		.filter( ( id ) => r4schedule.trips[ id ]?.service_id === SERVICE )
		.map( ( id ) => r4schedule.trips[ id ].start_time.slice( 0, 5 ) )
		.sort(),
	[ '08:15', '16:15' ]
);

const r4dir0 = r4patterns.directions.find( ( d ) => d.direction_id === 0 );
checkPinned( 'route 4 dir 0 feed-wide baseline trips', r4dir0?.patterns.find( ( p ) => p.is_baseline )?.trips_in_pattern, 268 );
report( 'route 4 dir 0 baseline stable across service days', r4dir0?.baseline_stable );
report( 'route 4 dir 0 baselines by service', JSON.stringify( r4dir0?.baseline_by_service ) );

/* ---- Target 2: route 4 blocks -------------------------------------------------------- */
process.stdout.write( '\n# Route 4 blocks\n' );
const r4blocks = read( 'routes/4/blocks.json' );
checkPinned( 'route 4 trips', Object.keys( r4blocks.trips ).length, 834 );
checkPinned( 'route 4 block_ids', r4blocks.block_count, 10 );
report( 'route 4 direction flips', r4blocks.direction_flip_count );
report( 'route 4 high-confidence chains', r4blocks.high_confidence_count );
report( 'route 4 service-day chains', Object.values( r4blocks.blocks ).reduce( ( n, b ) => n + b.chain_count, 0 ) );

/* The turnaround continuation named in api-contract.md §2 and the eng review. */
const anchor = r4blocks.trips[ '3014706_15608' ];
checkPinned( 'trip 3014706_15608 next departs', anchor?.next_trip?.start_time, '10:21:00' );
checkPinned( 'trip 3014706_15608 next from stop', anchor?.next_trip?.start_stop_id, '6243' );
checkPinned( 'trip 3014706_15608 is a direction flip', anchor?.next_trip?.is_direction_flip, true );
/*
 * §4 grades a block whose trips span more than one route_id as `low`, and block 1010 really
 * does interline routes 1, 4 and 485 on this service day. The §2 example in the contract
 * shows this same trip as `high`; §4 is the normative rule, so `low` is what we emit and the
 * grade_reasons say exactly why. See build/NOTES.md.
 */
checkPinned( 'trip 3014706_15608 confidence', anchor?.confidence, 'low' );
checkPinned( 'trip 3014706_15608 grade reasons', anchor?.grade_reasons, [ 'block_spans_multiple_routes' ] );
report( 'trip 3014706_15608 next trip_id', anchor?.next_trip?.trip_id );
report( 'trip 3014706_15608 layover_s', anchor?.layover_s );

/* ---- Target 3: route 7 timepoints ---------------------------------------------------- */
process.stdout.write( '\n# Route 7 timepoints\n' );
const r7 = read( 'routes/7/timepoints.json' );
const r7dir0 = r7.directions.find( ( d ) => d.direction_id === 0 );
checkPinned( 'route 7 dir 0 stops on baseline', r7dir0?.stop_count, 66 );
checkPinned( 'route 7 dir 0 timepoints', r7dir0?.timepoint_count, 8 );
const r7dir1 = r7.directions.find( ( d ) => d.direction_id === 1 );
report( 'route 7 dir 1 stops / timepoints', `${ r7dir1?.stop_count } / ${ r7dir1?.timepoint_count }` );
report( 'route 7 dir 0 baseline stable', r7dir0?.baseline_stable );

/* Every ladder on every route must account for each stop exactly once. */
let ladderGaps = 0;
let ladderCount = 0;
for ( const route of manifest.routes ) {
	const file = read( `routes/${ route.dir }/timepoints.json` );
	for ( const direction of file.directions ) {
		for ( const ladder of Object.values( direction.ladders ) ) {
			ladderCount++;
			const covered = ladder.timepoints.reduce( ( n, t ) => n + 1 + t.minor_stops.length, 0 );
			if ( covered !== ladder.stop_count ) {
				ladderGaps++;
			}
		}
	}
}
check( `all ${ ladderCount } ladders cover every baseline stop exactly once`, ladderGaps, 0 );

/* ---- Target 4: one-off service dates ------------------------------------------------- */
process.stdout.write( '\n# Calendar\n' );
const calendar = read( 'calendar.json' );
checkPinned( 'service dates', calendar.date_count, 145 );
checkPinned( 'dates carrying a one-off service', calendar.exception_dates.length, 8 );
report( 'those dates', calendar.exception_dates.join( ', ' ) );
report( 'one-off service_ids', calendar.one_off_service_ids.join( ', ' ) );
report( '1-172 weekday-ish reach', `${ calendar.services[ '1-172' ]?.date_count } dates / ${ calendar.services[ '1-172' ]?.route_count } routes` );
report( '9-172 weekday-ish reach', `${ calendar.services[ '9-172' ]?.date_count } dates / ${ calendar.services[ '9-172' ]?.route_count } routes` );

/* ---- Contract invariants -------------------------------------------------------------- */
process.stdout.write( '\n# Contract invariants\n' );
const stopsFile = read( 'stops.json' );
const entries = Object.entries( stopsFile.stops );
const tooLong = entries.filter( ( [ , s ] ) => [ ...s.stop_name ].length > STOP_NAME_MAX );
check( `no stop_name over ${ STOP_NAME_MAX } characters`, tooLong.length, 0 );

/*
 * A truncated name must have been cut at a space, never inside a word — except for a name
 * that is one token with no space to cut at, where §7's two requirements conflict and the
 * 25-character schema cap wins. build/lib/stop-names.mjs and runtime/lib/stopnames.php agree
 * on that fallback; see build/NOTES.md.
 */
const singleToken = [];
const midWord = entries.filter( ( [ id, s ] ) => {
	if ( ! s.stop_name.endsWith( '…' ) ) {
		return false;
	}
	const stage = s.stop_name_full
		.replace( /\s*\([^()]*\)\s*$/, '' )
		.trim()
		.replace( /^\d+\s+/, '' )
		.trim()
		.replace( /\bNorthbound\b/gi, 'NB' )
		.replace( /\bSouthbound\b/gi, 'SB' )
		.replace( /\bEastbound\b/gi, 'EB' )
		.replace( /\bWestbound\b/gi, 'WB' );
	const kept = s.stop_name.slice( 0, -1 );
	if ( ! stage.includes( ' ' ) ) {
		singleToken.push( `${ id } "${ s.stop_name }"` );
		return false;
	}
	return ! ( stage.startsWith( kept ) && stage[ kept.length ] === ' ' );
} );
check( 'no shortened name ends mid-word (except single-token names)', midWord.length, 0 );
report( 'single-token names cut inside the word to fit the cap', singleToken.join( ', ' ) || 'none' );
report( 'names that needed truncation', entries.filter( ( [ , s ] ) => s.stop_name.endsWith( '…' ) ).length );

/* No stop id in a schedule shard may be missing from the stops lookup. */
let danglingStops = 0;
for ( const route of manifest.routes ) {
	const schedule = read( `routes/${ route.dir }/schedule.json` );
	for ( const stopId of schedule.stop_ids ) {
		if ( ! stopsFile.stops[ stopId ] ) {
			danglingStops++;
		}
	}
}
check( 'every scheduled stop id resolves in stops.json', danglingStops, 0 );
check( 'no block successor pair has a negative layover', manifest.counts.block_negative_layovers, 0 );

/* ---- Size report ---------------------------------------------------------------------- */
process.stdout.write( '\n# Route 5 schedule shard\n' );
const r5raw = readFileSync( join( OUT_DIR, 'routes/5/schedule.json' ) );
const r5 = JSON.parse( r5raw );
checkPinned( 'route 5 stop_time rows', r5.stop_time_count, 34462 );
report( 'route 5 schedule raw', `${ ( r5raw.length / 1024 ).toFixed( 1 ) } KB` );
report( 'route 5 schedule gzipped', `${ ( gzipSync( r5raw, { level: 9 } ).length / 1024 ).toFixed( 1 ) } KB` );

process.stdout.write( `\n${ checks - failures }/${ checks } checks passed\n` );
process.exit( failures > 0 ? 1 : 0 );
