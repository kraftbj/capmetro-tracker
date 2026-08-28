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
# HTTPS, not SSH: the repo is public, so this needs no key on the box and no
# deploy key for the job account. --repo takes an SSH URL if you prefer one.
REPO="https://github.com/kraftbj/capmetro-tracker.git"
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
  --src-from <path>   deploy from a directory already on this box instead of
                      cloning. Use this when the repo is private and the box
                      has no GitHub credentials: rsync the tree up first.
  --dry-run           print what would happen, change nothing
EOF
}

DRY_RUN=0
SRC_FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)   DOMAIN="$2"; shift 2 ;;
    --repo)     REPO="$2"; shift 2 ;;
    --branch)   BRANCH="$2"; shift 2 ;;
    --webroot)  WEBROOT="$2"; shift 2 ;;
    --src)      SRC_DIR="$2"; shift 2 ;;
    --user)     RUN_USER="$2"; shift 2 ;;
    --interval) INTERVAL_S="$2"; shift 2 ;;
    --src-from) SRC_FROM="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

# Drop privileges without assuming sudo is installed. A minimal Debian image has
# no sudo at all - this script failed on exactly that - while runuser ships in
# util-linux, which is an essential package. Prefer runuser, fall back to sudo,
# and say so plainly rather than dying with "command not found" halfway through
# a half-finished install.
as_user() {
  local u="$1"; shift
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$u" -- "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -u "$u" "$@"
  else
    die "neither runuser nor sudo is available; cannot drop privileges to $u"
  fi
}

say()  { printf '\033[1m==\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '   would run: %s\n' "$*"; else "$@"; fi; }

[ "$(id -u)" = 0 ] || die "run as root (sudo $0 ...)"

# ---- preflight -------------------------------------------------------------
say "checking prerequisites"
# git is required only when we are going to use it. --src-from exists precisely
# so a box with no GitHub credentials, and no git at all, can still be deployed
# to, and demanding git there would defeat the option.
MISSING=""
for c in php rsync; do command -v "$c" >/dev/null 2>&1 || MISSING="$MISSING $c"; done
if [ -z "$SRC_FROM" ] && ! command -v git >/dev/null 2>&1; then
  MISSING="$MISSING git"
fi
[ -n "$MISSING" ] && die "missing:$MISSING — install them first (apt install php-cli rsync git)"

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

# The job writes the webroot and its state, and READS the source. It does not
# own the source, deliberately: this process talks to the public internet every
# sixty seconds, and a compromised one should not be able to rewrite the code it
# runs a minute later. Owning src as root also means git never needs credentials
# for a nologin system account.
run chown -R "$RUN_USER:$RUN_USER" "$WEBROOT" "$STATE_DIR"
# CONF_DIR is deliberately NOT in that list, and the unit fingerprint written into it later
# depends on that staying true: the job account is a nologin sandbox because the generator is
# the likeliest thing to be compromised, and a stamp it could rewrite is a check it could
# switch off. Asserted rather than inherited from whatever umask created the directory.
run chown root:root "$CONF_DIR"
run chmod 0755 "$CONF_DIR"

# ---- source ----------------------------------------------------------------
if [ -n "$SRC_FROM" ]; then
  [ -d "$SRC_FROM" ] || die "--src-from $SRC_FROM is not a directory"
  [ -f "$SRC_FROM/runtime/generate-api.php" ] || die "--src-from $SRC_FROM does not look like this repo"
  say "copying the source from $SRC_FROM"
  # --delete so a file deleted upstream actually disappears here. Safe because
  # this path is the source tree only; the webroot is a different directory.
  run rsync -a --delete --exclude '.git' "$SRC_FROM/" "$SRC_DIR/"
elif [ -d "$SRC_DIR/.git" ]; then
  say "updating checkout in $SRC_DIR"
  run git -C "$SRC_DIR" fetch --quiet origin "$BRANCH"
  run git -C "$SRC_DIR" checkout --quiet "$BRANCH"
  run git -C "$SRC_DIR" merge --ff-only --quiet "origin/$BRANCH"
elif [ -d "$SRC_DIR" ] && [ -f "$SRC_DIR/runtime/generate-api.php" ]; then
  say "using the source already in $SRC_DIR (no git checkout)"
else
  say "cloning $REPO into $SRC_DIR"
  run git clone --quiet --branch "$BRANCH" "$REPO" "$SRC_DIR" || die \
"clone failed, and on a private repo that is expected: git ran as root here, so
   it used /root/.ssh and not your key. Two ways forward, neither needing a key
   for the $RUN_USER account:

     a) copy the tree up from your laptop, then re-run:
          rsync -a --exclude .git ./ root@thisbox:/srv/capmetro/tree/
          $0 --src-from /srv/capmetro/tree --domain ${DOMAIN:-your.domain}

     b) put a read-only GitHub deploy key in /root/.ssh/ and re-run this script."
fi

