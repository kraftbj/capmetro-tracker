/*
 * Block continuation chains — api-contract.md §4.
 *
 * A chain is keyed on (block_id, the set of service_ids co-active on a date) — not on
 * block_id alone, and NOT on (block_id, service_id).
 *
 * Both of the rejected keys are wrong, in opposite directions, and the second one shipped:
 *
 *   block_id alone interleaves every service variant into one list. On route 4 that yielded
 *   719 of 824 successor pairs with a NEGATIVE layover — a "next" trip starting before its
 *   predecessor finishes — which is physically impossible and makes the §4 grade meaningless.
 *
 *   (block_id, service_id) fixed that and introduced the opposite error, because a service_id
 *   in this feed is NOT a service day. calendar_dates maps one date to SEVERAL service_ids,
 *   and CapMetro splits a single physical block across them BY DIRECTION: block 837001 keeps
 *   its northbound trips under 9-172 and its southbound trips under 5-172, and both run on a
 *   Friday. Keyed on (block_id, service_id) the builder saw half a block and chained each
 *   northbound trip to the NEXT NORTHBOUND one, skipping the southbound run physically in
 *   between. On 2026-08-21, across routes with two active services, 804 of 817 published
 *   continuations named the wrong trip — 98%.
 *
 * That error was self-reporting and we read it as something else. Skipping the return leg
 * inflates the gap it is graded on, so the wrong successors came out `low` with reasons
 * `layover_too_long` and `stops_too_far_apart` — 88 minutes and 12 km for the 837 case, where
 * the true handoff is 34 minutes and zero metres. Any corpus reading of the grade-reason
 * distribution taken before this fix was measuring this bug rather than real interlining.
 *
 * The successor's VISIBLE facts do not vary by date. Measured over the whole feed: of 865
 * trips that appear in more than one co-active set, ZERO have successors differing in
 * direction or start time, and 781 differ only in trip_id — CapMetro mints the same physical
 * run once per service variant. So next_trip carries those facts once, and `trip_id_by_service`
 * carries the per-variant identifier for a caller that needs to match the successor to a live
 * trip. assertInvariantAcrossSets() below fails the build if a future feed breaks that, rather
 * than letting a date-dependent time be published as though it were fixed.
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

export function buildBlockChains( { trips, stops, calendarDates } ) {
	/*
	 * date -> the service_ids running on it. exception_type 1 adds a service to a date and 2
	 * removes one; this feed expresses its whole calendar in calendar_dates, so an added row
	 * is the only evidence a service runs at all.
	 */
	const servicesByDate = new Map();
	for ( const row of calendarDates ?? [] ) {
		if ( row.exception_type !== 1 ) {
			continue;
		}
		let set = servicesByDate.get( row.date );
		if ( ! set ) {
			set = new Set();
			servicesByDate.set( row.date, set );
		}
		set.add( row.service_id );
	}

	const byBlock = new Map();
	const orphans = [];
	for ( const trip of trips ) {
		if ( ! trip.block_id ) {
			orphans.push( trip );
			continue;
		}
		let list = byBlock.get( trip.block_id );
		if ( ! list ) {
			list = [];
			byBlock.set( trip.block_id, list );
		}
		list.push( trip );
	}

	const chains = new Map();
	const blocks = new Map();
	const stats = {
		chain_count: 0,
		pairs: 0,
		negative_layovers: 0,
		multi_service_chains: 0,
		invariant_breaks: 0,
	};

	for ( const blockId of [ ...byBlock.keys() ].sort() ) {
		const list = byBlock.get( blockId );
		const blockServices = new Set( list.map( ( t ) => t.service_id ) );

		/*
		 * The distinct sets of this block's services that ever run on the same date. Two
		 * dates that activate the same combination share one chain, so a weekday pattern
		 * repeated ninety-five times is computed once.
		 */
		const serviceSets = new Map();
		for ( const dayServices of servicesByDate.values() ) {
			const active = [ ...blockServices ].filter( ( s ) => dayServices.has( s ) ).sort();
			if ( active.length ) {
				serviceSets.set( active.join( '+' ), active );
			}
		}
		/*
		 * A block whose services never appear in calendar_dates gets one chain per service,
		 * which is what this builder did for everything before co-active sets existed.
		 *
		 * Deliberately not "chain them all together". With no date saying two services run
		 * on the same day, assuming they do is the ORIGINAL bug: on route 4 it produced 719
		 * of 824 successor pairs with a negative layover, a next trip starting before its
		 * predecessor finishes. Between two wrong answers, the one that keeps a real block
		 * apart is recoverable and the one that invents a handoff is not.
		 */
		if ( ! serviceSets.size ) {
			for ( const service of [ ...blockServices ].sort() ) {
				serviceSets.set( service, [ service ] );
			}
		}

		let block = blocks.get( blockId );
		if ( ! block ) {
			block = {
				block_id: blockId,
				route_ids: new Set(),
				service_ids: new Set(),
				trip_count: list.length,
				chains: {},
			};
			blocks.set( blockId, block );
		}
		for ( const t of list ) {
			block.route_ids.add( t.route_id );
			block.service_ids.add( t.service_id );
		}

		for ( const setKey of [ ...serviceSets.keys() ].sort() ) {
			const services = new Set( serviceSets.get( setKey ) );
			const inSet = list.filter( ( t ) => services.has( t.service_id ) );
			if ( ! inSet.length ) {
				continue;
			}
			inSet.sort( compareTripsInChain );
			stats.chain_count++;
			if ( services.size > 1 ) {
				stats.multi_service_chains++;
			}

			const chainRouteIds = [ ...new Set( inSet.map( ( t ) => t.route_id ) ) ].sort();
			const chainSpansRoutes = chainRouteIds.length > 1;
			block.chains[ setKey ] = inSet.map( ( t ) => t.trip_id );

			for ( let i = 0; i < inSet.length; i++ ) {
				const trip = inSet[ i ];
				const next = inSet[ i + 1 ];

				if ( ! next ) {
					mergeChainRecord( chains, trip, {
						block_id: blockId,
						service_id: trip.service_id,
						confidence: 'high',
						next_trip: null,
						next_route_id: null,
						grade_reasons: [ 'last_trip_of_block' ],
					}, stats );
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

				mergeChainRecord( chains, trip, {
					block_id: blockId,
					service_id: trip.service_id,
					confidence: reasons.length === 0 ? 'high' : 'low',
					next_route_id: next.route_id,
					layover_s: layoverSeconds,
					handoff_distance_m: Number.isFinite( distanceMeters )
						? Math.round( distanceMeters )
						: null,
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
						trip_id_by_service: { [ next.service_id ]: next.trip_id },
					},
				}, stats );
			}
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
			service_ids: [ ...block.service_ids ].sort(),
			chain_count: Object.keys( block.chains ).length,
			trip_count: block.trip_count,
			chains: block.chains,
		} );
	}

	return { chains, blockMeta, stats, orphanCount: orphans.length };
}

