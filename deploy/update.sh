#!/usr/bin/env bash
#
# update.sh — pull the latest code and republish the client.
#
#   /srv/capmetro/src/deploy/update.sh   (as root)
#
# Deliberately does NOT touch /etc/capmetro/config.php, and does not restart the
# timer: the generator is a oneshot that picks up new code on its next firing,
# so there is no window where the board is down for a deploy.
set -euo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

SRC_DIR="${SRC_DIR:-/srv/capmetro/src}"
WEBROOT="${WEBROOT:-/var/www/capmetro}"
RUN_USER="${RUN_USER:-capmetro}"
BRANCH="${BRANCH:-trunk}"

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
if as_user "$RUN_USER" php "$SRC_DIR/runtime/generate-api.php" --config=/etc/capmetro/config.php --quiet; then
  say "generator clean at $AFTER; the timer takes it from here"
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

if as_user "$RUN_USER" php "$SRC_DIR/runtime/generate-api.php" --config=/etc/capmetro/config.php --quiet; then
  loud "rolled back to $BEFORE and the board is generating again"
  loud "$AFTER is broken; fix it before the next update runs"
  exit 1
fi

# Both commits fail, so the cause is not the code: a feed is down, the shards
# are gone, the disk is full. The atomic writes mean the last good JSON is
# still being served and ageing visibly, which is the designed behaviour.
loud "rollback to $BEFORE ALSO fails to generate; this is not a code problem"
loud "the last good JSON is still in $WEBROOT and its staleness is climbing"
exit 1
