/*
 * Step 1: load the GTFS static feed into a local SQLite database with node-gtfs.
 *
 * Idempotent-ish: pass --force (or set GTFS_REIMPORT=1) to drop an existing cache first.
 * Everything downstream reads the SQLite file, never the CSVs.
 */

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { importGtfs, openDb } from 'gtfs';
import { CACHE_DIR, SQLITE_PATH, gtfsConfig } from './config.mjs';

export async function ingest( { force = false } = {} ) {
	mkdirSync( CACHE_DIR, { recursive: true } );
	const { config, origin } = gtfsConfig();

	if ( force && existsSync( SQLITE_PATH ) ) {
		rmSync( SQLITE_PATH, { force: true } );
	}

	if ( ! existsSync( SQLITE_PATH ) ) {
		process.stderr.write( `[ingest] importing GTFS from ${ origin }\n` );
		const started = Date.now();
		await importGtfs( config );
		process.stderr.write( `[ingest] import finished in ${ ( ( Date.now() - started ) / 1000 ).toFixed( 1 ) }s\n` );
	} else {
		process.stderr.write( `[ingest] reusing cached ${ SQLITE_PATH } (pass --force to rebuild)\n` );
	}

	const db = openDb( config );
	db.pragma( 'journal_mode = WAL' );
	return db;
}

if ( import.meta.url === `file://${ process.argv[ 1 ] }` ) {
	const force = process.argv.includes( '--force' ) || process.env.GTFS_REIMPORT === '1';
	const db = await ingest( { force } );
	for ( const table of [ 'routes', 'trips', 'stop_times', 'stops', 'calendar_dates', 'feed_info' ] ) {
		const { n } = db.prepare( `SELECT COUNT(*) AS n FROM ${ table }` ).get();
		process.stdout.write( `${ table }\t${ n }\n` );
	}
}