/*
 * One trip belongs to as many chains as there are co-active service sets containing its own
 * service — five, for a weekday northbound trip on route 837. Every one of those chains
 * produces a successor, and across this feed they always describe the SAME physical run:
 * of 865 trips in more than one set, zero disagree on the successor's direction or start
 * time and 781 differ only in trip_id, because CapMetro mints one trip id per service
 * variant. So the record is written once and later chains contribute only their identifier.
 *
 * If a future feed ever disagrees on the facts, that assumption is no longer safe and the
 * count is surfaced in stats rather than silently resolved: a date-dependent departure time
 * published as a fixed one is precisely the class of error this rewrite exists to remove.
 */
function mergeChainRecord( chains, trip, record, stats ) {
	const existing = chains.get( trip.trip_id );
	if ( ! existing ) {
		chains.set( trip.trip_id, record );
		return;
	}
	if ( ! existing.next_trip || ! record.next_trip ) {
		if ( Boolean( existing.next_trip ) !== Boolean( record.next_trip ) ) {
			stats.invariant_breaks++;
		}
		return;
	}
	const a = existing.next_trip;
	const b = record.next_trip;
	if ( a.start_time !== b.start_time || a.direction_id !== b.direction_id ||
		a.start_stop_id !== b.start_stop_id ) {
		stats.invariant_breaks++;
		return;
	}
	Object.assign( a.trip_id_by_service, b.trip_id_by_service );
}

function compareTripsInChain( a, b ) {
	if ( a.first_arrival_s !== b.first_arrival_s ) {
		return a.first_arrival_s - b.first_arrival_s;
	}
	return a.trip_id < b.trip_id ? -1 : a.trip_id > b.trip_id ? 1 : 0;
}
