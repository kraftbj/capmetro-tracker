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
 * EVERYTHING HERE EXECUTES THE REAL SHELL. An earlier version of this file asserted that the
 * string "check_units" appeared inside a slice of update.sh's source, which cannot tell a live
 * call from a commented-out one -- the precise failure mode the feature exists to prevent.
 * update.sh now stops early when sourced with CM_UPDATE_SH_LIB_ONLY=1, so its functions can be
 * called directly without running a deploy or needing root.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = new URL('../../', import.meta.url).pathname
const LIB = path.join(REPO, 'deploy/lib/units.sh')
const UPDATE = path.join(REPO, 'deploy/update.sh')

/*
 * The unit list is read out of units.sh, never restated here. units.sh's own reason for
 * existing is that "a second copy of the list would be a third place to disagree", and a
 * hardcoded array in the test would have been exactly that third place.
 */
const UNITS = execFileSync('bash', ['-c', `. "${ LIB }"; printf '%s\\n' $CM_UNIT_FILES`], { encoding: 'utf8' })
	.trim().split('\n')

let work

/** A fake checkout: <work>/src/deploy/{unit files, lib/units.sh} plus an empty <work>/conf. */
beforeEach(() => {
	work = mkdtempSync(path.join(tmpdir(), 'cm-units-'))
	mkdirSync(path.join(work, 'src/deploy/lib'), { recursive: true })
	mkdirSync(path.join(work, 'conf'))
	for (const u of UNITS) writeFileSync(path.join(work, 'src/deploy', u), `[Unit]\nDescription=${ u }\n`)
	writeFileSync(path.join(work, 'src/deploy/lib/units.sh'), readFileSync(LIB))
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

/** Runs a snippet with deploy/lib/units.sh sourced. Returns { code, stdout }. */
function sh(snippet, opts = {}) {
	try {
		const stdout = execFileSync('bash', ['-c', `. "${ LIB }"\n${ snippet }`], {
			cwd: work, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ], ...opts,
		})
		return { code: 0, stdout }
	} catch (e) {
		return { code: e.status, stdout: (e.stdout || '') + (e.stderr || '') }
	}
}

/**
 * Calls the REAL check_units out of the real update.sh, with errexit on, the way the script
 * runs it. `env` overrides let a test point the systemd marker at a path that does or does
 * not exist without needing a container.
 */
function checkUnits(env = {}) {
	const script = `
set -euo pipefail
export CM_UPDATE_SH_LIB_ONLY=1
export SRC_DIR="${ work }/src" CONF_DIR="${ work }/conf"
export SYSTEMD_MARKER="${ env.SYSTEMD_MARKER ?? `${ work }/src` }"
export SYSTEMCTL_BIN="${ env.SYSTEMCTL_BIN ?? 'true' }"
. "${ UPDATE }"
check_units ${ env.context ?? '' }
`
	try {
		const stdout = execFileSync('bash', ['-c', script], {
			cwd: work, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ],
		})
		return { code: 0, stdout }
	} catch (e) {
		return { code: e.status, stdout: (e.stdout || '') + (e.stderr || '') }
	}
}

const writeStamp = () => sh('cm_unit_fingerprint src/deploy > conf/installed-units.sha256')
const editUnit = (u, body = 'changed\n') => writeFileSync(path.join(work, 'src/deploy', u), body)

