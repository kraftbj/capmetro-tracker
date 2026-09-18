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
# A plain assignment, deliberately. `readonly` made re-sourcing this file a fatal error, and
# the obvious repair -- keep whatever is already set -- turned it into an inherited switch:
# EXIT_UNIT_DRIFT=0 in the environment made confirmed drift exit 0, silently, which is the
# whole failure this file exists to end. Plain assignment is idempotent across sourcing AND
# overwrites anything inherited, which is everything readonly was buying.
EXIT_UNIT_DRIFT=3

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
  # Snapshotted BEFORE the source below. EXIT_UNIT_DRIFT is a plain assignment at the top of
  # this file, which stops it being INHERITED -- but not overwritten by the lib this function
  # is about to source out of $SRC_DIR. That lib is pulled code; a units.sh that assigned the
  # same name, for any reason, would silently zero the verdict. Third variant of the same
  # bug, so this time the value is simply put beyond reach.
  local exit_drift="$EXIT_UNIT_DRIFT"
  local lib="$SRC_DIR/deploy/lib/units.sh"
  if [ ! -f "$lib" ]; then
    return 0   # a checkout older than this feature; nothing to compare against
  fi
  # Existing is not the same as parsing. A syntax error in the pulled lib makes `.` fail,
  # and under `set -euo pipefail` that would abort the whole script -- on the paths where
  # the deploy has ALREADY succeeded, reporting a live board as a hard failure. A lib we
  # cannot load is one more way of not knowing, which is never fatal here.
  # shellcheck source=deploy/lib/units.sh
  if ! . "$lib"; then
    loud "cannot load $lib, so the systemd units were not checked. Nothing else is wrong."
    return 0
  fi

  # What that lib provides is NOT guaranteed to be what this update.sh expects. On the
  # rollback path `git reset --hard` has replaced the checkout underneath a running script,
  # so the lib on disk is from BEFORE while the code reading it is from AFTER. Two commits on
  # this branch ship a units.sh with neither cm_systemd_live nor the CM_DRIFT_* constants.
  #
  # Unchecked that goes wrong in both available directions: `cm_systemd_live` is then
  # command-not-found, whose 127 the `|| return 0` below would swallow into a silent success,
  # and the case arms would reference unbound constants and abort under `set -u`. A silent
  # success is this feature's own anti-pattern; an abort takes down a deploy that already
  # worked. Say which it is instead.
  local fn
  for fn in cm_systemd_live cm_unit_drift cm_unit_stamp_path; do
    if ! command -v "$fn" >/dev/null 2>&1; then
      loud "$lib predates this version of update.sh (no $fn); units NOT checked."
      loud "expected right after a rollback. Nothing else is wrong."
      return 0
    fi
  done

  # A box with no systemd running got a cron entry instead and owns none of these units, so
  # there is nothing here for it to be behind on. The same probe install.sh uses, out of the
  # same file, so the two cannot disagree about which kind of box this is.
  cm_systemd_live || return 0

  # CONF_DIR, not the state dir: install.sh chowns the state dir to the nologin job account,
  # and a stamp that account can rewrite is a check it can switch off.
  local stamp drift rc=0
  stamp="$(cm_unit_stamp_path "$CONF_DIR")"
  # `|| rc=$?`, never `set +e` ... `set -e`. That pair does not restore the caller's setting,
  # it forces errexit ON, which is invisible in a script that always has it on and fatal to
  # any caller that had turned it off. A failing left-hand side of `||` is exempt from
  # errexit, so nothing needs toggling.
  drift=$(cm_unit_drift "$SRC_DIR/deploy" "$stamp") || rc=$?

  # The arms are cm_unit_drift's contract, named in deploy/lib/units.sh. Anything that is not
  # one of these three is CM_DRIFT_FOUND, handled below.
  case "$rc" in
    "${CM_DRIFT_SAME:-0}") return 0 ;;
    "${CM_DRIFT_NO_STAMP:-2}")
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
    "${CM_DRIFT_NO_TOOL:-3}")
      # Deliberately not "no sha256sum on this box": the same status also covers a unit file
      # that exists and could not be read, and asserting the wrong cause sends someone to
      # install a package they already have.
      loud "cannot fingerprint the systemd units, so they were not checked"
      loud "no sha256sum or shasum, or a unit file could not be read. Nothing else is wrong."
      return 0
      ;;
    "${CM_DRIFT_FOUND:-1}") ;;
    *)
      # Anything else is a contract this function does not know about. Falling through to the
      # drift branch would print "the units have changed:" with nothing after it, which is the
      # empty-accusation failure the single-comparison rule exists to prevent.
      loud "the unit check returned an unexpected status ($rc); the units were not checked."
      return 0
      ;;
  esac

  # Never an accusation with nothing in it. rc says drift, but the names are what make that
  # actionable, and the two have come apart twice by different routes: once from deciding
  # drift with one comparison and explaining it with another, once from a partial lib whose
  # own unbound constants made cm_unit_drift fail in a way that merely LOOKED like rc=1.
  # Whatever the route, an empty list means the answer is not known, so say that instead.
  if [ -z "$drift" ]; then
    loud "the unit check reported a difference but named no unit, so it cannot be trusted."
    loud "the units were NOT checked. Nothing else is wrong."
    return 0
  fi

  loud "the systemd units in the checkout have changed since install.sh last ran:"
  # A here-string, not a pipe: the loop must run in THIS shell so `loud` output is not the
  # only thing that survives it. A piped `while` is a subshell, which worked here by luck.
  local u
  while IFS= read -r u; do
    [ -n "$u" ] && loud "    $u"
  done <<< "$drift"
  loud "the box is still running the OLD ones."
  # Only on the paths where it is true: said from the rollback branch, seven lines after
  # `git reset --hard` put the previous commit back, it would be precisely false at the one
  # moment someone is reading closely.
  if [ "$context" = deployed ]; then
    loud "the code and the schedule data are up to date; only the units are behind."
  fi
  loud "Apply them with:"
  loud "    sudo $SRC_DIR/deploy/install.sh"
  return "$exit_drift"
}

