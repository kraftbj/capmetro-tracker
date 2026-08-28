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
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
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
		stub('runuser', 'shift 2; [ "$1" = "--" ] && shift; exec "$@"')
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
