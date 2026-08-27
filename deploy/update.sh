#!/usr/bin/env bash
#
# update.sh — pull the latest code and republish the client.
#
#   /srv/capmetro/src/deploy/update.sh   (as root)
#
# Deliberately does NOT touch /etc/capmetro/config.php, and does not restart the
# timer: the generator is a oneshot that picks up new code on its next firing,
# so there is no window where the board is down for a deploy.
#
# It does not install systemd units either, and that silence used to be the bug. Only
# install.sh writes /etc/systemd/system, so a committed change to a .timer or .service
# merged, deployed, and then did nothing at all. capmetro-update.timer was moved off 04:17
# UTC on 2026-08-27 precisely because 04:17 is seven hours BEFORE the GTFS job commits at
# 11:20, meaning a rebuilt schedule waited a full day; the fix reached the box and the box
# kept firing at 04:17. This script still does not install units -- restarting timers from
# inside the timer-driven service that is running is its own hazard -- but it now NOTICES,
# and says so in a way that survives being read later. See the note in deploy/lib/units.sh.
#
# The check runs on every path where the deploy itself got far enough to have an answer:
# the no-op path, the generator-clean path, and the rollback path. It does NOT run on the
# hard refusals above it -- not root, no git checkout, not a fast-forward -- because those
# exit before the checkout has been touched and the units are not the story.
set -euo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

SRC_DIR="${SRC_DIR:-/srv/capmetro/src}"
WEBROOT="${WEBROOT:-/var/www/capmetro}"
RUN_USER="${RUN_USER:-capmetro}"
BRANCH="${BRANCH:-trunk}"
CONF="${CONF:-/etc/capmetro/config.php}"
CONF_DIR="${CONF_DIR:-/etc/capmetro}"

# See install.sh: a minimal Debian has no sudo, runuser is always there.
as_user() {
  local u="$1"; shift
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$u" -- "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$u" "$@"
  else
    printf 'xx neither runuser nor sudo is available\n' >&2; exit 1
  fi
}