# ---------------------------------------------------------------------------
# web server config drift
# ---------------------------------------------------------------------------

# Same question as check_units, asked about the two vhosts, and the answer is a NOTICE rather
# than an exit status.
#
# Why it exists: install.sh prints the vhost and never installs it, and this script does not
# touch it either, so a committed change to deploy/nginx-capmetro.conf or
# deploy/apache-capmetro.conf lands in the checkout and does nothing at all until somebody
# copies it by hand and reloads. Until now nothing said so. That matters more than a stale
# unit, not less: a stale timer fires at the wrong hour and the board still renders, while a
# stale vhost can refuse the manifest and the service worker outright -- no install prompt,
# no offline board, and health.json still ok:true, so the documented post-deploy health check
# cannot see it either.
#
# Why it does NOT change the exit code. 3 is documented, in CLAUDE.md and in install.sh's own
# output, as "deployed, but the committed SYSTEMD UNITS are not the ones installed, so run
# install.sh" -- a specific condition with a specific remedy. A vhost needs a different
# remedy, and widening 3 to mean "some config is stale" would make the one number ambiguous
# for whatever eventually reads it, which is the exact mistake EXIT_UNIT_DRIFT was split from
# 1 to avoid. The notice goes to stdout and therefore to the journal on every run, which is
# the same visibility the not-knowing arms of check_units settle for.
#
# Never fatal, for the same reason those arms are not: an absent stamp is the expected state
# of every box installed before this existed, including this one.
check_vhost() {
  local lib="$SRC_DIR/deploy/lib/units.sh"
  [ -f "$lib" ] || return 0

  # SOURCED IN A SUBSHELL, and that is the whole reason this is written as a command
  # substitution rather than the obvious `. "$lib"` at function scope.
  #
  # check_units takes `local exit_drift="$EXIT_UNIT_DRIFT"` before its own source, because a
  # pulled units.sh that assigned that name would zero its verdict -- its comment calls that
  # the third variant of the same bug. That defense only holds while check_units' source is
  # the FIRST one in the shell. This function runs immediately before it at every call site,
  # so sourcing here would have moved the attack surface in front of the snapshot and
  # reopened the hole from the outside. Inside `$( )` nothing units.sh assigns, defines or
  # exports can reach the parent shell at all, which closes it for good rather than by
  # ordering.
  #
  # The two private statuses are outside cm_drift's 0..3 contract on purpose, so "the lib
  # could not be loaded" can never be read as a drift verdict.
  local drift rc=0
  # shellcheck source=deploy/lib/units.sh
  drift=$(
    . "$lib" >/dev/null 2>&1 || exit 90
    command -v cm_vhost_drift >/dev/null 2>&1 || exit 91
    command -v cm_vhost_stamp_path >/dev/null 2>&1 || exit 91
    cm_vhost_drift "$SRC_DIR/deploy" "$(cm_vhost_stamp_path "$CONF_DIR")"
  ) || rc=$?

  # Compared against literals, not against CM_DRIFT_*: those constants live in the lib, which
  # is now deliberately out of reach. The numbers are cm_drift's published contract and are
  # named here so the arms stay readable.
  case "$rc" in
    0) return 0 ;;   # the configs agree
    1) ;;            # confirmed drift, names on stdout
    2)
      # No record. Normally silent: it is the state of every box installed before this
      # existed, and nagging four times a day for a condition no amount of re-running
      # clears is how a notice becomes wallpaper.
      #
      # With one exception, which is the case that actually matters. The justification for
      # staying quiet was "check_units has already explained a missing stamp" -- and that
      # fails precisely when a deploy changes a vhost and no unit, because then check_units
      # finds its own stamp intact, returns 0 silently, and nobody is ever told to run
      # install.sh. That is this very branch: it changes both vhosts and no unit file, so
      # the first deploy carrying vhost detection could not have announced itself.
      #
      # So: if THIS deploy changed a vhost and there is no record, say so once.
      # Exactly 1, never `! git ... --quiet`. git answers 0 for "no differences" and 1 for
      # "differences", but 128 for "not a repository" and other failures -- and `!` turns
      # every one of those into "the vhost changed", so a checkout git could not read would
      # print this notice on every run forever.
      # The revision guard runs FIRST, and every expansion is `${X:-}`. check_vhost is
      # sourceable and the tests call it directly, where BEFORE and AFTER are simply not
      # set -- a bare `$BEFORE` under `set -u` aborts the function there, which is the
      # not-fatal contract broken by the defensive fix meant to protect it.
      local changed=0
      if [ -n "${BEFORE:-}" ] && [ -n "${AFTER:-}" ] && [ "${BEFORE:-}" != "${AFTER:-}" ]; then
        git -C "$SRC_DIR" diff --quiet "${BEFORE:-}" "${AFTER:-}" -- \
          deploy/nginx-capmetro.conf deploy/apache-capmetro.conf 2>/dev/null || changed=$?
      fi
      if [ "$changed" = 1 ]; then
        loud "this deploy changed the web server config, and there is no record of which"
        loud "one is installed, so the change could not be checked -- but it is real:"
        # A here-string, never a pipe into `while`, for the two reasons check_units:189
        # already learned. Under `pipefail` this pipeline is check_vhost's last command and
        # check_vhost is called bare, so `set -e` takes update.sh down -- on the path where
        # the deploy has ALREADY succeeded, which is the one thing a diagnostic here must
        # never do. Both triggers are real and were reproduced at a shell: git exiting
        # non-zero (128 on a checkout it cannot read), and a trailing blank line, which
        # leaves `[ -n "" ]` as the loop's own last command and exits it 1.
        local names
        names=$(git -C "$SRC_DIR" diff --name-only "${BEFORE:-}" "${AFTER:-}" -- \
          deploy/nginx-capmetro.conf deploy/apache-capmetro.conf 2>/dev/null) || names=""
        while IFS= read -r f; do
          [ -n "$f" ] && loud "    $f"
        done <<< "$names"
        loud "Nothing here installs it, and health.json will read ok:true either way."
        loud "    sudo $SRC_DIR/deploy/install.sh"
        loud "prints the exact sed for this box and records the config, which also stops"
        loud "this message. The installed vhost may have been rewritten by certbot, so"
        loud "diff it before overwriting rather than copying the committed file over it."
      fi
      return 0
      ;;
    *) return 0 ;;   # 3 cannot hash, 90/91 lib unusable -- check_units explains those
  esac

  [ -n "$drift" ] || return 0   # never an accusation with nothing in it

  loud "the web server config in the checkout has changed since install.sh last ran:"
  local f nginx_drifted="" apache_drifted=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    loud "    $f"
    case "$f" in
      nginx-*) nginx_drifted=1 ;;
      apache-*) apache_drifted=1 ;;
    esac
  done <<< "$drift"

  # Which SERVER this box runs, and which FILE actually moved, are two different questions,
  # and answering the second with the first told an nginx box to reload apache. Only speak
  # about a file that is in the list above.
  local mine=""
  if command -v nginx >/dev/null 2>&1 && [ -n "$nginx_drifted" ]; then mine=1; fi
  if { command -v apache2ctl >/dev/null 2>&1 || command -v httpd >/dev/null 2>&1; } \
     && [ -n "$apache_drifted" ]; then mine=1; fi

  if [ -z "$mine" ]; then
    loud "none of those is the config this box serves from, so there is nothing to do here."
    return 0
  fi

  loud "the box is still serving the OLD one. Nothing here installs it."
  loud "A stale vhost can refuse the manifest and the service worker with nothing on screen"
  loud "to say so, and health.json still reads ok:true, so this will not show up anywhere else."
  # DELIBERATELY NOT a copy-paste `cp`. These files ship with @DOMAIN@ and @WEBROOT@ still in
  # them, and nginx accepts both as literals: `nginx -t` on an unsubstituted config reports
  # "test is successful", the reload succeeds, and every URL including /api/health.json then
  # 404s -- with the working config already overwritten. Verified against real nginx. A
  # remedy that can take the board down is worse than one extra command to run, and this
  # function does not know $DOMAIN anyway.
  loud "Run install.sh: it prints the exact sed for this box, with the placeholders filled."
  loud "    sudo $SRC_DIR/deploy/install.sh"
  loud "It also re-records the config, which is what stops this repeating every run."
  # Not just the placeholders. nginx-capmetro.conf says certbot rewrites the installed block
  # to add the 443 server and the redirect, so on a TLS box -- which production is -- the
  # installed file is not the committed one and copying over it destroys the cert config.
  loud "The installed vhost has been rewritten by certbot, so diff it before overwriting."
  return 0
}

