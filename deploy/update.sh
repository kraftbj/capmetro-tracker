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
set -euo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

SRC_DIR="${SRC_DIR:-/srv/capmetro/src}"
WEBROOT="${WEBROOT:-/var/www/capmetro}"
RUN_USER="${RUN_USER:-capmetro}"
BRANCH="${BRANCH:-trunk}"
CONF="${CONF:-/etc/capmetro/config.php}"

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

# The state directory is asked of the config file rather than assumed, because --state-dir
# is an install.sh flag and a box that used it would otherwise be checked against a stamp
# that is not there. php is already a hard requirement below, so this costs nothing new.
state_dir() {
  local d=""
  if [ -f "$CONF" ] && command -v php >/dev/null 2>&1; then
    d=$(php -r '$c = @include $argv[1]; echo is_array($c) && isset($c["state_dir"]) ? $c["state_dir"] : "";' "$CONF" 2>/dev/null || true)
  fi
  printf '%s\n' "${d:-/var/lib/capmetro}"
}

# Reports whether the unit files in the checkout still match the ones install.sh rendered
# from. Returns 0 when they agree or when the question does not apply, 1 when they do not.
# Never touches anything: this is the whole "notices but does not act" contract from the
# header, and acting would mean restarting a timer from inside its own service.
check_units() {
  # A box with no systemd running got a cron entry instead and owns none of these units, so
  # there is nothing here for it to be behind on. Its /etc/cron.d/capmetro has the same
  # shape of problem -- install.sh writes it, update.sh does not refresh it -- but that file
  # is generated inline rather than committed, so it has no source to fingerprint and is not
  # covered here. The systemd path is the one this deployment actually runs.
  [ -d /run/systemd/system ] || return 0

  local lib="$SRC_DIR/deploy/lib/units.sh"
  if [ ! -f "$lib" ]; then
    return 0   # a checkout older than this feature; nothing to compare against
  fi
  # shellcheck source=deploy/lib/units.sh
  . "$lib"

  local stamp drift rc
  stamp="$(cm_unit_stamp_path "$(state_dir)")"
  set +e
  drift=$(cm_unit_drift "$SRC_DIR/deploy" "$stamp")
  rc=$?
  set -e

  if [ "$rc" = 0 ]; then
    return 0
  fi

  if [ "$rc" = 2 ]; then
    loud "cannot tell which systemd units are installed: no record at $stamp"
    loud "run 'install.sh' once to write it. Until then a unit change deploys silently."
    return 1
  fi

  loud "the systemd units in the checkout have changed since install.sh last ran:"
  printf '%s\n' "$drift" | while IFS= read -r u; do
    [ -n "$u" ] && loud "    $u"
  done
  loud "the box is still running the OLD ones. The code and the schedule data above are"
  loud "up to date; only the units are behind. Apply them with:"
  loud "    sudo $SRC_DIR/deploy/install.sh"
  return 1
}

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
  check_units || exit 1
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
  check_units || exit 1
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
  check_units || true
  exit 1
fi

# Both commits fail, so the cause is not the code: a feed is down, the shards
# are gone, the disk is full. The atomic writes mean the last good JSON is
# still being served and ageing visibly, which is the designed behaviour.
loud "rollback to $BEFORE ALSO fails to generate; this is not a code problem"
loud "the last good JSON is still in $WEBROOT and its staleness is climbing"
exit 1
