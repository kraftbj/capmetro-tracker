/*
 * Block continuation chains — api-contract.md §4.
 *
 * A chain is keyed on (block_id, service_id), not on block_id alone. That distinction is
 * load-bearing: CapMetro reuses the same block_id across all eight service variants, so
 * grouping by block_id alone interleaves eight different service days into one list. On
 * route 4 that yields 719 of 824 successor pairs with a NEGATIVE layover — the "next" trip
 * starting before its predecessor finishes — which is physically impossible and makes the
 * §4 confidence grade meaningless. Keyed on (block_id, service_id) the same route yields
 * zero negative layovers. See build/NOTES.md for the worked examples.
 *
 * Chains are computed over EVERY trip in the feed, not per route, because a block may
 * interline across routes. Route shards then slice out the trips they own.
 *
 * Grading (all must hold for `high`):
 *   - the successor is on the same route_id, and the chain itself is single-route
 *   - the successor's first stop equals the predecessor's last stop, or lies within 150 m
 *   - the layover is 60 to 1800 seconds inclusive
 * A trip that is the last of its chain gets next_trip: null and confidence: high, because
 * "there is no continuation" is a confident statement, not an uncertain one.
 */

import {
	BLOCK_MAX_STOP_DISTANCE_M,
	BLOCK_MIN_LAYOVER_S,
	BLOCK_MAX_LAYOVER_S,
} from '../config.mjs';
import { haversineMeters } from './geo.mjs';
import { secondsToClock } from './time.mjs';

const KEY_SEP = '\u001f';

/*
 * The §4 grade as a pure function, so the rule has exactly one implementation and can be
 * exercised directly.
 *
 *   { block_id, predecessor: { route_id, last_stop_id, last_stop_lat, last_stop_lon, end_epoch },
 *     successor:  { route_id, first_stop_id, first_stop_lat, first_stop_lon, start_epoch } | null }
 *
 * `end_epoch` / `start_epoch` may equally be seconds after service-day midnight; only their
 * difference is used, and a continuation never spans two service days.
 */
export function continuationReasons( { block_id: blockId, predecessor, successor } ) {
	if ( ! blockId ) {
		return [ 'missing_block_id' ];
	}
	if ( ! successor ) {
		return [];
	}

	const reasons = [];
	if ( predecessor.route_id !== successor.route_id ) {
		reasons.push( 'successor_on_different_route' );
	}

	const sameStop = predecessor.last_stop_id === successor.first_stop_id;
	const distance = sameStop
		? 0
		: haversineMeters(
				predecessor.last_stop_lat,
				predecessor.last_stop_lon,
				successor.first_stop_lat,
				successor.first_stop_lon
		  );
	if ( ! ( distance <= BLOCK_MAX_STOP_DISTANCE_M ) ) {
		reasons.push( 'stops_too_far_apart' );
	}

	const layover = successor.start_epoch - predecessor.end_epoch;
	if ( layover < BLOCK_MIN_LAYOVER_S ) {
		reasons.push( 'layover_too_short' );
	}
	if ( layover > BLOCK_MAX_LAYOVER_S ) {
		reasons.push( 'layover_too_long' );
	}

	return reasons.sort();
}

/* api-contract.md §4: `high` only when every condition holds. */
export function blockConfidence( continuation ) {
	return continuationReasons( continuation ).length === 0 ? 'high' : 'low';
}

