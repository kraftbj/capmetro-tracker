#!/usr/bin/env bash
#
# install.sh — put the CapMetro dispatch board on a Debian/Ubuntu box.
#
# Single origin: the static client at /, and the JSON the cron writes at /api/*.
# There is no second host, so there is no CORS to configure and nothing to keep
# in sync between two deploys.
#
#   sudo ./deploy/install.sh --domain bus.dillo.dev
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
CONF_DIR="${CONF_DIR:-/etc/capmetro}"
# CONF_DIR, CM_NGINX_DIR and CM_APACHE_DIR are overridable so the suite can point this at
# a scratch tree. Said out loud when set, as units.sh does for its own overrides: `sudo -E`
# or an exported variable in a root shell would otherwise send the config and the drift
# records somewhere other than /etc without a word.
for _v in CONF_DIR CM_NGINX_DIR CM_APACHE_DIR; do
  if [ -n "${!_v:-}" ] && { [ "$_v" != CONF_DIR ] || [ "$CONF_DIR" != /etc/capmetro ]; }; then
    printf '!! %s is set to %s (a test override)\n' "$_v" "${!_v}" >&2
  fi
done
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
  --show-vhost        print the vhost install steps even when nothing changed
EOF
}

# Every flag below takes a value, and `shift 2` takes whatever follows it --
# including the next flag. `--domain --dry-run` set DOMAIN to the string
# `--dry-run` and left DRY_RUN at 0, so a run whose only stated intent was to
# change nothing became a real one: it created the user, the state dir and the
# webroot, installed the schedule, and recorded the vhost fingerprint. Verified
# locally with `id` stubbed -- it reached "creating /var/lib/capmetro" and got a
# permission error only because the probe was not actually root.
#
# It does not write a vhost; it never does, it prints the commands. What it
# printed was a paste-ready sed rendering `server_name --dry-run;`, which is the
# same dead server_name the placeholder refusal below exists to prevent, handed
# to an operator with no reason to read it closely or to check anything
# afterwards. None of these flags takes a value beginning with a hyphen, so
# reject an option-shaped or missing one instead of adopting it.
#
# exit 2, like the unknown-option arm, because this is a usage error and not a
# failed install -- and it happens before anything on the box is touched.
need_val() {
  case "${2-}" in
    "") printf 'xx %s needs a value\n' "$1" >&2; usage >&2; exit 2 ;;
    -*) printf 'xx %s needs a value, got the option %s -- put the value after %s\n' \
          "$1" "$2" "$1" >&2; exit 2 ;;
  esac
}

DRY_RUN=0
SHOW_VHOST=0
SRC_FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)   need_val "$1" "${2-}"; DOMAIN="$2"; shift 2 ;;
    --show-vhost) SHOW_VHOST=1; shift ;;
    --repo)     need_val "$1" "${2-}"; REPO="$2"; shift 2 ;;
    --branch)   need_val "$1" "${2-}"; BRANCH="$2"; shift 2 ;;
    --webroot)  need_val "$1" "${2-}"; WEBROOT="$2"; shift 2 ;;
    --src)      need_val "$1" "${2-}"; SRC_DIR="$2"; shift 2 ;;
    --user)     need_val "$1" "${2-}"; RUN_USER="$2"; shift 2 ;;
    --interval) need_val "$1" "${2-}"; INTERVAL_S="$2"; shift 2 ;;
    --src-from) need_val "$1" "${2-}"; SRC_FROM="$2"; shift 2 ;;
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

#
# A HOSTNAME, OR NOTHING. Checked here so a bad one cannot reach the sed that is
# printed for pasting, where it fails in two different silent ways:
#
#   --domain https://bus.dillo.dev   the '/' closes the s/// early, sed exits 1
#                                    with "bad flag in substitute command", and
#                                    because '>' truncates first, the temp file
#                                    is left at 0 bytes. An empty vhost adds no
#                                    directives, so nginx -t passes and the host
#                                    falls through to default_server.
#   --domain "bus dillo dev"         sed succeeds and writes
#                                    `server_name bus dillo dev;`, which nginx
#                                    reads as THREE names, none of them the host.
#
# Both reproduced. Neither is exotic: the first is a copied address bar.
#
case "${DOMAIN:-}" in
  "") : ;;
  *[!a-zA-Z0-9.-]*)
    die "--domain must be a hostname -- letters, digits, dots and hyphens only.
     Got: $DOMAIN
     A '/' or a space here renders a broken vhost that nginx still accepts." ;;
  .*|*.|*..*)
    die "--domain is not a hostname: $DOMAIN" ;;
