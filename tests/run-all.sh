#!/usr/bin/env bash
#
# Run every suite. This is the single entry point: `npm test` or `bash tests/run-all.sh`.
#
# Nothing here touches the network. Every input is a committed fixture, and the
# only generated input is produced locally from those fixtures.
#
# Exit code is non-zero if any suite fails. A skipped suite is not a failure;
# each one prints why it skipped.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILED=()
SKIPPED=()
PASSED=()

hr() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
note() { printf '   %s\n' "$1"; }

# ---------------------------------------------------------------------------
# 0. Generate a webroot from the fixtures, if the runtime job and shards allow.
#    Acceptance criteria 1 to 10 are statements about generated output; without
#    one they skip. With one they bind automatically.
# ---------------------------------------------------------------------------
hr "generate a webroot from the fixtures (optional input for the acceptance criteria)"
GEN_OUT="$ROOT/.local/test-webroot"
#    The shards are the COMMITTED ones in data/, reached through
#    runtime/config.fixture.php. This gate used to require .local/shards, a
#    directory this checkout has never had: the generation step was skipped on
#    every run, so the one assertion that validates all 71 route files, both new
#    catalog endpoints and the acceptance criteria against real output quietly
#    stood down. The suite reported 13 passing schema checks where pointing it
#    at generated output reports over 300. A skip that reads as a pass is worse
#    than a failure, so the gate now tests for what is actually required.
if [ -f runtime/generate-api.php ] && [ -f runtime/config.fixture.php ] \
   && [ -d data/routes ] && command -v php >/dev/null 2>&1; then
  if php runtime/generate-api.php \
      --config=runtime/config.fixture.php \
      --fixtures=tests/fixtures/feeds-20260819 \
      --out="$GEN_OUT" \
      --now=1787152239 --quiet >/dev/null 2>&1 \
    && [ -s "$GEN_OUT/api/health.json" ] \
    && ! grep -q '"ok":false' "$GEN_OUT/api/health.json"; then
    export CAPMETRO_WEBROOT="$GEN_OUT"
    note "generated $GEN_OUT; the acceptance criteria will run against it"
  else
    note "runtime job could not produce a clean webroot; acceptance criteria that need one will skip"
  fi
else
  note "runtime job or committed shards not available; acceptance criteria that need generated output will skip"
fi

# ---------------------------------------------------------------------------
# 1. Schema validation. Standalone, no build step. Must pass.
# ---------------------------------------------------------------------------
hr "schema validation (python3 tests/schema/validate.py)"
if ! command -v python3 >/dev/null 2>&1; then
  SKIPPED+=("schema: python3 not installed")
elif ! python3 -c 'import jsonschema, referencing' >/dev/null 2>&1; then
  SKIPPED+=("schema: pip3 install jsonschema referencing")
elif python3 tests/schema/validate.py; then
  PASSED+=("schema")
else
  FAILED+=("schema")
fi

# ---------------------------------------------------------------------------
# 2. Vitest: build job and shared client logic.
# ---------------------------------------------------------------------------
hr "node unit tests (npx vitest run)"
if [ ! -d node_modules/vitest ]; then
  SKIPPED+=("vitest: run npm install")
elif npx vitest run; then
  PASSED+=("vitest")
else
  FAILED+=("vitest")
fi

# ---------------------------------------------------------------------------
# 3. PHPUnit: the runtime join.
# ---------------------------------------------------------------------------
hr "php unit tests (vendor/bin/phpunit)"
if [ ! -x vendor/bin/phpunit ]; then
  SKIPPED+=("phpunit: run composer install")
elif vendor/bin/phpunit; then
  PASSED+=("phpunit")
else
  FAILED+=("phpunit")
fi

# ---------------------------------------------------------------------------
# 4. Playwright: end-to-end against the static client.
# ---------------------------------------------------------------------------
hr "end-to-end tests (playwright test)"
if [ ! -x node_modules/.bin/playwright ]; then
  SKIPPED+=("playwright: run npm install")
elif [ ! -f client/index.html ]; then
  SKIPPED+=("playwright: client/index.html does not exist yet")
elif ! node_modules/.bin/playwright test; then
  FAILED+=("playwright")
else
  PASSED+=("playwright")
fi

# ---------------------------------------------------------------------------
hr "summary"
for s in "${PASSED[@]:-}";  do [ -n "$s" ] && printf '  pass  %s\n' "$s"; done
for s in "${SKIPPED[@]:-}"; do [ -n "$s" ] && printf '  skip  %s\n' "$s"; done
for s in "${FAILED[@]:-}";  do [ -n "$s" ] && printf '  FAIL  %s\n' "$s"; done

if [ "${#FAILED[@]}" -gt 0 ]; then
  exit 1
fi
exit 0