# root owns the source; everyone can read it. The job needs no more than that.
run chown -R root:root "$SRC_DIR"
run chmod -R a+rX "$SRC_DIR"

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
# Absolute path on purpose. cron gets a PATH and would be fine with a bare
# `php`, but whether systemd searches PATH for ExecStart has varied by version,
# and a unit that fails to load reports it in a journal nobody is tailing.
PHP_BIN=$(command -v php)
GEN="$PHP_BIN $SRC_DIR/runtime/generate-api.php --config=$CONF_DIR/config.php --quiet"

# The unit list and the fingerprint helper, shared with update.sh so the two cannot drift
# apart about what "installed" means. Sourced after the clone, because it lives in it --
# guarded, because under --dry-run the clone above only printed what it would do, so on a
# fresh box the file is not there and an unguarded `.` would abort the dry run under `set -e`.
if [ -f "$SRC_DIR/deploy/lib/units.sh" ]; then
  # shellcheck source=deploy/lib/units.sh
  . "$SRC_DIR/deploy/lib/units.sh"
fi

# Whether systemd is really running here. Asked through deploy/lib/units.sh so update.sh
# asks exactly the same question; see the note there. Falls back to the literal test when
# the helper is absent, which happens only under --dry-run on a box with no checkout yet.
if command -v cm_systemd_live >/dev/null 2>&1 && cm_systemd_live; then
  SYSTEMD_LIVE=1
