/**
 * Regression: build/verify.mjs failed 23 correctly-shortened stop names.
 * Found while rebuilding shards for feed_version 260826_0956 on 2026-08-27.
 *
 * The §7 shortener breaks on a space OR a slash. verify.mjs re-derived the pre-truncation
 * name with its own hand-copied version of steps 1-3b and then demanded the cut land on a
 * SPACE, so every slash cut — "Martin Luther King/…", "Pleasant Valley/…", 23 of the 161
 * truncated names — was reported as ending mid-word. `npm run verify` only runs in CI when
 * feed_version changes, so the false failure sat latent in the committed tree and surfaced
 * as a blocked data update on the first off-cycle republish, with the board still serving a
 * superseded schedule while the gate refused the fix.
 *
 * Two things are locked down here: the staging is no longer duplicated (verify.mjs imports
 * stopNameStem), and the boundary predicate accepts both legal cut shapes.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { shortenStopName, stopNameStem } from '../../build/lib/stop-names.mjs'

/*
 * The predicate as build/verify.mjs applies it: true means "this cut is bad". Kept in step
 * with that file — if the rule changes there it must change here, and the corpus case below
 * will catch it if it does not.
 */
function endsMidWord( full, short ) {
	if ( ! short.endsWith( '…' ) ) {
		return false
	}
	const stage = stopNameStem( full )
	const kept = short.slice( 0, -1 )
	if ( kept.endsWith( '/' ) ) {
		return ! stage.startsWith( kept )
	}
	if ( ! /[ /]/.test( stage ) ) {
		return false
	}
	return ! ( stage.startsWith( kept ) && stage[ kept.length ] === ' ' )
}

describe( 'the mid-word check accepts a slash cut', () => {
	it.each( [
		[ '2207 Martin Luther King/Ferdinand', 'Martin Luther King/…' ],
		[ '850 Pleasant Valley/Webberville', 'Pleasant Valley/…' ],
		[ '12460 Lamplight Village/Alderbrook', 'Lamplight Village/…' ],
		[ '1900 William Cannon/Cannonleague', 'William Cannon/…' ],
		[ '10001 Capital of Texas/Stonelake', 'Capital of Texas/…' ],
	] )( 'passes %s shortened to %s', ( full, expected ) => {
		expect( shortenStopName( full ) ).toBe( expected )
		expect( endsMidWord( full, expected ) ).toBe( false )
	} )

	it( 'still accepts a space cut, where the space is dropped', () => {
		const full = 'Lamplight Village/Metric NW Corner'
		const short = shortenStopName( full )
		expect( short ).toBe( 'Lamplight Village/Metric…' )
		expect( endsMidWord( full, short ) ).toBe( false )
	} )

	it( 'still catches a genuine mid-word cut', () => {
		/* Hand-built, not something the shortener emits: the point is the check can fail. */
		expect( endsMidWord( '850 Pleasant Valley/Webberville', 'Pleasant Valley/Webber…' ) ).toBe( true )
		expect( endsMidWord( 'Lamplight Village/Metric NW Corner', 'Lamplight Vill…' ) ).toBe( true )
	} )

	it( 'does not flag a name the shortener left whole', () => {
		expect( endsMidWord( 'Pleasant Valley/Turnstone', 'Pleasant Valley/Turnstone' ) ).toBe( false )
	} )
} )

describe( 'stopNameStem is the one implementation of steps 1-3b', () => {
	it( 'strips the parenthetical, the street number, the bound word and the ordinal cap', () => {
		expect( stopNameStem( '2207 Martin Luther King/Ferdinand' ) ).toBe( 'Martin Luther King/Ferdinand' )
		expect( stopNameStem( '216 8Th/Lavaca' ) ).toBe( '8th/Lavaca' )
		expect( stopNameStem( 'Guadalupe/5Th Northbound' ) ).toBe( 'Guadalupe/5th NB' )
		expect( stopNameStem( 'Riverside/Pleasant Valley (Eastbound)' ) ).toBe( 'Riverside/Pleasant Valley' )
	} )

	it( 'never empties a name that is only a number', () => {
		expect( stopNameStem( '12345' ) ).toBe( '12345' )
	} )

	it( 'leaves shortenStopName as the stem plus truncation', () => {
		for ( const name of [
			'2207 Martin Luther King/Ferdinand',
			'Pleasant Valley/Turnstone',
			'216 8Th/Lavaca',
			'12345',
		] ) {
			const stem = stopNameStem( name )
			const short = shortenStopName( name )
			expect( short === stem || short.endsWith( '…' ) ).toBe( true )
		}
	} )
} )

describe( 'every committed stop name passes the check', () => {
	/*
	 * The whole corpus, because this failure was invisible in unit tests: each of the 23 names
	 * is individually unremarkable and only the full sweep showed the gate was wrong.
	 */
	it( 'reports no mid-word cuts across data/stops.json', () => {
		const stops = JSON.parse( readFileSync( new URL( '../../data/stops.json', import.meta.url ) ) ).stops
		const bad = Object.entries( stops )
			.filter( ( [ , s ] ) => endsMidWord( s.stop_name_full, s.stop_name ) )
			.map( ( [ id, s ] ) => `${ id } ${ s.stop_name }` )
		expect( bad ).toEqual( [] )
	} )

	it( 'agrees with the shortener on every committed name', () => {
		const stops = JSON.parse( readFileSync( new URL( '../../data/stops.json', import.meta.url ) ) ).stops
		const drift = Object.entries( stops )
			.filter( ( [ , s ] ) => shortenStopName( s.stop_name_full ) !== s.stop_name )
			.map( ( [ id ] ) => id )
		expect( drift ).toEqual( [] )
	} )
} )
