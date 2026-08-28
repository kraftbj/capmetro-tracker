# Which systemd units this deployment owns, and how to tell whether the ones on the box
# were built from the unit files currently in the checkout.
#
# Sourced by install.sh (which writes the record) and update.sh (which checks it). Shared
# rather than copied: the whole failure this guards against is two places disagreeing about
# what is deployed, and a second copy of the list would be a third place to disagree.
#
# WHY A FINGERPRINT OF THE SOURCE, NOT A DIFF OF THE INSTALLED FILES.
#
# install.sh does not copy three of these four units; it renders them, substituting
# @RUN_USER@, @GEN@, @WEBROOT@, @STATE_DIR@, @INTERVAL_S@ and @UPDATE@ from flags and from
# the machine it is running on. So the file in /etc/systemd/system never equals the file in
# deploy/, and a diff of the two reports drift on a perfectly current box, every time.
#
# Re-rendering them here to compare like with like would need the flags install.sh was
# invoked with, which are not recorded anywhere and are not update.sh's to guess: --interval
# in particular is invisible from the outside, since the installed timer is the only place
# the chosen value survives. Hashing the SOURCE files sidesteps the substitution entirely and
# answers the question actually being asked -- "have the unit definitions in the repo changed
# since anyone last ran install.sh?" -- which is the condition that leaves the box running a
# schedule the repo no longer describes.
#
# The trade: a unit hand-edited directly in /etc/systemd/system is invisible to this. That is
# a different failure with a different fix, and pretending to catch it would mean claiming a
# guarantee this cannot make.
#
# shellcheck shell=bash
# Sourced, never executed, so it carries no shebang. Both callers are bash and this file uses
# `local`, so it is not portable to a POSIX sh caller and does not pretend to be.

CM_UNIT_FILES='capmetro-generate.service capmetro-generate.timer capmetro-update.service capmetro-update.timer'

# cm_unit_drift's four answers, named. The numbers are local to this function and mean
# nothing outside it -- in particular update.sh's EXIT_UNIT_DRIFT is also 3 and is the
# OPPOSITE kind of answer (a confirmed difference, not an inability to tell). Same numeral,
# different layer, so both ends are named rather than left as digits to be recognized.
CM_DRIFT_SAME=0
CM_DRIFT_FOUND=1
CM_DRIFT_NO_STAMP=2
CM_DRIFT_NO_TOOL=3

# Ubuntu ships sha256sum; macOS ships shasum. The tests run on whichever the developer has.
#
# Returns non-zero and prints NOTHING when neither exists. Never a placeholder value: a
# stand-in hash makes every file compare equal to every other, so drift reads as clean
# forever -- a skip that reads as a pass, hiding the exact condition this file surfaces.
cm_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return "$CM_DRIFT_NO_TOOL"
  fi
}

# cm_unit_fingerprint <deploy-dir>
#
# One `<hash>  <name>` line per unit, in a fixed order so the output is comparable as text.
# A missing file is recorded as `missing` rather than skipped: a unit that disappears from
# the checkout is exactly as much of a change as one that was edited, and dropping the line
# would make the two fingerprints match by omission.
# Returns CM_DRIFT_NO_TOOL without printing anything when a hash cannot be computed, so a box
# that cannot answer says so rather than emitting a fingerprint that compares equal to
# everything.
cm_unit_fingerprint() {
  local dir="$1" f hash out=""
  for f in $CM_UNIT_FILES; do
    if [ -f "$dir/$f" ]; then
      hash=$(cm_sha256 "$dir/$f") || return "$CM_DRIFT_NO_TOOL"
      out="$out$hash  $f
"
    else
      out="${out}missing  $f
"
    fi
  done
  printf '%s' "$out"
}