describe('the fingerprint answers whether the committed units have moved', () => {
	it('reports no drift when nothing has changed', () => {
		writeStamp()
		expect(sh('cm_unit_drift src/deploy conf/installed-units.sha256').code).toBe(0)
	})

	it('names the unit that changed, and only that one', () => {
		writeStamp()
		editUnit('capmetro-update.timer', 'OnCalendar=*-*-* 00,06,12,18:20:00\n')
		const r = sh('cm_unit_drift src/deploy conf/installed-units.sha256')
		expect(r.code).toBe(1)
		expect(r.stdout.trim().split('\n')).toEqual([ 'capmetro-update.timer' ])
	})

	it('names several when several changed', () => {
		writeStamp()
		editUnit('capmetro-update.timer')
		editUnit('capmetro-generate.service')
		const r = sh('cm_unit_drift src/deploy conf/installed-units.sha256')
		expect(r.code).toBe(1)
		expect(r.stdout.trim().split('\n').sort())
			.toEqual([ 'capmetro-generate.service', 'capmetro-update.timer' ])
	})

	/*
	 * A unit that disappears is as much of a change as one that was edited, and recording it
	 * as `missing` rather than omitting the line is what keeps the two fingerprints from
	 * matching by omission.
	 */
	it('treats a deleted unit as drift rather than as agreement', () => {
		writeStamp()
		rmSync(path.join(work, 'src/deploy/capmetro-generate.timer'))
		const r = sh('cm_unit_drift src/deploy conf/installed-units.sha256')
		expect(r.code).toBe(1)
		expect(r.stdout).toContain('capmetro-generate.timer')
	})

	it('is stable across runs, so an unchanged box never reports drift twice', () => {
		const a = sh('cm_unit_fingerprint src/deploy').stdout
		const b = sh('cm_unit_fingerprint src/deploy').stdout
		expect(a).toBe(b)
		expect(a.trim().split('\n')).toHaveLength(UNITS.length)
	})

	it('puts the stamp in the same place whether or not the dir has a trailing slash', () => {
		expect(sh('cm_unit_stamp_path /var/lib/capmetro').stdout.trim())
			.toBe('/var/lib/capmetro/installed-units.sha256')
		expect(sh('cm_unit_stamp_path /var/lib/capmetro/').stdout.trim())
			.toBe('/var/lib/capmetro/installed-units.sha256')
	})
})

describe('not knowing is its own answer, never mistaken for agreement', () => {
	/*
	 * Distinct from "unchanged", and the distinction is the point: a box installed before this
	 * existed has no stamp, and reading that as agreement would report a clean bill of health
	 * for the exact state this was written to catch.
	 */
	it('separates "no record" (2) from "no change" (0)', () => {
		const r = sh('cm_unit_drift src/deploy conf/nothing-here')
		expect(r.code).toBe(2)
		expect(r.stdout.trim()).toBe('')
	})

	/*
	 * The nastiest version of this bug, caught in review: cm_sha256 used to print the literal
	 * string `no-sha256-tool` when neither hashing tool existed. Every file then hashed to the
	 * same value, every fingerprint compared equal, and drift read as clean forever -- a guard
	 * that answers "fine" precisely when it cannot compute the answer.
	 */
	it('refuses to fingerprint at all when no hashing tool exists, instead of hashing everything alike', () => {
		const noTool = 'cm_sha256() { return 3; }\n'
		const r = sh(`${ noTool }cm_unit_fingerprint src/deploy`)
		expect(r.code).toBe(3)
		expect(r.stdout.trim()).toBe('')
	})

	it('reports "cannot determine" (3) rather than agreement when hashing is unavailable', () => {
		writeStamp()
		const r = sh('cm_sha256() { return 3; }\ncm_unit_drift src/deploy conf/installed-units.sha256')
		expect(r.code).toBe(3)
	})

	/*
	 * Corruption is not drift. An earlier version compared per unit only, so a zero-byte or
	 * truncated stamp gave every unit an empty recorded hash, differed from every real hash,
	 * and was reported as "all four units drifted" -- a confident, specific, wrong accusation
	 * about a box where nothing had drifted.
	 */
	it.each([
		[ 'empty', '' ],
		[ 'truncated', 'abc  capmetro-generate.service\n' ],
		[ 'garbage', 'garbage\n' ],
		[ 'a duplicated entry', 'a  capmetro-generate.service\na  capmetro-generate.service\na  capmetro-generate.timer\na  capmetro-update.service\n' ],
	])('reports a %s stamp as "cannot tell" (2), never as drift', (_label, body) => {
		writeFileSync(path.join(work, 'conf/installed-units.sha256'), body)
		const r = sh('cm_unit_drift src/deploy conf/installed-units.sha256')
		expect(r.code).toBe(2)
		expect(r.stdout.trim()).toBe('')
	})

	/*
	 * Caught by the line-count check rather than the per-unit one: every real unit is present
	 * and correct, but the record carries something extra. The two validations look redundant
	 * and are not -- drop the count and this stamp is accepted as authoritative.
	 */
	it('rejects a stamp carrying an entry for something that is not a unit', () => {
		const good = sh('cm_unit_fingerprint src/deploy').stdout
		writeFileSync(
			path.join(work, 'conf/installed-units.sha256'),
			good + 'deadbeef  capmetro-extra.timer\n',
		)
		expect(sh('cm_unit_drift src/deploy conf/installed-units.sha256').code).toBe(2)
	})

	it('tells the operator a corrupt record is unreadable rather than blaming the units', () => {
		writeFileSync(path.join(work, 'conf/installed-units.sha256'), 'garbage\n')
		const r = checkUnits()
		expect(r.code).toBe(0)
		expect(r.stdout).toMatch(/unreadable/)
		expect(r.stdout).not.toMatch(/have changed since/)
	})

	it('both hashing backends produce the same fingerprint', () => {
		const real = sh('cm_unit_fingerprint src/deploy').stdout
		// Force the shasum branch by hiding sha256sum from `command -v`.
		const forced = sh('command() { if [ "$2" = sha256sum ]; then return 1; fi; builtin command "$@"; }\ncm_unit_fingerprint src/deploy')
		if (forced.code === 0 && forced.stdout.trim()) expect(forced.stdout).toBe(real)
	})
})