esac

# The refusals above are for strings that are not hostnames at all. These are
# for strings that ARE well-formed hostnames, pass every check above, render a
# vhost nginx accepts, and still cannot be the host this board is served on.
# They matter for the same reason `your.domain` did: the failure is a server_name
# that matches nothing, so the request falls through to default_server, and every
# check that looks at the config instead of the board reports success.
#
# Normalized BEFORE the refusals below, not after. With the lowercasing last,
# `--domain YOUR.DOMAIN` and `--domain Bus.Example.Com` walked straight past the
# placeholder list -- case patterns are literal -- and rendered a server_name
# nothing resolves to, which is the exact thing that list exists to stop.
#
# Worth normalizing at all because hostnames are case-insensitive and nginx
# matches server_name that way, while certbot builds its lineage directory from
# the string exactly as given: --domain BUS.DILLO.DEV would look up a lineage a
# `bus.dillo.dev` certificate does not have, and the restore step would fail on a
# name that is right in every sense DNS cares about.
if [ -n "${DOMAIN:-}" ]; then
  DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
fi

# Three independent questions, three cases. They were one ordered chain whose
# accept arm was `*[!0-9.]*.*` -- a non-digit BEFORE a dot -- which refused any
# name whose only letters are in the last label: `163.com`, a real registered
# domain, fell through to the single-label arm and was rejected by a message
# telling the operator it needed a dot while pointing at a name that has one. A
# false positive here is not the harmless direction; it blocks a real install
# with no workaround but editing this script.
case "${DOMAIN:-}" in
  "") : ;;
  your.domain|domain.tld|example.com|example.net|example.org \
    |*.example.com|*.example.net|*.example.org \
    |*.example|*.invalid|*.test|*.localhost)
    die "--domain is a documentation placeholder, not a host: $DOMAIN
     RFC 2606 reserves these names precisely so they never resolve to anything,
     which is the one property a server_name must not have. Re-run with the
     hostname the board is actually served on." ;;
esac

# Nothing but digits and dots. Checked on its own rather than as a fall-through,
# so it cannot answer for a name that merely failed a different test.
case "${DOMAIN:-}" in
  ""|*[!0-9.]*) : ;;
  *)
    die "--domain looks like an IP address, not a hostname: $DOMAIN
     An IP in server_name only ever matches a browser pointed straight at the
     address, no certificate authority will issue for it, and the certbot command
     printed below would fail with the vhost already installed." ;;
esac

# Deliberately NOT refused, though certbot cannot issue for any of them and they
# therefore fail the letter of the message below: bus.local, board.home.arpa,
# board.internal, board.lan, anything under .alt. A wall-mounted LAN board served
# over plain HTTP is a real way to run this, and refusing those names would be the
# 163.com mistake with a different suffix -- a false positive that blocks a real
# install to enforce a rule about certificates the operator never asked for.
case "${DOMAIN:-}" in
  ""|*.*) : ;;
  *)
    die "--domain needs a fully qualified name, with a dot: $DOMAIN
     A single label is a legal server_name and nginx will match it against a Host
     header, but 'certbot -d $DOMAIN' cannot issue for it, so step 2 of the
     summary below would hand you a command that fails after the vhost is live." ;;
esac



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
# Asked of php directly, never `php -m | grep -q`. That pipeline is a race under
# `set -o pipefail`: grep -q exits the moment it matches, php still has output to write, takes
# SIGPIPE, and pipefail promotes its 141/255 to the pipeline's status -- so the check reports
# a MISSING extension precisely when it is present and listed early enough to match. Whether
# it bites depends on the pipe buffer and scheduling, which is why it survived this long; on
# this developer's machine it fails every time, taking install.sh down at the prerequisite
# check with "PHP extension 'json' is missing" while json is loaded.
for ext in json curl mbstring; do
  php -r 'exit(extension_loaded($argv[1]) ? 0 : 1);' "$ext" \
    || die "PHP extension '$ext' is missing (apt install php-$ext)"
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
  #
  # The re-run line carries --domain only when there is a real one to carry.
  # It used to print `--domain ${DOMAIN:-your.domain}`, and that placeholder is
  # how the 2026-09-21 outage happened: pasted, it makes DOMAIN non-empty, so
  # the refusal further down never fires and the vhost commands print with a
  # hostname that matches nothing. A paste-ready command is the worst possible
  # home for a value with no safe default.
  #
  RERUN="$0 --src-from /srv/capmetro/tree"
  [ -n "${DOMAIN:-}" ] && RERUN="$RERUN --domain $DOMAIN"
  DOMAIN_NOTE=""
  [ -z "${DOMAIN:-}" ] && DOMAIN_NOTE="
          add --domain <the host this board is served on>; there is no default"
  run git clone --quiet --branch "$BRANCH" "$REPO" "$SRC_DIR" || die \