# Is systemd actually running here, such that this deployment's units are its business?
#
# systemctl can exist where systemd is not pid 1 -- a container, a chroot, WSL -- so the test
# is /run/systemd/system, which is what sd_booted(3) checks and what Debian's own maintainer
# scripts use. It was the only one of three candidates right in every case: systemctl is
# absent from a base ubuntu image but arrives as a dependency of cron, and
# `systemctl is-system-running` sent the installer down the systemd path on a box with no
# systemd, which then died at daemon-reload with the directories and config already created.
#
# Lives here because install.sh and update.sh must agree on it. They did not: install.sh
# asked both halves and update.sh only the directory, so a box with the directory and no
# systemctl got the cron install from one and questions about units it does not own from the
# other. The overrides exist so this is testable off a systemd box; nothing sets them in
# production.
cm_systemd_live() {
  # An override in effect says so on stderr. Both of these can point the probe at something
  # that does not exist, which makes the whole drift check return "not my kind of box" and
  # pass -- a switch that fails OPEN. It stays overridable because that is what makes the
  # function testable off a systemd box, but it can no longer do it quietly.
  if [ -n "${SYSTEMD_MARKER:-}" ] || [ -n "${SYSTEMCTL_BIN:-}" ]; then
    printf 'cm_systemd_live: overridden (marker=%s systemctl=%s)\n' \
      "${SYSTEMD_MARKER:-default}" "${SYSTEMCTL_BIN:-default}" >&2
  fi
  [ -d "${SYSTEMD_MARKER:-/run/systemd/system}" ] \
    && command -v "${SYSTEMCTL_BIN:-systemctl}" >/dev/null 2>&1
}

# cm_unit_stamp_path <state-dir>
cm_unit_stamp_path() {
  printf '%s/installed-units.sha256\n' "${1%/}"
}

# cm_unit_drift <deploy-dir> <stamp-file>
#
# Four outcomes, and the two "unknown" ones are deliberately NOT folded into either answer:
#
#   0  the sources agree with the stamp
#   1  they differ; the drifted unit names are printed, one per line
#   2  no stamp exists, so the question cannot be answered
#   3  a hash could not be computed (no sha256sum or shasum, or a unit file unreadable),
#      so the question cannot be answered
#
# Keeping 2 and 3 distinct from 0 is the whole contract. runtime/lib/upstream.php makes the
# same call for the same reason: a probe that could not answer reports nothing and never
# reports a mismatch it is not sure of. Collapsing "I cannot tell" into "unchanged" would
# report a clean bill of health for precisely the state this file exists to catch.
cm_unit_drift() {
  local deploy="$1" stamp="$2" now was f a b drifted want lines total
  [ -f "$stamp" ] || return "$CM_DRIFT_NO_STAMP"

  now=$(cm_unit_fingerprint "$deploy") || return "$CM_DRIFT_NO_TOOL"
  was=$(cat "$stamp") || return "$CM_DRIFT_NO_STAMP"

  # The stamp has to actually parse before it can be believed. A zero-byte, truncated or
  # hand-mangled record would otherwise make every unit's recorded hash empty, differ from
  # every real hash, and be reported as "all four units drifted" -- a confident, specific,
  # wrong accusation about a box where nothing drifted. Corruption is not drift; it is
  # another way of not knowing, and this file's whole contract is that the two stay apart.
  # Exactly one well-formed line per unit, and nothing else in the file. Both counts are
  # load-bearing: the well-formed tally alone accepts a stamp carrying junk that simply fails
  # to match the pattern, and the total alone accepts four malformed lines.
  #
  # "Well-formed" means the two things install.sh actually writes -- a sha256 digest or the
  # literal `missing`. A looser "any non-space token" pattern accepted a record whose hash
  # fields were arbitrary text, which then compared unequal to every real hash and was
  # reported as confirmed drift: a corrupt stamp laundered into a specific accusation.
  want=$(printf '%s\n' $CM_UNIT_FILES | wc -l | tr -d ' ')
  lines=$(printf '%s\n' "$was" | grep -c '^\([0-9a-f]\{64\}\|missing\)  [^ ][^ ]*$' || true)
  total=$(printf '%s\n' "$was" | grep -c . || true)
  if [ "$lines" != "$want" ] || [ "$total" != "$want" ]; then
    return "$CM_DRIFT_NO_STAMP"
  fi
  for f in $CM_UNIT_FILES; do
    if [ "$(printf '%s\n' "$was" | awk -v n="$f" '$2==n' | wc -l | tr -d ' ')" != "1" ]; then
      return "$CM_DRIFT_NO_STAMP"
    fi
  done

  # One comparison decides both the verdict and the report, so rc=1 always names at least one
  # unit. Deciding drift by one test and explaining it by another lets the two disagree, and
  # "the units have changed:" followed by an empty list is a permanent failure with nothing
  # to act on.
  local drifted="$CM_DRIFT_SAME"
  for f in $CM_UNIT_FILES; do
    a=$(printf '%s\n' "$now" | awk -v n="$f" '$2==n {print $1}')
    b=$(printf '%s\n' "$was" | awk -v n="$f" '$2==n {print $1}')
    if [ "$a" != "$b" ]; then
      printf '%s\n' "$f"
      drifted="$CM_DRIFT_FOUND"
    fi
  done
  return "$drifted"
}