export function buildBlockChains( { trips, stops } ) {
	const byChain = new Map();
	const orphans = [];

	for ( const trip of trips ) {
		if ( ! trip.block_id ) {
			orphans.push( trip );
			continue;
		}
		const key = `${ trip.block_id }${ KEY_SEP }${ trip.service_id }`;
		let list = byChain.get( key );
		if ( ! list ) {
			list = [];
			byChain.set( key, list );
		}
		list.push( trip );
	}

	const chains = new Map();
	const blocks = new Map();
	const stats = { chain_count: byChain.size, pairs: 0, negative_layovers: 0 };

	for ( const key of [ ...byChain.keys() ].sort() ) {
		const [ blockId, serviceId ] = key.split( KEY_SEP );
		const list = byChain.get( key );
		list.sort( compareTripsInChain );

		const chainRouteIds = [ ...new Set( list.map( ( t ) => t.route_id ) ) ].sort();
		const chainSpansRoutes = chainRouteIds.length > 1;

		let block = blocks.get( blockId );
		if ( ! block ) {
			block = {
				block_id: blockId,
				route_ids: new Set(),
				service_ids: [],
				trip_count: 0,
				chains: {},
			};
			blocks.set( blockId, block );
		}
		for ( const routeId of chainRouteIds ) {
			block.route_ids.add( routeId );
		}
		block.service_ids.push( serviceId );
		block.trip_count += list.length;
		block.chains[ serviceId ] = list.map( ( t ) => t.trip_id );

		for ( let i = 0; i < list.length; i++ ) {
			const trip = list[ i ];
			const next = list[ i + 1 ];

			if ( ! next ) {
				chains.set( trip.trip_id, {
					block_id: blockId,
					service_id: serviceId,
					confidence: 'high',
					next_trip: null,
					next_route_id: null,
					grade_reasons: [ 'last_trip_of_block' ],
				} );
				continue;
			}

			stats.pairs++;
			const layoverSeconds = next.first_arrival_s - trip.last_departure_s;
			if ( layoverSeconds < 0 ) {
				stats.negative_layovers++;
			}
			const from = stops.get( trip.last_stop_id );
			const to = stops.get( next.first_stop_id );
			const sameStop = trip.last_stop_id === next.first_stop_id;
			const distanceMeters = sameStop
				? 0
				: haversineMeters( from?.lat, from?.lon, to?.lat, to?.lon );

			const reasons = continuationReasons( {
				block_id: blockId,
				predecessor: {
					route_id: trip.route_id,
					last_stop_id: trip.last_stop_id,
					last_stop_lat: from?.lat,
					last_stop_lon: from?.lon,
					end_epoch: trip.last_departure_s,
				},
				successor: {
					route_id: next.route_id,
					first_stop_id: next.first_stop_id,
					first_stop_lat: to?.lat,
					first_stop_lon: to?.lon,
					start_epoch: next.first_arrival_s,
				},
			} );
			/* Block-level disqualifier, not a property of this one handoff. */
			if ( chainSpansRoutes ) {
				reasons.push( 'block_spans_multiple_routes' );
				reasons.sort();
			}

			chains.set( trip.trip_id, {
				block_id: blockId,
				service_id: serviceId,
				confidence: reasons.length === 0 ? 'high' : 'low',
				next_route_id: next.route_id,
				layover_s: layoverSeconds,
				handoff_distance_m: Number.isFinite( distanceMeters ) ? Math.round( distanceMeters ) : null,
				grade_reasons: reasons.sort(),
				next_trip: {
					trip_id: next.trip_id,
					direction_id: next.direction_id,
					start_time: secondsToClock( next.first_arrival_s ),
					start_stop_id: next.first_stop_id,
					start_stop_name: to ? to.stop_name : next.first_stop_id,
					is_direction_flip:
						trip.direction_id !== null &&
						next.direction_id !== null &&
						trip.direction_id !== next.direction_id,
				},
			} );
		}
	}

	/* Trips with no block_id can never be chained; §4 grades that `low`. */
	for ( const trip of orphans ) {
		chains.set( trip.trip_id, {
			block_id: null,
			service_id: trip.service_id,
			confidence: 'low',
			next_trip: null,
			next_route_id: null,
			grade_reasons: [ 'missing_block_id' ],
		} );
	}

	const blockMeta = new Map();
	for ( const [ blockId, block ] of blocks ) {
		blockMeta.set( blockId, {
			block_id: blockId,
			route_ids: [ ...block.route_ids ].sort(),
			spans_routes: block.route_ids.size > 1,
			service_ids: block.service_ids.slice().sort(),
			chain_count: block.service_ids.length,
			trip_count: block.trip_count,
			chains: block.chains,
		} );
	}

	return { chains, blockMeta, stats, orphanCount: orphans.length };
}

function compareTripsInChain( a, b ) {
	if ( a.first_arrival_s !== b.first_arrival_s ) {
		return a.first_arrival_s - b.first_arrival_s;
	}
	return a.trip_id < b.trip_id ? -1 : a.trip_id > b.trip_id ? 1 : 0;
}
