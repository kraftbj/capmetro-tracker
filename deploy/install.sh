#!/usr/bin/env bash
#
# install.sh — put the CapMetro dispatch board on a Debian/Ubuntu box.
#
# Single origin: the static client at /, and the JSON the cron writes at /api/*.
# There is no second host, so there is no CORS to configure and nothing to keep
# in sync between two deploys.
#
#   sudo ./deploy/install.sh --domain bus.example.com
#
# Idempotent. Run it again after a code change and it updates in place. It will
# NOT overwrite /etc/capmetro/config.php once that exists, and it will not touch
# an existing web server vhost — it prints the config for you to install, because
# silently rewriting a vhost on a box that serves other things is not a risk this
# script gets to take on your behalf.
set -euo pipefail

DOMAIN=""
REPO="git@github.com:kraftbj/capmetro-tracker.git"
BRANCH="trunk"
SRC_DIR="/srv/capmetro/src"
WEBROOT="/var/www/capmetro"
STATE_DIR="/var/lib/capmetro"
CONF_DIR="/etc/capmetro"
RUN_USER="capmetro"
INTERVAL_S=60

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --domain <host>     hostname the board will be served on (used in the vhost)
  --repo <url>        git remote to deploy from      (default: $REPO)
  --branch <name>     branch to deploy               (default: $BRANCH)
  --webroot <path>    where the client and api/ live (default: $WEBROOT)
  --src <path>        where the checkout lives       (default: $SRC_DIR)
  --user <name>       system user to run the cron as (default: $RUN_USER)
  --interval <sec>    how often to poll the feeds    (default: $INTERVAL_S)
  --dry-run           print what would happen, change nothing
EOF
}

DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)   DOMAIN="$2"; shift 2 ;;
    --repo)     REPO="$2"; shift 2 ;;
    --branch)   BRANCH="$2"; shift 2 ;;
    --webroot)  WEBROOT="$2"; shift 2 ;;
    --src)      SRC_DIR="$2"; shift 2 ;;
    --user)     RUN_USER="$2"; shift 2 ;;
    --interval) INTERVAL_S="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

