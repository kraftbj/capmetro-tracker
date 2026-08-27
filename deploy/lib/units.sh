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

# Ubuntu ships sha256sum; macOS ships shasum. The tests run on whichever the developer has.
#
# Returns non-zero and prints nothing when neither exists. An earlier version printed the
# literal string `no-sha256-tool` instead, which is the worst thing it could have done: every
# file hashes to the same value, every fingerprint matches every other fingerprint, and drift
# is reported as clean forever. That is this repo's signature failure -- a skip that reads as a
# pass -- and it would have hidden the exact condition this file exists to surface.
cm_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 3
  fi
}

# cm_unit_fingerprint <deploy-dir>
#
# One `<hash>  <name>` line per unit, in a fixed order so the output is comparable as text.
# A missing file is recorded as `missing` rather than skipped: a unit that disappears from
# the checkout is exactly as much of a change as one that was edited, and dropping the line
# would make the two fingerprints match by omission.
# Returns 3 without printing anything when no hashing tool is available, so a box that cannot
# compute a fingerprint says so rather than emitting one that compares equal to everything.
cm_unit_fingerprint() {
  local dir="$1" f hash out=""
  for f in $CM_UNIT_FILES; do
    if [ -f "$dir/$f" ]; then
      hash=$(cm_sha256 "$dir/$f") || return 3
      out="$out$hash  $f
"
    else
      out="${out}missing  $f
"
    fi
  done
  printf '%s' "$out"
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
#   3  no hashing tool exists, so the question cannot be answered
#
# Keeping 2 and 3 distinct from 0 is the whole contract. runtime/lib/upstream.php makes the
# same call for the same reason: a probe that could not answer reports nothing and never
# reports a mismatch it is not sure of. Collapsing "I cannot tell" into "unchanged" would
# report a clean bill of health for precisely the state this file exists to catch.
cm_unit_drift() {
  local deploy="$1" stamp="$2" now was f a b drifted want lines
  [ -f "$stamp" ] || return 2

  now=$(cm_unit_fingerprint "$deploy") || return 3
  was=$(cat "$stamp") || return 2

  # The stamp has to actually parse before it can be believed. A zero-byte, truncated or
  # hand-mangled record would otherwise make every unit's recorded hash empty, differ from
  # every real hash, and be reported as "all four units drifted" -- a confident, specific,
  # wrong accusation about a box where nothing drifted. Corruption is not drift; it is
  # another way of not knowing, and this file's whole contract is that the two stay apart.
  # Exactly one line per unit, no extras.
  want=$(printf '%s\n' $CM_UNIT_FILES | wc -l | tr -d ' ')
  lines=$(printf '%s\n' "$was" | grep -c '^[^ ][^ ]*  [^ ][^ ]*$' || true)
  if [ "$lines" != "$want" ]; then
    return 2
  fi
  for f in $CM_UNIT_FILES; do
    if [ "$(printf '%s\n' "$was" | awk -v n="$f" '$2==n' | wc -l | tr -d ' ')" != "1" ]; then
      return 2
    fi
  done

  # Decided per unit, and ONLY per unit. An earlier version compared the two fingerprints as
  # whole text first and returned 1 on any difference, then re-derived the names with this
  # loop -- two different tests that can disagree. A stamp with reordered lines, a trailing
  # blank, or any byte the loop does not look at made the text comparison say "drift" while
  # the loop named nothing, so update.sh printed "the units have changed:" followed by an
  # empty list and failed forever with no way to tell which unit was at fault.
  #
  # One test now decides both the answer and the report, so rc=1 always names at least one
  # unit. A stamp that is empty or missing lines makes every unit's recorded hash empty, which
  # differs from its real hash, so all four are named -- honest, and pointing at install.sh.
  local drifted=0
  for f in $CM_UNIT_FILES; do
    a=$(printf '%s\n' "$now" | awk -v n="$f" '$2==n {print $1}')
    b=$(printf '%s\n' "$was" | awk -v n="$f" '$2==n {print $1}')
    if [ "$a" != "$b" ]; then
      printf '%s\n' "$f"
      drifted=1
    fi
  done
  return "$drifted"
}
