# runtime/

The cron half of the dispatch board. Fetches three CapMetro feeds, joins them against
pre-built GTFS schedule shards, and writes static JSON into a webroot. Plain PHP 8, no
framework, no Composer, no daemon.

Everything here implements `docs/api-contract.md` sections 1, 2, 3.1, 5, 6, 8, 9, 10 and
11. The contract is authoritative; where this document and the contract disagree, the
contract wins and this document is a bug.

## Layout

| File | What it is |
|---|---|
| `generate-api.php` | The entry point. One cron run = one invocation. ASCII data-flow diagram in its header. |
| `lib/servicetime.php` | Service-clock to epoch, DST-correct. Pure. |
| `lib/adherence.php` | The 10-row decision table. Pure. |
| `lib/alerts.php` | Socrata alert parser and the PII allowlist. Pure. |
| `lib/stopstatus.php` | Stop service status precedence. Pure. |
| `lib/stopnames.php` | Stop name shortening, contract section 7. Pure. |
| `lib/staleness.php` | Staleness levels and `suppress_adherence`. Pure. |
| `lib/watch.php` | Watch id hashing and per-route resolution. Pure. |
| `lib/health.php` | `/api/health.json` assembly. Pure. |
| `lib/join.php` | Vehicle and Timepoint assembly. Pure. |
| `lib/shards.php` | Shard reader. Reads files; no other side effects. |
| `lib/fetch.php` | HTTP with gzip, plus a file reader for the offline path. |
| `lib/write.php` | `flock`, atomic write. |
| `tools/make-shards.php` | **Stopgap** shard builder from a GTFS extract. See "Shard format". |
| `config.example.php` | Production config template. |
| `config.fixture.php` | Offline development config. |

Every file under `lib/` defines functions and constants and nothing else, so a test can
`require_once` any of them in any order with no side effects. `require_once` chains are
already declared inside each file.

## Running it

### Offline, against the committed fixtures (no network)

```
php runtime/tools/make-shards.php --gtfs=/path/to/gtfs --out=.local/shards
php runtime/generate-api.php --config=runtime/config.fixture.php \
    --fixtures=tests/fixtures/feeds-20260819
```

Output lands in `.local/webroot/api/`. `--now=EPOCH` pins the clock, which is how the
staleness path is exercised without waiting.

### Live

```
cp runtime/config.example.php /etc/capmetro/config.php   # then edit the paths
php runtime/generate-api.php --config=/etc/capmetro/config.php
```

### Flags

| Flag | Effect |
|---|---|
| `--config=FILE` | PHP file returning the config array |
| `--shards=DIR` | override `shard_dir` |
| `--out=DIR` | override `webroot`; files land in `DIR/api/...` |
| `--fixtures=DIR` | read the three feeds from disk instead of the network |
| `--now=EPOCH` | pin the clock |
| `--routes=a,b` | restrict to these route ids |
| `--quiet` | no progress on stderr |

Exit code is 0 on success, 1 when the run recorded any error, 2 on a bad config file. A run
that finds the lock already held exits 0 without writing, because that is not an error.

## Cron

```cron
# Route state, every 60 seconds. flock inside the job already prevents overlap; the
# lockfile lives in state_dir.
* * * * * /usr/bin/php /srv/capmetro/runtime/generate-api.php --config=/etc/capmetro/config.php --quiet >>/var/log/capmetro/cron.log 2>&1

# Schedule shards. CapMetro republishes GTFS roughly three times a year, so a daily pull
# is generous. Separate job on purpose: a failed pull must not stop the 60s job.
17 4 * * * cd /srv/capmetro/shards && /usr/bin/git pull --ff-only --quiet
```

`cron` has no sub-minute resolution. If a faster refresh is ever wanted, run the job from a
tiny wrapper that loops `sleep 15` four times; do not add a daemon. The design's whole
survival argument is that there is nothing to restart after a reboot.

### What it needs

- `shard_dir` readable, containing `index.json` and `route-*.json`.
- `webroot` writable by the cron user. Files are written to `{webroot}/api/`.
- `state_dir` writable. Holds `cron.lock` and `state.json` (`cron_last_success_at`). Do not
  serve this directory.
- The temp files the atomic write creates are made inside the destination directory, so
  `webroot` must be a single filesystem. It always is unless someone mounts `/api`
  separately.

### Serving

Per contract section 11: `Cache-Control: no-cache` for `/api/*`, long `max-age` for
`/data/*` schedule shards. Nothing in `/api` is user-specific, so a shared cache is fine as
long as it revalidates.