"clone failed, and on a private repo that is expected: git ran as root here, so
   it used /root/.ssh and not your key. Two ways forward, neither needing a key
   for the $RUN_USER account:

     a) copy the tree up from your laptop, then re-run:
          rsync -a --exclude .git ./ root@thisbox:/srv/capmetro/tree/
          $RERUN$DOMAIN_NOTE

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
# the helper is absent -- under --dry-run before the clone, or on a tree rsynced up with
# --src-from that predates deploy/lib/.
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
      cm_write_stamp "$SRC_DIR/deploy" "$CONF_DIR" || STAMP_RC=$?
      if [ "${STAMP_RC:-0}" = 2 ]; then
        die "cannot create a temp file in $CONF_DIR (read-only filesystem, or full?).
     The units ARE installed and running, but there is no drift record."
      elif [ "${STAMP_RC:-0}" != 0 ]; then
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

#
# NO --domain, NO COMMAND. This used to default to the literal string
# `your.domain` and print it into a command built for pasting. On 2026-09-21 that
# command was pasted: it wrote `server_name your.domain;`, `nginx -t` reported
# success -- nginx never checks that a server_name matches a real host, or that
# any block matches -- the reload was clean, and every request for the real host
# fell through to default_server. The box also serves WordPress, so the board
# answered with a database error page for eleven minutes and looked like a DNS
# or hosting fault.
#
# The placeholder is not a usable default for a value with no safe guess. A
# refusal costs one re-run; the guess cost an outage that nothing detected.
#
# Which installer plugin certbot should use, set by whichever branch below
# actually matched. The summary used to print `certbot --nginx` unconditionally,
# so an apache box was told to configure a web server it is not running -- and
# the apache instructions now send a first-install operator straight at that
# line, which turned a stale default into a wrong instruction on a real path.
CERTBOT_PLUGIN=""
# Whether the vhost commands were actually printed. Not the same question as
# "was there a domain": the no-server arm below has a domain and still prints
# nothing to install, so guarding the drift fingerprint on $DOMAIN recorded the
# committed vhosts as installed on a box that had been given no way to install
# them. Narrower than the no-domain case -- a re-run once nginx is there
# re-stamps -- but it is the same false "clean" either way.
VHOST_PRINTED=0
if [ -z "$DOMAIN" ]; then
  warn "no --domain given, so the vhost instructions are not printed.
     There is no safe default for it: a placeholder substituted into server_name
     passes nginx -t, reloads cleanly, and matches nothing, which takes the board
     down with every check reporting success. Re-run with the hostname:
       sudo $0 --domain <the host this board is served on> ...
     Everything else above this line is already done and does not repeat. The vhost
     drift fingerprint is deliberately not written either, so a later vhost change
     still gets announced rather than landing silently."
