# Test harness notes

Everything under `tests/` except `tests/fixtures/feeds-20260819/` and
`tests/fixtures/golden/`, which are inputs. Configuration lives at the repo root:
`phpunit.xml`, `vitest.config.mjs`, `playwright.config.mjs`.

**No test touches the network.** Every input is a committed fixture, and the one
generated input is produced locally from those fixtures.

---

## Running them

One command runs everything:

```
npm test              # or: bash tests/run-all.sh
```

It prints a per-suite pass / skip / FAIL summary and exits non-zero if any suite
failed. A skipped suite is never a failure; each one says why it skipped.

Individually:

| Suite | Command | What it covers |
|---|---|---|
| Schema | `python3 tests/schema/validate.py` | Contract criteria 1 and 7. Standalone: no build step, needs only `jsonschema` and `referencing`. |
| Node | `npx vitest run` | `build/lib/*`, the client's pure logic, fixture invariants, criteria 1–10. |
| PHP | `vendor/bin/phpunit` | The runtime join: service clock, adherence table, alert parsing and PII, stop status, staleness, atomic writes, watch resolution. |
| End to end | `node_modules/.bin/playwright test` | The real client, served from fixtures at a 412px viewport. |

First-time setup: `npm install`, `composer install`,
`node_modules/.bin/playwright install chromium`.

To browse the fixture scenarios by hand: `npm run test:e2e:server`, then open
`http://localhost:4173/fresh/index.html`. Swap the prefix for `dead`, `torn`,
`missing`, `future` or `empty`.

### Pointing the acceptance criteria at generated output

Criteria 1 through 10 are statements about generated output. `run-all.sh` tries
to produce some first:

```
php runtime/generate-api.php --fixtures=tests/fixtures/feeds-20260819 \
    --shards=.local/shards --out=.local/test-webroot --now=1787152239
```

and, if that succeeds, exports `CAPMETRO_WEBROOT` so the criteria bind to it.
Set `CAPMETRO_WEBROOT` yourself to check a staging webroot instead. Without one,
the criteria that need generated files skip with that reason.

---

## A drift this harness caught, now closed

During this session the golden output grew a top-level `schedule` object and a
`route.next_departure` object while `schemas/route-state.schema.json` still
declared `additionalProperties: false` without them. Acceptance criterion 1
failed for the one file the contract names as its reference output, and the
derived `route-4-dead-cron.json` failed identically. The schema lane has since
declared both fields and the suite is green again.

Two standing consequences:

- `tests/fixtures/synthetic/route-4-dead-cron.json` and `torn-route-4.json` are
  **derived from the golden output**. Regenerate them whenever the golden file
  changes, or they will quietly describe a payload shape that no longer exists.
- `python3 tests/schema/validate.py` is the cheapest way to notice this class of
  drift. It runs in under a second, needs no build step, and is the first thing
  `run-all.sh` does.

---

## Skipped, and why

Measured under `npm test`, which is the entry point these counts describe:
`run-all.sh` generates a webroot from the committed fixtures first, so the suites
that need real generated output bind rather than stand down. Run `vitest` or
`phpunit` on their own, with no `CAPMETRO_WEBROOT`, and 40 node and 17 PHP cases
skip instead — each one naming the missing webroot, not a missing feature.

| Suite | What skips | Why |
|---|---|---|
| Node | `trip-corpus`, `publishes no arrival time anywhere when adherence is suppressed` | No route in the 2026-08-19 capture has `suppress_adherence` true. The rule itself runs in `StalenessTest` and `client-staleness.test.mjs`. |
| Node | acceptance criterion 3, `names the added and skipped stops on any vehicle actually running one` | Route 4's special trips run at 08:15 and 16:15 and the capture is from 10:10, so no bus is on one. The other two cases of criterion 3 run. |
| Node | acceptance criterion 8, `holds for every generated route file when feed ages are forced past 600s` | The generated output is fresh. Binds against a webroot regenerated with feed timestamps pushed past 600s. |
| PHP | `GtfsRtDecoderTest::testDecodedProtobufMatchesTheJsonExportForTheSameObservations` | Needs `tests/fixtures/feeds-pb-differential/`, a capture taken while both of CapMetro's positions publications are healthy. CLAUDE.md explains why unit tests against the spec are not a substitute. |
| PHP | `UpstreamTest::testReadsTheLiveUpstreamFeedVersionWithThreeRangeRequests` | Reaches the live upstream zip. The suite is offline by design, so this one skips wherever the network does not answer. |
| End to end | `marks a closed stop as not served wherever it appears on the ladder` | The page does not expose the payload it rendered, and no ladder row carries its `stop_id`, so the assertion has nothing to read. Two ways to unblock: put `data-stop-id` on ladder rows, or keep the parsed document on `window.CMB.lastRoute`. Either one turns this into a real test of silent failure 4 at the DOM level; the payload-level version already runs in `AlertParserTest`. |

---

## Findings for the other lanes

**For the runtime lane.**