## Shard format

**This is the interface with `build/`, which does not exist yet.** `tools/make-shards.php`
is a stopgap so the runtime could be developed and verified offline; it is also the
executable specification of the format. When `build/shards.js` lands it must emit these
files. If it emits something different, change `lib/shards.php` and this section together.

### `index.json`

```jsonc
{
  "schema": 1,
  "feed_version": "260818_1456",
  "built_at": 1787155004,             // epoch, when the shards were generated
  "feed_start_date": "20260818",      // from feed_info.txt; drives schedule_age_days
  "feed_end_date": "20270109",        // becomes health.gtfs.valid_until
  "routes": { "4": { "short_name": "4", "long_name": "4-7th Street" } },
  "calendar": { "3-172": ["20260819"] }   // exception_type 1 only; the feed has no calendar.txt
}
```

### `route-{id}.json`

```jsonc
{
  "schema": 1,
  "feed_version": "260818_1456",
  "route": { "id": "4", "short_name": "4", "long_name": "4-7th Street",
             "directions": [ { "id": 0, "headsign": "4 Mopac WB" } ] },
  "stops": { "6243": { "name": "Campbell/5th",              // shortened per section 7
                       "name_full": "504 Campbell/5th",
                       "lat": 30.26, "lon": -97.73 } },
  "patterns": { "p6": { "direction_id": 0, "trip_count": 268,
                        "is_baseline": true, "is_special": false,
                        "stop_ids": ["1368", "..."],
                        "adds": [], "skips": [] } },
  "baseline_pattern": { "0": "p6", "1": "p2" },
  "timepoint_stops": { "0": ["1368", "5937", "6243"] },     // baseline stops with timepoint=1
  "trips": { "3014700_15472": { "service_id": "3-172", "direction_id": 0,
                                "headsign": "4 Mopac WB", "block_id": "1010",
                                "pattern": "p4",
                                "start_time": "08:15:00", "end_time": "08:42:00",
                                "block_confidence": "low",
                                "next_trip": { "trip_id": "3014765_15065",
                                               "direction_id": 1,
                                               "start_time": "08:59:00",
                                               "start_stop_id": "1977",
                                               "start_stop_name": "Veterans/Atlanta",
                                               "is_direction_flip": true } } },
  "service_ids": ["1-172", "2-172", "..."]
}
```

Pattern ids are prefixed `p` so the map never serializes as a JSON array. Every map in
every shard must be a JSON object, including `stops`, `trips` and `calendar`.

### `route-{id}.times.json`

```jsonc
{ "schema": 1, "trips": { "3014700_15472": [29700, 29764, 29832, ...] } }
```

Seconds since service-day midnight, one entry per stop, **positional against the trip's
pattern `stop_ids`**. Verified against the whole feed before choosing this shape: all
24,295 trips number their stops 1..N contiguously, and all 244 patterns have an identical
sequence layout and an identical timepoint layout across every trip that shares them.
`arrival_time` equals `departure_time` on all 841,087 rows, so only one is stored.

Splitting times into their own file is what keeps the job cheap: a run parses
`route-{id}.times.json` only for routes that have a bus or a watch, and frees each route
before loading the next. Whole-fleet peak memory is 32 MB.

## Decisions

1. **No conditional requests.** The feeds return an ETag and answer `If-None-Match` with a
   full 200. Implemented nothing; sending the header would look like a saving and be none.

2. **`Accept-Encoding: gzip` always.** Measured on the live feed while building this:
   trip updates transfer 154,310 B gzipped against 1,808,702 B with `identity`.

3. **Per-trip time resolution uses the feed's own `trip.startDate`**, not the run's idea of
   today. A trip that began before midnight is still on yesterday's service date. The
   file-level `service_day.date` uses a 4:30am cutover, which is the only exact boundary in
   this feed: the latest scheduled arrival is `28:29:00` and the earliest first departure of
   a new service date is `04:36:00`.

4. **Cancellations come from the trip updates feed.** All 100 cancellations in the capture
   are there and none are on the positions feed, so honouring only the positions descriptor
   would make row 2 of the decision table dead code and compute lateness against canceled
   trips. When a trip update says `CANCELED`, the emitted `trip.schedule_relationship` says
   `CANCELED` too, so the object is not self-contradictory.

5. **Blocks are chained per `(block_id, service_id)`.** CapMetro reuses the same `block_id`
   across all five weekday service variants, so chaining on `block_id` alone makes a trip's
   successor the identically-timed trip of a parallel service. Chaining on the pair yields
   780 direction flips on route 4 across its services, matching the design's measured 175
   per service. This was a real bug, caught by acceptance criterion 4.

