/*
 * Stable entry point for stop names (api-contract.md §7).
 *
 * `shortenStopName` is the shortening rule itself. `stopsIndex` reads the emitted
 * data/stops.json, so callers that just want a lookup do not have to know the layout.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT_DIR } from './config.mjs';

export { shortenStopName } from './lib/stop-names.mjs';

let cached = null;

/** stop_id -> { stop_name, stop_name_full, lat, lon }. Throws if the shards are not built. */
export function stopsIndex( outDir = OUT_DIR ) {
	if ( cached && cached.outDir === outDir ) {
		return cached.stops;
	}
	const file = JSON.parse( readFileSync( join( outDir, 'stops.json' ), 'utf8' ) );
	cached = { outDir, stops: file.stops };
	return file.stops;
}