1. ~~*No aggregate unmatched-trip metric.*~~ Closed. `cm_unmatched_trip_rate()`
   lives in `runtime/lib/shards.php`, `generate-api.php` calls it, and
   `ShardFreshnessTest` runs against it rather than skipping.

2. *`staleness.oldest_feed_age_s` in the golden fixture is 43, but the alerts
   feed in the same file is 100 seconds old.* The reference generator weighed
   only the two realtime feeds. `cm_staleness()` correctly takes the oldest of
   all three. Both land inside the 120-second fresh window so nothing
   user-visible turns on it today, but a lagging alerts feed would otherwise
   never register. Asserted in `StalenessTest`.

**For the build lane.** Shard files are written with a plain `writeFileSync`
(`build/lib/emit.mjs`). During this session a concurrent shard rebuild made
`cm_shard_index()` return null intermittently from a half-written
`index.json` — the exact torn-read that section 11 requires atomic writes to
prevent, one directory over. The runtime job reads these files while the build
job may be rewriting them. Same fix as `runtime/lib/write.php`: temp file in the
destination directory, then rename.

**For whoever owns the contract.** Two claims in section 2 are not true of the
committed capture, and both matter because acceptance criterion 2 depends on
them:

- "roughly 7% of active vehicle trips have no matching trip update" — in this
  capture it is **0 of 249**. Decision-table row 3 is unreachable from the real
  fixture.
- "143 of 392 vehicles have a null `current_stop_sequence`" — true, but those
  143 are exactly the 143 deadheads, which row 1 catches first. Row 6b is also
  unreachable from the real fixture.