6. **`block.confidence`** follows contract section 4: `high` needs same `route_id`,
   successor's first stop equal to or within 150 m of the predecessor's last stop, and a
   60-1800 s layover; a block whose trips span more than one `route_id` is `low` throughout;
   last trip of a block is `next_trip: null` with `high`. Route 4 grades 774 high / 60 low.
   Block `1010` grades `low` because it interlines routes 1, 4 and 485 — that is the rule
   working, not a defect.

7. **The timepoint ladder is wider than the baseline pattern.** Contract section 3 defines
   the ladder *rows* from `timepoint = 1` on the baseline, and this does exactly that. But
   which stops appear at all is a separate question: stops 1967 and 1971 exist only on route
   4's Austin High variant and both sit under an active `NO_SERVICE` alert, and a ladder
   built strictly from the baseline could never show that — which the contract calls a
   correctness requirement. So every pattern on the direction is merged into the stop order
   (each extra stop inserted after the last stop of its own pattern already present), and
   the merged stops appear as `minor_stops`. Consequence, and the one thing a client author
   needs to know: **`timepoint.stop_sequence` is ladder ordering, not a GTFS join key.** It
   is monotonic within a direction and equals the GTFS `stop_sequence` whenever today's
   patterns agree with the baseline, which is the common case. Use
   `adherence.against.stop_sequence` when a real GTFS sequence is needed.

8. **`pattern_skip` counting.** A ladder stop is `pattern_skip` when no trip present in the
   live trip updates feed serves it, per the section 3.1 counting window. It never fires
   when a route has no trips in the feed at all, so an empty early-morning feed does not
   strike out the whole ladder.

9. **`pattern.is_special`** is true when a pattern is not the baseline and either omits a
   stop the baseline serves, or is carried by four trips or fewer. Merely extending the
   baseline on many trips is a routine variation, not a special, and the extra stops are
   already visible in `adds`. This makes the Austin High 08:15/16:15 run special (8 trips,
   adds Veterans/Atlanta, skips Campbell/5th) without flagging route 4's 129-trip extension.

10. **`pattern.trips_in_pattern` counts the whole feed, not just today.** The contract's own
    section 3 cites "268 of 834 trips" for route 4 direction 0, which is the feed-wide
    count, and the golden fixture agrees (397 for the direction 1 baseline). It is also the
    only number computable at build time, since a shard covers a feed version rather than a
    day.

11. **`alerts_at`.** The alerts feed is a bare array with no header, so it has no
    self-reported generation time. The age of our copy is the time we fetched it. Offline
    runs fall back to the positions header so a fixture run is deterministic.

12. **Deadheads are not in route files.** A deadhead has no route, so it appears only in
    `/api/all.json`. Route files carry the vehicles actually on that route. Contract
    acceptance criterion 2's `deadhead` state is satisfied by `all.json`.

13. **PII is stripped by allowlist at the parse boundary.** `CM_ALERT_ALLOWED_FIELDS` in
    `lib/alerts.php` is the only place an upstream alert field can enter the system. The
    parser never copies the object and deletes keys, so a field CapMetro adds next year
    cannot leak by default. Ten fields are emitted; four upstream fields including
    `userEmail` and `userFullname` are never read.

## Things for other agents

Written here rather than edited into files this task does not own.

- **`schemas/common.schema.json`, `vehicle.route_id`.** It is a required non-nullable
  string, but a deadhead has no route. This job emits `""` for deadheads in `/api/all.json`
  because that is the only in-type way to say "not applicable"; `in_service: false` carries
  the real meaning. Contract section 0 says never use `""` for unknown, so the schema and
  the conventions currently contradict each other here. Making `route_id` nullable would
  resolve it.

- **`schemas/common.schema.json`, `serviceDay.service_ids` has `minItems: 1`.** A route with
  no service at all today has an empty list. This job emits `["none"]` rather than an
  invalid document. Allowing an empty array would be cleaner.

- **`docs/api-contract.md` section 9 example.** `scheduled_time: "07:52:09"` on service date
  `20260819` resolves to `1787143929`, not the `1787146329` printed in the example. The
  resolution itself is right: the tuple resolves to trip `3010894_22201` on both `20260819`
  and `20260820`, as acceptance criterion 9 requires.

