/**
 * A committed systemd unit change has to reach the box, or say why it did not.
 *
 * `deploy/update.sh` pulls code and republishes the client; only `install.sh` writes
 * /etc/systemd/system. So a change to a .timer or .service merged, deployed, and did nothing,
 * with nothing anywhere reporting the difference. deploy/update.sh's header has the incident
 * that found it.
 *
 * The detection cannot diff the installed files against the committed ones: install.sh RENDERS
 * three of the four, substituting @RUN_USER@, @GEN@, @INTERVAL_S@ and friends, so the installed
 * copy never equals the source and a diff reports drift on a current box every time. It
 * fingerprints the sources at install time instead. See deploy/lib/units.sh.
 *
 * EVERYTHING HERE EXECUTES THE REAL SHELL. An earlier version of this file asserted that the
 * string "check_units" appeared inside a slice of update.sh's source, which cannot tell a live
 * call from a commented-out one -- the precise failure mode the feature exists to prevent.
 * update.sh does nothing but define its functions when sourced, so they can be called
 * directly; and the deploy itself is driven end to end against a real git repo with stubbed
 * id/chown/runuser/php, which is the only way to prove the check is actually WIRED IN.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = new URL('../../', import.meta.url).pathname
const LIB = path.join(REPO, 'deploy/lib/units.sh')
const UPDATE = path.join(REPO, 'deploy/update.sh')
/*
 * deploy/lib/units.sh as it stood BEFORE the vhost helpers existed -- the genuine "older
 * tree" an `--src-from` rsync can leave behind.
 *
 * Derived from history, not from the branch position. This was
 * `git merge-base origin/trunk HEAD`, which is the pre-branch commit while the work is on a
 * branch and becomes trunk itself the moment that branch merges -- so the fixture silently
 * inverted into the CURRENT file and the test failed on trunk within minutes of landing.
 * Caught only because the guard below asserts the fixture actually lacks the helper.
 *
 * Asking history "which commit introduced this function, and what did the file look like
 * one commit earlier" is stable under merging, rebasing onto trunk, and further vhost work.
 */
const VHOST_ERA = execFileSync('git',
	['log', '-S', 'cm_write_vhost_stamp', '--format=%H', '--reverse', '--', 'deploy/lib/units.sh'],
	{ cwd: REPO, encoding: 'utf8' }).trim().split('\n')[0]
const BASE = `${ VHOST_ERA }^`

/*
 * The unit list is read out of units.sh, never restated here. units.sh's own reason for
 * existing is that "a second copy of the list would be a third place to disagree", and a
 * hardcoded array in the test would have been exactly that third place.
 */
const UNITS = execFileSync('bash', ['-c', `. "${ LIB }"; printf '%s\\n' $CM_UNIT_FILES`], { encoding: 'utf8' })
	.trim().split('\n')
/* Same rule: read from units.sh, never restated here. */
const VHOSTS = execFileSync('bash', ['-c', `. "${ LIB }"; printf '%s\\n' $CM_VHOST_FILES`], { encoding: 'utf8' })
	.trim().split('\n')

let work