Both are pinned as tests in `tests/node/fixture-invariants.test.mjs`, and both
gaps are filled by synthetic fixtures. Criterion 2 as written ("generating from
the fixture produces all six states") cannot be met from
`feeds-20260819/` alone; it needs the synthetic inputs alongside it.

---

## Assumptions about other lanes' code

Bindings resolve at run time and skip with a message naming exactly what was
looked for, so a rename shows up as a skip rather than a mystery.

| Assumed | Where | Status |
|---|---|---|
| `cm_clock_to_epoch`, `cm_service_day_midnight`, `cm_clock_to_seconds`, `cm_seconds_to_clock` | `runtime/lib/servicetime.php` | bound |
| `cm_adherence_evaluate`, `cm_adherence_glyph`, `cm_adherence_classify` | `runtime/lib/adherence.php` | bound |
| `cm_alerts_parse`, `cm_alerts_for_route`, `cm_alert_no_service_stops`, `cm_alert_severity` | `runtime/lib/alerts.php` | bound |
| `cm_stop_service_status` | `runtime/lib/stopstatus.php` | bound |
| `cm_staleness`, `cm_build_health` | `runtime/lib/staleness.php`, `runtime/lib/health.php` | bound |
| `cm_atomic_write`, `cm_atomic_write_json`, `cm_acquire_lock`, `cm_release_lock` | `runtime/lib/write.php` | bound |
| `cm_watch_id`, `cm_watch_resolve` | `runtime/lib/watch.php` | bound; resolution needs shards |
| `cm_shard_index`, `cm_shard_route`, `cm_shard_times`, `cm_shard_active_services` | `runtime/lib/shards.php` | bound; layout migrating |
| `cm_unmatched_trip_rate` | not written | skipped |
| `shortenStopName`, `buildBlockChains`, `buildCalendar`, `secondsToClock`, `feedVersionToEpoch` | `build/lib/*.mjs` | bound |
| `serviceClockToEpoch` | `build/lib/time.mjs` | not exported; skipped |
| `window.CMB.adherence`, `window.CMB.states`, `window.CMB.fmt` | `client/*.js` | bound |
| Shards at `.local/shards`, generated webroot at `$CAPMETRO_WEBROOT` or `webroot/` | — | both optional |

Two structural assumptions worth stating:

- **`runtime/lib/*.php` is pure and safe to `require`.** `tests/php/bootstrap.php`
  loads that directory and nothing else. `runtime/generate-api.php` and
  `runtime/tools/*` execute on include, so they are deliberately not loaded.
  Anything that needs a unit test belongs in a library file.
- **`client/*.js` are classic scripts attaching to `window.CMB`.**
  `tests/node/helpers/client.mjs` evaluates them in a `vm` context with a
  deliberately thin DOM stub — enough to read what a builder produced, and no
  more. Anything needing a real DOM belongs in the Playwright suite, which
  drives the actual page.

Shared files this lane touched, so the other lanes know: `package.json` (added
`@playwright/test` and the `test:*` scripts; `npm test` now runs
`tests/run-all.sh`, which includes `vitest run`) and `composer.json` (created,
for PHPUnit only — no autoload section, to stay out of the runtime lane's way).

---

## Fixtures

`tests/fixtures/feeds-20260819/` and `tests/fixtures/golden/` are **read-only
inputs** owned elsewhere. This lane adds `tests/fixtures/synthetic/`, for the
cases the captured minute does not contain. Every file names the failure it
encodes in a `_comment`, and `MANIFEST.json` lists them all.

| Fixture | Failure it encodes |
|---|---|
| `after-midnight-tripupdate.json` | Silent failure 5: a GTFS clock of `25:10:00`. |
| `dst-spring-forward-20260308.json` | Silent failure 3: a 23-hour service day. |
| `dst-fall-back-20261101.json` | Silent failure 3: a 25-hour service day, with a repeated local hour. |
| `stale-shard-route-4.json` | Silent failure 1: a shard from an older feed version; no live trip id matches. |
| `vehicle-without-trip-update.json` | Decision-table row 3. |
| `canceled-trip-no-stop-updates.json` | Decision-table row 2. |
| `vehicle-null-current-stop-sequence.json` | Decision-table row 6b. |
| `frozen-feed-response.json` | Silent failure 2: HTTP 200 with a 4-hour-old timestamp. |
| `route-4-dead-cron.json` | Silent failure 2 / criterion 8: the last-good file, 47 minutes on. |
| `torn-route-4.json` | Section 11: a file truncated mid-write. Deliberately unparseable. |
| `chain-800-to-4.json` | Transfer chains: two routes that share **no** stop ids and connect anyway, across a 27 m walk at Pleasant Valley. |

Conventions: keys beginning with `_` are test metadata, never wire format.
`_expected` holds the values an implementation must produce, so a fixture and
the test that reads it cannot drift apart. `_now` is the observer clock, so no
test depends on the wall clock. Strip `_`-prefixed keys before schema
validation; `stripTestMetadata()` in `tests/node/helpers/fixtures.mjs` and
`strip_test_metadata()` in `tests/schema/validate.py` both do it.

`route-4-dead-cron.json` and `torn-route-4.json` are derived from the golden
output. If the golden file is regenerated, regenerate these too, or they will
quietly describe a payload shape that no longer exists.

`chain-800-to-4.json` is derived from **generated output**, not from the golden
file, because the golden file is route 4 alone and a transfer needs two routes.
Rebuild it with `node tests/fixtures/synthetic/generate-chain-fixture.mjs
<webroot>`, committed beside it. The suite asserts the two routes share zero stop
ids: if a rebuilt feed ever merges them onto shared stops, that assertion fails
loudly rather than letting the walk-radius tests pass for the wrong reason.

---

## Where each silent failure is caught

| # | Silent failure | Tests |
|---|---|---|
| 1 | Shards stale after a GTFS reset | `tests/php/ShardFreshnessTest.php` (unmatched rate against the real shards and against a stale one; the alarm itself skips, see above), `AdherenceDecisionTableTest::testRowFive…` |
| 2 | Cron dies, webroot serves the last file forever | `tests/php/StalenessTest.php`, `HealthEndpointTest::testCarriesTheLastSuccessfulCronTime…`, `tests/node/client-staleness.test.mjs`, `tests/e2e/board.spec.mjs` (banner shown, no numbers rendered) |
| 3 | DST transition mis-converts service-day times | `tests/php/ServiceClockTest.php` (both dates, every clock case), `tests/node/build-time.test.mjs` |
| 4 | An alert-closed stop still rendered as served | `tests/php/AlertParserTest.php` (stop 1967 on route 4, from the real alerts feed), `StopServiceStatusTest.php` (precedence, and that 1967 is only ever caught by the alert source), `tests/node/fixture-invariants.test.mjs`, `tests/e2e/silent-failures.spec.mjs` |
| 5 | GTFS time `>= 24:00:00` parsed as invalid | `tests/php/ServiceClockTest.php`, `tests/node/build-time.test.mjs`, and a pass over every `startTime` in the captured feed |

## Where each acceptance criterion is encoded

All ten live in `tests/node/acceptance-criteria.test.mjs`, one `describe` each,
with the deeper unit coverage cross-referenced here.

| # | Also covered by |
|---|---|
| 1 | `tests/schema/validate.py` — all five schemas, the golden output, and every generated endpoint |
| 2 | `AdherenceDecisionTableTest` covers all six states and all ten rows directly |
| 3 | needs generated output |
| 4 | runs today against the golden output; `build-blocks.test.mjs` covers the grading |
| 5 | the realtime `SKIPPED` prediction for stop 1222 is asserted against the real feed today |
| 6 | `AlertParserTest`, `StopServiceStatusTest` |
| 7 | `acceptance-criteria.test.mjs` scans every generated file for the PII **keys and the real values**, reading both out of the upstream fixture, because renaming `userFullname` to `filed_by` would still leak. `AlertParserTest` covers the ingest allowlist directly, and asserts the fixture still carries the identifiers the parser exists to strip |
| 8 | `StalenessTest`, `client-staleness.test.mjs`, `board.spec.mjs` |
| 9 | `WatchResolutionTest` — hash and resolution both run against the committed `tests/fixtures/shards-260818_1456` snapshot |
| 10 | `StopNameTest`, `build-stops.test.mjs`. "Mid-word" is judged against the name a label came from, not by pattern-matching the label alone — `Pleasant Valley at…` is correct and `San Jacin…` is not, and no regex over the output alone can tell them apart |