say()  { printf '\033[1m==\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '   would run: %s\n' "$*"; else "$@"; fi; }

[ "$(id -u)" = 0 ] || die "run as root (sudo $0 ...)"

# ---- preflight -------------------------------------------------------------
say "checking prerequisites"
MISSING=""
for c in php git rsync; do command -v "$c" >/dev/null 2>&1 || MISSING="$MISSING $c"; done
[ -n "$MISSING" ] && die "missing:$MISSING — install them first (apt install php-cli git rsync)"

# 8.2 because composer.json declares php>=8.2. Gating lower here would let the
# install succeed on a box the code does not actually support, and the failure
# would surface as a parse error inside a cron job nobody is watching.
PHP_OK=$(php -r 'echo PHP_VERSION_ID >= 80200 ? "yes" : "no";')
PHP_V=$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;')
[ "$PHP_OK" = yes ] || die "PHP $PHP_V found; composer.json requires php>=8.2"
for ext in json curl mbstring; do
  php -m | grep -qix "$ext" || die "PHP extension '$ext' is missing (apt install php-$ext)"
done
say "php $PHP_V with json, curl, mbstring (no composer packages needed)"

# ---- user and directories --------------------------------------------------
if id "$RUN_USER" >/dev/null 2>&1; then
  say "user $RUN_USER exists"
else
  say "creating system user $RUN_USER"
  run useradd --system --home-dir /srv/capmetro --shell /usr/sbin/nologin "$RUN_USER"
fi

for d in "$SRC_DIR" "$WEBROOT" "$STATE_DIR" "$CONF_DIR"; do
  [ -d "$d" ] || { say "creating $d"; run mkdir -p "$d"; }
done
run chown -R "$RUN_USER:$RUN_USER" "$SRC_DIR" "$WEBROOT" "$STATE_DIR"

# ---- source ----------------------------------------------------------------
if [ -d "$SRC_DIR/.git" ]; then
  say "updating checkout in $SRC_DIR"
  run sudo -u "$RUN_USER" git -C "$SRC_DIR" fetch --quiet origin "$BRANCH"
  run sudo -u "$RUN_USER" git -C "$SRC_DIR" checkout --quiet "$BRANCH"
  run sudo -u "$RUN_USER" git -C "$SRC_DIR" merge --ff-only --quiet "origin/$BRANCH"
else
  say "cloning $REPO into $SRC_DIR"
  run sudo -u "$RUN_USER" git clone --quiet --branch "$BRANCH" "$REPO" "$SRC_DIR" \
    || die "clone failed. The repo is private: give $RUN_USER a deploy key, or clone it yourself and re-run."
fi

# ---- config ----------------------------------------------------------------
# Never overwritten. It carries the watch list, which is the one file on the box
# that describes somebody's routine.
if [ -f "$CONF_DIR/config.php" ]; then
  say "keeping existing $CONF_DIR/config.php"
else
  say "writing $CONF_DIR/config.php from the example"
  if [ "$DRY_RUN" = 0 ]; then
    sed -e "s#'/srv/capmetro/data'#'$SRC_DIR/data'#" \
        -e "s#'/var/www/capmetro'#'$WEBROOT'#" \
        -e "s#'/var/lib/capmetro'#'$STATE_DIR'#" \
        "$SRC_DIR/runtime/config.example.php" > "$CONF_DIR/config.php"
    chmod 0640 "$CONF_DIR/config.php"
    chown root:"$RUN_USER" "$CONF_DIR/config.php"
  fi
fi

# ---- client ----------------------------------------------------------------
# --delete would remove api/, which the cron owns and the client does not.
say "publishing the client to $WEBROOT"
run rsync -a --exclude 'NOTES.md' "$SRC_DIR/client/" "$WEBROOT/"
run chown -R "$RUN_USER:$RUN_USER" "$WEBROOT"

# ---- the generation job ----------------------------------------------------
GEN="php $SRC_DIR/runtime/generate-api.php --config=$CONF_DIR/config.php --quiet"

if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
  say "installing the systemd timer (every ${INTERVAL_S}s)"
  if [ "$DRY_RUN" = 0 ]; then
    sed -e "s#@RUN_USER@#$RUN_USER#g" -e "s#@GEN@#$GEN#g" \
      "$SRC_DIR/deploy/capmetro-generate.service" > /etc/systemd/system/capmetro-generate.service
    sed -e "s#@INTERVAL_S@#$INTERVAL_S#g" \
      "$SRC_DIR/deploy/capmetro-generate.timer" > /etc/systemd/system/capmetro-generate.timer
    systemctl daemon-reload
    systemctl enable --now capmetro-generate.timer
  fi
  SCHEDULER="systemd timer capmetro-generate.timer"
else
  # cron cannot go below a minute, so INTERVAL_S is ignored here and the job
  # runs once a minute. Say so rather than pretending the flag was honored.
  say "no systemd; installing a once-a-minute cron entry instead"
  [ "$INTERVAL_S" != 60 ] && warn "cron cannot run more often than once a minute; --interval $INTERVAL_S ignored"
  run sh -c "printf '* * * * * %s %s\n' '$RUN_USER' '$GEN' > /etc/cron.d/capmetro"
  run chmod 0644 /etc/cron.d/capmetro
  SCHEDULER="cron /etc/cron.d/capmetro"
fi

# ---- first run, so a failure surfaces now and not at a bus stop ------------
say "running the generator once"
if [ "$DRY_RUN" = 0 ]; then
  if sudo -u "$RUN_USER" $GEN; then
    say "generator ran clean"
  else
    die "the generator failed. Nothing is serving stale data yet, so fix this before pointing a browser at it."
  fi
  HEALTH="$WEBROOT/api/health.json"
  [ -s "$HEALTH" ] || die "no $HEALTH was written"
  if grep -q '"ok":false' "$HEALTH"; then
    warn "health.json reports ok:false — the board will render, but check it:"
    warn "  $HEALTH"
  else
    say "health.json reports ok"
  fi
fi

# ---- web server ------------------------------------------------------------
say "web server"
if command -v nginx >/dev/null 2>&1; then
  echo "   nginx found. Install the vhost yourself, then reload:"
  echo "     sed 's/@DOMAIN@/${DOMAIN:-your.domain}/; s#@WEBROOT@#$WEBROOT#' \\"
  echo "       $SRC_DIR/deploy/nginx-capmetro.conf > /etc/nginx/sites-available/capmetro"
  echo "     ln -sf /etc/nginx/sites-available/capmetro /etc/nginx/sites-enabled/capmetro"
  echo "     nginx -t && systemctl reload nginx"
elif command -v apache2ctl >/dev/null 2>&1 || command -v httpd >/dev/null 2>&1; then
  echo "   apache found. Install the vhost yourself, then reload:"
  echo "     sed 's/@DOMAIN@/${DOMAIN:-your.domain}/; s#@WEBROOT@#$WEBROOT#' \\"
  echo "       $SRC_DIR/deploy/apache-capmetro.conf > /etc/apache2/sites-available/capmetro.conf"
  echo "     a2enmod headers expires && a2ensite capmetro"
  echo "     apache2ctl configtest && systemctl reload apache2"
else
  warn "no nginx or apache found. The files are in $WEBROOT; point any static server at it."
fi

cat <<EOF

$(say "done")
  source      $SRC_DIR ($BRANCH)
  webroot     $WEBROOT
  config      $CONF_DIR/config.php
  state       $STATE_DIR
  scheduler   $SCHEDULER

Next:
  1. install the vhost printed above and reload the web server
  2. get a certificate:  certbot --nginx -d ${DOMAIN:-your.domain}
  3. check it:           curl -s https://${DOMAIN:-your.domain}/api/health.json | head -c 200
  4. update later:       sudo $SRC_DIR/deploy/update.sh
EOF