describe('check_units, executed for real out of update.sh', () => {
	it('is silent and clean when the stamp matches', () => {
		writeStamp()
		const r = checkUnits()
		expect(r.code).toBe(0)
		expect(r.stdout.trim()).toBe('')
	})

	/*
	 * Returns 0, not a failure. An absent stamp is the expected state of every box installed
	 * before this feature shipped; failing on it would put capmetro-update.service into FAILED
	 * four times a day for a condition that is not drift and that re-running never clears.
	 */
	it('warns but does not fail when there is no stamp', () => {
		const r = checkUnits()
		expect(r.code).toBe(0)
		expect(r.stdout).toMatch(/cannot tell which systemd units are installed/)
		expect(r.stdout).toContain('install.sh')
	})

	it('fails with the dedicated drift code, naming the unit and the remedy', () => {
		writeStamp()
		editUnit('capmetro-update.timer')
		const r = checkUnits()
		expect(r.code).toBe(3)
		expect(r.stdout).toContain('capmetro-update.timer')
		expect(r.stdout).toContain('install.sh')
	})

	/*
	 * 3, never 1. 1 already means the deploy failed and rolled back; collapsing the two would
	 * teach whoever wires up alerting that a red capmetro-update is ambiguous.
	 */
	it('does not reuse the generic failure code', () => {
		writeStamp()
		editUnit('capmetro-generate.timer')
		expect(checkUnits().code).not.toBe(1)
	})

	/* A cron-only box owns none of these units, so the question does not apply to it. */
	it('skips silently when systemd is not running', () => {
		writeStamp()
		editUnit('capmetro-update.timer')
		const r = checkUnits({ SYSTEMD_MARKER: path.join(work, 'no-such-dir') })
		expect(r.code).toBe(0)
		expect(r.stdout.trim()).toBe('')
	})

	it('skips when the checkout predates the helper', () => {
		writeStamp()
		editUnit('capmetro-update.timer')
		rmSync(path.join(work, 'src/deploy/lib/units.sh'))
		expect(checkUnits().code).toBe(0)
	})

	/*
	 * Called from the rollback branch, this used to print "the code and the schedule data
	 * above are up to date" immediately after `git reset --hard` had put the previous commit
	 * back -- a reassurance that was precisely false at the one moment someone would be
	 * reading it closely.
	 */
	it('does not claim the code is up to date when it was just rolled back', () => {
		writeStamp()
		editUnit('capmetro-update.timer')
		const deployed = checkUnits()
		const rolledBack = checkUnits({ context: 'rolled-back' })

		expect(deployed.stdout).toMatch(/code and the schedule data/)
		expect(rolledBack.stdout).not.toMatch(/code and the schedule data/)
		// Both still name the unit and the remedy; only the reassurance differs.
		for (const r of [ deployed, rolledBack ]) {
			expect(r.code).toBe(3)
			expect(r.stdout).toContain('capmetro-update.timer')
			expect(r.stdout).toContain('install.sh')
		}
	})

	/*
	 * check_units used to end its drift computation with a bare `set -e`, which does not
	 * restore the caller's setting -- it forces errexit ON. Invisible inside update.sh, which
	 * always has it on, and fatal to anything that had deliberately turned it off.
	 */
	it('leaves the caller\'s errexit setting alone', () => {
		writeStamp()
		const script = `
export CM_UPDATE_SH_LIB_ONLY=1
export SRC_DIR="${ work }/src" CONF_DIR="${ work }/conf" SYSTEMD_MARKER="${ work }/src"
. "${ UPDATE }"
set +e
check_units >/dev/null 2>&1
case "$-" in *e*) echo LEAKED ;; *) echo CLEAN ;; esac
`
		const out = execFileSync('bash', ['-c', script], { cwd: work, encoding: 'utf8' })
		expect(out.trim()).toBe('CLEAN')
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
		expect(install).toMatch(/cm_unit_fingerprint "\$SRC_DIR\/deploy" > "\$_stamp_tmp"/)
	})

	/*
	 * A plain `>` truncates before the command runs, so a fingerprint that fails would leave a
	 * zero-byte stamp -- which matches nothing, and would report all four units as drifted
	 * forever on a box where nothing drifted.
	 */
	it('writes the stamp atomically rather than truncating it up front', () => {
		expect(install).toMatch(/mktemp/)
		expect(install).toMatch(/mv "\$_stamp_tmp" "\$_stamp"/)
	})

	/* A cron-only box owns no units, so update.sh must ask the same question install.sh did. */
	it('uses the same systemd probe on both sides', () => {
		expect(install).toMatch(/\[ -d \/run\/systemd\/system \] && command -v systemctl/)
		expect(update).toMatch(/command -v "\$\{SYSTEMCTL_BIN:-systemctl\}"/)
	})

	/*
	 * The stamp must live where only root can write it. install.sh chowns STATE_DIR to the
	 * nologin job account, so a stamp there could be forged to switch the check off -- or
	 * replaced with a symlink, turning a root write into an arbitrary-file overwrite.
	 */
	it('keeps the stamp in the root-owned config dir, not the job account\'s state dir', () => {
		expect(install).toMatch(/cm_unit_stamp_path "\$CONF_DIR"/)
		expect(install).not.toMatch(/cm_unit_stamp_path "\$STATE_DIR"/)
		expect(update).toMatch(/cm_unit_stamp_path "\$CONF_DIR"/)
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

	it('does not install units itself, which would restart a timer from inside its own service', () => {
		expect(update).not.toMatch(/systemctl\s+(restart|start|enable|reenable|link|daemon-reload)/)
		expect(update).not.toMatch(/(cp|install|mv|ln)\s+[^\n]*\/etc\/systemd/)
		expect(update).not.toMatch(/>\s*\/etc\/systemd/)
	})

	it('guards the source so a dry-run install without a checkout cannot abort', () => {
		expect(install).toMatch(/if \[ -f "\$SRC_DIR\/deploy\/lib\/units\.sh" \]; then/)
	})
})
