/* SQL access layer. Everything downstream works on plain objects, never on the database. */

import { shortenStopName } from './stop-names.mjs';

export function ensureIndexes( db ) {
	db.exec( `
		CREATE INDEX IF NOT EXISTS idx_build_trips_route ON trips (route_id);
		CREATE INDEX IF NOT EXISTS idx_build_trips_block ON trips (block_id);
		CREATE INDEX IF NOT EXISTS idx_build_st_trip_seq ON stop_times (trip_id, stop_sequence);
		CREATE INDEX IF NOT EXISTS idx_build_caldates_date ON calendar_dates (date);
	` );
}

export function loadFeedInfo( db ) {
	return db.prepare( 'SELECT * FROM feed_info LIMIT 1' ).get() ?? {};
}

export function loadRoutes( db ) {
	return db
		.prepare(
			`SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color
			 FROM routes ORDER BY route_id`
		)
		.all();
}

export function loadStops( db ) {
	const rows = db
		.prepare( 'SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops ORDER BY stop_id' )
		.all();
	const byId = new Map();
	for ( const row of rows ) {
		byId.set( String( row.stop_id ), {
			stop_id: String( row.stop_id ),
			stop_name: shortenStopName( row.stop_name ),
			stop_name_full: row.stop_name ?? '',
			lat: row.stop_lat,
			lon: row.stop_lon,
		} );
	}
	return byId;
}

/*
 * One row per trip carrying its terminal stops. Cheap enough (24k rows) to hold globally,
 * which block chaining needs because blocks may interline across routes.
 */
export function loadTripSummaries( db ) {
	return db
		.prepare(
			`SELECT
				t.trip_id, t.route_id, t.service_id, t.direction_id, t.block_id, t.trip_headsign,
				fs.stop_id AS first_stop_id, fs.stop_sequence AS first_stop_sequence,
				fs.arrival_timestamp AS first_arrival_s, fs.departure_timestamp AS first_departure_s,
				ls.stop_id AS last_stop_id, ls.stop_sequence AS last_stop_sequence,
				ls.arrival_timestamp AS last_arrival_s, ls.departure_timestamp AS last_departure_s
			FROM trips t
			JOIN stop_times fs
				ON fs.trip_id = t.trip_id
				AND fs.stop_sequence = ( SELECT MIN( stop_sequence ) FROM stop_times WHERE trip_id = t.trip_id )
			JOIN stop_times ls
				ON ls.trip_id = t.trip_id
				AND ls.stop_sequence = ( SELECT MAX( stop_sequence ) FROM stop_times WHERE trip_id = t.trip_id )
			ORDER BY t.trip_id`
		)
		.all()
		.map( ( row ) => ( {
			...row,
			trip_id: String( row.trip_id ),
			route_id: String( row.route_id ),
			service_id: String( row.service_id ),
			block_id: row.block_id === null || row.block_id === '' ? null : String( row.block_id ),
			direction_id: row.direction_id === null ? null : Number( row.direction_id ),
			first_stop_id: String( row.first_stop_id ),
			last_stop_id: String( row.last_stop_id ),
		} ) );
}

/* Full stop_times for one route, ordered so trips come out already grouped and sequenced. */
export function loadRouteStopTimes( db, routeId ) {
	const rows = db
		.prepare(
			`SELECT st.trip_id, st.stop_sequence, st.stop_id, st.arrival_timestamp, st.departure_timestamp, st.timepoint
			 FROM stop_times st
			 JOIN trips t ON t.trip_id = st.trip_id
			 WHERE t.route_id = ?
			 ORDER BY st.trip_id, st.stop_sequence`
		)
		.all( routeId );

	const byTrip = new Map();
	for ( const row of rows ) {
		const tripId = String( row.trip_id );
		let list = byTrip.get( tripId );
		if ( ! list ) {
			list = [];
			byTrip.set( tripId, list );
		}
		list.push( {
			stop_sequence: Number( row.stop_sequence ),
			stop_id: String( row.stop_id ),
			arrival_s: row.arrival_timestamp,
			departure_s: row.departure_timestamp,
			/* GTFS treats a missing timepoint column as "exact", i.e. 1. */
			timepoint: row.timepoint === null || row.timepoint === undefined ? 1 : Number( row.timepoint ),
		} );
	}
	return { byTrip, rowCount: rows.length };
}

export function loadCalendarDates( db ) {
	return db
		.prepare(
			`SELECT service_id, date, exception_type FROM calendar_dates ORDER BY date, service_id`
		)
		.all()
		.map( ( row ) => ( {
			service_id: String( row.service_id ),
			date: String( row.date ),
			exception_type: Number( row.exception_type ),
		} ) );
}

export function hasCalendarTable( db ) {
	const { n } = db.prepare( 'SELECT COUNT(*) AS n FROM calendar' ).get();
	return n > 0;
}
