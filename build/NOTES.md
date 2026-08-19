# GTFS shard build

Turns the CapMetro GTFS static feed (11.3 MB zip / 66 MB unzipped / 841,087 `stop_times` rows)
into small per-route JSON files the PHP runtime reads every minute.

```
npm install
npm run build        # reuse the cached SQLite import if present
npm run build:fresh  # re-import the feed first
npm run verify       # assert the emitted shards against measured facts
npm run gtfs         # build + verify
```

Source resolution, in order: `GTFS_DIR` (an extracted feed directory), then `/tmp/gtfs` when it
looks like one, then a download from `GTFS_URL`
(`https://data.texas.gov/download/r4v4-vz24/application%2Fzip`). Set `GTFS_FORCE_DOWNLOAD=1` to
skip the `/tmp/gtfs` shortcut. Ingestion uses the `gtfs` npm package (node-gtfs 4.20) into a
SQLite cache at `build/.cache/gtfs.db`; everything downstream reads SQLite, never the CSVs.
Full run from a cold download: about 25 seconds.

---

## Output layout

Output goes to **`data/`** at the repo root (override with `GTFS_OUT_DIR`). `data/` was chosen
over `dist/` because api-contract.md §11 already names `/data/*` as the long-cache path for
schedule shards, distinct from the `no-cache` `/api/*` files the runtime writes.

```
data/
  manifest.json                     feed version, built_at, counts, per-route index
  calendar.json                     service date -> service ids, one-off flags
  stops.json                        stop_id -> shortened + full name, lat, lon
  routes/<route_id>/
    schedule.json                   every trip's stop times          (compact)
    patterns.json                   trip pattern classification      (indented)
    blocks.json                     block continuation chains        (compact)
    calendar.json                   this route's service dates       (indented)
    timepoints.json                 ladder rows + minor stops        (indented)
```

358 files, **27.96 MB raw / 2.99 MB gzipped** for all 71 routes. Route directory names are the
route id, escaped to `[A-Za-z0-9._-]` and suffixed with a hash if escaping changed anything;
the manifest records the mapping as `dir`. No escaping was needed for the current feed.

### Sizes

Schedule shards alone total 16.65 MB raw / 2.12 MB gzipped. Largest and smallest:

| Route | Trips | stop_times rows | schedule.json raw | gzipped | whole route dir raw / gz |
|---|---|---|---|---|---|
| 10 | 1,057 | 74,176 | 1,348 KB | 189 KB | — |
| 7 | 1,070 | 67,925 | 1,240 KB | 169 KB | 1,707 KB / 205 KB |
| 5 | 565 | 34,462 | 629 KB | 76 KB | 868 KB / 96 KB |
| 800 | 903 | 18,952 | 431 KB | 52 KB | 798 KB / 78 KB |
| 4 | 834 | 18,624 | 410 KB | 43 KB | 740 KB / 66 KB |
| 339 (median) | 188 | 4,330 | 97 KB | 19 KB | — |
| 980 (smallest) | 6 | 67 | 2 KB | 1 KB | — |

Route 5 came in at 629 KB raw / 76 KB gzipped against a ~1.0 MB / 180 KB target, because the
schedule shard interns stop ids and stores times as integers rather than repeating keys.

### File shapes

