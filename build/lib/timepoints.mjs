/*
 * Timepoint ladder rows — api-contract.md §3.
 *
 * The ladder is built from the BASELINE pattern: stops carrying stop_times.timepoint = 1,
 * each holding the stops between it and the next timepoint as minor_stops (the accordion
 * payload).
 *
 * Because §3 pins the baseline to the current service date and route 4 direction 0 really
 * does run two different baselines depending on the day, one ladder per direction is not
 * enough. A ladder is emitted for every distinct baseline the direction can resolve to, keyed
 * by pattern id; `baseline_by_service` in patterns.json says which one applies today.
 *
 * service_status is deliberately NOT emitted. All three of its sources — realtime SKIPPED
 * events, NO_SERVICE alerts, and the running trip's own pattern — are live inputs the PHP
 * runtime owns. The build job supplies only the static ladder.
 */

export function buildRouteTimepoints( { patternDirections, tripStops, stops } ) {
	const directions = [];
	const warnings = [];

	for ( const direction of patternDirections ) {
		const byId = new Map( direction.patterns.map( ( p ) => [ p.pattern_id, p ] ) );
		const ladders = {};

		for ( const baselineId of direction.baseline_pattern_ids ) {
			const pattern = byId.get( baselineId );
			if ( ! pattern ) {
				continue;
			}
			/* Trip ids are sorted, so the representative trip is stable across rebuilds. */
			const representativeTripId = pattern.trip_ids[ 0 ];
			const stopList = tripStops.get( representativeTripId );
			if ( ! stopList || stopList.length === 0 ) {
				continue;
			}

			const isTimepoint = stopList.map( ( s ) => s.timepoint === 1 );
			if ( ! isTimepoint.some( Boolean ) ) {
				warnings.push(
					`direction ${ direction.direction_id } baseline ${ baselineId }: no timepoint=1 stops; promoting first and last`
				);
				isTimepoint[ 0 ] = true;
				isTimepoint[ isTimepoint.length - 1 ] = true;
			} else if ( ! isTimepoint[ 0 ] ) {
				/*
				 * Stops ahead of the first timepoint would have no row to hang off, so the
				 * trip's first stop is promoted. It is the terminal, which is a sensible
				 * ladder row anyway.
				 */
				warnings.push(
					`direction ${ direction.direction_id } baseline ${ baselineId }: starts on a non-timepoint stop; promoting it`
				);
				isTimepoint[ 0 ] = true;
			}

			const timepoints = [];
			let current = null;
			for ( let i = 0; i < stopList.length; i++ ) {
				const row = toLadderStop( stopList[ i ], direction.direction_id, stops );
				if ( isTimepoint[ i ] ) {
					current = { ...row, stop_name_full: stopFull( stopList[ i ], stops ), minor_stops: [] };
					timepoints.push( current );
				} else if ( current ) {
					current.minor_stops.push( row );
				}
			}

			ladders[ baselineId ] = {
				pattern_id: baselineId,
				direction_id: direction.direction_id,
				representative_trip_id: representativeTripId,
				service_ids: pattern.is_baseline_for_services,
				stop_count: stopList.length,
				timepoint_count: timepoints.length,
				timepoints,
			};
		}

		const defaultLadder = ladders[ direction.baseline_pattern_id ];
		directions.push( {
			direction_id: direction.direction_id,
			baseline_pattern_id: direction.baseline_pattern_id,
			baseline_by_service: direction.baseline_by_service,
			baseline_stable: direction.baseline_stable,
			/* Convenience mirrors of the feed-wide default ladder. */
			stop_count: defaultLadder?.stop_count ?? 0,
			timepoint_count: defaultLadder?.timepoint_count ?? 0,
			ladders,
		} );
	}

	return { directions, warnings };
}

function toLadderStop( stopTime, directionId, stops ) {
	const stop = stops.get( stopTime.stop_id );
	return {
		stop_id: stopTime.stop_id,
		stop_name: stop ? stop.stop_name : stopTime.stop_id,
		stop_sequence: stopTime.stop_sequence,
		direction_id: directionId,
		lat: stop ? stop.lat : null,
		lon: stop ? stop.lon : null,
	};
}

function stopFull( stopTime, stops ) {
	const stop = stops.get( stopTime.stop_id );
	return stop ? stop.stop_name_full : stopTime.stop_id;
}