say() { [ "$QUIET" = 1 ] || printf '\033[1m==\033[0m %s\n' "$*"; }
# Never silenced. A timer that fails quietly is worse than no timer.
loud() { printf '\033[1m==\033[0m %s\n' "$*"; }
die() { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# systemd unit drift
# ---------------------------------------------------------------------------

# Exit status for "the deploy worked, but the units on disk are behind the repo". Distinct
# from 1 on purpose: 1 already means the deploy itself failed and rolled back, and collapsing
# the two teaches whoever eventually wires up alerting (issue 11) that a red capmetro-update
# is ambiguous and therefore ignorable.
readonly EXIT_UNIT_DRIFT=3

# Reports whether the unit files in the checkout still match the ones install.sh rendered
# from. Returns 0 when they agree, when the question does not apply, or when it cannot be
# answered; EXIT_UNIT_DRIFT when they genuinely differ.
#
# Not-knowing returns 0 deliberately. An absent stamp is the expected state of every box
# installed before this feature existed, including this one, and failing on it would put
# capmetro-update.service into FAILED four times a day for a condition that is not drift and
# that no amount of re-running will clear. runtime/lib/upstream.php draws the same line for
# the same reason: a probe that could not answer reports nothing and never reports a mismatch
# it is not sure of. The warning still reaches the journal on every run, so the state stays
# visible without being fatal.
#
# Never touches anything: this is the "notices but does not act" contract from the header,
# and acting would mean restarting a timer from inside its own service.
# $1 is the caller's context: `deployed` (the code and schedule went live) or `rolled-back`
# (they did not). It only decides which sentences are true enough to print.
check_units() {
  local context="${1:-deployed}"
  # A box with no systemd running got a cron entry instead and owns none of these units, so
  # there is nothing here for it to be behind on. Its /etc/cron.d/capmetro has the same
  # shape of problem -- install.sh writes it, update.sh does not refresh it -- but that file
  # is generated inline rather than committed, so it has no source to fingerprint and is not
  # covered here. The systemd path is the one this deployment actually runs.
  # The SAME two-part probe install.sh uses (it checks the directory AND systemctl before it
  # installs units or writes a stamp). Checking only the directory made the two asymmetric: a
  # box with /run/systemd/system but no systemctl binary gets the cron install and no stamp,
  # yet would still have been asked about units it does not own.
  # Both halves are overridable so this function can be exercised off a systemd box. The
  # defaults are the real thing; nothing in production sets either variable.
  { [ -d "${SYSTEMD_MARKER:-/run/systemd/system}" ] \
    && command -v "${SYSTEMCTL_BIN:-systemctl}" >/dev/null 2>&1; } || return 0

  local lib="$SRC_DIR/deploy/lib/units.sh"
  if [ ! -f "$lib" ]; then
    return 0   # a checkout older than this feature; nothing to compare against
  fi
  # shellcheck source=deploy/lib/units.sh
  . "$lib"

  # CONF_DIR, not the state dir: install.sh chowns the state dir to the nologin job account,
  # and a stamp that account can rewrite is a check it can switch off.
  local stamp drift rc=0
  stamp="$(cm_unit_stamp_path "$CONF_DIR")"
  # `|| rc=$?` rather than toggling errexit off and back on. The earlier version ended with a
  # bare `set -e`, which does not restore the caller's setting -- it forces errexit ON. Under
  # this script that was invisible because errexit is always on, but it made the function
  # unusable from anywhere that had deliberately turned it off, including its own test.
  # A failing left-hand side of `||` is exempt from errexit, so nothing needs toggling.
  drift=$(cm_unit_drift "$SRC_DIR/deploy" "$stamp") || rc=$?

  case "$rc" in
    0) return 0 ;;
    2)
      if [ -f "$stamp" ]; then
        loud "the record of which systemd units are installed is unreadable: $stamp"
        loud "it does not parse, so it cannot be compared. Rewrite it with:"
      else
        loud "cannot tell which systemd units are installed: no record at $stamp"
        loud "this is normal on a box installed before that record existed. Write it with:"
      fi
      loud "    sudo $SRC_DIR/deploy/install.sh"
      loud "until then a unit change would deploy silently, but nothing else is wrong."
      return 0
      ;;
    3)
      loud "cannot fingerprint the systemd units: no sha256sum or shasum on this box"
      loud "drift detection is off until one is installed. Nothing else is wrong."
      return 0
      ;;
  esac

  loud "the systemd units in the checkout have changed since install.sh last ran:"
  # A here-string, not a pipe: the loop must run in THIS shell so `loud` output is not the
  # only thing that survives it. A piped `while` is a subshell, which worked here by luck.
  local u
  while IFS= read -r u; do
    [ -n "$u" ] && loud "    $u"
  done <<< "$drift"
  loud "the box is still running the OLD ones."
  # Only on the paths where it is true. Called from the rollback branch this used to print
  # "the code and the schedule data above are up to date" immediately after `git reset --hard`
  # had put the previous commit back -- a reassurance that was precisely false at the one
  # moment someone would be reading it closely.
  if [ "$context" = deployed ]; then
    loud "the code and the schedule data above are up to date; only the units are behind."
  fi
  loud "Apply them with:"
  loud "    sudo $SRC_DIR/deploy/install.sh"
  return "$EXIT_UNIT_DRIFT"
}

# ---------------------------------------------------------------------------
# Everything above is definitions; everything below deploys. Sourcing this file with
# CM_UPDATE_SH_LIB_ONLY=1 stops here, which is how tests/node/deploy-unit-drift.test.mjs
# exercises check_units for real instead of grepping this file for the string "check_units".
# A regex cannot tell a live call from a commented-out one, and the bug this whole feature
# exists to prevent is a check that looks present and does nothing.
# ---------------------------------------------------------------------------
if [ "${CM_UPDATE_SH_LIB_ONLY:-0}" = 1 ]; then
  return 0