elif [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  SYSTEMD_LIVE=1
else
  SYSTEMD_LIVE=0
fi

if [ "$SYSTEMD_LIVE" = 1 ]; then
  say "installing the systemd timer (every ${INTERVAL_S}s)"
  if [ "$DRY_RUN" = 0 ]; then
    sed -e "s#@RUN_USER@#$RUN_USER#g" -e "s#@GEN@#$GEN#g" \
        -e "s#@WEBROOT@#$WEBROOT#g" -e "s#@STATE_DIR@#$STATE_DIR#g" \
      "$SRC_DIR/deploy/capmetro-generate.service" > /etc/systemd/system/capmetro-generate.service
    sed -e "s#@INTERVAL_S@#$INTERVAL_S#g" \
      "$SRC_DIR/deploy/capmetro-generate.timer" > /etc/systemd/system/capmetro-generate.timer
    # An unsubstituted @PLACEHOLDER@ in ReadWritePaths makes systemd refuse every
    # write the job needs, and the failure surfaces a minute later inside a unit
    # nobody is tailing. Catch it here, where the message can say what happened.
    # Directive lines only. The first version of this check read the whole file
    # and tripped on the unit's own comment explaining what placeholders are,
    # which aborted a completely correct install.
    # A plain `if grep`, not a command substitution. Two earlier versions of this
    # guard were each broken in their own way: the first matched the unit's own
    # comment and aborted a correct install, and the second used $(...) whose
    # grep exits 1 when it finds nothing, which under `set -e` also aborted a
    # correct install. `if grep -q` has neither failure mode, and grep's exit
    # code IS the question being asked.
    if grep -v '^[[:space:]]*#' /etc/systemd/system/capmetro-generate.service \
       | grep -q '@[A-Z_]*@'; then
      die "the service unit still has an unsubstituted placeholder; not enabling the timer"
    fi
    # The second timer is the one that answers "how does a schedule change ever
    # reach this box". Without it the board serves last season's departures
    # until a human remembers to pull, and the only symptom is staleness
    # climbing past seven days on a board nobody is watching that closely.
    sed -e "s#@UPDATE@#$SRC_DIR/deploy/update.sh#g" \
      "$SRC_DIR/deploy/capmetro-update.service" > /etc/systemd/system/capmetro-update.service
    cp "$SRC_DIR/deploy/capmetro-update.timer" /etc/systemd/system/capmetro-update.timer

    systemctl daemon-reload
    systemctl enable --now capmetro-generate.timer
    systemctl enable --now capmetro-update.timer

    # Record which unit sources these were rendered from. update.sh reads this to notice
    # when the repo's units have moved on and the box has not, which is otherwise silent:
    # update.sh never touches /etc/systemd/system, so a committed timer change deploys and
    # then does nothing. See deploy/update.sh's header for the incident that found this.
    #
    # In CONF_DIR, deliberately, and NOT in STATE_DIR. Line 130 chowns STATE_DIR to the job
    # account, which is a nologin sandbox precisely because the generator is the thing most
    # likely to be compromised. Writing this file as root into a directory that account owns
    # would hand it two gifts: a symlink planted at the stamp path turns a root write into an
    # arbitrary-file overwrite, and absent that, it could simply forge the stamp to make drift
    # report clean forever -- switching off the check this file exists to be. CONF_DIR is
    # asserted root:root 0755 above, right after WEBROOT and STATE_DIR are handed to the job
    # account, so root is the only writer.
    #
    # Written to a temp file and moved into place only on success. A plain `>` redirect
    # truncates the target BEFORE the command runs, so a fingerprint that fails -- no
    # sha256sum on the box, or sha256sum itself erroring under `set -o pipefail` -- would
    # leave a zero-byte stamp behind and then abort the install with the timers already
    # enabled. A zero-byte stamp matches nothing, so update.sh would report all four units
    # as drifted, forever, on a box where nothing had drifted at all.
    if ! command -v cm_unit_fingerprint >/dev/null 2>&1; then
      # The source above is guarded, so this is reachable: a source tree without
      # deploy/lib/units.sh (an older --src-from rsync, say). Calling the helper anyway
      # aborts with "command not found" AFTER both timers are enabled, which is a worse
      # outcome than simply having no drift record.
      warn "no $SRC_DIR/deploy/lib/units.sh here; units installed, but no drift record written"
    else
      if ! cm_write_stamp "$SRC_DIR/deploy" "$CONF_DIR"; then
        # Naming what update.sh will say, because it will say "no record ... normal on a box
        # installed before that record existed", which is the wrong story for this failure.
        die "cannot fingerprint the unit sources (no sha256sum or shasum?). The units ARE
     installed and running. update.sh will report no drift record and call that normal for
     an older box; it is not, it is this failure. Fix the hashing tool and re-run."
      fi
    fi
  fi
  SCHEDULER="systemd timers capmetro-generate.timer (60s) + capmetro-update.timer (daily)"
else
  if command -v systemctl >/dev/null 2>&1; then
    warn "systemctl is installed but systemd is not running here; using cron instead"
  fi
  # cron cannot go below a minute, so INTERVAL_S is ignored here and the job
  # runs once a minute. Say so rather than pretending the flag was honored.
  say "installing a once-a-minute cron entry"
  [ "$INTERVAL_S" != 60 ] && warn "cron cannot run more often than once a minute; --interval $INTERVAL_S ignored"
  run sh -c "printf '* * * * * %s %s\n#\n# Four times a day, matching capmetro-update.timer; see the note there.\n20 0,6,12,18 * * * root %s/deploy/update.sh --quiet\n' '$RUN_USER' '$GEN' '$SRC_DIR' > /etc/cron.d/capmetro"
  run chmod 0644 /etc/cron.d/capmetro
  SCHEDULER="cron /etc/cron.d/capmetro (60s generate + daily update)"
fi

# ---- first run, so a failure surfaces now and not at a bus stop ------------
say "running the generator once"
if [ "$DRY_RUN" = 0 ]; then
  if as_user "$RUN_USER" $GEN; then
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
# The vhost is printed, never installed. Rewriting a web server config on a box
# that already serves other sites is not a risk this script gets to take on your
# behalf, and the substitution is one command you can read before running it.
say "web server"
VHOST_DOMAIN="${DOMAIN:-your.domain}"
# `| sudo tee`, never `sudo sed ... > file`. Redirection is performed by the
# invoking shell, not by sudo, so the > lands in /etc as the unprivileged user
# and fails. The first version of these instructions got that wrong and the
# copy-pasted command returned Permission denied.
if command -v nginx >/dev/null 2>&1; then
  printf '   nginx found. Install the vhost, then reload:\n'
  printf '     sed -e %ss/@DOMAIN@/%s/%s -e %ss#@WEBROOT@#%s#%s \\\n' "'" "$VHOST_DOMAIN" "'" "'" "$WEBROOT" "'"
  printf '       %s/deploy/nginx-capmetro.conf \\\n' "$SRC_DIR"
  printf '       | sudo tee /etc/nginx/sites-available/capmetro > /dev/null\n'
  printf '     sudo ln -sf /etc/nginx/sites-available/capmetro /etc/nginx/sites-enabled/capmetro\n'
  printf '     sudo nginx -t && sudo systemctl reload nginx\n'
elif command -v apache2ctl >/dev/null 2>&1 || command -v httpd >/dev/null 2>&1; then
  printf '   apache found. Install the vhost, then reload:\n'
  printf '     sed -e %ss/@DOMAIN@/%s/%s -e %ss#@WEBROOT@#%s#%s \\\n' "'" "$VHOST_DOMAIN" "'" "'" "$WEBROOT" "'"
  printf '       %s/deploy/apache-capmetro.conf \\\n' "$SRC_DIR"
  printf '       | sudo tee /etc/apache2/sites-available/capmetro.conf > /dev/null\n'
  printf '     sudo a2enmod headers expires && sudo a2ensite capmetro\n'
  printf '     sudo apache2ctl configtest && sudo systemctl reload apache2\n'
else
  warn "no nginx or apache found. The files are in $WEBROOT; point any static server at it."
fi

echo
say "done"
printf '  source      %s (%s)\n' "$SRC_DIR" "$BRANCH"
printf '  webroot     %s\n' "$WEBROOT"
printf '  config      %s/config.php\n' "$CONF_DIR"
printf '  state       %s\n' "$STATE_DIR"
printf '  scheduler   %s\n' "$SCHEDULER"
echo
echo "Next:"
printf '  1. install the vhost printed above and reload the web server\n'
printf '  2. get a certificate:  sudo certbot --nginx -d %s\n' "$VHOST_DOMAIN"
printf '  3. check it:           curl -s https://%s/api/health.json | head -c 200\n' "$VHOST_DOMAIN"
printf '  4. update later:       %s/deploy/update.sh   (as root)\n' "$SRC_DIR"
