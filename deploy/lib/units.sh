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

CM_UNIT_FILES='capmetro-generate.service capmetro-generate.timer capmetro-update.service capmetro-update.timer'

# Ubuntu ships sha256sum; macOS ships shasum. The tests run on whichever the developer has.
cm_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    printf 'no-sha256-tool\n'
  fi
}

# cm_unit_fingerprint <deploy-dir>
#
# One `<hash>  <name>` line per unit, in a fixed order so the output is comparable as text.
# A missing file is recorded as `missing` rather than skipped: a unit that disappears from
# the checkout is exactly as much of a change as one that was edited, and dropping the line
# would make the two fingerprints match by omission.
cm_unit_fingerprint() {
  _cm_dir="$1"
  for _cm_f in $CM_UNIT_FILES; do
    if [ -f "$_cm_dir/$_cm_f" ]; then
      printf '%s  %s\n' "$(cm_sha256 "$_cm_dir/$_cm_f")" "$_cm_f"
    else
      printf 'missing  %s\n' "$_cm_f"
    fi
  done
  unset _cm_dir _cm_f
}

# cm_unit_stamp_path <state-dir>
cm_unit_stamp_path() {
  printf '%s/installed-units.sha256\n' "${1%/}"
}

# cm_unit_drift <deploy-dir> <stamp-file>
#
# Prints the names of the units whose source has changed since the stamp was written, one per
# line, and exits non-zero when there are any. Exits non-zero with no output when the stamp is
# absent, which means "unknown", not "unchanged" -- the caller has to say which it is.
cm_unit_drift() {
  _cm_deploy="$1"
  _cm_stamp="$2"
  [ -f "$_cm_stamp" ] || { unset _cm_deploy _cm_stamp; return 2; }

  _cm_now=$(cm_unit_fingerprint "$_cm_deploy")
  _cm_was=$(cat "$_cm_stamp")
  if [ "$_cm_now" = "$_cm_was" ]; then
    unset _cm_deploy _cm_stamp _cm_now _cm_was
    return 0
  fi

  for _cm_f in $CM_UNIT_FILES; do
    _cm_a=$(printf '%s\n' "$_cm_now" | awk -v n="$_cm_f" '$2==n {print $1}')
    _cm_b=$(printf '%s\n' "$_cm_was" | awk -v n="$_cm_f" '$2==n {print $1}')
    [ "$_cm_a" = "$_cm_b" ] || printf '%s\n' "$_cm_f"
  done
  unset _cm_deploy _cm_stamp _cm_now _cm_was _cm_f _cm_a _cm_b
  return 1
}