fi

[ "$(id -u)" = 0 ] || die "run as root"
if [ ! -d "$SRC_DIR/.git" ]; then
  die "no git checkout at $SRC_DIR. If you deployed with --src-from, update the
     same way: rsync the tree up again and re-run install.sh --src-from <path>."
fi

# git runs as root, matching who owns the source. The job account is nologin,
# has no credentials and cannot write here, which is the point.
BEFORE=$(git -C "$SRC_DIR" rev-parse --short HEAD)
say "updating $SRC_DIR from origin/$BRANCH (at $BEFORE)"
git -C "$SRC_DIR" fetch --quiet origin "$BRANCH"
git -C "$SRC_DIR" merge --ff-only --quiet "origin/$BRANCH" \
  || die "not a fast-forward. Someone committed on the box, or the branch was rewritten. Resolve by hand."
AFTER=$(git -C "$SRC_DIR" rev-parse --short HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  say "already at $AFTER; nothing to do"
  # Checked even here, and this is the case that matters most. Drift persists across runs:
  # the commit that changed a unit lands once, and every run after it reports "nothing to
  # do" while the box quietly stays on the old unit forever.
  check_units || exit $?
  exit 0
fi
say "$BEFORE -> $AFTER"

# --delete is deliberately absent: api/ lives in the webroot and belongs to the
# cron, not to the client. Deleting what rsync does not recognise would wipe it.
say "republishing the client"
rsync -a --exclude 'NOTES.md' "$SRC_DIR/client/" "$WEBROOT/"
chown -R "$RUN_USER:$RUN_USER" "$WEBROOT"

# Prove the new code can actually generate before leaving it to the timer. A
# failure here means the previous JSON is still in place and still being served,
# which is the whole point of writing atomically.
say "running the generator once against the new code"
if as_user "$RUN_USER" php "$SRC_DIR/runtime/generate-api.php" --config="$CONF" --quiet; then
  say "generator clean at $AFTER; the timer takes it from here"
  # Last, and non-fatal to the deploy itself: the code and the schedule are already live by
  # this point. A unit change that has not been applied is worth a failed unit and a red
  # `systemctl status`, but not worth withholding a schedule the board needs today.
  check_units || exit $?
  exit 0
fi

# This path runs unattended from a timer, so it cannot just print advice and
# leave broken code in place until someone reads a journal. It puts the previous
# commit back and proves the old code still works.
#
# `reset --hard` is the right tool HERE and only here: this checkout is a
# disposable deployment artifact with no local commits and nothing to push. It
# is not a history rewrite.
loud "the generator FAILED at $AFTER; rolling back to $BEFORE"
git -C "$SRC_DIR" reset --hard --quiet "$BEFORE"
rsync -a --exclude 'NOTES.md' "$SRC_DIR/client/" "$WEBROOT/"
chown -R "$RUN_USER:$RUN_USER" "$WEBROOT"

if as_user "$RUN_USER" php "$SRC_DIR/runtime/generate-api.php" --config="$CONF" --quiet; then
  loud "rolled back to $BEFORE and the board is generating again"
  loud "$AFTER is broken; fix it before the next update runs"
  # Reported but not allowed to change the exit code: a broken commit is the headline and
  # a stale unit must not read as the reason the rollback happened.
  check_units rolled-back || true
  exit 1
fi

# Both commits fail, so the cause is not the code: a feed is down, the shards
# are gone, the disk is full. The atomic writes mean the last good JSON is
# still being served and ageing visibly, which is the designed behaviour.
loud "rollback to $BEFORE ALSO fails to generate; this is not a code problem"
loud "the last good JSON is still in $WEBROOT and its staleness is climbing"
exit 1
