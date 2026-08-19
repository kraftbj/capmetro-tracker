/*
 * Calendar index.
 *
 * This feed has NO calendar.txt — every service is enumerated date by date in
 * calendar_dates.txt with exception_type 1 (added). There is therefore no "weekday" service
 * to resolve against: 1-172 covers 95 weekdays over 42 routes while 9-172 covers 99 weekdays
 * over 32 routes. Resolution has to be per route, per service date, which is why the per-route
 * calendar shard exists alongside the global one.
 *
 * is_exception_day follows §1: true when any service active that date spans exactly one date.
 */

export function buildCalendar( { calendarDates, trips } ) {
	const datesByService = new Map();
	const servicesByDate = new Map();

	for ( const row of calendarDates ) {
		/* exception_type 2 removes a date; this feed has none, but honor it anyway. */
		if ( row.exception_type === 2 ) {
			datesByService.get( row.service_id )?.delete( row.date );
			servicesByDate.get( row.date )?.delete( row.service_id );
			continue;
		}
		if ( row.exception_type !== 1 ) {
			continue;
		}
		if ( ! datesByService.has( row.service_id ) ) {
			datesByService.set( row.service_id, new Set() );
		}
		datesByService.get( row.service_id ).add( row.date );
		if ( ! servicesByDate.has( row.date ) ) {
			servicesByDate.set( row.date, new Set() );
		}
		servicesByDate.get( row.date ).add( row.service_id );
	}

	const oneOffServiceIds = [ ...datesByService.entries() ]
		.filter( ( [ , dates ] ) => dates.size === 1 )
		.map( ( [ serviceId ] ) => serviceId )
		.sort();
	const oneOff = new Set( oneOffServiceIds );

	/* service_id -> the set of routes that actually run trips on it. */
	const routesByService = new Map();
	const servicesByRoute = new Map();
	for ( const trip of trips ) {
		if ( ! routesByService.has( trip.service_id ) ) {
			routesByService.set( trip.service_id, new Set() );
		}
		routesByService.get( trip.service_id ).add( trip.route_id );
		if ( ! servicesByRoute.has( trip.route_id ) ) {
			servicesByRoute.set( trip.route_id, new Set() );
		}
		servicesByRoute.get( trip.route_id ).add( trip.service_id );
	}

	const dates = {};
	for ( const date of [ ...servicesByDate.keys() ].sort() ) {
		const serviceIds = [ ...servicesByDate.get( date ) ].sort();
		dates[ date ] = {
			service_ids: serviceIds,
			is_exception_day: serviceIds.some( ( id ) => oneOff.has( id ) ),
			one_off_service_ids: serviceIds.filter( ( id ) => oneOff.has( id ) ).sort(),
		};
	}

	const services = {};
	for ( const serviceId of [ ...datesByService.keys() ].sort() ) {
		const serviceDates = [ ...datesByService.get( serviceId ) ].sort();
		services[ serviceId ] = {
			dates: serviceDates,
			date_count: serviceDates.length,
			is_one_off: oneOff.has( serviceId ),
			route_count: routesByService.get( serviceId )?.size ?? 0,
		};
	}

	const global = {
		date_count: Object.keys( dates ).length,
		service_count: Object.keys( services ).length,
		first_date: Object.keys( dates )[ 0 ] ?? null,
		last_date: Object.keys( dates ).at( -1 ) ?? null,
		exception_dates: Object.keys( dates ).filter( ( d ) => dates[ d ].is_exception_day ).sort(),
		one_off_service_ids: oneOffServiceIds,
		dates,
		services,
	};

	/* Per route: which of its services run on each date it has any service at all. */
	function forRoute( routeId ) {
		const routeServices = [ ...( servicesByRoute.get( routeId ) ?? [] ) ].sort();
		const routeSet = new Set( routeServices );
		const routeDates = {};
		for ( const date of Object.keys( dates ) ) {
			const active = dates[ date ].service_ids.filter( ( id ) => routeSet.has( id ) );
			if ( active.length === 0 ) {
				continue;
			}
			routeDates[ date ] = {
				service_ids: active,
				is_exception_day: active.some( ( id ) => oneOff.has( id ) ),
			};
		}
		return {
			service_ids: routeServices,
			date_count: Object.keys( routeDates ).length,
			exception_dates: Object.keys( routeDates ).filter( ( d ) => routeDates[ d ].is_exception_day ).sort(),
			dates: routeDates,
		};
	}

	return { global, forRoute };
}