# ---------------------------------------------------------------------------
# Everything above is definitions; everything below deploys. Sourcing this file gets the
# definitions and nothing else, which is what lets the tests call check_units for real
# rather than grepping this file for the string "check_units" -- a regex cannot tell a live
# call from a commented-out one, and a check that looks present and does nothing is the
# entire bug this feature exists to prevent.
#
# The condition is "am I being sourced", asked directly, rather than an env var the caller
# sets: a switch in a root script that turns a deploy into a silent success having deployed
# nothing is worth not having. Running the file runs the deploy; sourcing it does not.
# ---------------------------------------------------------------------------
if [ "${BASH_SOURCE[0]:-$0}" != "$0" ]; then
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
  check_vhost
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
  check_vhost
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
  check_vhost
  check_units rolled-back || true
  exit 1
fi

# Both commits fail, so the cause is not the code: a feed is down, the shards
# are gone, the disk is full. The atomic writes mean the last good JSON is
# still being served and ageing visibly, which is the designed behaviour.
loud "rollback to $BEFORE ALSO fails to generate; this is not a code problem"
loud "the last good JSON is still in $WEBROOT and its staleness is climbing"
# Cheap, and occasionally the answer: a generator that cannot start on either commit may be
# looking for a config path a newer unit moved. Reported, never allowed to change the verdict.
check_vhost
check_units rolled-back || true
exit 1
