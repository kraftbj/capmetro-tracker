/* Great-circle distance in metres. Used for the 150 m block-continuation test (§4). */

const EARTH_RADIUS_M = 6371008.8;

export function haversineMeters( lat1, lon1, lat2, lon2 ) {
	if ( ! Number.isFinite( lat1 ) || ! Number.isFinite( lon1 ) || ! Number.isFinite( lat2 ) || ! Number.isFinite( lon2 ) ) {
		return Infinity;
	}
	const toRad = Math.PI / 180;
	const dLat = ( lat2 - lat1 ) * toRad;
	const dLon = ( lon2 - lon1 ) * toRad;
	const a =
		Math.sin( dLat / 2 ) ** 2 +
		Math.cos( lat1 * toRad ) * Math.cos( lat2 * toRad ) * Math.sin( dLon / 2 ) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin( Math.min( 1, Math.sqrt( a ) ) );
}
