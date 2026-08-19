/*
 * Shared configuration for the GTFS build job.
 *
 * The feed can come from three places, checked in this order:
 *   1. GTFS_DIR    — an already-extracted feed directory (fast local dev loop)
 *   2. /tmp/gtfs   — the conventional local dev location, used when it looks like a feed
 *   3. GTFS_URL    — downloaded and unzipped by node-gtfs (what CI does)
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(BUILD_DIR, '..');

export const GTFS_URL =
	process.env.GTFS_URL || 'https://data.texas.gov/download/r4v4-vz24/application%2Fzip';

export const OUT_DIR = resolve(process.env.GTFS_OUT_DIR || join(REPO_ROOT, 'data'));
export const CACHE_DIR = resolve(process.env.GTFS_CACHE_DIR || join(BUILD_DIR, '.cache'));
export const SQLITE_PATH = join(CACHE_DIR, 'gtfs.db');

/* Output format version. Bump when the shard shape changes incompatibly. */
export const SHARD_SCHEMA = 1;

/* §4: successor first stop must be within this distance of predecessor last stop. */
export const BLOCK_MAX_STOP_DISTANCE_M = 150;
export const BLOCK_MIN_LAYOVER_S = 60;
export const BLOCK_MAX_LAYOVER_S = 1800;

/* §7: shortened names truncate under this, and the schema caps the result at 25. */
export const STOP_NAME_TRUNCATE_AT = 24;
export const STOP_NAME_MAX = 25;

function looksLikeFeedDir( dir ) {
	return existsSync( join( dir, 'stop_times.txt' ) ) && existsSync( join( dir, 'trips.txt' ) );
}

/* Returns the node-gtfs agency config: a local path when one is available, else the URL. */
export function resolveSource() {
	const explicit = process.env.GTFS_DIR;
	if ( explicit ) {
		if ( ! looksLikeFeedDir( explicit ) ) {
			throw new Error( `GTFS_DIR=${ explicit } does not contain stop_times.txt and trips.txt` );
		}
		return { path: resolve( explicit ), origin: 'GTFS_DIR' };
	}
	if ( ! process.env.GTFS_FORCE_DOWNLOAD && looksLikeFeedDir( '/tmp/gtfs' ) ) {
		return { path: '/tmp/gtfs', origin: '/tmp/gtfs' };
	}
	return { url: GTFS_URL, origin: 'download' };
}

export function gtfsConfig() {
	const source = resolveSource();
	const agency = source.path ? { path: source.path } : { url: source.url };
	return {
		config: {
			agencies: [ agency ],
			sqlitePath: SQLITE_PATH,
			verbose: process.env.GTFS_VERBOSE === '1',
			ignoreDuplicates: true,
		},
		origin: source.origin,
	};
}