elif command -v nginx >/dev/null 2>&1 || command -v apache2ctl >/dev/null 2>&1 \
     || command -v httpd >/dev/null 2>&1; then
  if command -v nginx >/dev/null 2>&1; then
    CERTBOT_PLUGIN=--nginx
    VHOST_SERVER=nginx
    VHOST_CONF=nginx-capmetro.conf
    VHOST_DIR="${CM_NGINX_DIR:-/etc/nginx}"
    VHOST_AT="$VHOST_DIR/sites-available/capmetro"
    VHOST_ON="$VHOST_DIR/sites-enabled/capmetro"
    VHOST_ENABLE="sudo ln -sf $VHOST_AT $VHOST_ON"
    VHOST_RELOAD="sudo nginx -t && sudo systemctl reload nginx"
  else
    CERTBOT_PLUGIN=--apache
    VHOST_SERVER=apache
    VHOST_CONF=apache-capmetro.conf
    VHOST_DIR="${CM_APACHE_DIR:-/etc/apache2}"
    VHOST_AT="$VHOST_DIR/sites-available/capmetro.conf"
    VHOST_ON="$VHOST_DIR/sites-enabled/capmetro.conf"
    VHOST_ENABLE="sudo a2enmod headers expires && sudo a2ensite capmetro"
    VHOST_RELOAD="sudo apache2ctl configtest && sudo systemctl reload apache2"
  fi
  VHOST_PRINTED=1

  #
  # NOTHING TO DO IS ONE LINE. This section used to print its full install steps, and
  # a page of reasons with them, on every run -- including every run update.sh sends
  # an operator here for, to fix a UNIT drift that has nothing to do with the vhost.
  #
  # "Nothing to do" is decided by what is INSTALLED, never by the drift record. The
  # record fingerprints the committed vhosts as of the last install.sh, and it is
  # written whether or not the operator then ran the printed steps -- so a record
  # that matches says nothing about /etc, and trusting it would turn one skipped
  # checklist into "nothing to do" on every run after.
  #
  # Instead the committed vhost is rendered with THIS run's --domain and --webroot,
  # and its lines must appear IN ORDER in the file the web server actually loads:
  # the sites-enabled entry, read through its symlink, since a stale plain-file copy
  # there is what nginx serves whatever sites-available holds. Membership alone was
  # not enough: 4ef16f4 repeated eighteen add_header lines into the location blocks,
  # and every one of them was already somewhere in the file. In order, with
  # repeats, catches that, a reordered block, a vhost never installed, a 0-byte one,
  # placeholders left in, a wrong server_name (the 2026-09-21 outage), and a changed
  # --domain or --webroot.
  #
  # Lines in the installed file that are not in the committed one are allowed
  # between them, because certbot inserts its own. `listen` and `<VirtualHost` lines
  # are skipped on the committed side, because certbot moves and rewrites them (the
  # port-80 listen goes to a redirect block in certbot's own spacing, and apache's
  # HTTPS copy opens with *:443). Comments and blank lines carry no configuration.
  #
  # Apache serves HTTPS from the separate capmetro-le-ssl.conf certbot writes, so
  # when that exists it has to match as well, or a change would land on port 80
  # only.
  #
  # The one thing this cannot see is a committed change that only DELETES a line,
  # since an extra line in the installed file is exactly what certbot's own
  # additions look like. update.sh's drift notice still announces that change.
  #
  # And it reads files, not the running server: a copy that landed without a reload
  # passes. The one line says "file", and the summary still ends at the health check.
  vhost_matches() {
    local file="$1" line i=0
    local -a want=()
    [ -s "$file" ] || return 1
    # `|| [ -n "$line" ]` keeps a last line that has no newline after it.
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'#'*|listen*|Listen*|'<VirtualHost'*) continue ;; esac
      want+=("$line")
    done <<< "$VHOST_WANT"
    [ "${#want[@]}" -gt 0 ] || return 1
    while IFS= read -r line || [ -n "$line" ]; do
      [ "$i" -lt "${#want[@]}" ] || break
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      [ "$line" = "${want[$i]}" ] && i=$((i + 1))
    done < "$file"
    [ "$i" -eq "${#want[@]}" ]
  }
  vhost_applied() {
    # Rendered into a variable and checked, not substituted into a loop's input: a
    # failed substitution there feeds the loop nothing, and a loop over nothing finds
    # nothing missing -- "nothing to do" from a template that could not be read.
    VHOST_WANT=$(sed -e "s/@DOMAIN@/$DOMAIN/g" -e "s#@WEBROOT@#$WEBROOT#g" \
      -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$SRC_DIR/deploy/$VHOST_CONF") || return 1
    vhost_matches "$VHOST_ON" || return 1
    if [ "$VHOST_SERVER" = apache ] && [ -e "$VHOST_DIR/sites-enabled/capmetro-le-ssl.conf" ]; then
      vhost_matches "$VHOST_DIR/sites-enabled/capmetro-le-ssl.conf" || return 1
    fi
  }
  VHOST_CURRENT=0
  if [ "$SHOW_VHOST" = 0 ] && vhost_applied; then VHOST_CURRENT=1; fi

  if [ "$VHOST_CURRENT" = 1 ]; then
    printf '   %s vhost file enabled and matching this checkout; nothing to install.\n' "$VHOST_SERVER"
    printf '   (Board not answering? --show-vhost prints the install steps.)\n'
  else
    #
    # The steps, kept short on screen. The reasons live here instead:
    #
    # 1. DIFF FIRST. certbot rewrites the INSTALLED file to add the 443 server and the
    #    http->https redirect, so on a TLS box it is not the committed one, and copying
    #    over it deletes the TLS block. The certificate survives, unreferenced, and the
    #    board leaves HTTPS.
    #
    # 2. BACK UP, THEN A GUARDED COPY. The copy is the one irreversible step, and the
    #    command meant to undo it (step 3) is the one least likely to work, so the
    #    backup comes first on the same chain. A .bak is inert: nginx includes
    #    sites-enabled, and a2ensite will not enable a name that does not end in .conf.
    #    The guard refuses an empty file ('>' truncates before sed runs, so a failed
    #    sed leaves 0 bytes) and one with @PLACEHOLDERS@ left in it. nginx -t passes
    #    both, and the host falls through to default_server.
    #
    # 3. PUT THE TLS BLOCK BACK, LOOKING THE NAME UP. certbot names a lineage after the
    #    FIRST -d, so a certificate covering the apex and this host is named for the
    #    apex, a wildcard for the first usable name, and a re-issue leaves
    #    <domain>-0001. --cert-name exits 1 on any name not exactly right, after the
    #    copy has already removed the block. An empty list means certbot did not issue
    #    this certificate (acme.sh, Caddy, a commercial CA) and cannot restore it, so
    #    the .bak is the way back. On a first install there is no certificate and no
    #    443 block to lose, so the step is skipped and certbot is run fresh instead.
    #
    # 4. CHECK THE BOARD, NOT THE CONFIG. A green nginx -t is not evidence: it passed
    #    through every failure above.
    #
    cat <<EOF
   $VHOST_SERVER vhost to install (not installed here, or not matching this checkout):
   1. Render it and read the diff. certbot edited the installed copy, so do not copy blind:
     sed -e 's/@DOMAIN@/$DOMAIN/g' -e 's#@WEBROOT@#$WEBROOT#g' \\
       $SRC_DIR/deploy/$VHOST_CONF > /tmp/capmetro-vhost.new
     sudo diff -u $VHOST_AT /tmp/capmetro-vhost.new
   2. Back up, copy (refuses an empty or unfilled file), reload:
     B=$VHOST_AT
     [ -f \$B ] && sudo cp -a \$B \$B.\$(date +%Y%m%d-%H%M%S).bak
     [ -s /tmp/capmetro-vhost.new ] && ! grep -q '@[A-Z_]*@' /tmp/capmetro-vhost.new \\
       && sudo cp /tmp/capmetro-vhost.new \$B
     $VHOST_ENABLE
     $VHOST_RELOAD
   3. Put TLS back, using the certificate name certbot lists (often not the domain).
      If the list is empty and this host has never had HTTPS, it is a first install:
      skip this step. If it had HTTPS, an empty list means restore the .bak instead.
     sudo certbot certificates | grep -iE 'Certificate Name|Domains'
     sudo certbot install $CERTBOT_PLUGIN --cert-name <the name listed>
     $VHOST_RELOAD
   4. Check the board, not the config:
     curl -sf https://$DOMAIN/api/health.json
EOF
  fi
else
  warn "no nginx or apache found. The files are in $WEBROOT; point any static server at it."
fi

# The record update.sh compares against, so a LATER committed change to either vhost gets
# noticed instead of sitting in the checkout doing nothing.
#
# Written whether or not the operator actually runs the commands above, and that is the
# honest reading of what it records: "these are the configs as of the last install.sh", which
# is the same thing the unit stamp records. It cannot know whether the sed-and-reload
# happened. What it turns into a detectable event is the case that actually bites -- a vhost
# change landing in a later deploy with nothing to announce it.
#
# Not inside the systemd branch above: a box on cron still serves the board over HTTP.
# `--dry-run` must not write it. The units stamp is already inside a DRY_RUN guard and this
# was not, so a mode whose whole promise is "changes nothing" recorded the COMMITTED vhosts
# as installed -- and every later update.sh then reported no drift for a vhost that had
# never been applied. That is "cannot tell" laundered into a durable false "clean", which is
# the one outcome the CM_DRIFT_NO_STAMP / NO_TOOL split exists to prevent.
#
# Guarded on the FUNCTION, not on the file, for the reason the units block gives twelve
# lines up: a source tree carrying an older units.sh has the file and not the function, and
# calling it anyway is a command-not-found -- which would then be evaluated a second time
# inside the warning below, printing an empty path next to a raw shell error.
# The function check comes FIRST so a dry run reports it too: "this tree cannot record the
# vhost fingerprint" is exactly the kind of thing a dry run exists to surface, and putting
# the DRY_RUN arm first made that branch unreachable in the only mode that can be tested
# without root.
#
# The VHOST_PRINTED arm comes first because it is the one case where writing the record
# is actively harmful rather than merely uninformative. A run that printed no vhost
# commands -- no --domain, or no web server found -- cannot have installed anything, and
# stamping the committed vhosts as "installed" on that run tells update.sh, permanently,
# that /etc already matches the checkout. The next real vhost change then deploys with
# nothing to announce it, which is the exact event the record exists to catch. Worse than
# having no record, because a box with no record says so once per run and carries on.
if [ "$VHOST_PRINTED" = 0 ]; then
  printf '%s\n%s\n' \
    '   not recording a vhost drift fingerprint: this run printed no vhost, so' \
    '   nothing can have been installed from it. A later vhost change still gets announced.'
elif ! command -v cm_write_vhost_stamp >/dev/null 2>&1 \
   || ! command -v cm_vhost_stamp_path >/dev/null 2>&1; then
  warn "this source tree cannot record a vhost drift fingerprint:
     $SRC_DIR/deploy/lib/units.sh is absent or predates it. Everything else still installs;
     a later vhost change will simply deploy without a notice."
elif [ "$DRY_RUN" = 1 ]; then
  printf '   would run: record the vhost drift fingerprint in %s\n' "$CONF_DIR"
else
  VHOST_STAMP_RC=0
  cm_write_vhost_stamp "$SRC_DIR/deploy" "$CONF_DIR" || VHOST_STAMP_RC=$?
  if [ "$VHOST_STAMP_RC" != 0 ]; then
    # A warning, not a die. The board serves correctly without this record; all that is
    # lost is the notice on a future vhost change, and killing a working install over a
    # missing fingerprint would be the wrong trade.
    #
    # 2 and 1 are told apart, as cm_write_stamp_for's own comment asks: a read-only /etc or
    # a full disk is a different thing to tell somebody than a hashing tool that would not
    # run, and folding them sends the operator to fix the wrong one.
    if [ "$VHOST_STAMP_RC" = 2 ]; then
      warn "could not create a temp file in $CONF_DIR (read-only filesystem, or full?), so
     there is no vhost drift record. Everything else is installed."
    else
      warn "could not fingerprint the vhost sources, so there is no drift record at
     $(cm_vhost_stamp_path "$CONF_DIR"). Either no sha256sum or shasum is installed, a
     source file could not be read, or the list holds a name the record format cannot
     represent -- CM_DRIFT_NO_TOOL covers all three and does not say which, so check the
     cheap one first. Everything else is installed; a later vhost change will deploy
     without a notice."
    fi
  fi
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
# Same rule as the vhost block above: with no --domain there is no hostname to put in
# these commands, and a placeholder here would be pasted just as readily as one in a
# server_name. Say what to do instead of printing something that looks runnable.
if [ -z "$DOMAIN" ]; then
  printf '  1. re-run with --domain to get the vhost and certificate commands\n'
  printf '  2. update later:       %s/deploy/update.sh   (as root)\n' "$SRC_DIR"
else
  if [ "${VHOST_CURRENT:-0}" = 1 ]; then
    # Nothing to install and no certificate to get, so the list is what is left.
    printf '  1. check the BOARD:    curl -sf https://%s/api/health.json | head -c 200\n' "$DOMAIN"
    printf '  2. update later:       %s/deploy/update.sh   (as root)\n' "$SRC_DIR"
  else
    # Same reason step 2 branches: with no web server detected, nothing was printed
    # above, so "install the vhost printed above" names output that does not exist.
    if [ -n "$CERTBOT_PLUGIN" ]; then
      printf '  1. install the vhost printed above, reading the diff, and reload the web server\n'
    else
      printf '  1. install nginx or apache, then re-run this to get the vhost commands\n'
    fi
    if [ -n "$CERTBOT_PLUGIN" ]; then
      printf '  2. get a certificate:  sudo certbot %s -d %s\n' "$CERTBOT_PLUGIN" "$DOMAIN"
    else
      printf '  2. get a certificate:  install nginx or apache first, then run certbot\n'
    fi
    # Branched for the same reason as 1 and 2: with no web server there is nothing
    # listening, so this curl cannot answer and its failure would say nothing about
    # whether the install worked.
    if [ -n "$CERTBOT_PLUGIN" ]; then
      printf '  3. check the BOARD:    curl -sf https://%s/api/health.json | head -c 200\n' "$DOMAIN"
    else
      printf '  3. check the BOARD once a web server is serving %s\n' "$WEBROOT"
    fi
    printf '  4. update later:       %s/deploy/update.sh   (as root)\n' "$SRC_DIR"
  fi
fi
