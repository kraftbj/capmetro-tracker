/*
 * Deterministic file emission.
 *
 * Every value is serialized with recursively sorted object keys so that a rerun over the
 * same feed produces byte-identical files. That is what lets CI decide "nothing changed"
 * by comparing the working tree instead of trusting a timestamp.
 */

import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

export function stableStringify( value, pretty = false ) {
	const sorted = sortDeep( value );
	return pretty ? JSON.stringify( sorted, null, '\t' ) + '\n' : JSON.stringify( sorted ) + '\n';
}

function sortDeep( value ) {
	if ( Array.isArray( value ) ) {
		return value.map( sortDeep );
	}
	if ( value && typeof value === 'object' ) {
		const out = {};
		for ( const key of Object.keys( value ).sort() ) {
			out[ key ] = sortDeep( value[ key ] );
		}
		return out;
	}
	return value;
}

export class Emitter {
	constructor( outDir ) {
		this.outDir = outDir;
		this.written = new Map();
	}

	write( relPath, value, { pretty = true } = {} ) {
		const abs = join( this.outDir, relPath );
		mkdirSync( dirname( abs ), { recursive: true } );
		const text = stableStringify( value, pretty );
		const buf = Buffer.from( text, 'utf8' );
		writeFileSync( abs, buf );
		const entry = { bytes: buf.length, gzip: gzipSync( buf, { level: 9 } ).length };
		this.written.set( relPath.split( sep ).join( '/' ), entry );
		return entry;
	}

	sizes( relPath ) {
		return this.written.get( relPath ) ?? null;
	}

	/* Remove anything left over from a previous build so stale routes cannot linger. */
	prune() {
		const removed = [];
		const walk = ( dir ) => {
			for ( const name of readdirSync( dir ) ) {
				const abs = join( dir, name );
				if ( statSync( abs ).isDirectory() ) {
					walk( abs );
					if ( readdirSync( abs ).length === 0 ) {
						rmSync( abs, { recursive: true } );
					}
					continue;
				}
				const rel = relative( this.outDir, abs ).split( sep ).join( '/' );
				if ( ! this.written.has( rel ) ) {
					rmSync( abs );
					removed.push( rel );
				}
			}
		};
		try {
			walk( this.outDir );
		} catch ( err ) {
			if ( err.code !== 'ENOENT' ) {
				throw err;
			}
		}
		return removed.sort();
	}
}