/** A fake checkout: <work>/src/deploy/{unit files, lib/units.sh} plus an empty <work>/conf. */
beforeEach(() => {
	work = mkdtempSync(path.join(tmpdir(), 'cm-units-'))
	mkdirSync(path.join(work, 'src/deploy/lib'), { recursive: true })
	mkdirSync(path.join(work, 'conf'))
	for (const u of UNITS) writeFileSync(path.join(work, 'src/deploy', u), `[Unit]\nDescription=${ u }\n`)
	for (const v of VHOSTS) writeFileSync(path.join(work, 'src/deploy', v), `# ${ v }\nroot @WEBROOT@;\n`)
	writeFileSync(path.join(work, 'src/deploy/lib/units.sh'), readFileSync(LIB))
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

/**
 * Runs a snippet with deploy/lib/units.sh sourced, under `set -euo pipefail` -- the same
 * shell options install.sh and update.sh both set. Testing a library under laxer options
 * than its only two callers use hides exactly the failures errexit causes: a helper whose
 * non-zero return is meant to be caught instead takes the caller down.
 */
function sh(snippet, opts = {}) {
	try {
		const stdout = execFileSync('bash', ['-c', `set -euo pipefail\n. "${ LIB }"\n${ snippet }`], {
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
export SRC_DIR="${ work }/src" CONF_DIR="${ work }/conf"
export SYSTEMD_MARKER="${ env.SYSTEMD_MARKER ?? `${ work }/src` }"
export SYSTEMCTL_BIN="${ env.SYSTEMCTL_BIN ?? 'true' }"
${ env.EXIT_UNIT_DRIFT ? `export EXIT_UNIT_DRIFT=${ env.EXIT_UNIT_DRIFT }` : '' }
. "${ UPDATE }"
# Exactly how the real call sites invoke it. A bare \`check_units\` is STRICTER than
# production: in \`cmd || exit $?\` bash suppresses errexit for the whole left-hand side, so
# a bare call turns an internal failure into a script abort that no real caller would see.
# Testing under stricter options than production over-reports rather than under-reports, but
# it means these results would not model the context check_units actually runs in.
check_units ${ env.context ?? '' } || exit $?
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

/**
 * Calls the REAL check_vhost out of the real update.sh. No systemd overrides: a box on cron
 * still serves the board over HTTP, so this check deliberately does not gate on systemd.
 *
 * `server` puts a stub `nginx` or `apache2ctl` on PATH, because check_vhost decides which
 * remedy to print by probing for them, and the answer has to be controlled rather than
 * inherited: macOS ships /usr/sbin/httpd, so a developer's real PATH silently makes every
 * box "an apache box" and the which-file-drifted test passes for the wrong reason.
 *
 * PATH is therefore the stub dir plus /usr/bin and /bin only. Those hold sha256sum or
 * shasum -- without a hasher cm_sha256 cannot answer, the check correctly takes its
 * cannot-tell branch, and the test proves nothing while looking green -- and they do NOT
 * hold /usr/sbin, where both nginx and apache2ctl/httpd live on the platforms this runs on.
 */
function checkVhost({ server = null, lib = null, before = null, after = null, gitStub = null, context = '' } = {}) {
	const bin = path.join(work, 'stubbin')
	mkdirSync(bin, { recursive: true })
	for (const name of ['nginx', 'apache2ctl', 'httpd']) {
		rmSync(path.join(bin, name), { force: true })
	}
	if (server) {
		writeFileSync(path.join(bin, server), '#!/bin/sh\nexit 0\n')
		execFileSync('chmod', ['+x', path.join(bin, server)])
	}
	if (lib !== null) writeFileSync(path.join(work, 'src/deploy/lib/units.sh'), lib)
	rmSync(path.join(bin, 'git'), { force: true })
	if (gitStub) {
		writeFileSync(path.join(bin, 'git'), gitStub)
		execFileSync('chmod', ['+x', path.join(bin, 'git')])
	}
	const script = `
set -euo pipefail
export SRC_DIR="${ work }/src" CONF_DIR="${ work }/conf" WEBROOT="${ work }/www"
export PATH="${ bin }:/usr/bin:/bin"
${ before ? `BEFORE="${ before }"` : '' }
${ after ? `AFTER="${ after }"` : '' }
. "${ UPDATE }"
# BARE, exactly as the four real call sites invoke it. Writing it as
# check_vhost || exit STATUS would be WRONG here and would quietly neuter these
# tests: bash suppresses errexit for the entire left-hand side of a || list, so
# an abort inside the function -- the precise failure mode of a pipeline under
# pipefail -- cannot happen in that form. Verified at a shell: with the
# pipe-into-while restored, a bare call exits 128 and never reaches the
# sentinel, while the || form survives and prints it. The same trap is
# documented for check_units above.
check_vhost ${ context }
echo "EXIT_UNIT_DRIFT_AFTER=\${EXIT_UNIT_DRIFT}"
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
const writeVhostStamp = () => sh('cm_vhost_fingerprint src/deploy > conf/installed-vhost.sha256')
const editVhost = (v, body = 'changed\n') => writeFileSync(path.join(work, 'src/deploy', v), body)
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

	/*
	 * The well-formed-line count alone would accept this: the junk line does not match the
	 * pattern, so it is not counted, and the four real entries satisfy the tally. Only
	 * checking the TOTAL line count as well catches it.
	 */
	it('rejects a stamp with the right entries plus unparseable junk', () => {
		const good = sh('cm_unit_fingerprint src/deploy').stdout
		writeFileSync(path.join(work, 'conf/installed-units.sha256'), good + 'not a fingerprint line\n')
		expect(sh('cm_unit_drift src/deploy conf/installed-units.sha256').code).toBe(2)
	})

	/*
	 * A stamp can be the right shape and still be nonsense. The pattern used to accept any
	 * non-space token as a hash, so a record whose hash fields were arbitrary text passed
	 * validation, compared unequal to every real hash, and was reported as CONFIRMED drift --
	 * corruption laundered into a specific accusation. Only the two things install.sh actually
	 * writes count: a sha256 digest, or the literal `missing`.
	 */
	it.each([
		[ 'arbitrary text', 'whoops' ],
		[ 'a truncated digest', 'abc123' ],
		[ 'an uppercase digest', 'A'.repeat(64) ],
	])('rejects a shape-valid stamp whose hash fields are %s', (_label, fake) => {
		const good = sh('cm_unit_fingerprint src/deploy').stdout
		writeFileSync(
			path.join(work, 'conf/installed-units.sha256'),
			good.replace(/^\S+/gm, fake),
		)
		expect(sh('cm_unit_drift src/deploy conf/installed-units.sha256').code).toBe(2)
	})

	it('still accepts the literal "missing" that a deleted unit records', () => {
		rmSync(path.join(work, 'src/deploy/capmetro-update.timer'))
		writeStamp()
		expect(sh('cm_unit_drift src/deploy conf/installed-units.sha256').code).toBe(0)
	})

	it('tells the operator a corrupt record is unreadable rather than blaming the units', () => {
		writeFileSync(path.join(work, 'conf/installed-units.sha256'), 'garbage\n')
		const r = checkUnits()
		expect(r.code).toBe(0)
		expect(r.stdout).toMatch(/unreadable/)
		expect(r.stdout).not.toMatch(/have changed since/)
	})

	/*
	 * Both branches forced, and asserted unconditionally. An earlier version wrapped the
	 * comparison in `if (forced.code === 0 && ...)`, so on a host missing one of the two tools
	 * the test passed having asserted nothing -- a skip that reads as a pass, in the very file
	 * whose subject is a skip that reads as a pass.
	 */
	/*
	 * The hasher's status is captured directly, not read off a pipeline, so "this file could
	 * not be hashed" does not depend on the caller having set pipefail.
	 */
	it('reports an unhashable unit without relying on the caller setting pipefail', () => {
		const r = sh('set +o pipefail\nsha256sum() { return 1; }\nshasum() { return 1; }\ncm_unit_fingerprint src/deploy')
		expect(r.code).not.toBe(0)
		expect(r.stdout.trim()).toBe('')
	})

	it('both hashing backends produce the same fingerprint', () => {
		const viaSha256sum = sh('cm_sha256() { sha256sum "$1" | awk \'{print $1}\'; }\ncm_unit_fingerprint src/deploy')
		const viaShasum = sh('cm_sha256() { shasum -a 256 "$1" | awk \'{print $1}\'; }\ncm_unit_fingerprint src/deploy')

		expect(viaSha256sum.code).toBe(0)
		expect(viaShasum.code).toBe(0)
		expect(viaSha256sum.stdout).toBe(viaShasum.stdout)
		expect(viaSha256sum.stdout.trim()).not.toBe('')
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
	 * The verdict must not be settable from outside. EXIT_UNIT_DRIFT was briefly written as
	 * "keep whatever is already set" -- a repair for a double-source crash that turned the
	 * exit code into an inherited switch, so EXIT_UNIT_DRIFT=0 in the environment made
	 * confirmed drift exit 0. A silent switch that disables the check is the failure this
	 * whole feature exists to end, so it is worth a test rather than a comment.
	 */
	it('ignores EXIT_UNIT_DRIFT arriving from the environment', () => {
		writeStamp()
		editUnit('capmetro-update.timer')
		expect(checkUnits().code).toBe(3)
		expect(checkUnits({ EXIT_UNIT_DRIFT: '0' }).code).toBe(3)
		expect(checkUnits({ EXIT_UNIT_DRIFT: '99' }).code).toBe(3)
	})

	/*
	 * EXIT_UNIT_DRIFT is a plain assignment, so it cannot be inherited -- but check_units
	 * sources a lib out of $SRC_DIR, and that lib could assign the same name. Third variant of
	 * "the verdict is reachable from outside", so the value is snapshotted before the source.
	 */
	it('ignores a sourced lib that tries to redefine the drift exit code', () => {
		const lib = readFileSync(LIB, 'utf8') + '\nEXIT_UNIT_DRIFT=0\n'
		writeStamp()
		writeFileSync(path.join(work, 'src/deploy/lib/units.sh'), lib)
		editUnit('capmetro-update.timer')
		expect(checkUnits().code).toBe(3)
	})

	/*
	 * The systemd overrides stay overridable -- that is what makes this testable off a systemd
	 * box -- but they can point the probe at nothing and make the whole check pass, so they
	 * must not be able to do it quietly.
	 */
	it('says on stderr when the systemd probe has been pointed somewhere else', () => {
		const r = sh('cm_systemd_live || true', {
			env: { ...process.env, SYSTEMD_MARKER: path.join(work, 'nope'), SYSTEMCTL_BIN: 'true' },
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		})
		// sh() returns stdout on success; read stderr directly for this one.
		const err = execFileSync('bash', ['-c',
			`set -euo pipefail\n. "${ LIB }"\ncm_systemd_live 2>&1 >/dev/null || true`], {
			cwd: work, encoding: 'utf8',
			env: { ...process.env, SYSTEMD_MARKER: path.join(work, 'nope'), SYSTEMCTL_BIN: 'true' },
		})
		expect(err).toMatch(/overridden/)
		expect(r.code).toBe(0)
	})

	/*
	 * The `*)` arm exists for a status outside cm_unit_drift's contract. Nothing produces one
	 * today, which is exactly why it needs a test: it is the arm that stops an unknown status
	 * falling through into the drift branch, and an untested defence is a guess.
	 */
	it('treats a status outside the contract as "not checked", not as drift', () => {
		const lib = readFileSync(LIB, 'utf8')
			.replace('cm_unit_drift() {', 'cm_unit_drift() { return 9;')
		writeStamp()
		writeFileSync(path.join(work, 'src/deploy/lib/units.sh'), lib)
		const r = checkUnits()

		expect(r.code).toBe(0)
		expect(r.stdout).toMatch(/unexpected status \(9\)/)
		expect(r.stdout).not.toMatch(/have changed since install\.sh last ran/)
	})

	/*
	 * The lib is read out of $SRC_DIR, and on the rollback path `git reset --hard` has already
	 * replaced the checkout underneath the running script -- so the units.sh on disk is from
	 * BEFORE while the update.sh reading it is from AFTER. Two commits on this branch ship a
	 * units.sh with neither cm_systemd_live nor the CM_DRIFT_* constants.
	 */
	it('says it did not check, rather than passing silently, on a lib that predates it', () => {
		const old = execFileSync('git', [ 'show', '074ed16:deploy/lib/units.sh' ],
			{ cwd: REPO, encoding: 'utf8' })
		writeStamp()
		writeFileSync(path.join(work, 'src/deploy/lib/units.sh'), old)
		const r = checkUnits()

		expect(r.code).toBe(0)
		expect(r.stdout).toMatch(/predates this version of update\.sh/)
		expect(r.stdout).toMatch(/NOT checked/)
	})

	/*
	 * One case per name, because the loop is a list and a list can lose an entry silently. The
	 * only historical lib that actually exists is missing all three at once, which would pass
	 * even if two of the three checks were deleted.
	 */
	it.each([ 'cm_systemd_live', 'cm_unit_drift', 'cm_unit_stamp_path' ])(
		'notices a lib missing only %s', (fn) => {
			const lib = readFileSync(LIB, 'utf8').replace(`${ fn }() {`, `${ fn }_disabled() {`)
			writeStamp()
			writeFileSync(path.join(work, 'src/deploy/lib/units.sh'), lib)
			const r = checkUnits()

			expect(r.code).toBe(0)
			expect(r.stdout).toContain(`no ${ fn }`)
			expect(r.stdout).toMatch(/NOT checked/)
		})

	/*
	 * And a lib that has the functions but not the constants: the case arms default so the
	 * script cannot die on an unbound variable, and whatever cm_unit_drift does in that state
	 * must not become a confident answer.
	 */
	it('survives a lib whose constants are missing without aborting or accusing', () => {
		const lib = readFileSync(LIB, 'utf8')
			.replace(/^CM_DRIFT_(SAME|FOUND|NO_STAMP|NO_TOOL)=\d\n/gm, '')
		writeStamp()
		writeFileSync(path.join(work, 'src/deploy/lib/units.sh'), lib)
		editUnit('capmetro-update.timer')
		const r = checkUnits()

		expect(r.code).not.toBe(1)
		expect(r.stdout).not.toMatch(/unbound variable[\s\S]*have changed since/)
	})

	/*
	 * The invariant behind both: a drift report with no unit named is not an answer. It has
	 * come apart twice by different routes, so it is guarded at the point of reporting rather
	 * than trusted to the contract upstream.
	 */
	it('never accuses without naming a unit', () => {
		const lib = readFileSync(LIB, 'utf8')
			.replace('cm_unit_drift() {', 'cm_unit_drift() { return 1;')
		writeStamp()
		writeFileSync(path.join(work, 'src/deploy/lib/units.sh'), lib)
		const r = checkUnits()

		expect(r.code).toBe(0)
		expect(r.stdout).toMatch(/named no unit/)
		expect(r.stdout).not.toMatch(/have changed since install\.sh last ran/)
	})

	/*
	 * check_units used to end its drift computation with a bare `set -e`, which does not
	 * restore the caller's setting -- it forces errexit ON. Invisible inside update.sh, which
	 * always has it on, and fatal to anything that had deliberately turned it off.
	 */
	it('leaves the caller\'s errexit setting alone', () => {
		writeStamp()
		const script = `
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

/**
 * The write side, executed. install.sh cannot be run in this suite -- it needs root, a clone
 * and systemctl -- so for three review rounds the stamp write was asserted only by matching
 * install.sh's own source text, which is the technique this file's header rejects. The
 * sequence now lives in units.sh as cm_write_stamp and install.sh calls it, so the thing that
 * actually writes the record is the thing under test.
 */
describe('writing the record', () => {
	it('produces a stamp that immediately reads back as agreement', () => {
		expect(sh('cm_write_stamp src/deploy conf').code).toBe(0)
		expect(sh('cm_unit_drift src/deploy conf/installed-units.sha256').code).toBe(0)
	})

	it('writes it 0644 and leaves no temp file behind', () => {
		sh('cm_write_stamp src/deploy conf')
		const mode = execFileSync('bash', ['-c',
			`ls -l "${ work }/conf/installed-units.sha256" | cut -c1-10`], { encoding: 'utf8' }).trim()
		expect(mode).toBe('-rw-r--r--')
		expect(readdirSync(path.join(work, 'conf'))).toEqual([ 'installed-units.sha256' ])
	})

	/*
	 * The reason it is not a plain `>` redirect: that truncates the target before the command
	 * runs, so a failing fingerprint would leave a zero-byte record -- and a zero-byte record
	 * matches nothing, reporting all four units as drifted on a box where nothing drifted.
	 */
	it('leaves an existing record untouched when the fingerprint fails', () => {
		sh('cm_write_stamp src/deploy conf')
		const before = readFileSync(path.join(work, 'conf/installed-units.sha256'), 'utf8')

		const r = sh('cm_sha256() { return 3; }\ncm_write_stamp src/deploy conf')
		expect(r.code).not.toBe(0)
		expect(readFileSync(path.join(work, 'conf/installed-units.sha256'), 'utf8')).toBe(before)
		expect(readdirSync(path.join(work, 'conf'))).toEqual([ 'installed-units.sha256' ])
	})

	/*
	 * The chmod and the mv ARE the write, so their status is the answer. Returning 0 after them
	 * unconditionally reported a successful record when the rename had failed: no stamp on
	 * disk, a temp file left behind, and an install that said it was fine.
	 */
	it('reports failure when the rename fails, and leaves no temp file behind', () => {
		const r = sh('mv() { return 1; }\ncm_write_stamp src/deploy conf')
		expect(r.code).not.toBe(0)
		expect(readdirSync(path.join(work, 'conf'))).toEqual([])
	})

	it('reports failure when the mode cannot be set', () => {
		const r = sh('chmod() { return 1; }\ncm_write_stamp src/deploy conf')
		expect(r.code).not.toBe(0)
		expect(readdirSync(path.join(work, 'conf'))).toEqual([])
	})

	it('reports failure when the temp file cannot be created at all', () => {
		const r = sh('cm_write_stamp src/deploy conf/does-not-exist')
		expect(r.code).not.toBe(0)
	})

	it('reports failure rather than writing an empty record when there was none', () => {
		const r = sh('cm_sha256() { return 3; }\ncm_write_stamp src/deploy conf')
		expect(r.code).not.toBe(0)
		expect(readdirSync(path.join(work, 'conf'))).toEqual([])
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

	it('install.sh writes the record through the shared helper', () => {
		expect(install).toMatch(/cm_write_stamp "\$SRC_DIR\/deploy" "\$CONF_DIR"/)
	})

	/* A cron-only box owns no units, so update.sh must ask the same question install.sh did. */
	/*
	 * Asserted by behavior, not by matching the probe's text in two files. It used to be
	 * written out twice and the two copies had already diverged once -- install.sh asked for
	 * the directory AND systemctl, update.sh only the directory -- which is the same
	 * two-places-disagreeing failure units.sh exists to prevent, one level down.
	 */
	it('uses one shared systemd probe, and it answers', () => {
		const probe = (marker, bin) => sh('cm_systemd_live && echo live || echo dead', {
			env: { ...process.env, SYSTEMD_MARKER: marker, SYSTEMCTL_BIN: bin },
		}).stdout.trim()

		expect(probe(work, 'true')).toBe('live')
		expect(probe(path.join(work, 'nope'), 'true')).toBe('dead')
		expect(probe(work, 'definitely-not-a-real-binary')).toBe('dead')

		// And both callers go through it rather than keeping a copy.
		expect(update).toMatch(/cm_systemd_live \|\| return 0/)
		expect(install).toMatch(/cm_systemd_live; then/)
	})

	/*
	 * The stamp must live where only root can write it. install.sh chowns STATE_DIR to the
	 * nologin job account, so a stamp there could be forged to switch the check off -- or
	 * replaced with a symlink, turning a root write into an arbitrary-file overwrite.
	 */
	it('keeps the stamp in the root-owned config dir, not the job account\'s state dir', () => {
		expect(install).toMatch(/cm_write_stamp "\$SRC_DIR\/deploy" "\$CONF_DIR"/)
		expect(install).not.toMatch(/cm_write_stamp .*\$STATE_DIR/)
		expect(update).toMatch(/cm_unit_stamp_path "\$CONF_DIR"/)
		// install.sh hands the job account WEBROOT and STATE_DIR; CONF_DIR must not be in that list.
		expect(install).toMatch(/chown -R "\$RUN_USER:\$RUN_USER" "\$WEBROOT" "\$STATE_DIR"/)
		expect(install).toMatch(/chown root:root "\$CONF_DIR"/)
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
		// `| tee /etc/systemd/...` is a shape this repo actually writes elsewhere (install.sh
		// uses `| sudo tee` for the vhosts), so it is the plausible way this guard gets evaded.
		expect(update).not.toMatch(/tee\s+[^\n]*\/etc\/systemd/)
	})

	it('guards the source so a dry-run install without a checkout cannot abort', () => {
		expect(install).toMatch(/if \[ -f "\$SRC_DIR\/deploy\/lib\/units\.sh" \]; then/)
	})
})

/**
 * The deploy itself, run end to end.
 *
 * Round 1 replaced this file's regex-over-source assertions with real execution of
 * `check_units` -- and in doing so deleted the only thing pinning the three CALL SITES.
 * The function was proven correct while being unreachable: all three calls could have been
 * deleted and every test still passed. That is the same bug as the one the feature exists to
 * catch, reintroduced one level up, so it is worth the harness.
 *
 * update.sh is run for real against a real git repo. Only the things a test genuinely cannot
 * do are stubbed on PATH: `id` (the script refuses to run as non-root), `chown` (needs root),
 * `runuser` (needs root), and `php` (the generator, whose success or failure selects the
 * branch under test). git, rsync and the whole of update.sh's own logic are the real thing.
 */
describe('the drift check is actually wired into the deploy', () => {
	const git = (cwd, ...args) => execFileSync('git', [
		'-c', 'user.email=t@example.com', '-c', 'user.name=t',
		'-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=trunk',
		...args,
	], { cwd, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] })

	/** Builds <work>/origin (a repo) and <work>/src (a clone of it), plus PATH stubs. */
	function buildDeployFixture() {
		const origin = path.join(work, 'origin')
		const src = path.join(work, 'src')
		const bin = path.join(work, 'bin')
		rmSync(src, { recursive: true, force: true })
		mkdirSync(path.join(origin, 'deploy/lib'), { recursive: true })
		mkdirSync(path.join(origin, 'runtime'), { recursive: true })
		mkdirSync(path.join(origin, 'client'), { recursive: true })
		mkdirSync(bin, { recursive: true })
		mkdirSync(path.join(work, 'webroot'), { recursive: true })

		for (const u of UNITS) writeFileSync(path.join(origin, 'deploy', u), `[Unit]\nDescription=${ u }\n`)
		writeFileSync(path.join(origin, 'deploy/lib/units.sh'), readFileSync(LIB))
		writeFileSync(path.join(origin, 'runtime/generate-api.php'), '<?php\n')
		writeFileSync(path.join(origin, 'client/index.html'), '<!doctype html>\n')

		git(origin, 'init', '-q')
		git(origin, 'add', '-A')
		git(origin, 'commit', '-qm', 'base')
		git(work, 'clone', '-q', origin, src)

		// `php <script> ...` fails when the checkout carries the BOOM marker, which is how a
		// test selects the rollback branch: the new commit adds it, the old commit has not got it.
		const stub = (name, body) => {
			const p = path.join(bin, name)
			writeFileSync(p, `#!/bin/sh\n${ body }\n`, { mode: 0o755 })
		}
		stub('id', 'echo 0')
		stub('chown', 'exit 0')
		/*
		 * Asserts the exact shape `as_user` promises -- `runuser -u <user> -- <cmd>` -- and dies
		 * loudly on anything else. A tolerant stub (`shift 2; [ "$1" = "--" ] && shift`) accepted
		 * both the right and the wrong invocation, so dropping the `--` separator from as_user
		 * left the whole suite green. A stub that forgives is a test that does not test.
		 */
		stub('runuser', [
			'[ "$1" = "-u" ] || { echo "runuser stub: expected -u, got $1" >&2; exit 99; }',
			'[ "$3" = "--" ] || { echo "runuser stub: expected -- separator, got $3" >&2; exit 99; }',
			'shift 3',
			'exec "$@"',
		].join('\n'))
		stub('php', 'd=$(dirname "$1"); [ -f "$d/BOOM" ] && exit 1; exit 0')
		return { origin, src, bin }
	}

	/** Adds a commit to origin so update.sh has something to fast-forward to. */
	function commitUpstream(origin, { poison = false } = {}) {
		writeFileSync(path.join(origin, 'client/index.html'), '<!doctype html><p>new\n')
		if (poison) writeFileSync(path.join(origin, 'runtime/BOOM'), 'x\n')
		git(origin, 'add', '-A')
		git(origin, 'commit', '-qm', 'upstream change')
	}

	/** Runs update.sh the way the timer does. Returns { code, out }. */
	function runUpdate({ bin, src }) {
		const script = `
export PATH="${ bin }:$PATH"
export SRC_DIR="${ src }" WEBROOT="${ work }/webroot" CONF_DIR="${ work }/conf"
export SYSTEMD_MARKER="${ src }" SYSTEMCTL_BIN=true RUN_USER="$(whoami)" BRANCH=trunk
exec bash "${ UPDATE }"
`
		try {
			const out = execFileSync('bash', ['-c', script], {
				cwd: work, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ],
			})
			return { code: 0, out }
		} catch (e) {
			return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }
		}
	}

	const stampFrom = (src) =>
		sh(`cm_unit_fingerprint "${ src }/deploy" > conf/installed-units.sha256`)

	it('deploys cleanly and exits 0 when the units match', () => {
		const fx = buildDeployFixture()
		commitUpstream(fx.origin)
		stampFrom(fx.src)
		const r = runUpdate(fx)
		expect(r.code).toBe(0)
		expect(r.out).toMatch(/generator clean/)
	})

	/* Call site 1: the path taken on the vast majority of runs, where nothing was pulled. */
	it('reports drift on the nothing-to-do path', () => {
		const fx = buildDeployFixture()
		stampFrom(fx.src)
		writeFileSync(path.join(fx.src, 'deploy/capmetro-update.timer'), 'changed\n')
		const r = runUpdate(fx)
		expect(r.out).toMatch(/already at .*nothing to do/)
		expect(r.code).toBe(3)
		expect(r.out).toContain('capmetro-update.timer')
	})

	/* Call site 2: after a real pull whose generator run succeeded. */
	it('reports drift after a successful deploy, without undoing the deploy', () => {
		const fx = buildDeployFixture()
		commitUpstream(fx.origin)
		stampFrom(fx.src)
		writeFileSync(path.join(fx.src, 'deploy/capmetro-generate.timer'), 'changed\n')
		const r = runUpdate(fx)
		expect(r.code).toBe(3)
		expect(r.out).toMatch(/generator clean/)
		expect(r.out).toContain('capmetro-generate.timer')
		// The deploy really happened: the client was republished before the check ran.
		expect(readFileSync(path.join(work, 'webroot/index.html'), 'utf8')).toContain('new')
	})

	/*
	 * Call site 3: a stale unit must never be mistaken for the reason a rollback happened.
	 *
	 * The drift is put in the STAMP rather than in the working tree, because `git reset --hard`
	 * on this path discards working-tree edits -- so a unit edited in the checkout genuinely
	 * stops being drift once the rollback lands. What survives a rollback is a stamp that does
	 * not describe the commit the box is now back on, which is the real shape of this case.
	 */
	it('keeps exit 1 on the rollback path even when the units have also drifted', () => {
		const fx = buildDeployFixture()
		commitUpstream(fx.origin, { poison: true })
		stampFrom(fx.src)
		const stampPath = path.join(work, 'conf/installed-units.sha256')
		writeFileSync(stampPath, readFileSync(stampPath, 'utf8').replace(
			/^\S+(  capmetro-update\.service)$/m,
			'0'.repeat(64) + '$1',
		))
		const r = runUpdate(fx)
		expect(r.code).toBe(1)
		expect(r.out).toMatch(/rolled back/)
		// Reported, but not credited with the failure, and not claiming the code is current.
		expect(r.out).toContain('capmetro-update.service')
		expect(r.out).not.toMatch(/code and the schedule data/)
	})

	/*
	 * The last path: neither the new commit nor the rolled-back one can generate. The board is
	 * already in trouble, so the drift line is a footnote -- but it must not be the headline,
	 * and it must not change the exit code.
	 */
	it('still reports drift, without changing the verdict, when both commits fail to generate', () => {
		const fx = buildDeployFixture()
		writeFileSync(path.join(fx.origin, 'runtime/BOOM'), 'x\n')
		git(fx.origin, 'add', '-A')
		git(fx.origin, 'commit', '-qm', 'poison the base too')
		execFileSync('git', [ '-C', fx.src, 'pull', '-q' ], { encoding: 'utf8' })
		commitUpstream(fx.origin)
		stampFrom(fx.src)
		const stampPath = path.join(work, 'conf/installed-units.sha256')
		writeFileSync(stampPath, readFileSync(stampPath, 'utf8').replace(
			/^\S+(  capmetro-update\.timer)$/m, '0'.repeat(64) + '$1',
		))
		const r = runUpdate(fx)

		expect(r.code).toBe(1)
		expect(r.out).toMatch(/ALSO fails to generate/)
		expect(r.out).toContain('capmetro-update.timer')
	})

	it('exits 0 with no drift complaint when everything agrees', () => {
		const fx = buildDeployFixture()
		stampFrom(fx.src)
		const r = runUpdate(fx)
		expect(r.code).toBe(0)
		expect(r.out).not.toMatch(/have changed since/)
	})
})

/**
 * install.sh, executed.
 *
 * Four review rounds ran with install.sh asserted only by pattern-matching its own source
 * text, and that fragility was demonstrated live: two behavior-preserving refactors during
 * the review broke three of those assertions while the behavior they described was fine.
 *
 * It cannot be run for real here -- it clones, writes /etc/systemd, and calls systemctl -- but
 * `--dry-run` walks the same argument parsing, the same preconditions, and the same branch
 * structure while printing instead of acting. With `id` stubbed to 0 that is reachable, and it
 * is enough to prove the script parses, gets to the end, and does not abort on the paths this
 * PR added.
 */
describe('install.sh --dry-run', () => {
	const INSTALL = path.join(REPO, 'deploy/install.sh')
	const install = readFileSync(INSTALL, 'utf8')

	/*
	 * `server` stubs the web server binary the vhost branch keys off. Without it the branch
	 * is chosen by what happens to be installed on the machine running the suite -- apache
	 * on a Mac, nginx on the box, neither in a slim container -- so the same assertions
	 * covered a different code path per developer, and on a machine with neither they would
	 * have been asserting against a one-line warning.
	 */
	/*
	 * `isolate` is how the no-web-server branch gets tested at all. Prepending a stub
	 * directory cannot make a binary ABSENT, and a developer machine has a real
	 * /usr/sbin/httpd -- macOS ships one -- so `command -v httpd` succeeded and
	 * install.sh took the apache branch no matter what the test stubbed. PATH is
	 * replaced outright instead, with only what a dry run genuinely executes symlinked
	 * in: bash and sed to run the script at all, php for the version check, tr for the
	 * domain normalization, plus dummy rsync and git so the prerequisite check does
	 * not die on their absence. Resolved
	 * from the environment rather than hardcoded, so it does not assume this machine's
	 * layout.
	 */
	function runInstall(extraArgs = [], { server = null, isolate = false, env = {} } = {}) {
		const bin = path.join(work, 'ibin')
		mkdirSync(bin, { recursive: true })
		writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 })
		if (server) writeFileSync(path.join(bin, server), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
		if (isolate) {
			for (const tool of [ 'bash', 'sed', 'php', 'tr' ]) {
				const real = spawnSync('sh', [ '-c', `command -v ${ tool }` ], { encoding: 'utf8' })
				expect(real.status, `${ tool } is not on PATH, so this test cannot run`).toBe(0)
				/*
				 * Idempotent, like the mkdirSync and writeFileSync either side of it.
				 * symlinkSync alone throws EEXIST on a second isolate run inside one
				 * `it`, which nothing does today -- and that asymmetry is exactly the
				 * kind of thing that bites whoever adds the second call.
				 */
				const link = path.join(bin, tool)
				if (!existsSync(link)) symlinkSync(real.stdout.trim(), link)
			}
			for (const tool of [ 'rsync', 'git' ]) {
				writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
			}
		}
		const script = `
export PATH="${ bin }${ isolate ? '' : ':$PATH' }"
${ Object.entries(env).map(([ k, v ]) => `export ${ k }='${ v }'`).join('\n') }
bash "${ INSTALL }" --dry-run --src "${ work }/src" --webroot "${ work }/webroot" \
  ${ extraArgs.map((a) => `'${ a }'`).join(' ') }
`
		/*
		 * stderr is merged on the SUCCESS path too, not only in the catch. execFileSync
		 * returns stdout ALONE, and install.sh's warn() is `printf ... >&2` -- as is bash's
		 * own "command not found". So every `.not.toMatch(...)` against a passing dry run
		 * was checking a string that could not contain what it forbade. Proven by injecting
		 * both forbidden strings and two real command-not-founds into the dry-run arm:
		 * 84 of 84 still passed.
		 */
		const r = spawnSync('bash', ['-c', script], { cwd: work, encoding: 'utf8' })
		return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') }
	}

	it('runs to completion without aborting', () => {
		const r = runInstall()
		expect(r.code).toBe(0)
	})

	/*
	 * The guard round 2 added. Under --dry-run the clone only prints, so on a fresh box
	 * deploy/lib/units.sh does not exist -- and an unguarded `.` of it would abort the whole
	 * dry run under `set -euo pipefail`. This is the case that guard exists for.
	 */
	it('survives a source tree with no units.sh, which is the dry-run case', () => {
		rmSync(path.join(work, 'src/deploy/lib/units.sh'))
		const r = runInstall()
		expect(r.code).toBe(0)
		expect(r.out).not.toMatch(/cm_unit_(stamp_path|fingerprint|write_stamp): command not found/)
	})

	/*
	 * `php -m | grep -qix json` is a race under `set -o pipefail`: grep -q exits on the match,
	 * php takes SIGPIPE, and pipefail promotes its status -- so the check reports an extension
	 * MISSING exactly when it is present. It took install.sh down at the prerequisite check on
	 * this machine every time, which is how four rounds of "run install.sh to fix the drift"
	 * advice would have played out in practice.
	 */
	it('does not ask php about its extensions through a pipe', () => {
		// Directive lines only -- the comment above the fix quotes the broken pattern on purpose.
		const code = install.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
		expect(code).not.toMatch(/php -m\s*\|\s*grep/)
		expect(code).toMatch(/extension_loaded/)
	})

	/*
	 * NO --domain, NO PASTE-READY COMMAND.
	 *
	 * This printed `your.domain` as the substitution when --domain was omitted, in a block
	 * formatted for copying. On 2026-09-21 it was copied: the installed vhost got
	 * `server_name your.domain;`, `nginx -t` reported success -- nginx validates neither
	 * that a server_name resolves nor that any block matches -- the reload was clean, and
	 * every request for the real host fell to default_server. That box also serves
	 * WordPress, so bus.dillo.dev answered with a database error page and read like a DNS
	 * fault. Every signal a deploy has was green throughout.
	 */
	it('prints no vhost command at all without --domain', () => {
		const r = runInstall()
		expect(r.code).toBe(0)
		expect(r.out, 'a placeholder hostname was offered as a default').not.toMatch(/your\.domain/)
		expect(r.out, 'a sed was printed with no real domain to put in it')
			.not.toMatch(/s\/@DOMAIN@\//)
		expect(r.out, 'a server_name command was printed').not.toMatch(/sites-available\/capmetro/)
		expect(r.out, 'it should say what to re-run with').toMatch(/--domain/)
	})

	it('names the real domain in the sed when it is given one', () => {
		/* Server stubbed, like its siblings. Without it this test picks its branch
		 * from whatever the machine happens to have installed -- and on a box with
		 * neither nginx nor apache, install.sh prints "no nginx or apache found"
		 * and the sed line never appears at all, so the assertion below fails for
		 * a reason that has nothing to do with the code. */
		const r = runInstall(['--domain', 'bus.dillo.dev'], { server: 'nginx' })
		expect(r.code).toBe(0)
		expect(r.out).toMatch(/s\/@DOMAIN@\/bus\.dillo\.dev\/g/)
		expect(r.out).not.toMatch(/your\.domain/)
	})

	/*
	 * `--domain --dry-run` -- the refusal reached by the other door.
	 *
	 * Every one of these flags did `FLAG="$2"; shift 2`, which takes whatever follows,
	 * including the next flag. So `--domain --dry-run` set DOMAIN to the string
	 * `--dry-run`, left DRY_RUN at 0, and went on to a REAL install: run locally with
	 * only `id` stubbed, the unfixed script got as far as `creating /var/lib/capmetro`
	 * and stopped there only because the probe was not actually root. On the box it
	 * would have written `server_name --dry-run;` -- the same outage the placeholder
	 * refusal exists to prevent, except the operator believed they had asked for a
	 * dry run and had no reason to check anything afterwards.
	 *
	 * The assertion below can only prove the refusal, not the real install behind it:
	 * runInstall injects --dry-run ahead of extraArgs, and a run without it would
	 * write to /var/lib and /etc. Exit 2 before the first prerequisite line is the
	 * observable half, and it is the half the fix owns.
	 */
	it.each([
		[ '--domain' ], [ '--repo' ], [ '--branch' ], [ '--webroot' ],
		[ '--src' ], [ '--user' ], [ '--interval' ], [ '--src-from' ],
	])('refuses %s when the next argument is another option', (flag) => {
		const r = runInstall([ flag, '--dry-run' ])
		expect(r.code, 'an option-shaped value was accepted as the value').toBe(2)
		expect(r.out).toMatch(new RegExp(`\\${ flag } needs a value`))
		/* Before anything is inspected, let alone written. */
		expect(r.out, 'it got as far as the prerequisite checks')
			.not.toMatch(/checking prerequisites/)
	})

	it.each([ [ '--domain' ], [ '--webroot' ], [ '--interval' ] ])(
		'refuses %s with nothing after it', (flag) => {
			const r = runInstall([ flag ])
			expect(r.code).toBe(2)
			expect(r.out).toMatch(new RegExp(`\\${ flag } needs a value`))
		},
	)

	/*
	 * Names that ARE well-formed hostnames, pass the letters-digits-dots-hyphens check,
	 * render a vhost nginx accepts, and still match no request the board will ever get.
	 * `your.domain` is the one that caused the outage; the rest are the same shape.
	 *
	 * The reserved names matter because they are the ones an operator pastes: the usage
	 * line in this very script said `--domain bus.example.com`, so the most likely wrong
	 * value was the one the documentation handed them. That example now names the real
	 * host, and this refuses the class.
	 */
	it.each([
		[ 'your.domain' ], [ 'domain.tld' ], [ 'example.com' ], [ 'bus.example.com' ],
		[ 'board.example.net' ], [ 'x.invalid' ], [ 'y.test' ], [ 'host.localhost' ],
		[ '203.0.113.5' ], [ '1.2.3' ], [ 'localhost' ], [ 'nginx' ],
	])('refuses %s, which nginx would accept and no browser would reach', (domain) => {
		const r = runInstall([ '--domain', domain ], { server: 'nginx' })
		expect(r.code, `${ domain } was accepted as a hostname`).toBe(1)
		expect(r.out, 'it rendered a sed with an unusable hostname in it')
			.not.toMatch(/s\/@DOMAIN@\//)
		expect(r.out, 'it printed a vhost install command anyway')
			.not.toMatch(/sites-available\/capmetro/)
	})

	/*
	 * A domain is not the same question as a vhost having been printed. The no-server
	 * arm has a domain, prints nothing installable, and was still reaching the write --
	 * recording the committed vhosts as installed on a box that had been given no way
	 * to install them. Narrower than the no-domain case, since a re-run once nginx is
	 * there re-stamps, but it is the same false "clean" while it lasts.
	 */
	it('records no vhost fingerprint when no web server was found either', () => {
		const r = runInstall([ '--domain', 'bus.dillo.dev' ], { isolate: true })
		expect(r.code).toBe(0)
		expect(r.out, 'the no-server branch was not the one taken')
			.toMatch(/no nginx or apache found/)
		expect(r.out, 'it stamped the vhosts as installed having printed none')
			.not.toMatch(/would run: record the vhost drift fingerprint/)
		expect(r.out).toMatch(/not recording a vhost drift fingerprint/)
	})

	/* And the summary cannot point at a vhost it never printed, or name a plugin. */
	it('sends a box with no web server to install one first', () => {
		const r = runInstall([ '--domain', 'bus.dillo.dev' ], { isolate: true })
		expect(r.out).toMatch(/1\. install nginx or apache, then re-run/)
		expect(r.out, 'it named a certbot plugin with no web server to configure')
			.not.toMatch(/certbot --(nginx|apache)/)
		expect(r.out, 'it pointed at a vhost that was never printed')
			.not.toMatch(/install the vhost printed above/)
		/*
		 * And step 3, for the same reason: with nothing listening, that curl cannot
		 * answer, and its failure would say nothing about whether the install worked.
		 */
		expect(r.out, 'it told them to curl a board with no web server to serve it')
			.not.toMatch(/curl -sf https:\/\//)
	})

	/*
	 * The false-positive direction, which is not the harmless one: a refusal blocks a
	 * real install and the operator's only workaround is editing this script.
	 *
	 * The refusals were one ordered `case` whose accept arm was `*[!0-9.]*.*` -- a
	 * non-digit BEFORE a dot. A name whose only letters are in the last label has no
	 * such character, so `163.com` (a real registered domain) fell past it to the
	 * single-label arm and was refused by a message telling the operator it needed a
	 * dot, while pointing at a name that has one. Three independent cases now.
	 */
	it.each([
		[ '163.com' ], [ '512.dev' ], [ '123.com' ], [ '1.2.dev' ],
		[ 'bus.dillo.dev' ], [ 'xn--80ak6aa92e.com' ], [ 'notexample.com' ],
		[ 'my-board.dillo.dev' ],
	])('accepts %s, which is a hostname somebody could really be serving', (domain) => {
		const r = runInstall([ '--domain', domain ], { server: 'nginx' })
		expect(r.code, `${ domain } was refused: ${ r.out.slice(-400) }`).toBe(0)
		expect(r.out, 'accepted but never rendered into the sed')
			.toContain(`s/@DOMAIN@/${ domain }/g`)
	})

	/*
	 * Hostnames are case-insensitive; certbot's lineage directory is not. It is built
	 * from the string as given, so --domain BUS.DILLO.DEV would send the restore step
	 * looking for a lineage a `bus.dillo.dev` certificate does not have.
	 *
	 * Normalizing has to happen BEFORE the refusals, not after: `case` patterns are
	 * literal, so with the lowercasing last, YOUR.DOMAIN walked straight past the
	 * placeholder list and rendered the dead server_name that list exists to stop.
	 */
	it('lowercases the domain, so the certificate lineage can be found', () => {
		const r = runInstall([ '--domain', 'BUS.DILLO.DEV' ], { server: 'nginx' })
		expect(r.code).toBe(0)
		expect(r.out, 'the domain reached the sed with its case intact')
			.toContain('s/@DOMAIN@/bus.dillo.dev/g')
		expect(r.out).not.toContain('BUS.DILLO.DEV')
	})

	it.each([ [ 'YOUR.DOMAIN' ], [ 'Bus.Example.Com' ], [ 'EXAMPLE.COM' ] ])(
		'still refuses %s, which case alone must not smuggle past the list', (domain) => {
			const r = runInstall([ '--domain', domain ], { server: 'nginx' })
			expect(r.code, `${ domain } was accepted`).toBe(1)
			expect(r.out).not.toMatch(/s\/@DOMAIN@\//)
		},
	)

	/*
	 * The summary told every box to run `certbot --nginx`, including the apache ones.
	 * Harmless while it was only a stale default; the apache instructions now send a
	 * first-install operator at that exact line, which made it a wrong instruction on
	 * a path somebody follows.
	 */
	it.each([
		[ 'nginx', 'nginx', /certbot --nginx -d bus\.dillo\.dev/, /certbot --apache/ ],
		[ 'apache', 'apache2ctl', /certbot --apache -d bus\.dillo\.dev/, /certbot --nginx/ ],
	])('tells a %s box to use its own certbot plugin', (_n, server, want, unwanted) => {
		const r = runInstall([ '--domain', 'bus.dillo.dev' ], { server })
		expect(r.code).toBe(0)
		expect(r.out, 'the summary names the wrong web server').toMatch(want)
		expect(r.out, 'it names the other web server as well').not.toMatch(unwanted)
	})

	/*
	 * The record that silences update.sh, written on the run that earned it least.
	 *
	 * cm_write_vhost_stamp sat outside the `[ -z "$DOMAIN" ]` chain, so a run with no
	 * --domain refused to print the vhost commands and then recorded the committed
	 * vhosts as the installed ones. Nothing can have been installed from a run that
	 * printed no commands, and from then on update.sh compares /etc against a record
	 * that already matches -- so the next real vhost change deploys with nothing to
	 * announce it. That is strictly worse than having no record at all, because a box
	 * with no record says so once per run and carries on.
	 *
	 * Asserted through the --dry-run arm, which is the only one reachable without root:
	 * the DOMAIN arm comes first in the chain, so proving it wins here proves the write
	 * below it is unreachable. Deleting the guard flips both assertions.
	 */
	it('records no vhost fingerprint on a run that printed no vhost', () => {
		const r = runInstall([], { server: 'nginx' })
		expect(r.code).toBe(0)
		expect(r.out, 'it stamped the vhosts as installed without printing them')
			.not.toMatch(/would run: record the vhost drift fingerprint/)
		expect(r.out, 'it does not say why there is no record')
			.toMatch(/not recording a vhost drift fingerprint/)
	})

	/*
	 * The second half of the same outage. The committed conf is `listen 80` only; certbot
	 * rewrites the INSTALLED file to add the 443 server. The old instructions said
	 * `| sudo tee` straight over it, which deletes the TLS block while leaving the
	 * certificate valid and unreferenced -- so the board loses HTTPS and the error is a
	 * fall-through to whatever else the box serves on 443.
	 */
	it.each([
		/*
		 * Paths that only one branch can print. `sites-available/capmetro` is a
		 * SUBSTRING of apache's own `/etc/apache2/sites-available/capmetro.conf`,
		 * so as a self-check for the nginx case it was satisfied by the apache
		 * branch too -- the two cases stayed separate because install.sh tests
		 * `command -v nginx` before apache2ctl, not because this regex said so.
		 */
		[ 'nginx', 'nginx', /etc\/nginx\/sites-available/ ],
		[ 'apache', 'apache2ctl', /etc\/apache2\/sites-available/ ],
	])('tells you to diff before overwriting, and to put certbot back after (%s)', (_name, server, target) => {
		const r = runInstall(['--domain', 'bus.dillo.dev'], { server })
		const out = r.out
		/*
		 * Exit status FIRST. Every other assertion here reads text that is printed
		 * before the vhost block ends, so the script can abort immediately after it
		 * and they all still pass -- proven by putting a bare `false` after the
		 * heredoc, which `set -e` turns into an abort, with both cases still green.
		 * This is the one path that represents a real completed install.
		 */
		expect(r.code, 'the script aborted after printing the vhost block').toBe(0)
		expect(out, 'the branch under test was not the one taken').toMatch(target)
		expect(out, 'no diff step').toMatch(/diff -u/)
		/*
		 * It must tell you to LOOK UP the lineage name, not assume it is the domain.
		 * `certbot install --cert-name <wrong name>` fails, and it fails at the one
		 * moment that matters: after the cp has already replaced the installed file
		 * and deleted the 443 block certbot put there. A re-issue leaves the lineage
		 * named bus.dillo.dev-0001, and a cert taken with an explicit --cert-name has
		 * whatever name it was given, so "usually the first -d" is not good enough to
		 * print as a command.
		 */
		/* Presence only; the exact shape, including the installer plugin, is asserted below. */
		expect(out, 'no certbot step').toMatch(/certbot install /)
		expect(out, 'it does not say how to find the lineage name')
			.toMatch(/certbot certificates/)
		expect(out, 'it assumes the lineage is named after the domain')
			.not.toMatch(/certbot install --cert-name bus\.dillo\.dev/)
		expect(out, 'it does not say to skip certbot on a first install, where it fails')
			.toMatch(/FIRST install|first install/)

		/*
		 * The backup is what makes the copy survivable, and it is the only thing that
		 * covers every way the restore can fail at once. Verified with real certbot
		 * 2.9.0 on Ubuntu 24.04: `certbot install --cert-name <name>` exits 1 when no
		 * lineage exists, and when the lineage is not named exactly that -- and certbot
		 * names a lineage after the FIRST -d, so a certificate covering the apex and
		 * this host together is named for the apex. If the certificate came from
		 * acme.sh, Caddy or a commercial CA there is no lineage to name at all, so
		 * `certbot certificates` lists nothing and no --cert-name can restore the block.
		 * Every one of those lands AFTER the cp, with HTTPS already down.
		 *
		 * Ordering asserted, not just presence: a backup taken after the overwrite is a
		 * copy of the damage.
		 */
		expect(out, 'no backup, so the overwrite is irreversible')
			.toMatch(/cp -a \$B \$B\./)
		const bakAt = out.search(/cp -a \$B/)
		expect(bakAt, 'no backup step at all, so the order assertion is empty')
			.toBeGreaterThan(-1)
		expect(bakAt, 'the backup is taken after the copy, so it preserves the damage')
			.toBeLessThan(out.search(/sudo cp \/tmp\/capmetro-vhost\.new/))
		expect(out, 'the backup is guarded so a first install does not fail on it')
			.toMatch(/\[ -f \$B \]/)
		expect(out, 'it does not say what to do when certbot has no lineage to restore')
			.toMatch(/EMPTY|empty/)
		/*
		 * `certbot install` needs an installer plugin named. Without one it cannot know
		 * which config to write the 443 block into.
		 */
		expect(out, 'certbot install is printed with no installer plugin')
			.toMatch(/certbot install --(nginx|apache) --cert-name/)
		expect(out, 'still piping straight into the live config').not.toMatch(/\|\s*sudo tee/)

		/* Order matters more than presence: a diff printed after the copy is decoration. */
		const diffAt = out.search(/diff -u/)
		const copyAt = out.search(/sudo cp .*capmetro-vhost\.new/)
		const certAt = out.search(/certbot install/)
		expect(copyAt, 'no copy step at all, so the order assertion is empty')
			.toBeGreaterThan(-1)
		expect(diffAt, 'the diff comes after the copy that makes it pointless')
			.toBeLessThan(copyAt)
		expect(certAt, 'certbot runs before the copy that removes its block')
			.toBeGreaterThan(copyAt)
	})

	/*
	 * The instructions only work while the conf actually carries the placeholders. If a
	 * hostname were ever hardcoded into the committed file, the sed above would be a no-op
	 * and every box would install somebody else's domain.
	 */
	it('and the committed vhosts still carry the placeholders the sed replaces', () => {
		for (const v of ['nginx-capmetro.conf', 'apache-capmetro.conf']) {
			const conf = readFileSync(path.join(REPO, 'deploy', v), 'utf8')
			expect(conf, `${ v } no longer has @DOMAIN@`).toMatch(/@DOMAIN@/)
			expect(conf, `${ v } no longer has @WEBROOT@`).toMatch(/@WEBROOT@/)
		}
	})

	/*
	 * Nothing to do is one line. update.sh sends an operator here to fix a UNIT drift,
	 * and every such run used to print the whole vhost procedure -- about sixty lines
	 * of it -- for a vhost that had not changed.
	 *
	 * "Nothing to do" is decided by what is installed: the committed vhost rendered
	 * with this run's --domain and --webroot, every line present in the installed
	 * file, and the site enabled. Each case below is one way that can be false.
	 */
	describe.each([
		[ 'nginx', 'nginx', 'nginx-capmetro.conf', 'capmetro', 'CM_NGINX_DIR' ],
		[ 'apache', 'apache2ctl', 'apache-capmetro.conf', 'capmetro.conf', 'CM_APACHE_DIR' ],
	])('whether the %s vhost needs installing', (name, server, conf, file, dirVar) => {
		const dir = () => path.join(work, name)
		const TEMPLATE = 'server {\n    listen 80;\n    server_name @DOMAIN@;\n    root @WEBROOT@;\n}\n'
		const render = (domain = 'bus.dillo.dev') =>
			TEMPLATE.replace('@DOMAIN@', domain).replace('@WEBROOT@', path.join(work, 'webroot'))
		/*
		 * `tls` puts certbot's evidence in place the way each server keeps it: an
		 * ssl_certificate line in the nginx file, an HTTPS copy beside the apache one.
		 */
		const install = (body = render(), { enabled = true, tls = true } = {}) => {
			mkdirSync(path.join(dir(), 'sites-available'), { recursive: true })
			mkdirSync(path.join(dir(), 'sites-enabled'), { recursive: true })
			if (tls && name === 'nginx') body = body.replace(/}\n$/, '    ssl_certificate /etc/letsencrypt/live/x/fullchain.pem; # managed by Certbot\n}\n')
			writeFileSync(path.join(dir(), 'sites-available', file), body)
			if (enabled) writeFileSync(path.join(dir(), 'sites-enabled', file), body)
			if (tls && name === 'apache') {
				for (const d of [ 'sites-available', 'sites-enabled' ]) {
					writeFileSync(path.join(dir(), d, 'capmetro-le-ssl.conf'), body)
				}
			}
		}
		const run = (extra = [], domain = 'bus.dillo.dev') => {
			writeFileSync(path.join(work, 'src/deploy', conf), TEMPLATE)
			return runInstall([ '--domain', domain, ...extra ], {
				server,
				env: { CONF_DIR: path.join(work, 'conf'), [ dirVar ]: dir() },
			})
		}
		const quiet = new RegExp(`${ name } vhost file enabled and matching this checkout; nothing to install`)

		it('says so in one line, and the summary drops to checking the board', () => {
			install()
			const r = run()
			expect(r.code).toBe(0)
			expect(r.out).toMatch(quiet)
			expect(r.out).toMatch(/--show-vhost/)
			expect(r.out, 'the install steps were printed anyway').not.toMatch(/diff -u/)
			expect(r.out).not.toMatch(/certbot install/)
			expect(r.out).toMatch(/1\. check the BOARD/)
			expect(r.out, 'the summary still lists the install steps').not.toMatch(/^\s+3\. /m)
		})

		it('recognizes the real committed vhost once it is installed', () => {
			/* The fixture above is five lines; the real file has multi-line directives. */
			const real = readFileSync(path.join(REPO, 'deploy', conf), 'utf8')
			writeFileSync(path.join(work, 'src/deploy', conf), real)
			install(real.replaceAll('@DOMAIN@', 'bus.dillo.dev').replaceAll('@WEBROOT@', path.join(work, 'webroot')))
			const r = runInstall([ '--domain', 'bus.dillo.dev' ], {
				server,
				env: { CONF_DIR: path.join(work, 'conf'), [ dirVar ]: dir() },
			})
			expect(r.out).toMatch(quiet)
		})

		it('still counts it current once certbot has edited the installed copy', () => {
			/*
			 * certbot moves `listen 80` into a redirect block of its own, and writes it
			 * back in its own spacing (`listen 80 ;`), so the committed line is not in
			 * the file at all. The rest of the block is left as it was.
			 */
			install(render()
				.replace('    listen 80;\n', '    listen 443 ssl; # managed by Certbot\n')
				.concat('server {\n    listen 80 ;\n    return 301 https://$host$request_uri; # managed by Certbot\n}\n'))
			expect(run().out).toMatch(quiet)
		})

		it.each([
			[ 'with --show-vhost', () => install(), [ '--show-vhost' ] ],
			[ 'when nothing is installed', () => {}, [] ],
			[ 'when the installed file is empty', () => install(''), [] ],
			[ 'when the site is not enabled', () => install(render(), { enabled: false }), [] ],
			[ 'when it names another host', () => install(render('your.domain')), [] ],
			[ 'when it still carries a placeholder', () => install(TEMPLATE), [] ],
		])('prints the steps %s', (_why, setup, extra) => {
			setup()
			const r = run(extra)
			expect(r.out).toMatch(/diff -u/)
			expect(r.out).not.toMatch(quiet)
		})

		it('prints the steps when the committed template has nothing to compare', () => {
			/* A template that renders to nothing must not read as "every line present". */
			install()
			writeFileSync(path.join(work, 'src/deploy', conf), '# only a comment\n')
			const r = runInstall([ '--domain', 'bus.dillo.dev' ], {
				server,
				env: { CONF_DIR: path.join(work, 'conf'), [ dirVar ]: dir() },
			})
			expect(r.out).toMatch(/diff -u/)
		})

		it('keeps the certificate step when the matching vhost has no TLS', () => {
			/* A first install before certbot, or a copy that took the 443 block out. */
			install(render(), { tls: false })
			const r = run()
			expect(r.out).toMatch(quiet)
			expect(r.out).toMatch(/It has no TLS yet/)
			expect(r.out).toMatch(/1\. add TLS/)
			expect(r.out).toMatch(new RegExp(`certbot install --${ name === 'nginx' ? 'nginx' : 'apache' } --cert-name NAME`))
		})

		it('prints the steps when the drift record says the committed vhost changed', () => {
			/*
			 * A change that only DELETES a line: the installed file still has it, which
			 * is what certbot's own additions look like, so only the record can tell.
			 * Taking the one-line path here would also restamp the record and silence
			 * update.sh's notice.
			 */
			const before = TEMPLATE.replace('}\n', '    index index.html;\n}\n')
			writeFileSync(path.join(work, 'src/deploy', conf), before)
			writeVhostStamp()
			install(before.replace('@DOMAIN@', 'bus.dillo.dev').replace('@WEBROOT@', path.join(work, 'webroot')))
			const r = run()
			expect(r.out).toMatch(/diff -u/)
			expect(r.out).not.toMatch(quiet)
		})

		it('ignores a change to the other server\'s vhost in the record', () => {
			install()
			writeFileSync(path.join(work, 'src/deploy', conf), TEMPLATE)
			writeVhostStamp()
			const other = conf === 'nginx-capmetro.conf' ? 'apache-capmetro.conf' : 'nginx-capmetro.conf'
			editVhost(other)
			expect(run().out).toMatch(quiet)
		})

		it('takes the one-line path when the drift record agrees', () => {
			install()
			writeFileSync(path.join(work, 'src/deploy', conf), TEMPLATE)
			writeVhostStamp()
			expect(run().out).toMatch(quiet)
		})

		it('prints the steps when this run is for a different webroot', () => {
			install()
			expect(run([ '--webroot', path.join(work, 'elsewhere') ]).out).toMatch(/diff -u/)
		})

		/*
		 * 4ef16f4 repeated add_header lines into blocks that already had them. Every
		 * line was somewhere in the old file, so a membership check called the old
		 * install current. Order and repeats are what change there.
		 */
		it.each([
			[ 'repeats a line that is already elsewhere in the file',
				TEMPLATE.replace('}\n', '    location / {\n        root @WEBROOT@;\n    }\n}\n'),
				(t) => t.replace('}\n', '    location / {\n    }\n}\n') ],
			[ 'reorders two lines',
				TEMPLATE.replace('    server_name @DOMAIN@;\n    root @WEBROOT@;\n', '    root @WEBROOT@;\n    server_name @DOMAIN@;\n'),
				(t) => t ],
		])('prints the steps when the committed vhost %s', (_why, committed, installedFrom) => {
			install(installedFrom(render()))
			writeFileSync(path.join(work, 'src/deploy', conf), committed)
			const r = runInstall([ '--domain', 'bus.dillo.dev' ], {
				server,
				env: { CONF_DIR: path.join(work, 'conf'), [ dirVar ]: dir() },
			})
			expect(r.out).toMatch(/diff -u/)
			expect(r.out).not.toMatch(quiet)
		})

		it('reads the enabled file, which is what the server loads', () => {
			/* A stale plain-file copy in sites-enabled, a current one in sites-available. */
			install()
			writeFileSync(path.join(dir(), 'sites-enabled', file), render('your.domain'))
			expect(run().out).toMatch(/diff -u/)
		})

		it('prints the steps when this run is for a different domain', () => {
			install()
			expect(run([], 'buses.dillo.dev').out).toMatch(/diff -u/)
		})

		it('prints the steps when the checkout moved on and the change was never applied', () => {
			/*
			 * The case a drift record cannot see: install.sh printed the new vhost,
			 * stamped it, and the operator never ran the steps.
			 */
			install()
			const r = runInstall([ '--domain', 'bus.dillo.dev' ], {
				server,
				env: { CONF_DIR: path.join(work, 'conf'), [ dirVar ]: dir() },
			})
			writeFileSync(path.join(work, 'src/deploy', conf), TEMPLATE.replace('}\n', '    index index.html;\n}\n'))
			const again = runInstall([ '--domain', 'bus.dillo.dev' ], {
				server,
				env: { CONF_DIR: path.join(work, 'conf'), [ dirVar ]: dir() },
			})
			expect(r.code).toBe(0)
			expect(again.out).toMatch(/diff -u/)
		})
	})

	it.each([ 'CM_NGINX_DIR', 'CM_APACHE_DIR', 'CONF_DIR' ])('says when %s is pointing it away from /etc', (v) => {
		const r = runInstall([ '--domain', 'bus.dillo.dev' ], {
			server: 'nginx',
			env: { [ v ]: path.join(work, 'elsewhere') },
		})
		expect(r.out).toMatch(new RegExp(`${ v } is set to .* \\(a test override\\)`))
	})

	it('says nothing when CONF_DIR is set to its own default', () => {
		const r = runInstall([ '--domain', 'bus.dillo.dev' ], {
			server: 'nginx',
			env: { CONF_DIR: '/etc/capmetro' },
		})
		expect(r.out).not.toMatch(/CONF_DIR is set to/)
	})

	/*
	 * Apache with certbot: certbot adds Rewrite lines to the port-80 file and serves
	 * HTTPS from a copy it writes beside it, capmetro-le-ssl.conf, opening *:443.
	 */
	describe('an apache box certbot has been at', () => {
		const dir = () => path.join(work, 'apache')
		const TEMPLATE = '<VirtualHost *:80>\n    ServerName @DOMAIN@\n    DocumentRoot @WEBROOT@\n</VirtualHost>\n'
		const render = (t = TEMPLATE) =>
			t.replace('@DOMAIN@', 'bus.dillo.dev').replace('@WEBROOT@', path.join(work, 'webroot'))
		const place = (name, body) => {
			for (const d of [ 'sites-available', 'sites-enabled' ]) {
				mkdirSync(path.join(dir(), d), { recursive: true })
				writeFileSync(path.join(dir(), d, name), body)
			}
		}
		const certbotted = (body) => body.replace('</VirtualHost>',
			'RewriteEngine on\nRewriteCond %{SERVER_NAME} =bus.dillo.dev\nRewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [END,NE,R=permanent]\n</VirtualHost>')
		const sslCopy = (body) => '<IfModule mod_ssl.c>\n' + body.replace('*:80', '*:443')
			.replace('</VirtualHost>', 'SSLCertificateFile /etc/letsencrypt/live/bus.dillo.dev/fullchain.pem\n</VirtualHost>') + '</IfModule>\n'
		const run = () => {
			writeFileSync(path.join(work, 'src/deploy/apache-capmetro.conf'), TEMPLATE)
			return runInstall([ '--domain', 'bus.dillo.dev' ], {
				server: 'apache2ctl',
				env: { CONF_DIR: path.join(work, 'conf'), CM_APACHE_DIR: dir() },
			})
		}

		it('counts it current with the rewrite lines and the HTTPS copy in place', () => {
			place('capmetro.conf', certbotted(render()))
			place('capmetro-le-ssl.conf', sslCopy(render()))
			expect(run().out).toMatch(/apache vhost file enabled and matching this checkout/)
		})

		it('names the HTTPS copy when only it is stale, since the steps cannot reach it', () => {
			place('capmetro.conf', certbotted(render()))
			place('capmetro-le-ssl.conf', sslCopy(render().replace('bus.dillo.dev', 'your.domain')))
			const r = run()
			const out = r.out
			expect(out).toMatch(/certbot's HTTPS copy does not/)
			expect(out).toMatch(/capmetro-le-ssl\.conf/)
			expect(out, 'the port-80 steps would repeat forever').not.toMatch(/diff -u/)
			/*
			 * Pasted as a block, nothing destructive may run unless all of it can: the
			 * name is looked up first, the chain is gated on NAME and stops on any
			 * failure before the reload, and there is a way back. A `<placeholder>`
			 * is a shell redirect that fails on its own line while the rm around it
			 * runs anyway.
			 */
			expect(out, 'a pasteable <placeholder>').not.toMatch(/--cert-name </)
			const lookup = out.search(/certbot certificates/)
			const rm = out.search(/sudo rm -f /)
			expect(lookup).toBeGreaterThan(-1)
			expect(lookup, 'the name is looked up after the file is gone').toBeLessThan(rm)
			expect(out.search(/sudo cp -a \$S \$B/), 'no backup before the removal').toBeLessThan(rm)
			expect(out).toMatch(/\[ -n "\$NAME" \] && sudo cp -a/)
			expect(out).toMatch(/--cert-name "\$NAME" && sudo apache2ctl configtest/)
			expect(out, 'no way back if certbot fails').toMatch(/sudo cp -a \$B \$S/)
			/* And the summary says the same thing, not the four-step list. */
			expect(out).toMatch(/1\. bring the HTTPS copy printed above into line/)
			expect(out).toMatch(/2\. check the BOARD/)
			expect(out).not.toMatch(/install the vhost printed above/)
		})

		it('tells an apache box the HTTPS copy needs the same change when the steps print', () => {
			place('capmetro.conf', certbotted(render().replace('bus.dillo.dev', 'your.domain')))
			place('capmetro-le-ssl.conf', sslCopy(render()))
			const r = run()
			expect(r.out).toMatch(/diff -u/)
			expect(r.out).toMatch(/HTTPS is served from .*capmetro-le-ssl\.conf, which these steps do not touch/)
		})
	})

	/*
	 * THE PLACEHOLDER THAT SURVIVED THE FIRST FIX.
	 *
	 * The clone-failure message printed `--domain ${DOMAIN:-your.domain}` inside an
	 * indented block formatted for copying. Pasted, DOMAIN becomes non-empty, so
	 * the refusal above never fires and the vhost commands print with a hostname
	 * that matches nothing -- the 2026-09-21 outage, rebuilt out of the very file
	 * that was meant to have removed it.
	 *
	 * The earlier test could not see it: it asserts on a --dry-run, and a dry run
	 * never fails a clone. So this reads the SOURCE. That is the right instrument
	 * here, because the defect is a string the script is willing to print, not a
	 * branch a happy-path run walks through.
	 */
	it('offers no placeholder hostname anywhere it could be pasted', () => {
		const lines = install.split('\n')
		/*
		 * The refusal has to name the string in order to refuse it, so a bare
		 * search for it now matches the fix as well as the bug. What separates
		 * them is position, not spelling: inside a `case "${DOMAIN:-}" in` block
		 * the name is a pattern being rejected, and anywhere else it is a value
		 * that can be printed and pasted.
		 *
		 * Ranges, rather than a keyword exclusion, because the strings this test
		 * exists to catch live in heredocs where they look like ordinary prose --
		 * `sudo certbot --nginx -d your.domain` carries no marker distinguishing
		 * it from a case arm, so any exclusion written to spare the arm would
		 * spare that too. Verified by mutation: putting that line back in the
		 * nginx heredoc fails this test, and deleting the refusal arm keeps it
		 * green, which is the pair that says the range logic is not a blanket.
		 */
		const refusals = []
		let open = null
		lines.forEach((line, i) => {
			if (/^case "\$\{DOMAIN:-\}" in\s*$/.test(line)) open = i
			else if (open !== null && /^esac\s*$/.test(line)) {
				refusals.push([ open, i ])
				open = null
			}
		})
		expect(refusals.length, 'no DOMAIN validation block found, so nothing is excluded')
			.toBeGreaterThan(0)
		/*
		 * Pattern LINES inside those blocks, not the whole block. The blocks also hold
		 * multi-line `die` bodies, and a die body is printed to the terminal -- as
		 * pasteable as any heredoc. Excluding whole blocks meant a placeholder in a
		 * refusal's own explanatory text was invisible, which is a hole in the shape of
		 * the very thing being banned. Verified: `sudo certbot --nginx -d your.domain`
		 * added to the placeholder arm's die body left this test green while
		 * `--domain bus.example.com` printed that line to the operator.
		 *
		 * A pattern line is only pattern characters -- names, dots, stars, pipes,
		 * hyphens -- and MUST end in a terminator: a closing paren, or a backslash
		 * continuing the arm. Prose and quotes disqualify it, which is what separates
		 * a `case` arm from the message underneath it.
		 *
		 * Both terminators were optional at first, which exempted a line that is
		 * nothing but an indented hostname -- so a die body reading "do not use the
		 * stand-in from the docs:" followed by the stand-in on its own line was
		 * exempt, and printed. Requiring the terminator costs nothing: every real
		 * pattern line in this file ends in one.
		 */
		const isPatternLine = (line) =>
			/^\s*\|?[A-Za-z0-9.*|_-]+(\)|\s*\\)\s*$/.test(line)
		const inRefusal = (n) =>
			refusals.some(([ a, b ]) => n >= a && n <= b) && isPatternLine(lines[n])
		/*
		 * The comment filter had a hole the size of the usage text. `usage()` is
		 * `sed -n '2,20p' "$0" | sed 's/^# \\{0,1\\}//'`, so header comment lines 2-20
		 * are reprinted verbatim by --help: they are operator-facing, paste-ready
		 * output that merely looks like a comment in the source. Line 9 is the
		 * example invocation, and it is the line this branch edited away from a
		 * reserved name precisely because it is pasteable -- while the test written
		 * to forbid that could not see it. Confirmed by mutation: putting
		 * `--domain your.domain` back on line 9 left this test green and
		 * `install.sh --help` printed it.
		 */
		const usageRange = (() => {
			const m = install.match(/sed -n '(\d+),(\d+)p' "\$0"/)
			expect(m, 'usage() no longer reprints a line range; this exclusion is stale')
				.not.toBeNull()
			return [ Number(m[1]) - 1, Number(m[2]) - 1 ]
		})()
		const reprinted = (i) => i >= usageRange[0] && i <= usageRange[1]
		const offenders = lines
			.map((line, i) => ({ line, n: i + 1, i }))
			.filter(({ line }) => /your\.domain/.test(line))
			.filter(({ line, i }) => reprinted(i) || !/^\s*#/.test(line))
			.filter(({ i }) => !inRefusal(i))
		expect(offenders.map((o) => `${ o.n }: ${ o.line.trim() }`),
			'a placeholder hostname is printable; pasting it walks past the refusal')
			.toEqual([])
	})

	/*
	 * And the stronger form of the same rule, which does not depend on a list of
	 * known placeholder spellings at all: ANY hostname this script suggests, it must
	 * also accept. `bus.yourcompany.com` is not RFC 2606, so the validator lets it
	 * through and a literal ban would never have listed it -- but a name the script
	 * offers and then refuses, or offers and then renders into a dead server_name,
	 * is the whole bug either way.
	 *
	 * Asserted against the real --help output rather than the source, so it covers
	 * however usage() is built.
	 */
	it('accepts every domain its own help text suggests', () => {
		const help = spawnSync('bash', [ INSTALL, '--help' ], { encoding: 'utf8' })
		expect(help.status, '--help did not exit 0').toBe(0)
		/*
		 * No `.includes('.')` filter. It looked like it was skipping the options
		 * list's `--domain <name>`, but `<` is outside the character class so that
		 * line never matched anyway -- while a single-label suggestion, which
		 * install.sh refuses, was silently dropped by it. Today the sweep finds
		 * exactly one value, so removing the filter changes nothing except what a
		 * future edit can smuggle past.
		 */
		const suggested = [ ...help.stdout.matchAll(/--domain\s+([A-Za-z0-9.-]+)/g) ]
			.map((m) => m[1])
		expect(suggested.length, 'the help text suggests no example hostname to check')
			.toBeGreaterThan(0)
		for (const domain of suggested) {
			const r = runInstall([ '--domain', domain ], { server: 'nginx' })
			expect(r.code, `--help suggests ${ domain }, which install.sh then refuses`)
				.toBe(0)
		}
	})

	/*
	 * The same rule for a reserved name that arrives in --help by any OTHER sentence.
	 * The check above only sees `--domain X`, so `check the board at
	 * https://bus.example.com/...` in the header would hand the operator an RFC 2606
	 * name that install.sh itself refuses -- the offers-then-refuses bug, through a
	 * different door.
	 *
	 * Every hostname-shaped token is swept, and each is tested against install.sh's
	 * OWN reserved list, parsed out of the refusal arm rather than restated here so
	 * the two cannot drift. Suffix matching, not runInstall: the sweep legitimately
	 * picks up install.sh, config.php and capmetro-tracker.git, which are filenames,
	 * and feeding those through the validator would fail for reasons that are not
	 * this rule.
	 */
	it('never prints a reserved hostname in its help text, in any sentence', () => {
		const arm = install.match(/\n\s*(your\.domain[\s\S]*?)\)\n\s*die /)
		expect(arm, 'the reserved-name refusal arm could not be parsed; this check is stale')
			.not.toBeNull()
		const reserved = arm[1]
			.split('|')
			.map((t) => t.replace(/[\\\s]/g, ''))
			.filter(Boolean)
		expect(reserved.length, 'parsed no reserved patterns').toBeGreaterThan(5)

		const help = spawnSync('bash', [ INSTALL, '--help' ], { encoding: 'utf8' })
		expect(help.status).toBe(0)
		const tokens = [ ...new Set(
			[ ...help.stdout.matchAll(/\b[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+\b/g) ]
				.map((m) => m[0].toLowerCase()),
		) ]
		expect(tokens.length, 'the help text has no hostname-shaped token to check')
			.toBeGreaterThan(0)

		const offenders = tokens.filter((t) => reserved.some((r) =>
			r.startsWith('*.') ? t.endsWith(r.slice(1)) : t === r))
		expect(offenders, 'the help text names a hostname install.sh itself refuses')
			.toEqual([])
	})

	/*
	 * A hostname that breaks the sed, or that nginx reads as several names, must
	 * not reach the printed command. Both reproduced against real sed:
	 *   'https://bus.dillo.dev' closes the s/// early -- sed exits 1, and because
	 *   '>' truncates first the temp file is left at 0 bytes, which nginx accepts.
	 *   'bus dillo dev' renders `server_name bus dillo dev;`, three names.
	 */
	it.each([
		[ 'a URL', 'https://bus.dillo.dev' ],
		[ 'a space', 'bus dillo dev' ],
		[ 'a slash', 'a/b' ],
		[ 'a leading dot', '.bus.dillo.dev' ],
		[ 'a trailing dot', 'bus.dillo.dev.' ],
	])('refuses %s as a domain rather than rendering a broken vhost', (_n, domain) => {
		const r = runInstall([ '--domain', domain ], { server: 'nginx' })
		expect(r.code, 'it carried on with a domain it cannot render').not.toBe(0)
		expect(r.out).toMatch(/--domain (must be a hostname|is not a hostname)/)
		expect(r.out, 'a sed was printed anyway').not.toMatch(/s\/@DOMAIN@\//)
	})

	it('still accepts an ordinary hostname', () => {
		const r = runInstall([ '--domain', 'bus.dillo.dev' ], { server: 'nginx' })
		expect(r.code).toBe(0)
		expect(r.out).toMatch(/s\/@DOMAIN@\/bus\.dillo\.dev\/g/)
	})

	/*
	 * And the copy refuses a render that went wrong, because the operator pastes
	 * the whole block. An empty file and a file with @PLACEHOLDERS@ left in it are
	 * both accepted by nginx -t and both drop the host to default_server.
	 */
	it.each([
		[ 'nginx', 'nginx' ],
		[ 'apache', 'apache2ctl' ],
	])('guards the copy against an empty or unsubstituted render (%s)', (_n, server) => {
		const r = runInstall([ '--domain', 'bus.dillo.dev' ], { server })
		expect(r.out, 'the copy is unguarded: a 0-byte render would be installed')
			.toMatch(/\[ -s \/tmp\/capmetro-vhost\.new \]/)
		expect(r.out, 'an unsubstituted render would be installed')
			.toMatch(/grep -q '@\[A-Z_\]\*@'/)
		/* The guard has to be on the same chain as the cp, or pasting the block
		 * runs the cp regardless of what the guard said. */
		expect(r.out).toMatch(/grep -q '@\[A-Z_\]\*@' \/tmp\/capmetro-vhost\.new \\\n\s*&& sudo cp/)
	})

	/*
	 * THE SUMMARY, which had no assertion at all.
	 *
	 * Deleting the whole `Next:` block -- the re-run guidance, the certbot command
	 * and the health-check curl -- left all eleven dry-run tests green. The
	 * refusal test looked like it covered it, because it matches /--domain/, but
	 * the warn() text higher up satisfies that on its own, so the assertion never
	 * reached the summary.
	 *
	 * It matters because these four lines are what an operator does next, and the
	 * outage happened between two of them.
	 */
	it('tells an operator what to do next, once it has a domain', () => {
		const r = runInstall([ '--domain', 'bus.dillo.dev' ], { server: 'nginx' })
		expect(r.code).toBe(0)
		expect(r.out, 'no certbot step in the summary')
			.toMatch(/certbot --nginx -d bus\.dillo\.dev/)
		/* The board, not the config: a green nginx -t is what made the outage
		 * invisible, so the summary has to point at health.json. */
		expect(r.out, 'the summary does not say to check the board')
			.toMatch(/https:\/\/bus\.dillo\.dev\/api\/health\.json/)
		expect(r.out).toMatch(/update\.sh/)
	})

	it('and tells them how to get one, when it has none', () => {
		const r = runInstall([], { server: 'nginx' })
		expect(r.code).toBe(0)
		expect(r.out, 'the summary offers no way forward without --domain')
			.toMatch(/re-run with --domain/)
		/* And prints no hostname-shaped command it cannot fill in. */
		expect(r.out).not.toMatch(/certbot --nginx -d/)
		expect(r.out).not.toMatch(/api\/health\.json/)
	})

	it('changes nothing on disk', () => {
		/*
		 * Weak on its own and kept for what it does cover: CONF_DIR is hardcoded at the top
		 * of install.sh with no flag and no env fallback, so work/conf is a directory the
		 * script never touches and this passes regardless of what it writes. The real
		 * assertion is the one below, which watches what the script SAYS it is doing.
		 */
		const before = readdirSync(path.join(work, 'conf'))
		runInstall()
		expect(readdirSync(path.join(work, 'conf'))).toEqual(before)
	})

	it('does not write the vhost drift record under --dry-run', () => {
		/*
		 * The units stamp write has always been inside `if [ "$DRY_RUN" = 0 ]`; the vhost
		 * one was added outside it, so `--dry-run` -- a mode whose whole promise is that it
		 * changes nothing -- wrote /etc/capmetro/installed-vhost.sha256 recording the
		 * COMMITTED vhosts as installed. Every later update.sh then reported no drift for a
		 * vhost that had never been applied: "cannot tell" laundered into a durable false
		 * "clean", which is the one outcome the NO_STAMP / NO_TOOL split exists to prevent.
		 *
		 * Asserted on the announced action rather than on the file, because CONF_DIR is not
		 * redirectable and /etc/capmetro is not this test's to write.
		 */
		/*
		 * With a domain, deliberately. The `[ -z "$DOMAIN" ]` arm added later comes
		 * first in the same chain, so a no-domain run never reaches the DRY_RUN arm
		 * this test is about -- it would pass for the wrong reason and stop covering
		 * the guard it was written for.
		 */
		const r = runInstall([ '--domain', 'bus.dillo.dev' ], { server: 'nginx' })
		expect(r.out, 'dry run did not announce the vhost record as a would-run')
			.toMatch(/would run: record the vhost drift fingerprint/)
		expect(r.out, 'dry run reported actually writing the record')
			.not.toMatch(/could not write the vhost drift record/)
	})

	/*
	 * With a domain and a server, deliberately: the VHOST_PRINTED arm now answers
	 * first in that chain, so a bare runInstall() never reaches the helper check this
	 * test is named for. Proven by deleting the whole `elif ! command -v
	 * cm_write_vhost_stamp` arm, which left every install.sh dry-run test green.
	 */
	it('survives a pulled units.sh that predates the vhost helper', () => {
		/*
		 * What this DOES prove: a dry run against a tree carrying the pre-branch units.sh
		 * completes, exits 0, and prints no shell error.
		 *
		 * What it does NOT prove, stated here rather than implied: that install.sh guards
		 * the helper on `command -v cm_write_vhost_stamp` rather than on the file existing.
		 * Verified by mutation -- reverting that guard to `[ -r .../units.sh ]` leaves this
		 * green -- because under --dry-run the DRY_RUN arm answers before the call is ever
		 * reached, and the real path needs root and a real /etc/capmetro. The guard is still
		 * written the strict way, for the reason the units block gives twelve lines up: the
		 * file existing is not the question being asked. It is simply unverified here.
		 */
		/*
		 * The REAL older file out of git, not a synthetic one. Deleting the function's first
		 * line by regex leaves an orphan body, which is a syntax error rather than an old
		 * library -- `.` then fails and install.sh aborts under set -euo pipefail, which is
		 * a different bug being tested by accident.
		 */
		const older = execFileSync('git', ['show', `${ BASE }:deploy/lib/units.sh`],
			{ cwd: REPO, encoding: 'utf8' })
		expect(older,
			'the pre-vhost fixture still contains cm_write_vhost_stamp -- history search found the\n'
			+ 'wrong commit, which means this test is no longer reading a genuinely older library')
			.not.toMatch(/cm_write_vhost_stamp/)
		writeFileSync(path.join(work, 'src/deploy/lib/units.sh'), older)
		const r = runInstall([ '--domain', 'bus.dillo.dev' ], { server: 'nginx' })
		expect(r.code).toBe(0)
		expect(r.out).not.toMatch(/command not found/)
		expect(r.out).not.toMatch(/vhost drift record \(\)/)
		/* The arm this test is named for, reached rather than assumed. */
		expect(r.out, 'the helper-missing arm was not the one that answered')
			.toMatch(/cannot record a vhost drift fingerprint/)
	})
})

/*
 * The vhosts have the same shape of problem as the units and, until this, none of the
 * machinery. install.sh PRINTS them and never installs them; update.sh does not touch them.
 * So a committed change to either sat in the checkout doing nothing, silently.
 *
 * The consequence is worse than a stale unit, which is why it is worth detecting: a stale
 * timer fires at the wrong hour and the board still renders, while a stale vhost can refuse
 * manifest.webmanifest and sw.js outright -- not installable, no offline board, nothing on
 * screen, and health.json still ok:true so the documented health check cannot see it.
 */
/*
 * The vhost templates are the one path with NO validation on it at all.
 *
 * install.sh refuses a placeholder hostname and prints a guarded copy. These two files
 * are what someone follows when they are not running install.sh, and their headers used
 * to hand over the exact procedure the outage came from: `sed 's/@DOMAIN@/bus.example.com/'
 * ... > /etc/nginx/sites-available/capmetro`. A reserved name that cannot resolve, written
 * straight over the live config, with nothing between the sed and /etc.
 *
 * Both halves bite on their own. `>` truncates before sed runs, so a failed sed leaves a
 * 0-byte vhost that nginx accepts and that drops the host to default_server; and on a TLS
 * box the installed file is certbot's rewrite, so copying over the top takes the board off
 * HTTPS. health.json reads ok:true through both.
 */
describe('the vhost templates do not teach the procedure that caused the outage', () => {
	const templates = [
		[ 'nginx', 'deploy/nginx-capmetro.conf', /@DOMAIN@/, 'server_name @DOMAIN@;' ],
		[ 'apache', 'deploy/apache-capmetro.conf', /@DOMAIN@/, 'ServerName @DOMAIN@' ],
	]

	it.each(templates)('%s: suggests no hostname that cannot resolve', (_n, file) => {
		const text = readFileSync(path.join(REPO, file), 'utf8')
		/* The reserved family install.sh refuses. Suggesting one here routes around it. */
		expect(text, 'the header offers a name install.sh itself would refuse')
			.not.toMatch(/your\.domain|domain\.tld|\bexample\.(com|net|org)\b/)
	})

	it.each(templates)('%s: never seds straight into the installed file', (_n, file) => {
		const text = readFileSync(path.join(REPO, file), 'utf8')
		expect(text, 'a redirect writes directly into /etc, truncating before sed runs')
			.not.toMatch(/>\s*\/etc\//)
		expect(text, 'no diff step, so certbot\'s 443 block gets overwritten unseen')
			.toMatch(/diff -u/)
		expect(text, 'the copy is unguarded, so a 0-byte or placeholder-bearing file installs')
			.toMatch(/-s \/tmp\/capmetro-vhost\.new/)
		expect(text, 'nothing refuses a file still holding @PLACEHOLDERS@')
			.toMatch(/grep -q '@\[A-Z_\]\*@'/)
	})

	/*
	 * And the template is still a template. A header rewrite that gutted the directives
	 * would leave every assertion above green while installing a vhost with no
	 * server_name at all -- which is, once again, a fall-through to default_server.
	 */
	it.each(templates)('%s: still carries the placeholders it exists to substitute',
		(_n, file, _re, directive) => {
			const text = readFileSync(path.join(REPO, file), 'utf8')
			const body = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
			expect(body, 'the directive the sed targets is gone from the template body')
				.toContain(directive)
			expect(body).toMatch(/@WEBROOT@/)
		})
})

describe('the same question, asked about the web server config', () => {
	it('reports no drift when nothing has changed', () => {
		writeVhostStamp()
		expect(sh('cm_vhost_drift src/deploy conf/installed-vhost.sha256').code).toBe(0)
	})

	it('names the vhost that changed, and only that one', () => {
		writeVhostStamp()
		editVhost(VHOSTS[0], "add_header Content-Security-Policy \"default-src 'none'\";\n")
		const r = sh('cm_vhost_drift src/deploy conf/installed-vhost.sha256')
		expect(r.code).toBe(1)
		expect(r.stdout.trim().split('\n')).toEqual([ VHOSTS[0] ])
	})

	it('keeps its own record, so installing units does not erase the vhost answer', () => {
		/*
		 * Two stamps rather than more lines in one, because the two are written by different
		 * remedies at different times -- install.sh rewrites the units, a hand cp plus a
		 * reload installs a vhost -- and a single file would be rewritten wholesale by
		 * whichever ran last, losing the other's answer.
		 */
		writeStamp()
		writeVhostStamp()
		expect(sh('cm_unit_stamp_path conf').stdout.trim()).toBe('conf/installed-units.sha256')
		expect(sh('cm_vhost_stamp_path conf').stdout.trim()).toBe('conf/installed-vhost.sha256')
		editVhost(VHOSTS[0])
		/* The vhost moved; the units did not. Each answer is its own. */
		expect(sh('cm_vhost_drift src/deploy conf/installed-vhost.sha256').code).toBe(1)
		expect(sh('cm_unit_drift src/deploy conf/installed-units.sha256').code).toBe(0)
	})

	it('treats a deleted vhost as drift rather than as agreement', () => {
		writeVhostStamp()
		rmSync(path.join(work, 'src/deploy', VHOSTS[0]))
		const r = sh('cm_vhost_drift src/deploy conf/installed-vhost.sha256')
		expect(r.code).toBe(1)
		expect(r.stdout.trim().split('\n')).toEqual([ VHOSTS[0] ])
	})

	it('separates "no record" (2) from "no change" (0)', () => {
		expect(sh('cm_vhost_drift src/deploy conf/nothing-here').code).toBe(2)
	})

	it('refuses to fingerprint at all when no hashing tool exists', () => {
		const r = sh('cm_sha256() { return 3; }\ncm_vhost_fingerprint src/deploy')
		expect(r.code).toBe(3)
		expect(r.stdout.trim()).toBe('')
	})
})

describe('update.sh actually reports vhost drift, and does not change its exit code', () => {
	it('says nothing when the configs agree', () => {
		writeVhostStamp()
		const r = checkVhost()
		expect(r.code).toBe(0)
		expect(r.stdout).not.toMatch(/web server config/)
	})

	it('names the drifted config and the remedy', () => {
		writeVhostStamp()
		editVhost(VHOSTS[0])
		const r = checkVhost({ server: 'nginx' })
		expect(r.stdout).toMatch(/web server config in the checkout has changed/)
		expect(r.stdout).toContain(VHOSTS[0])
		/* The symptom, because there is none on screen and health.json cannot show it. */
		expect(r.stdout).toMatch(/ok:true/)
	})

	it('returns 0 even on confirmed drift, so exit 3 keeps meaning the units', () => {
		/*
		 * 3 is documented in CLAUDE.md, and only there -- install.sh never names the
		 * exit code -- as "the committed SYSTEMD
		 * UNITS are not the ones installed, run install.sh" -- one condition, one remedy.
		 * A vhost needs a different remedy, and widening 3 to "some config is stale" would
		 * make the number ambiguous for whatever eventually reads it, which is the mistake
		 * EXIT_UNIT_DRIFT was split away from 1 to avoid.
		 */
		writeVhostStamp()
		editVhost(VHOSTS[0])
		editVhost(VHOSTS[1])
		expect(checkVhost({ server: 'nginx' }).code).toBe(0)
	})

	it('says nothing at all on a box with no record, rather than nagging every run', () => {
		/*
		 * The expected state of every box installed before this existed, including the live
		 * one. check_units already explains a missing stamp in its own words; repeating it
		 * about the vhosts would be noise on every run forever.
		 */
		const r = checkVhost()
		expect(r.code).toBe(0)
		expect(r.stdout).not.toMatch(/web server config/)
	})

	it('is wired into update.sh ahead of the units check, so exit 3 cannot swallow it', () => {
		/*
		 * check_units exits 3 through `|| exit $?` at its call sites. A check_vhost called
		 * after it would never run on precisely the deploy that changed both.
		 */
		const src = readFileSync(UPDATE, 'utf8')
		/* Call sites only. `check_units() {` matches a bare name regex too, and the
		   definitions appear before every call, so including them made the first "call"
		   a definition and the assertion nonsense. */
		const calls = [...src.matchAll(/^\s*check_(vhost|units)(?!\s*\()\b.*$/gm)].map((m) => m[1])
		expect(calls.length, 'no check_ call sites found').toBeGreaterThan(0)
		/* Every units call is immediately preceded by a vhost call. */
		calls.forEach((name, i) => {
			if (name === 'units') expect(calls[i - 1], `check_units call ${ i } has no check_vhost before it`).toBe('vhost')
		})
	})
})

/*
 * Three bugs an adversarial pass found in check_vhost itself, after it was written. Each one
 * is the kind that only shows up on the box: unattended, as root, once, at 04:00.
 */
describe('the vhost notice cannot take the board down or lie about which file moved', () => {
	it('never prints a copy-paste cp of a config that still has placeholders in it', () => {
		/*
		 * deploy/*-capmetro.conf ship with @DOMAIN@ and @WEBROOT@ unsubstituted, and nginx
		 * takes both as literals: `nginx -t` on that file reports "test is successful", the
		 * reload succeeds, and every URL including /api/health.json then 404s -- with the
		 * working config already overwritten and no copy of it. Verified against real nginx
		 * in a container. So the remedy points at install.sh, which prints the correct sed
		 * for this box, rather than at a cp that config-tests clean and serves nothing.
		 */
		writeVhostStamp()
		editVhost(VHOSTS[0])
		const r = checkVhost({ server: 'nginx' })
		expect(r.stdout).not.toMatch(/\bcp\b.*capmetro\.conf/)
		expect(r.stdout).not.toMatch(/sites-available/)
		expect(r.stdout).toMatch(/install\.sh/)
	})

	it('does not tell an nginx box to reload the apache config that drifted', () => {
		/*
		 * The remedy used to be chosen by which server is INSTALLED and the drift list is
		 * per FILE, so a box running nginx, with only apache-capmetro.conf changed, was told
		 * its config was stale and pointed at the nginx vhost, which had not moved. That is
		 * the mismatched accusation the empty-list guard exists to prevent, arriving by a
		 * different route.
		 */
		writeVhostStamp()
		editVhost(VHOSTS.find((v) => v.startsWith('apache')))
		const r = checkVhost({ server: 'nginx' })
		expect(r.stdout).toMatch(/nothing to do here/)
		/* The REMEDY must not be printed. "install.sh" on its own appears in the headline
		   ("since install.sh last ran"), so matching the bare name asserts nothing. */
		expect(r.stdout).not.toMatch(/sudo .*install\.sh/)
		/* Pointed at the CURRENT headline. It used to match "still serving the OLD one",
		   a sentence update.sh no longer contains -- so it passed without checking
		   anything. The wording moved because the record fingerprints the committed
		   files and cannot see what is installed. */
		expect(r.stdout).not.toMatch(/install\.sh last recorded here/)
	})

	it('cannot be used to zero the unit-drift exit code from the pulled library', () => {
		/*
		 * check_units snapshots EXIT_UNIT_DRIFT before its own source, because a units.sh
		 * that assigned that name would silently zero its verdict. That defense only held
		 * while its source was the first in the shell -- and check_vhost now runs before it
		 * at every call site. Sourcing at function scope here would have reopened the hole
		 * from outside the function that closed it, so check_vhost sources inside a command
		 * substitution and nothing the lib assigns reaches this shell.
		 */
		const hostile = readFileSync(LIB, 'utf8') + '\nEXIT_UNIT_DRIFT=0\n'
		writeVhostStamp()
		const r = checkVhost({ server: 'nginx', lib: hostile })
		expect(r.stdout).toMatch(/EXIT_UNIT_DRIFT_AFTER=3/)
	})
})

describe('the deploy that carries a vhost change, on a box with no record yet', () => {
	/*
	 * The case the detector was written for, and the one it originally could not announce.
	 *
	 * The vhost stamp is written only by install.sh; update.sh never runs install.sh. So on
	 * the first deploy carrying this feature there is no record, and the no-record branch is
	 * silent on the stated grounds that "check_units has already explained a missing stamp".
	 * That premise fails exactly when a deploy changes a vhost and NO unit file -- which is
	 * what the branch introducing vhost detection does -- because check_units then finds its
	 * own stamp intact, returns 0 silently, and nobody is ever told to run install.sh.
	 *
	 * Result without this: code and client land, the vhost does not, both checks say
	 * nothing, exit 0, health.json ok:true, and the board is quietly not installable.
	 */
	function repoWithVhostChange({ touchVhost }) {
		const src = path.join(work, 'src')
		const git = (...args) => execFileSync('git', args, { cwd: src, encoding: 'utf8' })
		git('init', '-q')
		git('config', 'user.email', 't@example.test')
		git('config', 'user.name', 'test')
		git('add', '-A')
		git('commit', '-qm', 'before')
		const before = git('rev-parse', 'HEAD').trim()
		if (touchVhost) editVhost(VHOSTS[0], "add_header X-Test 1;\n")
		else writeFileSync(path.join(src, 'deploy', 'something-else.txt'), 'unrelated\n')
		git('add', '-A')
		git('commit', '-qm', 'after')
		return { before, after: git('rev-parse', 'HEAD').trim() }
	}

	it('says so when this deploy changed a vhost and nothing has ever recorded one', () => {
		const { before, after } = repoWithVhostChange({ touchVhost: true })
		const r = checkVhost({ server: 'nginx', before, after })
		expect(r.code).toBe(0)
		/*
		 * The sentinel proves the function RETURNED rather than taking the script down with
		 * it. The reporting path used to pipe git's output into a `while` loop, and under
		 * `pipefail` that pipeline is check_vhost's last command while check_vhost is called
		 * bare -- so a non-zero git (128 on an unreadable checkout) or a trailing blank line
		 * (which makes the loop's own last command `[ -n "" ]`) killed update.sh, on the
		 * path where the deploy had ALREADY succeeded. Both reproduced before the fix.
		 */
		expect(r.stdout, 'check_vhost aborted instead of returning').toMatch(/EXIT_UNIT_DRIFT_AFTER=/)
		expect(r.stdout).toMatch(/this deploy changed the web server config/)
		expect(r.stdout).toContain(VHOSTS[0])
		expect(r.stdout).toMatch(/install\.sh/)
		/* certbot rewrites the installed nginx block, so a plain copy destroys the TLS
		   config even with the placeholders filled. Never print a bare cp. */
		expect(r.stdout).toMatch(/certbot/)
		expect(r.stdout).not.toMatch(/sudo cp /)
	})

	it('stays quiet when the deploy changed no vhost, so it is not wallpaper', () => {
		const { before, after } = repoWithVhostChange({ touchVhost: false })
		const r = checkVhost({ server: 'nginx', before, after })
		expect(r.stdout).not.toMatch(/web server config/)
	})

	it('stays quiet when git cannot answer, rather than nagging forever', () => {
		/*
		 * git exits 129 in a directory that is not a repository, and `! git diff --quiet`
		 * turns that into "the vhost changed" -- so a checkout git could not read would
		 * print this on every single run. The status is read explicitly; only 1 counts.
		 */
		const r = checkVhost({ server: 'nginx', before: 'deadbee', after: 'f00ba12' })
		expect(r.stdout).not.toMatch(/this deploy changed the web server config/)
	})
})

describe('the drift contract is written in two files and must not desynchronize', () => {
	it('keeps CM_DRIFT_* at the numbers update.sh compares against', () => {
		/*
		 * check_vhost reads cm_drift's status with literals rather than the CM_DRIFT_*
		 * constants, on purpose: those constants come from the pulled library, and reading
		 * them from the code under inspection is the same class of hole as letting it
		 * reassign EXIT_UNIT_DRIFT -- a units.sh with CM_DRIFT_FOUND=0 would make "they
		 * agree" and "they differ" the same answer. The cost of literals is that the
		 * contract now lives in two files, so it is pinned here.
		 */
		const got = sh('printf "%s %s %s %s\\n" "$CM_DRIFT_SAME" "$CM_DRIFT_FOUND" ' +
			'"$CM_DRIFT_NO_STAMP" "$CM_DRIFT_NO_TOOL"')
		expect(got.stdout.trim()).toBe('0 1 2 3')
	})
})

describe('a file list the record format cannot represent', () => {
	/*
	 * The stamp is `<hash>  <name>` and every consumer splits on whitespace: the
	 * well-formedness pattern ends `[^ ][^ ]*$` and the lookups match awk's $2. A name
	 * containing a space cannot round-trip -- it writes a line that fails its own
	 * validation, and cm_drift then answers "there is no record" for a file that has one.
	 * A durable, confident, WRONG "cannot tell", which is what the four-outcome contract
	 * exists to prevent. Quoting does not fix it; the format has no room for the name. So
	 * the list is refused as NO_TOOL instead: not knowing, reported as not knowing.
	 */
	const withNames = (names, body) => {
		const dir = path.join(work, 'weird')
		mkdirSync(path.join(dir, 'deploy'), { recursive: true })
		mkdirSync(path.join(dir, 'conf'), { recursive: true })
		for (const n of names) writeFileSync(path.join(dir, 'deploy', n), `body of ${ n }\n`)
		return sh(body.replaceAll('<D>', `${ dir }`))
	}

	it('refuses a name with a space rather than reporting a phantom missing record', () => {
		const r = withNames(['my conf.conf', 'apache-capmetro.conf'],
			`cm_drift '<D>/deploy' '<D>/conf/none' 'my conf.conf' apache-capmetro.conf`)
		expect(r.code, 'a space in a name must answer NO_TOOL (3), never NO_STAMP (2)').toBe(3)
	})

	it('refuses to fingerprint one either, rather than writing a record that cannot be read', () => {
		const r = withNames(['my conf.conf'], `cm_fingerprint '<D>/deploy' 'my conf.conf'`)
		expect(r.code).toBe(3)
		expect(r.stdout.trim()).toBe('')
	})

	it('handles a glob character in a name, which quoting DOES fix', () => {
		/*
		 * Distinct from the space case: `a*.conf` round-trips through the format fine, and
		 * the bug was purely that the comparison loops re-split an already-correct argument
		 * list through `local files="$*"`. Before the fix the drifted file was not named at
		 * all; the verdict and its explanation had come apart, which the single-comparison
		 * rule exists to forbid.
		 */
		const dir = path.join(work, 'globby')
		mkdirSync(path.join(dir, 'deploy'), { recursive: true })
		mkdirSync(path.join(dir, 'conf'), { recursive: true })
		writeFileSync(path.join(dir, 'deploy', 'a*.conf'), 'one\n')
		writeFileSync(path.join(dir, 'deploy', 'aXX.conf'), 'decoy\n')
		writeFileSync(path.join(dir, 'deploy', 'apache-capmetro.conf'), 'two\n')
		expect(sh(`cm_write_stamp_for '${ dir }/deploy' '${ dir }/conf/s' 'a*.conf' apache-capmetro.conf`).code).toBe(0)
		expect(sh(`cm_drift '${ dir }/deploy' '${ dir }/conf/s' 'a*.conf' apache-capmetro.conf`).code).toBe(0)
		writeFileSync(path.join(dir, 'deploy', 'a*.conf'), 'changed\n')
		const r = sh(`cm_drift '${ dir }/deploy' '${ dir }/conf/s' 'a*.conf' apache-capmetro.conf`)
		expect(r.code).toBe(1)
		expect(r.stdout.trim().split('\n')).toEqual(['a*.conf'])
	})
})

describe('a diagnostic must never take down a deploy that already succeeded', () => {
	it('survives git failing while it is listing the changed configs', () => {
		/*
		 * The exact hazard, driven rather than argued. check_vhost is called BARE at every
		 * site -- `check_vhost`, not `check_vhost || true` -- so under `pipefail` any
		 * pipeline that is its last command takes update.sh with it when it fails. The
		 * reporting path used to pipe `git diff --name-only` into a `while` loop, and git
		 * answers 128 on a checkout it cannot read. That would abort the script on the path
		 * where the code and the schedule are ALREADY live.
		 *
		 * The stub says "they differ" to the --quiet probe, so the branch is entered, then
		 * fails the --name-only call the way an unreadable checkout would. The sentinel
		 * printed after the call is the assertion: if check_vhost aborts, it never appears.
		 */
		writeFileSync(path.join(work, 'conf/installed-vhost.sha256'), '')
		rmSync(path.join(work, 'conf/installed-vhost.sha256'))
		const gitStub = [
			'#!/bin/sh',
			'for a in "$@"; do',
			'  [ "$a" = "--quiet" ] && exit 1',      // differences: enter the branch
			'  [ "$a" = "--name-only" ] && exit 128', // then fail, as an unreadable checkout does
			'done',
			'exit 0',
		].join('\n') + '\n'
		const r = checkVhost({ server: 'nginx', before: 'aaaaaaa', after: 'bbbbbbb', gitStub })
		expect(r.stdout, 'check_vhost aborted the script when git failed').toMatch(/EXIT_UNIT_DRIFT_AFTER=/)
		expect(r.code).toBe(0)
	})

	it('survives a blank line in the list of changed configs', () => {
		/*
		 * The second trigger, and the subtler one: with `[ -n "$f" ] && loud ...` as the
		 * loop body, a trailing blank line leaves a failed test as the loop's last command,
		 * so the loop exits 1 -- and in a pipeline under pipefail that is the whole
		 * command's status. `printf 'a\n\n' | while ...; done; echo TAIL` never reaches
		 * TAIL under set -euo pipefail. A here-string does not have this property.
		 */
		const gitStub = [
			'#!/bin/sh',
			'for a in "$@"; do',
			'  [ "$a" = "--quiet" ] && exit 1',
			'  [ "$a" = "--name-only" ] && { printf "nginx-capmetro.conf\\n\\n"; exit 0; }',
			'done',
			'exit 0',
		].join('\n') + '\n'
		const r = checkVhost({ server: 'nginx', before: 'aaaaaaa', after: 'bbbbbbb', gitStub })
		expect(r.stdout, 'a blank line in git output aborted the script').toMatch(/EXIT_UNIT_DRIFT_AFTER=/)
		expect(r.stdout).toContain('nginx-capmetro.conf')
		expect(r.code).toBe(0)
	})
})

describe('after a rollback, the notice must not describe a change that is gone', () => {
	function repoWithVhostChange({ touchVhost }) {
		const src = path.join(work, 'src')
		const git = (...args) => execFileSync('git', args, { cwd: src, encoding: 'utf8' })
		git('init', '-q')
		git('config', 'user.email', 't@example.test')
		git('config', 'user.name', 'test')
		git('add', '-A')
		git('commit', '-qm', 'before')
		const before = git('rev-parse', 'HEAD').trim()
		if (touchVhost) editVhost(VHOSTS[0], "add_header X-Test 1;\n")
		git('add', '-A')
		git('commit', '-qm', 'after')
		return { before, after: git('rev-parse', 'HEAD').trim() }
	}

	it('says nothing about the pulled range once the checkout has been reset', () => {
		/*
		 * The rc=2 branch reasons about what THIS DEPLOY changed. On the rollback path
		 * `git reset --hard "$BEFORE"` has already put the checkout back -- but both commit
		 * objects still exist, so `git diff BEFORE AFTER` still answers "the vhost changed"
		 * and the branch would announce a change that is no longer in the tree, then send
		 * the operator to install.sh. install.sh would record, and tell them to install,
		 * the OLD vhost as if it were the new one.
		 *
		 * check_units carries a context argument for exactly this reason, seven lines after
		 * its own reset. check_vhost was written without one.
		 */
		const { before, after } = repoWithVhostChange({ touchVhost: true })
		const deployed = checkVhost({ server: 'nginx', before, after })
		expect(deployed.stdout, 'the deployed path should still announce it')
			.toMatch(/this deploy changed the web server config/)

		const rolled = checkVhost({ server: 'nginx', before, after, context: 'rolled-back' })
		expect(rolled.stdout, 'announced a vhost change that the rollback removed')
			.not.toMatch(/this deploy changed the web server config/)
		expect(rolled.stdout, 'check_vhost aborted on the rollback path').toMatch(/EXIT_UNIT_DRIFT_AFTER=/)
		expect(rolled.code).toBe(0)
	})
})

describe('the guards that only matter when the record is already wrong', () => {
	it('rejects a stamp naming the same file twice, instead of accusing the other one', () => {
		/*
		 * The duplicate-name guard. A record carrying two lines for nginx-capmetro.conf and
		 * none for apache-capmetro.conf passes both count checks -- the right number of
		 * well-formed lines, the right total -- so without this guard apache has no recorded
		 * hash, compares unequal to itself, and is reported as drifted. A confident,
		 * specific, false accusation about a file nobody touched, which is precisely what
		 * the four-outcome contract exists to forbid. Deleting the guard left all 90 tests
		 * green before this.
		 */
		writeVhostStamp()
		const stamp = path.join(work, 'conf/installed-vhost.sha256')
		const lines = readFileSync(stamp, 'utf8').trim().split('\n')
		expect(lines).toHaveLength(2)
		/* Same count, same shape, one name twice. */
		const hash = lines[0].split(/\s+/)[0]
		writeFileSync(stamp, `${ hash }  ${ VHOSTS[0] }\n${ hash }  ${ VHOSTS[0] }\n`)
		const r = sh(`cm_vhost_drift '${ work }/src/deploy' '${ stamp }' ${ VHOSTS.join(' ') }`)
		expect(r.code, 'a duplicated name must be NO_STAMP (2), never a drift verdict').toBe(2)
		expect(r.stdout.trim(), 'it named a file as drifted on a corrupt record').toBe('')
	})

	it('refuses to hash at all when neither hashing tool exists', () => {
		/*
		 * cm_sha256's last arm, which no test reached: every other test either stubs
		 * cm_sha256 itself or shadows sha256sum/shasum as a shell FUNCTION -- and
		 * `command -v` finds a function, so the real "neither binary is installed" path
		 * never ran. Replacing its return with a literal placeholder hash left all 90 tests
		 * green, which is the anti-pattern its own comment forbids in as many words: a
		 * stand-in makes every file compare equal to every other, so drift reads clean
		 * forever.
		 *
		 * PATH is emptied rather than the tools stubbed, so the absence is real.
		 */
		const r = sh(`PATH= cm_fingerprint '${ work }/src/deploy' ${ VHOSTS.join(' ') }`)
		expect(r.code, 'no hashing tool must be NO_TOOL (3)').toBe(3)
		expect(r.stdout.trim(), 'it emitted a fingerprint with no way to compute one').toBe('')
	})
})