**`schedule.json`** — the big one, so it is deliberately terse. `stop_ids` is a per-file
interning table; each trip's `stops` is an array of `[stop_sequence, stop_index, arrival_s,
timepoint]` rows, with `stop_index` an offset into that table. Times are **integer seconds
after service-day midnight**, not clock strings, so `25:10:00` needs no special case. The
runtime converts to epoch with the noon-minus-12 rule in api-contract.md §2, and back to a
`HH:MM:SS` service clock (which watch resolution in §9 compares against) with
`sprintf('%02d:%02d:%02d', intdiv($s,3600), intdiv($s%3600,60), $s%60)`.

Only `arrival_time` is stored, per the build spec. Adherence in §2 compares against arrival
and `arrival` wins over `departure` where both exist, so departure is not needed downstream.
Departure times *are* read during the build, for block layovers.

**`patterns.json`** — per direction: `baseline_pattern_id`, `baseline_by_service`,
`baseline_stable`, and one entry per pattern with `stop_ids`, `trip_ids`, `trips_in_pattern`,
`trips_by_service`, and `deltas`. `pattern_id` is `<route>-<direction>-<sha1(signature)[0:8]>`,
stable across rebuilds as long as the stop sequence is unchanged.

**`blocks.json`** — `blocks` maps `block_id` to its metadata and its per-service ordered trip
lists; `trips` maps each trip to `{block_id, service_id, confidence, next_trip, layover_s,
handoff_distance_m, grade_reasons}`. `next_trip` carries the contract's §2 fields except
`start_epoch`, which needs a service date and therefore belongs to the runtime.
`next_route_id` sits beside `next_trip`, not inside it, so the object can be passed through to
the contract shape without stripping.

**`timepoints.json`** — per direction, a `ladders` map keyed by baseline pattern id (see the
service-date note below). Each ladder has `timepoints[]`, each carrying its `minor_stops[]`.
`service_status` is **not** emitted: all three of its sources (realtime `SKIPPED`, `NO_SERVICE`
alerts, the running trip's own pattern) are live inputs the runtime owns.

---

## Decisions

### Output is byte-identical for a given feed, and nothing reads the clock

Every object key is sorted recursively before serialization, every array has an explicit sort,
and `built_at` is derived from the feed's own `feed_version` (`YYMMDD_HHMM`, parsed in
`America/Chicago`) rather than from `Date.now()`. A wall-clock `built_at` would put a fresh
timestamp in `manifest.json` every day and defeat the whole point of the `feed_version` gate.

Verified: a build from `/tmp/gtfs` and a build from a fresh download of the live URL produce
the identical tree hash `ede925c7…`. A committed tree rebuilt in place leaves
`git status --porcelain -- data` empty, which is exactly what the workflow's no-op day depends
on.

### Block chains are keyed on (block_id, service_id), not block_id alone

This is the one place the build departs from a stated verification target, and it is
deliberate.

CapMetro reuses the same `block_id` across all eight service variants. Grouping route 4's 834
trips by `block_id` alone gives 10 lists averaging 83 trips — which the design doc reads as "a
block is one physical vehicle's day", but no bus runs 83 trips in a day. Interleaving eight
service days into one list produces **719 of 824 successor pairs with a negative layover**: the
"next" trip starts before its predecessor finishes. Keyed on `(block_id, service_id)` the same
route yields 55 chains averaging 15 trips and **zero** negative layovers, feed-wide zero across
all 22,180 pairs.

The three worked examples already published settle it:

| Predecessor | Documented successor | block_id only | (block_id, service_id) |
|---|---|---|---|
| `3014695_15713` (design doc) | `3014759_15051` @ 07:30 stop 6243 | `3014759_15051` ✓ | `3014759_15059` @ 07:30 stop 6243 |
| `3014700_15476` (Austin High) | `3014765_15061` @ 08:59 stop 1977 | `3014765_15061` ✓ | `3014765_15069` @ 08:59 stop 1977 |
| `3014706_15608` (contract §2) | `3014770_15088` @ 10:21 stop 6243, dir flip | `3014706_15665` @ **09:49**, stop 1368, **no flip** ✗ | `3014770_15203` @ 10:21 stop 6243, dir flip ✓ |

Trip ids are `<scheduled_trip_id>_<sequence>`. In the first two rows both methods return the
*same scheduled trip* at the same time from the same stop — `3014759_15059` is simply the
service-matched twin of `3014759_15051`. In the third row `block_id` alone fails outright,
returning a trip that starts 25 minutes *before* its predecessor ends, at the wrong stop, with
no direction flip. `(block_id, service_id)` reproduces the contract's own §2 example exactly.

**Consequence for the stated target:** route 4 has **780 direction flips across 780 successor
pairs**, not 175. The 175 figure is reproducible but is an artifact of the interleaving — it
counts flips in a list that mixes eight service days. Route 4's trip count (834) and block
count (10) are unaffected and match.

### Pattern baselines and `trips_in_pattern` are per service date

api-contract.md §3 defines the baseline "on the current service date" and §2 defines
`trips_in_pattern` as "how many trips share this stop signature **today**". Both qualifiers
turn out to matter:

- Route 4 direction 0 runs **two different baselines** depending on the day. Services 1-172,
  6-172 and 8-172 use a 19-stop baseline that serves stops 1967 and 1971; services 2/3/4/5/7-172
  use a 17-stop one that does not. A single feed-wide baseline would mislabel the ladder on
  three of eight service days.
- The Austin High special has 8 feed-wide trips but exactly **2 per service date**, which is
  what the verification target describes.

So each direction emits `baseline_by_service` (what the runtime resolves against today's
service), `baseline_pattern_id` (the feed-wide default, which is where §3's "268 of 834 trips"
figure comes from — confirmed at 268), and `baseline_stable`. Each pattern emits
`trips_by_service` alongside the feed-wide `trips_in_pattern`.

Because "added" and "skipped" depend on which baseline is in force, `adds`/`skips` are emitted
as `deltas`, keyed by baseline pattern id, covering every baseline that direction can resolve
to. **The runtime must read `deltas[patterns.directions[d].baseline_by_service[today_service]]`,
not a top-level `adds`/`skips`** — there deliberately isn't one, so there is no way to grab the
wrong baseline's answer by accident.

`timepoints.json` follows the same logic: one ladder per distinct baseline, keyed by pattern id.

### `block.confidence` follows §4 literally, including the multi-route rule

§4 grades `low` for, among other things, "a block whose trips span more than one `route_id`".
Block `1010` genuinely interlines routes 1, 4 and 485, so trip `3014706_15608` is graded
`low` — even though its own successor pair is same-route, same stop (0 m), 420 s layover, and
would otherwise be `high`.

The contract's §2 *example* shows that same trip as `"confidence": "high"`. §4 is the normative
rule and §2 is illustrative, so §4 wins; **the two are inconsistent and §2's example should
probably be corrected.** `grade_reasons: ["block_spans_multiple_routes"]` is emitted so the
demotion is never mysterious. The multi-route test is evaluated on the chain's own
`(block_id, service_id)` route set, not the block-wide one, since that is the actual vehicle
day; block-wide `route_ids` and `spans_routes` are still recorded in the block metadata.

Route 4 lands at 774 of 834 trips `high`.

### Stop name shortening is literal, which disagrees with one contract example

§7's four rules are implemented exactly and in order. Rule 2 ("drop a leading street number",
`"4999 7th/Shady"` → `"7th/Shady"`) means stop `6243` shortens to **`Campbell/5th`**, not
`504 Campbell/5th`. The §2 and §3 examples show `"stop_name": "504 Campbell/5th"`, which is the
raw upstream name and contradicts §7's own rule and worked example. Rules were implemented as
written; **acceptance criterion 3 in the contract expects the string `504 Campbell/5th` in
`skips` and will need updating to `Campbell/5th`** (or §7 rule 2 needs a carve-out).

Every other cited name matches: `1222` → `Dove Springs NB`, `1977` → `Veterans/Atlanta`,
`6293` → `Simond SB`.

Rule 4 has an unstated edge case: a name that is a single token longer than 24 characters has
no word boundary to truncate at, so §7's "never truncate mid-word" and the schema's
25-character cap cannot both be satisfied. The cap wins — the name is cut one character short
of the budget and marked. A mid-word cut is bad; a document that fails its own schema is
worse. Exactly one stop in this feed is affected: `6477` `University/Orion/Goodwill` becomes
`University/Orion/Goodwi…`. 215 of 2,348 names needed truncation; the other 214 all cut at a
space.

Two further unstated cases, resolved the same way in both lanes: a step that would reduce the
name to nothing is skipped (so `"12345"` stays `"12345"`), and a name that empties out entirely
falls back to the raw upstream string.

**This function must stay behaviourally identical to `runtime/lib/stopnames.php`**, because the
build writes `stop_name` for static ladder rows and the runtime writes it for live vehicle
rows, and two spellings of one stop would be a visible bug. Verified: both implementations
produce byte-identical output across all 2,348 names in the feed. `build/lib/stop-names.mjs`
mirrors the PHP branch for branch, including the fallbacks above.

### Calendar

There is no `calendar.txt`; all 589 rows of `calendar_dates.txt` are `exception_type 1`
(added). `exception_type 2` is handled anyway, for the day the feed grows one. `is_exception_day`
follows §1: true when any service active that date spans exactly one date.

Per-route service data is emitted separately because there is no single "weekday" service —
`1-172` covers 95 weekdays over 42 routes while `9-172` covers 99 over 32, both confirmed.

### Timepoints

Ladder rows come from `stop_times.timepoint = 1` on the baseline pattern, using the
lexicographically smallest trip id in that pattern as the representative so rebuilds are
stable. Two routes (103 direction 0, 322 direction 1) have a baseline whose first stop is not a
timepoint; the stops ahead of the first timepoint would have no ladder row to hang off, so the
first stop is promoted and a warning is recorded in `manifest.warnings`. Every one of the 204
emitted ladders accounts for each baseline stop exactly once.

A missing `timepoint` column is treated as `1` per the GTFS spec.

---

## Notes for other agents

These touch directories this job does not own.

1. **`docs/api-contract.md` §2/§3 examples show `"stop_name": "504 Campbell/5th"`**, which §7
   rule 2 shortens to `Campbell/5th`. Acceptance criterion 3 names the same string. One of the
   two needs to change; the build implements §7 as written.
2. **`docs/api-contract.md` §2's example shows block `1010` with `confidence: "high"`**, but §4
   grades a multi-route block `low` and block `1010` interlines routes 1, 4 and 485. The
   example contradicts the rule.
3. **The design doc's "175 direction flips" on route 4** counts flips across a list that
   interleaves eight service days. The physically correct figure is 780 of 780 successor pairs.
   See the block chain section above for the evidence.
4. **`schemas/` has no schema for the build shards.** The five schemas cover the runtime's
   `/api/*` output, which is a different shape. If shard validation is wanted, a
   `schemas/shard-*.schema.json` set would need to be added by whoever owns `schemas/`.
5. **`.gitignore` already ignores `build/data/` and `build/dist/`.** Those entries are now
   vestigial, since the output goes to `data/` at the repo root so CI can commit it and the
   webserver can serve it as `/data/*` per §11. `node_modules/` and `build/.cache/` are already
   covered correctly. Harmless either way, but worth tidying.
6. **`data/` is not committed yet.** The workflow commits it, but the first commit has to come
   from a human or from a `workflow_dispatch` run with `force_commit`. It is 27.96 MB raw and
   about 5.5 MB as a git object store; `TODOS.md` already tracks the history-growth question,
   and the `feed_version` gate it names as "the cheapest mitigation" is implemented here.

## Interfaces other lanes import

`tests/node/` probes a handful of module paths under `build/`. Those paths exist as thin,
stable entry points over `build/lib/`:

| Path | Exports |
|---|---|
| `build/time.js` | `serviceDayMidnight`, `serviceClockToEpoch`, `clockToSeconds`, `secondsToClock`, `feedVersionToEpoch` |
| `build/stops.js` | `shortenStopName`, `stopsIndex` |
| `build/blocks.js` | `blockConfidence`, `continuationReasons`, `buildBlockChains` |
| `build/calendar.js` | `activeServiceIds`, `isExceptionDay`, `watchId`, `buildCalendar` |

`blockConfidence` is §4's grade as a pure function over one predecessor/successor pair, and it
is the same code path `buildBlockChains` runs over the feed, so the rule has one
implementation. `serviceDayMidnight` implements §2's noon-minus-12 anchor: on 2026-03-08 it
lands at 23:00 the previous evening, because that service day is 23 hours long.

**`build/shards.js` (`unmatchedTripRate`, `shardHealth`) is deliberately absent.** Both grade
how well live trip updates match a shard, which is a property of a runtime poll rather than of
the static build, and neither has an input the build job possesses. `optionalModule` skips
those tests with a reason rather than failing, so the gap is visible. Whoever owns the runtime
should decide where they live.

`package.json` gained `vitest` as a devDependency and a `test` script so `tests/node/` can run;
that file was untracked and effectively unowned before.

## Workflow

`.github/workflows/gtfs.yml` runs daily at 11:20 UTC, rebuilds from the upstream feed, and
commits only when `feed_info.txt`'s `feed_version` differs from the one in the committed
`data/manifest.json`. On an unchanged feed it asserts the rebuilt tree is byte-identical to the
committed one and fails if it is not — a diff without a `feed_version` bump means either
CapMetro republished without bumping or the build lost determinism, and both need a human.
`npm run verify` gates the commit. `workflow_dispatch` accepts `force_commit` for the first
commit and for recovery.

`build/verify.mjs` splits its assertions: structural invariants (name lengths, no mid-word
truncation, referential integrity, ladder coverage, no negative layovers) run on every feed,
while facts measured against `feed_version 260818_1456` (route 4's pattern and block counts,
route 7's timepoints, route 5's row count) soften to informational reports on any other
version. Otherwise the first legitimate CapMetro republish would block rebuilds forever.