- **`docs/api-contract.md` section 2 and 3 examples** show `"504 Campbell/5th"` as a
  `stop_name`, but section 7 rule 2 ("drop a leading street number") shortens it to
  `"Campbell/5th"`, which is what the golden fixture contains. The rules are implemented;
  the examples are stale.

- **Acceptance criteria 2 and 3 cannot be met by the 2026-08-19 capture alone.** At 10:10
  CT every one of the 249 in-service vehicles has a matching trip update, none is canceled,
  and no vehicle is on the 08:15 or 16:15 Austin High trip. The golden fixture's own README
  says the same. Both criteria were verified against synthetic mutations of the real feeds;
  the test suite needs those fixtures committed. What to mutate is in the "Verified" section
  below.

- **`build/`** owns shard generation. `tools/make-shards.php` should be deleted once
  `build/shards.js` emits the format above.

## Verified

Everything below was run, not reasoned about. `.local/` is scratch and gitignored.

- **Schema validation.** 444 generated files across six scenarios (fixture, live network,
  synthetic-unknowns, forced-stale, special-pattern, next-day) validate against
  `schemas/route-state.schema.json`, `all.schema.json`, `watch.schema.json` and
  `health.schema.json` with zero errors.

- **`adherence.state` distribution, `tests/fixtures/feeds-20260819` at `generated_at`
  1787152239** (all 392 vehicles, from `/api/all.json`):

  | state | count |
  |---|---|
  | `ontime` | 149 |
  | `deadhead` | 143 |
  | `early` | 35 |
  | `late` | 33 |
  | `very_late` | 32 |
  | `unknown` | 0 |

  Zero `unknown` is correct for this minute: all 249 in-service trip ids have a trip update,
  none is canceled, and every one reports a `currentStopSequence`.

- **All six states and all five non-stale reasons** were produced from a synthetic mutation
  of the same feeds — one route 4 vehicle each: positions descriptor flipped to `CANCELED`,
  trip update deleted, `stopTimeUpdate` emptied, trip id renamed to one GTFS never had, and
  `currentStopSequence` removed. Result: `ontime` 144, `deadhead` 143, `early` 35, `late`
  33, `very_late` 32, `unknown` 5, with reasons `trip_canceled`, `no_trip_update`,
  `no_stop_predictions`, `trip_not_in_schedule`, `no_progress`, one each.

- **Forced stale** (`--now` = positions timestamp + 700s): every route file reports
  `staleness.level: "stale"` and `suppress_adherence: true`, and all 249 in-service vehicles
  report `unknown` / `stale_data`. `health.ok` is false.

- **PII.** Zero occurrences of `userEmail`, `userFullname`, `@capmetro.org`, or any of the
  40 distinct staff identifiers in the fixture, across all 444 generated files. Emitted
  alert keys: `id, effect, cause, header, description, url, active_from, active_until,
  stop_ids, severity`.

- **Atomic writes.** A reader loop performed 212,168 successful `json.loads` of
  `/api/route/4.json` during 60 full write cycles, with 0 parse errors.

- **`flock`.** With the lock held by another process the job logs
  "another run holds the lock; exiting without writing" and exits 0 without touching any
  file.

- **Upstream failure.** With all three feeds unreachable, `route/4.json` is byte-identical
  before and after, `health.json` reports `ok: false` with the three fetch errors, and
  `cron_last_success_at` keeps its previous value.

- **DST.** `25:10:00` resolves on both 2026 transition dates and on ordinary days;
  `28:29:00` and `24:00:00` parse; service-day midnight for 2026-03-08 is 23:00 CST the
  previous evening and for 2026-11-01 is 01:00 CDT, which is exactly what noon-minus-12
  means and what GTFS specifies.

- **Acceptance criteria.** 1 pass, 2 pass (synthetic), 3 pass (synthetic: `is_special` true,
  `Veterans/Atlanta` in `adds`, `Campbell/5th` in `skips`), 4 pass (5 of 5 route 4 vehicles
  have `is_direction_flip: true`), 5 pass (stop `1222` on route 800: `realtime_skipped`,
  `served: false`, "Skipped on 76 trips today"), 6 pass (stops `1967` and `1971` on route 4:
  `alert_no_service`, `served: false`), 7 pass, 8 pass, 9 pass (`3010894_22201` on both
  20260819 and 20260820), 10 pass (no `stop_name` over 25 characters; 126 truncated names,
  all cut at a word boundary).

- **Cost.** A full run over all 71 routes takes 0.17-0.28 s wall and peaks at 32 MB, writing
  1.3 MB of JSON. Shards for all 71 routes are 14 MB on disk.
