/*
 * Trip pattern classification — api-contract.md §3.
 *
 * A pattern is an ordered stop-ID signature. Within each (route_id, direction_id) the
 * BASELINE is the signature the most trips share; ties break toward more stops, then toward
 * the lexicographically smallest first stop id, then toward the smallest signature.
 *
 * §3 defines the baseline "on the current service date", and that qualifier is not
 * decorative: on route 4 direction 0 services 1-172, 6-172 and 8-172 run a 19-stop baseline
 * while 2/3/4/5/7-172 run a 17-stop one. A single feed-wide baseline would mislabel the
 * ladder on three of eight service days. So this emits:
 *
 *   - baseline_pattern_id      the feed-wide baseline (§3's "268 of 834 trips" figure)
 *   - baseline_by_service      service_id -> baseline pattern id, what the runtime resolves
 *   - trips_by_service         per-pattern trip counts, so §2's `trips_in_pattern` ("how many
 *                              trips share this stop signature today") is a lookup, not a scan
 *   - deltas                   adds/skips keyed by baseline pattern id, since which stops
 *                              count as added or skipped depends on which baseline is in force
 */

import { createHash } from 'node:crypto';

/* ASCII unit separator: cannot occur inside a GTFS stop id, so joins stay unambiguous. */
const UNIT_SEP = '\u001f';

export function buildRoutePatterns( { routeId, routeTrips, tripStops, stops } ) {
	const byDirection = new Map();

	for ( const trip of routeTrips ) {
		const stopList = tripStops.get( trip.trip_id );
		if ( ! stopList || stopList.length === 0 ) {
			continue;
		}
		const direction = trip.direction_id === null ? 0 : trip.direction_id;
		const stopIds = stopList.map( ( s ) => s.stop_id );
		const signature = stopIds.join( UNIT_SEP );

		let group = byDirection.get( direction );
		if ( ! group ) {
			group = new Map();
			byDirection.set( direction, group );
		}
		let pattern = group.get( signature );
		if ( ! pattern ) {
			pattern = { signature, stop_ids: stopIds, trip_ids: [], services: new Map() };
			group.set( signature, pattern );
		}
		pattern.trip_ids.push( trip.trip_id );
		pattern.services.set( trip.service_id, ( pattern.services.get( trip.service_id ) ?? 0 ) + 1 );
	}

	const directions = [];
	const tripPattern = new Map();

	for ( const direction of [ ...byDirection.keys() ].sort( ( a, b ) => a - b ) ) {
		const patterns = [ ...byDirection.get( direction ).values() ];
		for ( const pattern of patterns ) {
			pattern.trip_ids.sort();
			pattern.pattern_id = patternId( routeId, direction, pattern.signature );
		}

		/* Feed-wide baseline. */
		const feedBaseline = pickBaseline( patterns, ( p ) => p.trip_ids.length );

		/* Per-service baseline: same rules, counting only that service's trips. */
		const serviceIds = [ ...new Set( patterns.flatMap( ( p ) => [ ...p.services.keys() ] ) ) ].sort();
		const baselineByService = {};
		for ( const serviceId of serviceIds ) {
			const active = patterns.filter( ( p ) => ( p.services.get( serviceId ) ?? 0 ) > 0 );
			baselineByService[ serviceId ] = pickBaseline(
				active,
				( p ) => p.services.get( serviceId ) ?? 0
			).pattern_id;
		}

		/* Every baseline any service might resolve to, so deltas can cover all of them. */
		const baselineIds = [
			...new Set( [ feedBaseline.pattern_id, ...Object.values( baselineByService ) ] ),
		].sort();
		const patternById = new Map( patterns.map( ( p ) => [ p.pattern_id, p ] ) );

		const emitted = patterns
			.map( ( pattern ) => {
				const patternStops = new Set( pattern.stop_ids );
				const deltas = {};
				for ( const baselineId of baselineIds ) {
					const baseline = patternById.get( baselineId );
					const baselineStops = new Set( baseline.stop_ids );
					deltas[ baselineId ] = {
						adds: uniqueMissing( pattern.stop_ids, baselineStops ).map( ( id ) => stopRef( id, stops ) ),
						skips: uniqueMissing( baseline.stop_ids, patternStops ).map( ( id ) => stopRef( id, stops ) ),
					};
				}
				for ( const tripId of pattern.trip_ids ) {
					tripPattern.set( tripId, pattern.pattern_id );
				}
				return {
					pattern_id: pattern.pattern_id,
					direction_id: direction,
					is_baseline: pattern.pattern_id === feedBaseline.pattern_id,
					is_baseline_for_services: serviceIds
						.filter( ( s ) => baselineByService[ s ] === pattern.pattern_id )
						.sort(),
					is_special: pattern.pattern_id !== feedBaseline.pattern_id,
					trips_in_pattern: pattern.trip_ids.length,
					trips_by_service: Object.fromEntries(
						[ ...pattern.services.entries() ].sort( ( a, b ) => compareStrings( a[ 0 ], b[ 0 ] ) )
					),
					stop_count: pattern.stop_ids.length,
					stop_ids: pattern.stop_ids,
					trip_ids: pattern.trip_ids,
					deltas,
				};
			} )
			/* Feed-wide baseline first, then most-used to least-used, then by id. */
			.sort( ( a, b ) => {
				if ( a.is_baseline !== b.is_baseline ) {
					return a.is_baseline ? -1 : 1;
				}
				if ( a.trips_in_pattern !== b.trips_in_pattern ) {
					return b.trips_in_pattern - a.trips_in_pattern;
				}
				return compareStrings( a.pattern_id, b.pattern_id );
			} );

		directions.push( {
			direction_id: direction,
			baseline_pattern_id: feedBaseline.pattern_id,
			baseline_by_service: baselineByService,
			baseline_stable: baselineIds.length === 1,
			baseline_pattern_ids: baselineIds,
			pattern_count: emitted.length,
			trip_count: emitted.reduce( ( n, p ) => n + p.trips_in_pattern, 0 ),
			patterns: emitted,
		} );
	}

	return { directions, tripPattern };
}

/* §3's tiebreak chain: most trips, then more stops, then smallest first stop id. */
function pickBaseline( patterns, countOf ) {
	return patterns.slice().sort( ( a, b ) => {
		const countA = countOf( a );
		const countB = countOf( b );
		if ( countA !== countB ) {
			return countB - countA;
		}
		if ( a.stop_ids.length !== b.stop_ids.length ) {
			return b.stop_ids.length - a.stop_ids.length;
		}
		const firstA = a.stop_ids[ 0 ] ?? '';
		const firstB = b.stop_ids[ 0 ] ?? '';
		if ( firstA !== firstB ) {
			return compareStrings( firstA, firstB );
		}
		return compareStrings( a.signature, b.signature );
	} )[ 0 ];
}

/* Stop ids present in `ids` but absent from `have`, de-duplicated, in first-seen order. */
function uniqueMissing( ids, have ) {
	const seen = new Set();
	const out = [];
	for ( const id of ids ) {
		if ( ! have.has( id ) && ! seen.has( id ) ) {
			seen.add( id );
			out.push( id );
		}
	}
	return out;
}

function compareStrings( a, b ) {
	return a < b ? -1 : a > b ? 1 : 0;
}

function patternId( routeId, direction, signature ) {
	const digest = createHash( 'sha1' ).update( signature ).digest( 'hex' ).slice( 0, 8 );
	return `${ routeId }-${ direction }-${ digest }`;
}

function stopRef( stopId, stops ) {
	const stop = stops.get( stopId );
	return { stop_id: stopId, stop_name: stop ? stop.stop_name : stopId };
}
