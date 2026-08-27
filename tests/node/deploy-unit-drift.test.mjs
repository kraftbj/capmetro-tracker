/**
 * A committed systemd unit change has to reach the box, or say why it did not.
 *
 * `deploy/update.sh` pulls code and republishes the client; only `install.sh` writes
 * /etc/systemd/system. So a change to a .timer or .service merged, deployed, and did nothing,
 * with nothing anywhere reporting the difference. `capmetro-update.timer` was moved off 04:17
 * UTC on 2026-08-27 because 04:17 is seven hours BEFORE the GTFS job commits at 11:20, so a
 * rebuilt schedule waited a full day. The fix reached the box; the box kept firing at 04:17.
 *
 * The detection cannot diff the installed files against the committed ones: install.sh RENDERS
 * three of the four, substituting @RUN_USER@, @GEN@, @INTERVAL_S@ and friends, so the installed
 * copy never equals the source and a diff reports drift on a current box every time. It
 * fingerprints the sources at install time instead. See deploy/lib/units.sh.
 *
 * These run the real shell functions rather than reading them, because the failure being
 * guarded is behavioral -- "does it come back non-zero" -- and a text assertion cannot tell a
 * working comparison from a broken one.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = new URL('../../', import.meta.url).pathname
const LIB = path.join(REPO, 'deploy/lib/units.sh')
const UNITS = [
	'capmetro-generate.service',
	'capmetro-generate.timer',
	'capmetro-update.service',
	'capmetro-update.timer',
]

let work

beforeEach(() => {
	work = mkdtempSync(path.join(tmpdir(), 'cm-units-'))
	mkdirSync(path.join(work, 'deploy'))
	mkdirSync(path.join(work, 'state'))
	for (const u of UNITS) writeFileSync(path.join(work, 'deploy', u), `[Unit]\nDescription=${ u }\n`)
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

/** Runs a snippet with deploy/lib/units.sh sourced. Returns { code, stdout }. */
function sh(snippet) {
	try {
		const stdout = execFileSync('bash', ['-c', `. "${ LIB }"\n${ snippet }`], {
			cwd: work,
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		})
		return { code: 0, stdout }
	} catch (e) {
		return { code: e.status, stdout: (e.stdout || '') + (e.stderr || '') }
	}
}

const stamp = () => sh('cm_unit_fingerprint deploy > state/installed-units.sha256')

describe('the fingerprint answers whether the committed units have moved', () => {
	it('reports no drift when nothing has changed', () => {
		stamp()
		expect(sh('cm_unit_drift deploy state/installed-units.sha256').code).toBe(0)
	})

	it('names the unit that changed, and only that one', () => {
		stamp()
		writeFileSync(path.join(work, 'deploy/capmetro-update.timer'), 'OnCalendar=*-*-* 00,06,12,18:20:00\n')
		const r = sh('cm_unit_drift deploy state/installed-units.sha256')
		expect(r.code).toBe(1)
		expect(r.stdout.trim().split('\n')).toEqual([ 'capmetro-update.timer' ])
	})

	it('names several when several changed', () => {
		stamp()
		writeFileSync(path.join(work, 'deploy/capmetro-update.timer'), 'changed\n')
		writeFileSync(path.join(work, 'deploy/capmetro-generate.service'), 'changed\n')
		const r = sh('cm_unit_drift deploy state/installed-units.sha256')
		expect(r.code).toBe(1)
		expect(r.stdout.trim().split('\n').sort()).toEqual([
			'capmetro-generate.service', 'capmetro-update.timer',
		])
	})

	/*
	 * A unit that disappears is as much of a change as one that was edited, and recording it
	 * as `missing` rather than omitting the line is what keeps the two fingerprints from
	 * matching by omission.
	 */
	it('treats a deleted unit as drift rather than as agreement', () => {
		stamp()
		rmSync(path.join(work, 'deploy/capmetro-generate.timer'))
		const r = sh('cm_unit_drift deploy state/installed-units.sha256')
		expect(r.code).toBe(1)
		expect(r.stdout).toContain('capmetro-generate.timer')
	})

	/*
	 * Distinct from "unchanged", and the distinction is the point: a box installed before this
	 * existed has no stamp, and reading that as agreement would report a clean bill of health
	 * for the exact state this was written to catch.
	 */
	it('separates "no record" from "no change"', () => {
		const r = sh('cm_unit_drift deploy state/nothing-here')
		expect(r.code).toBe(2)
		expect(r.stdout.trim()).toBe('')
	})

	it('is stable across runs, so an unchanged box never reports drift twice', () => {
		stamp()
		const a = sh('cm_unit_fingerprint deploy').stdout
		const b = sh('cm_unit_fingerprint deploy').stdout
		expect(a).toBe(b)
		expect(a.trim().split('\n')).toHaveLength(UNITS.length)
	})
})

describe('the two scripts agree about what is deployed', () => {
	const install = readFileSync(path.join(REPO, 'deploy/install.sh'), 'utf8')
	const update = readFileSync(path.join(REPO, 'deploy/update.sh'), 'utf8')
	const lib = readFileSync(LIB, 'utf8')

	it('both source the shared list rather than keeping their own', () => {
		expect(install).toContain('deploy/lib/units.sh')
		expect(update).toContain('deploy/lib/units.sh')
	})

	it('install.sh records the fingerprint when it installs the units', () => {
		expect(install).toMatch(/cm_unit_fingerprint .* > "\$\(cm_unit_stamp_path/)
	})

	/*
	 * Every unit file in deploy/ has to be in the list. Adding a fifth and forgetting it would
	 * leave exactly the silent gap this whole change is about, and nothing else would notice.
	 */
	it('covers every unit file the deploy directory actually carries', () => {
		const onDisk = readdirSync(path.join(REPO, 'deploy'))
			.filter((f) => f.endsWith('.service') || f.endsWith('.timer'))
			.sort()
		expect(onDisk).toEqual([ ...UNITS ].sort())
		for (const u of onDisk) expect(lib).toContain(u)
	})

	/*
	 * The check has to run on the "nothing to do" path too, and that is the easy one to drop.
	 * Drift persists across runs: the commit that changed a unit lands once, and every run
	 * afterwards short-circuits on "already at HEAD" while the box stays on the old unit.
	 */
	it('update.sh checks on the nothing-to-do path, not only after a real pull', () => {
		const nothingToDo = update.slice(
			update.indexOf('already at $AFTER'),
			update.indexOf('say "$BEFORE -> $AFTER"'),
		)
		expect(nothingToDo).toContain('check_units')
	})

	it('update.sh checks after a successful generate', () => {
		expect(update).toMatch(/generator clean at \$AFTER[\s\S]{0,400}?check_units/)
	})

	/*
	 * A stale unit must not be able to fail a deploy that otherwise worked, nor read as the
	 * reason a rollback happened. It is reported on the rollback path with `|| true`.
	 */
	it('never lets a stale unit change the verdict on a rollback', () => {
		expect(update).toMatch(/rolled back to \$BEFORE[\s\S]{0,400}?check_units \|\| true/)
	})

	it('does not install units itself, which would restart a timer from inside its own service', () => {
		expect(update).not.toMatch(/systemctl\s+(restart|start|enable)/)
		expect(update).not.toMatch(/cp\s+.*\/etc\/systemd/)
	})
})
