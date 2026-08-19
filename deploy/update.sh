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

say() { printf '\033[1m==\033[0m %s\n' "$*"; }
die() { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"
[ -d "$SRC_DIR/.git" ] || die "no checkout at $SRC_DIR"

BEFORE=$(git -C "$SRC_DIR" rev-parse --short HEAD)
say "updating $SRC_DIR from origin/$BRANCH (at $BEFORE)"
as_user "$RUN_USER" git -C "$SRC_DIR" fetch --quiet origin "$BRANCH"
as_user "$RUN_USER" git -C "$SRC_DIR" merge --ff-only --quiet "origin/$BRANCH" \
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
  say "generator clean; the timer takes it from here"
else
  die "the new code fails to generate. The last good JSON is still being served. Roll back with: git -C $SRC_DIR reset --hard $BEFORE && $0"
fi
