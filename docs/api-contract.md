# Route-State API Contract

Status: DRAFT
Version: schema 1
Written: 2026-08-19
Amended: 2026-08-19 — added `route.next_departure` (§1) and the windowed timepoint schedule
`schedule` (§3.2); made `alerts[].stop_ids` an explicit set (§5); added ordinal normalization as
§7 rule 4; acceptance criteria 11 to 14. Purely additive: no existing field changed shape, so
`schema` stays **1**.
Source task: T6 in `docs/designs/capmetro-dispatch-board.md`

The runtime job writes static JSON into the webroot. The client reads it and renders. This
document is the boundary between them. **The client makes no inference.** Every derived value
(lateness, pattern classification, block continuation, stop service status, staleness) is computed
server-side and named explicitly here.

All shapes are validated by JSON Schema, committed alongside this document:

| Endpoint | Schema |
|---|---|
| shared `$defs` | `schemas/common.schema.json` |
| `/api/route/{id}.json` | `schemas/route-state.schema.json` |
| `/api/all.json` | `schemas/all.schema.json` |
| `/api/watch/{id}.json` | `schemas/watch.schema.json` |
| `/api/health.json` | `schemas/health.schema.json` |

The committed fixtures in `tests/fixtures/feeds-20260819/` are the inputs; schema validation of
generated output is a test, not a convention. There are **four endpoint kinds**; the route
endpoint is one kind with one file per route.

---

## 0. Conventions

- **All times are Unix epoch seconds, integers.** Never strings, never local time strings. The
  client formats for display; the server never does.
- **All durations are signed integers in seconds.** Negative is early, positive is late.
- **Absent vs null.** A field that is absent means "not applicable to this object." A field that
  is `null` means "applicable but unknown." These are different and the client renders them
  differently. Never use `0` or `""` to mean unknown.
- **Every response carries `schema`.** The client refuses to render a response whose `schema` is
  greater than the version it was built for, and shows an "app needs updating" state.
- **Route and stop IDs are strings**, matching GTFS. `"4"`, not `4`. Some CapMetro route IDs are
  non-numeric.
- **No field is ever a CapMetro staff name or email.** See section 6.

---

## 1. `GET /api/route/{route_id}.json`

The primary endpoint. One file per route, regenerated every cron run.

```jsonc
{
  "schema": 1,
  "generated_at": 1787152239,          // when this file was written
  "route": {
    "id": "4",
    "short_name": "4",
    "long_name": "4-7th Street",
    "directions": [
      { "id": 0, "headsign": "4 Mopac WB" },
      { "id": 1, "headsign": "4 Shady EB" }
    ],
    "next_departure": {                 // null when the service day is over; see below
      "scheduled_at": 1787152860,
      "stop_id": "1368",
      "stop_name": "Pleasant Valley/5th",
      "direction_id": 0,
      "headsign": "4 Mopac WB"
    }
  },
  "feeds": {                            // age of each upstream input, for staleness rendering
    "positions_at": 1787152239,
    "trip_updates_at": 1787152196,
    "alerts_at": 1787152100,
    "gtfs_feed_version": "260818_1456",
    "gtfs_built_at": 1787100000
  },
  "staleness": {                        // server decides; client does not compute this
    "level": "fresh",                   // fresh | aging | stale | dead
    "oldest_feed_age_s": 43,
    "schedule_age_days": 1,
    "suppress_adherence": false,        // when true the client MUST NOT render any lateness value
    "reason": null                      // human-readable string when level != fresh
  },
  "service_day": {
    "date": "20260819",                 // GTFS service date, not calendar date
    "service_ids": ["3-172", "9-172"],  // active today for THIS route
    "is_exception_day": true            // true when any active service_id spans exactly one date
  },
  "vehicles": [ /* Vehicle, see §2 */ ],
  "timepoints": [ /* Timepoint, see §3 — BOTH directions in one flat array */ ],
  "schedule": { /* windowed timepoint schedule, see §3.2 */ },
  "alerts": [ /* Alert, see §5 */ ]
}
```

**One file per route, both directions.** There is no `direction_id` in the URL. The file carries
every vehicle on the route and every timepoint for both directions in flat arrays; each
`Timepoint` and each `Vehicle.trip` carries its own `direction_id`. The client filters for the
A / B / BOTH toggle. This keeps one fetch per route regardless of which direction the user is
looking at, which matters because the BOTH toggle would otherwise need two round trips.

### `route.next_departure`

So the empty state can say *"No buses on route 350 right now. Next departure 2:14pm from
Airport/12th."* rather than stopping after the first sentence. Without this field the client
either invents the second sentence or omits it, and both are worse than the server answering.

It names exactly one trip: **the earliest scheduled trip start on this route, for the current
service date, strictly after `generated_at`, across both directions.** Precisely:

- *Trip start* is the scheduled arrival time at the trip's **first stop**, resolved to epoch by
  the service-day rule in §2 — the same value as `Vehicle.trip.start_epoch`.
- Only trips whose `service_id` is active on the current service date are eligible (§9's
  `calendar_dates.txt` resolution, same rule).
- A trip the live trip-updates feed reports as `CANCELED` is **excluded**. A departure the
  agency has already canceled is not a promise the board should make.
- Ties — two trips scheduled to the same second — break toward the lower `direction_id`, then
  the lexicographically smallest `trip_id`, so the value is stable across rebuilds.
- `direction_id` and `headsign` describe the trip that departs, not the route's default
  direction. `headsign` is the trip's GTFS `trip_headsign` and may be `null`; `stop_name` is
  shortened per §7.

`null` means no departure remains today: the service day is over. The key is **always present**
— `null` and absent are not interchangeable (§0), and a client that has to tell "server did not
compute this" from "there genuinely is no next bus" has been handed an inference to make.

Computed on every route regardless of whether it currently has vehicles. The empty state is the
reason it exists, but a route showing five buses can still answer "when does the next one leave".


### Staleness levels

| level | Condition | Client behavior |
|---|---|---|
| `fresh` | oldest feed age <= 120s and schedule_age_days <= 2 | Normal render |
| `aging` | oldest feed age <= 600s | Render normally, show age chip |
| `stale` | oldest feed age > 600s **or** schedule_age_days > 7 | `suppress_adherence: true`; positions shown, no lateness numbers, banner |
| `dead` | oldest feed age > 3600s | Positions shown greyed; prominent banner with last-good time |

`suppress_adherence` is authoritative. The client checks that flag, not the ages. This is the
enforcement rule the engineering review required: staleness is a rendered state, not a log line.

---

## 2. Vehicle object

```jsonc
{
  "vehicle_id": "2641",
  "label": "2641",
  "route_id": "4",                      // always present, including in /api/all.json
  "route_short_name": "4",
  "position": { "lat": 30.27623, "lon": -97.66901, "bearing": 214.0, "speed_mps": 0.0 },
  "position_at": 1787152230,

  "in_service": true,                   // false = deadhead / no trip assigned
  "trip": {                             // absent entirely when in_service is false
    "trip_id": "3014767_15200",
    "start_time": "09:33:00",           // GTFS service-day clock string, may exceed 24:00:00
    "start_epoch": 1787147580,          // resolved to epoch; use THIS for display
    "direction_id": 1,
    "headsign": "4 Shady EB",
    "schedule_relationship": "SCHEDULED" // SCHEDULED | CANCELED | ADDED | UNSCHEDULED
  },

  "progress": {                         // absent when in_service is false
    "current_stop_sequence": 42,        // null when the feed omits it
    "current_stop_id": "6243",
    "current_status": "IN_TRANSIT_TO"   // IN_TRANSIT_TO | STOPPED_AT | INCOMING_AT | null
  },

  "adherence": {
    "state": "late",                    // early | ontime | late | very_late | unknown | deadhead
    "seconds": 183,                     // null when state is unknown or deadhead
    "glyph": "up-triangle",             // left-triangle|circle|up-triangle|square|question|ring
    "against": {                        // null when state is unknown or deadhead
      "stop_id": "6243",
      "stop_name": "504 Campbell/5th",
      "stop_sequence": 43,
      "scheduled_at": 1787152380,
      "predicted_at": 1787152563
    },
    "reason": null                      // set when state is unknown, e.g. "no_trip_update"
  },

  "pattern": {                          // absent when in_service is false
    "is_baseline": false,
    "is_special": true,
    "trips_in_pattern": 2,              // how many trips share this stop signature today
    "adds": [ { "stop_id": "1977", "stop_name": "Veterans/Atlanta" } ],
    "skips": [ { "stop_id": "6243", "stop_name": "504 Campbell/5th" } ]
  },

  "block": {                            // absent when in_service is false
    "block_id": "1010",
    "confidence": "high",               // high | low  (see §4)
    "next_trip": {                      // null when this is the last trip of the block
      "trip_id": "3014770_15088",
      "direction_id": 1,
      "start_time": "10:21:00",
      "start_epoch": 1787155260,
      "start_stop_id": "6243",
      "start_stop_name": "504 Campbell/5th",
      "is_direction_flip": true         // the whole point: this bus becomes the other direction
    }
  }
}
```

### `adherence.state` decision table

Evaluated in order. First match wins.

| Order | Condition | state | seconds |
|---|---|---|---|
| 1 | `in_service` is false | `deadhead` | null |
| 2 | `trip.schedule_relationship` is `CANCELED` | `unknown` | null, `reason: "trip_canceled"` |
| 3 | No matching trip update for this trip | `unknown` | null, `reason: "no_trip_update"` |
| 4 | Trip update has no `stopTimeUpdate` entries | `unknown` | null, `reason: "no_stop_predictions"` |
| 5 | Trip id absent from the schedule shard | `unknown` | null, `reason: "trip_not_in_schedule"` |
| 6 | `staleness.suppress_adherence` is true | `unknown` | null, `reason: "stale_data"` |
| 6b | `progress.current_stop_sequence` is null | `unknown` | null, `reason: "no_progress"` |
| 7 | seconds < -60 | `early` | signed |
| 8 | -60 <= seconds <= 150 | `ontime` | signed |
| 9 | 150 < seconds <= 360 | `late` | signed |
| 10 | seconds > 360 | `very_late` | signed |

Rows 2 through 5 are not hypothetical. In the 2026-08-19 fixture: 143 of 392 vehicles are
deadheads, 100 of 912 trip updates are `CANCELED` with no stop predictions (11%), and roughly 7%
of active vehicle trips have no matching trip update at all.

**`seconds` is computed as** `predicted_at - scheduled_at` at the first stop in the trip update
whose `stopSequence >= current_stop_sequence`, skipping any entry whose `scheduleRelationship` is
`SKIPPED` and any entry with neither an arrival nor a departure time. When both `arrival` and
`departure` are present, **`arrival` wins**. When `current_stop_sequence` is null the comparison
has no anchor, so row 6b applies and the state is `unknown` with `reason: "no_progress"`; 143 of
392 vehicles in the fixture have a null `current_stop_sequence`. `scheduled_at` comes from
the GTFS schedule shard, joined on `(trip_id, stop_sequence)`. There is no `delay` field in the
upstream feed; it must be computed.

**Service-day time resolution.** GTFS clock strings may exceed 24 hours (`"25:10:00"` means 1:10am
the following day). Resolve as `service_day_midnight_local + h*3600 + m*60 + s`, where
`service_day_midnight_local` is noon on the service date minus 12 hours in `America/Chicago`. The
noon-minus-12 form is required: it is DST-correct, whereas midnight-plus-offset is not.

---

## 3. Timepoint object

The ladder's default row set. Derived from GTFS `stop_times.timepoint = 1` on the route's
**baseline pattern** for each direction. Both directions appear in one flat array; filter on
`direction_id`.

**Baseline pattern is defined as** the stop-ID signature shared by the greatest number of trips
for that `(route_id, direction_id)` on the current service date. Ties break toward the signature
with more stops, then toward the lexicographically smallest first stop id, so the choice is
deterministic across rebuilds. On route 4 direction 0 the baseline is 268 of 834 trips.

```jsonc
{
  "stop_id": "1222",
  "stop_name": "Dove Springs NB",       // shortened per §7
  "stop_name_full": "Dove Springs NB (Pleasant Valley/Stassney)",
  "stop_sequence": 18,
  "direction_id": 0,
  "lat": 30.18, "lon": -97.75,
  "service_status": {
    "served": false,
    "source": "realtime_skipped",       // see precedence below
    "detail": "Skipped on 123 trips today"   // counting window: §3.1
  },
  "minor_stops": [                      // the accordion payload; stops between this and the next
    { "stop_id": "1223", "stop_name": "Pleasant Valley/Terri", "stop_sequence": 19,
      "lat": 30.18, "lon": -97.75, "service_status": { "served": true, "source": null, "detail": null } }
  ]
}
```

### 3.1 Counting window for `detail`

Counts in `detail` are over **the trips of the current service date present in the live trip
updates feed at `generated_at`**, not over the whole schedule and not a rolling window. The number
therefore moves during the day, which is correct: it answers "how much is this happening today".

### `service_status` precedence — THREE independent sources

There are three ways a stop can be not-served, they disagree, and the contract must rank them.
Measured on the 2026-08-19 fixture: 172 realtime `SKIPPED` events across 5 stops, 38 stops under a
`NO_SERVICE` alert, and static special patterns that add and skip stops. **Only 1 of the 5
realtime-skipped stops also had an alert.** They are largely independent signals.

| Priority | `source` | Origin | Meaning |
|---|---|---|---|
| 1 | `realtime_skipped` | `stopTimeUpdate.scheduleRelationship == "SKIPPED"` | The agency says this specific trip skips this stop, right now. Most authoritative. |
| 2 | `alert_no_service` | Alerts feed, `effect == "NO_SERVICE"`, active period covers now | The stop is closed. Applies to all trips. |
| 3 | `pattern_skip` | The vehicle's trip pattern omits a stop the baseline serves | Scheduled variation, e.g. the Austin High special run. |
| — | `null` | None of the above | Served normally. |

Highest priority wins. `served: false` from any source means the client renders the stop struck
through with the reason. **This is a correctness requirement, not a nicety**: at time of writing,
6 stop/route pairs on the six watched routes are scheduled in GTFS but under an active
`NO_SERVICE` alert, two of them on the route 4 Austin High run.

### 3.2 Windowed timepoint schedule — `schedule`

The ladder can draw where a bus **is**. Drawing where it **should be** — a true time-axis
string-line, scheduled trips as diagonals with live vehicles plotted against them — needs
scheduled clock times at more than one stop per bus. Everything above this section gives the
client exactly one scheduled time per vehicle (`adherence.against.scheduled_at`), which is enough
for a lateness number and not enough for a diagonal.

`schedule` supplies them: for each direction, the scheduled arrival time at each **timepoint**,
for every trip whose span overlaps the **schedule window**.

```jsonc
"schedule": {
  "window": {
    "from": 1787151339,      // generated_at - before_s  (09:55:39 CDT)
    "until": 1787154939,     // generated_at + after_s   (10:55:39 CDT)
    "before_s": 900,         // 15 minutes back
    "after_s": 2700          // 45 minutes forward
  },
  "directions": [
    {
      "direction_id": 0,
      "timepoint_stop_ids": ["1368", "5937", "6243"],      // the column order
      "trips": [
        ["3014707_15609", 1787151900, [0, 900, 1500]],     // [trip_id, start_epoch, offsets]
        ["3014708_15610", 1787152860, [0, 900, 1500]]
      ]
    },
    { "direction_id": 1, "timepoint_stop_ids": ["6243", "5610", "1368"], "trips": [ /* ... */ ] }
  ]
}
```

**A trip row is `[trip_id, start_epoch, offsets]`** — always exactly three elements, in that
order.

- `start_epoch` — the trip's scheduled start: the scheduled arrival at its **first stop**, not
  its first timepoint, resolved by the service-day rule in §2. For a `SCHEDULED` trip this is the
  same value as `Vehicle.trip.start_epoch`, which is how the client joins a live vehicle to its
  own diagonal without a second lookup. Verified on the 2026-08-19 fixture: all five in-service
  route 4 vehicles match their schedule row exactly.
- `offsets[i]` — seconds from `start_epoch` to the scheduled arrival at `timepoint_stop_ids[i]`.
  Always an integer ≥ 0. **`null` when this trip does not serve that timepoint**, which happens
  on special patterns (§3 already models the same fact for the row set). Absolute clock time is
  `start_epoch + offsets[i]`.
- A trip serving **none** of the columns is omitted from `trips` entirely rather than carried as
  an all-null row.
- Offsets rather than absolute epochs because they are 1–4 digits instead of 10 and repeat across
  trips, which shrinks the file both raw and gzipped. Array-of-arrays rather than objects for the
  same reason: the key names would otherwise repeat once per timepoint per trip.

`timepoint_stop_ids` is the column order: the timepoints of that direction's **baseline pattern**
(§3), in `stop_sequence` order. It is exactly the `stop_id` sequence of the `timepoints[]`
entries carrying that `direction_id`, in the same order, so the client can index the two together
with no matching logic. `schedule.directions` carries exactly one entry per entry in
`route.directions`, in ascending `direction_id`; a direction with no baseline timepoints, or
with no trip in the window, appears with empty `timepoint_stop_ids` / empty `trips` rather than
being omitted, so the client never has to distinguish "absent" from "nothing scheduled".

Rows are sorted by `start_epoch` ascending, then `trip_id`, so a diff between two runs is
readable.

#### The schedule window

**`generated_at - 900` to `generated_at + 2700`** — now minus 15 minutes, now plus 45 minutes.
Both bounds are restated in the payload as `before_s` and `after_s` so they are a server
decision, not a client constant; a later widening is a build change and nothing else.

A trip is included when its span **overlaps** the window — `trip_start <= window.until` **and**
`trip_end >= window.from`, where `trip_end` is the scheduled arrival at its last stop. Overlap,
not "starts inside the window": the trips already in progress are precisely the ones with buses
on them, and a start-inside test would drop every one of them.

Why 15 back and 45 forward. Backward is the shorter side because a trip that ended twenty minutes
ago has no diagonal worth drawing beside a live position; 15 minutes covers the in-progress trips
whose start is already behind us, which on route 4 at this hour is one full 16-minute headway.
Forward is the longer side because the question a dispatch board answers is what happens next: 45
minutes shows two to three following trips per direction, enough for the string-line to read as a
repeating pattern and enough to answer "when is the next one" without a second fetch. The window
holds **12** of route 4's **124** trips for this service date.

#### Measured size cost

Route 4, 2026-08-19 fixture, 3 timepoints and 6 in-window trips per direction. Compressed
figures are `gzip -9 -n` over the serialized bytes.

| | raw | gzipped |
|---|---|---|
| `schedule` block alone, compact, as `runtime/` writes it | 750 B | 279 B |
| whole route file as committed (pretty-printed), **without** `schedule` | 20,302 B | 2,928 B |
| whole route file as committed (pretty-printed), **with** `schedule` | 21,979 B | 3,204 B |
| **delta** | **+1,677 B** | **+276 B** |

The two restrictions are what keep that number small, and both were measured rather than assumed
(same encoding, route 4, same service date, raw bytes):

| Scope | raw |
|---|---|
| timepoints only, windowed — **what this contract ships** | 750 B |
| timepoints only, all 124 trips of the service day | 5,103 B |
| every stop, all 124 trips of the service day | 15,025 B |
| every stop, all 834 trips in the GTFS extract | 102,305 B |

Estimated for the widest watched route — route 7, 8 timepoints per direction, ~12 in-window trips
per direction — the compact block is about **1.9 KB raw**. That estimate is raw bytes only; a
gzip figure from a synthesized block would flatter itself, because synthetic rows repeat more
than real ones do.

The route file is regenerated every 60s and served `no-cache` (§11), so this cost is paid per
poll. Under 300 gzipped bytes on route 4 and an estimated sub-kilobyte on route 7 is the reason
the window and the timepoints-only restriction are in the contract rather than left to the
implementation.


---

## 4. `block.confidence`

Block continuation is verified on route 4 only (10 blocks, 175 direction flips, 249/249 live trip
ids resolvable). Other routes may interline across routes, lay over away from passenger stops, or
carry missing or dirty `block_id`. Rather than assert the feature works everywhere, the build job
grades it:

- `high` — all of: the successor trip is on the same `route_id`; its first `stop_id` **equals**
  the predecessor's last `stop_id`, or lies within **150 metres** of it (covering paired
  directional stops across a street); and the layover is **60 to 1800 seconds** inclusive.
- `low` — anything else: missing or empty `block_id`, layover outside that range, a successor
  whose first stop is farther than 150 m from the predecessor's last stop, or a block whose trips
  span more than one `route_id`.

A trip that is the **last** of its block has `next_trip: null` and `confidence: "high"`, because
"there is no continuation" is a confident statement, not an uncertain one.

The client renders `low` confidence continuations with hedged language ("likely becomes the
10:21 EB") or not at all. It never presents a `low` continuation as fact.

---

## 5. Alert object

Upstream `9zu9-jwr2` is **not GTFS-Realtime**. It is a bespoke Socrata array: camelCase keys,
`informedEntities` (plural), `activePeriods`, no `header`/`entity` envelope. It needs its own
parser.

```jsonc
{
  "id": "ef0ee2ee-9210-4af1-8170-7f123ec47110",
  "effect": "NO_SERVICE",               // NO_SERVICE|DETOUR|REDUCED_SERVICE|MODIFIED_SERVICE|OTHER
  "cause": "CONSTRUCTION",
  "header": "Stop Closure on Routes 4 and 663",
  "description": "On Routes 4 and 663, stop 416 6th/San Antonio (ID 1967) will be closed.",
  "url": "https://www.capmetro.org/alerts",
  "active_from": 1780000000,
  "active_until": null,                 // null means open-ended; 59 of 104 alerts today are null
  "stop_ids": ["1967"],                 // a SET: deduplicated, may be empty (29 of 175 are route-only)
  "severity": "high"                    // high for NO_SERVICE, medium for DETOUR/REDUCED, low else
}
```

Only alerts whose active period covers `generated_at` are included. An `active_until` of `null`
means open-ended and is treated as currently active.

**`stop_ids` is a set: no duplicates, ever.** The upstream `informedEntities` array repeats a stop
once per informed route, so a stop closure naming routes 4 and 663 arrives as
`["940", "940"]`. The build job deduplicates, preserving first-seen order. This is a correctness
requirement, not tidiness: anything that groups or counts by stop double-counts otherwise, and
the client is forbidden from deduplicating because the client makes no inference. An empty array
is still valid and means the alert is route-level with no stop named.

---

## 6. Privacy: fields that MUST NOT appear

The upstream alerts feed embeds CapMetro staff PII on every alert object: `userEmail` and
`userFullname` of the employee who filed it. These are **stripped at ingest** and never appear in
any generated file, cache, or log. The alert parser uses an explicit allowlist of fields, not a
denylist, so a new upstream field cannot leak by default.

No endpoint carries user data of any kind. Saved watches are client-local only; see §9.

---

## 7. Stop name shortening

Upstream names are long and parenthetical (`"Dove Springs NB (Pleasant Valley/Stassney)"`), and
clip mid-word on a 412px ladder. The build job emits both `stop_name` (shortened) and
`stop_name_full`. Shortening is deterministic, applied in order:

1. Drop a trailing parenthetical group.
2. Drop a leading street number (`"4999 7th/Shady"` becomes `"7th/Shady"`).
3. Standardize suffixes: `Northbound` to `NB`, `Southbound` to `SB`, `Eastbound` to `EB`,
   `Westbound` to `WB`.
4. **Normalize intercapped ordinals.** Upstream title-cases every word, so `8Th/Lavaca`,
   `48Th Half` and `21St` arrive capitalized mid-token. Lowercase an ordinal suffix that
   immediately follows a digit. Exactly:

   > Replace every match of the regular expression `(?<=[0-9])(St|Nd|Rd|Th)\b` with the
   > lowercase form of the matched text.

   Case-sensitive; no other flags. The lookbehind requires a digit with **no** intervening
   space, so `Main St` and `Nd` standing alone are untouched and only `8Th` to `8th`,
   `2Nd` to `2nd`, `3Rd` to `3rd`, `1St` to `1st` and their multi-digit forms change. The rule
   never changes a string's length, so it is safe to apply before truncation and it cannot
   affect rule 5. Any regex flavor works: PHP `preg_replace`, JavaScript `String.replace` with
   `/(?<=[0-9])(St|Nd|Rd|Th)\b/g`, Python `re.sub`.
5. If still over 24 characters, truncate at the last word boundary under 24 and append `…`.
   **Never truncate mid-word.**

---

## 8. `GET /api/all.json`

Every vehicle in the system, including deadheads. Same `Vehicle` shape as §2, same envelope
fields (`schema`, `generated_at`, `feeds`, `staleness`), with `route` and `timepoints` omitted and
a `counts` block added:

```jsonc
{ "counts": { "total": 392, "in_service": 249, "deadhead": 143, "routes_active": 46 } }
```

---

## 9. `GET /api/watch/{watch_id}.json`

A saved watch is **client-local**. The client owns the tuple; the server resolves it.

**`watch_id` is** the lowercase hex of the first 16 bytes of `SHA-256` over the UTF-8 string
formed by joining the tuple with a single `|`, in exactly this order and with no whitespace:

```
route_id | direction_id | stop_id | scheduled_time | day_type
"800|1|6293|07:52:09|weekday"  ->  sha256 -> first 16 bytes -> hex (32 chars)
```

`direction_id` serializes as `0` or `1`. `scheduled_time` keeps its `HH:MM:SS` form including a
leading zero. This is a stable identifier, not a secret: it exists so a URL or server log never
carries a legible description of a child's daily routine.

```jsonc
{
  "schema": 1, "generated_at": 1787152239,
  "watch": { "route_id": "800", "direction_id": 1, "stop_id": "6293",
             "stop_name": "Simond SB", "scheduled_time": "07:52:09", "day_type": "weekday" },
  "resolution": {
    "resolved": true,
    "trip_id": "3010894_22201",         // resolved for TODAY, never stored client-side
    "service_id": "9-172",
    "service_date": "20260819",
    "scheduled_at": 1787146329,
    "ambiguous_candidates": []          // >1 entry when several trips share the scheduled time
  },
  "status": "not_yet_running",          // not_yet_running|running|passed|canceled|unresolvable
  "vehicle": null                       // a Vehicle object once the trip is in service
}
```

**Resolution rule.** The watch stores a semantic tuple, never a trip id. Trip ids are not stable:
service `1-172` covers 95 weekdays over 42 routes while `9-172` covers 99 weekdays over 32 routes,
so there is no single "weekday" service. Resolution is **per route**, against
`calendar_dates.txt` for the current service date. On the 8 of 145 dates carrying a one-off
service, resolution still succeeds because it matches on service date, not day-of-week.

`status: unresolvable` when no trip matches today (holiday, service change, route discontinued).
The client shows why, never a blank.

---

## 10. `GET /api/health.json`

Small, cheap, and checkable without opening the app.

```jsonc
{
  "schema": 1,
  "generated_at": 1787152239,
  "ok": true,
  "cron_last_success_at": 1787152239,
  "feeds": { "positions_at": 1787152239, "trip_updates_at": 1787152196, "alerts_at": 1787152100 },
  "gtfs": { "feed_version": "260818_1456", "built_at": 1787100000, "valid_until": "20270109" },
  "counts": { "vehicles": 392, "routes_written": 71 },
  "errors": []                          // strings; non-empty forces ok:false
}
```

`ok` is false when any feed is older than 600s, the GTFS feed version is past `valid_until`, or
the last cron run raised an error. This is the endpoint an uptime check hits.

---

## 11. File semantics

- Written **atomically**: temp file in the same directory, `fsync`, then `rename`. A client
  fetching mid-write gets the previous complete file, never a torn one.
- A `flock` prevents overlapping cron runs from interleaving writes.
- On upstream failure the **previous file is left in place** and its `staleness` ages naturally.
  A failed run never writes a partial or empty file.
- Served with `Cache-Control: no-cache` for `/api/*` (regenerated every 60s) and a long max-age
  for `/data/*` schedule shards (regenerated only when `feed_version` changes).

---

## 12. Acceptance criteria

1. All four endpoints validate against their JSON Schema in `schemas/` for the 2026-08-19 fixture.
2. Generating from the fixture produces `adherence.state` values covering all six states, with at
   least one `deadhead`, one `unknown` with `reason: "no_trip_update"`, and one `unknown` with
   `reason: "trip_canceled"`.
3. A route 4 vehicle on the 08:15 or 16:15 trip has `pattern.is_special: true` and names
   Veterans/Atlanta in `adds` and 504 Campbell/5th in `skips`.
4. At least one route 4 vehicle has `block.next_trip.is_direction_flip: true`.
5. Stop `1222` on route 800 has `service_status.source == "realtime_skipped"` and `served: false`.
6. Stop `1967` on route 4 has `service_status.source == "alert_no_service"` and `served: false`.
7. No generated file contains the strings `userEmail` or `userFullname`, or any value from those
   upstream fields.
8. With feed ages forced past 600s, every route file reports `staleness.suppress_adherence: true`
   and every vehicle reports `adherence.state: "unknown"` with `reason: "stale_data"`.
9. Resolving the watch tuple `("800", 1, "6293", "07:52:09", "weekday")` returns trip
   `3010894_22201` for service date 20260819 and also resolves for 20260820, which runs a
   different one-off service.
10. No `stop_name` in any generated file ends mid-word or exceeds 25 characters, and no
    `stop_name` anywhere matches `[0-9](St|Nd|Rd|Th)\b` — the §7 rule 4 ordinal artefact
    (`8Th/Lavaca`) is gone from timepoints, minor stops, `adherence.against`, `pattern.adds`,
    `pattern.skips`, `block.next_trip` and `route.next_departure` alike.
11. `route.next_departure` is present on every route file, `null` only when no trip remains
    today. For route 4 on the 2026-08-19 fixture (`generated_at` 1787152239) it reports
    `scheduled_at: 1787152860` at stop `1368`, `direction_id: 0` — the 10:21 Mopac WB, ten
    minutes after the 10:10:39 CDT `generated_at`. Forcing the clock past the last trip of the
    service day makes it `null`, with the key still present.
12. `timepoints[]` carries at least one entry for **each** direction the route runs. On route 4
    that is 3 timepoints for direction 0 and 3 for direction 1, in one flat array.
13. `schedule` is present on every route file and internally consistent with the rest of it:
    `directions[].timepoint_stop_ids` equals the `stop_id` sequence of the `timepoints[]`
    entries for that `direction_id` in order; every in-service vehicle whose trip overlaps the
    window appears as a trip row whose `start_epoch` equals that vehicle's
    `trip.start_epoch`; every offset is `null` or an integer ≥ 0; every trip row has exactly
    three elements and an `offsets` array as long as `timepoint_stop_ids`. On the 2026-08-19
    fixture that is 6 trip rows per direction and all 5 in-service route 4 vehicles matched.
14. No `alerts[].stop_ids` array in any generated file contains a duplicate.

## 13. Out of scope

- Transfer chains across routes. Deferred in the design doc; the contract does not model them.
- Push notifications, accounts, and history. No user data server-side at all.
- Protobuf feed support. JSON with gzip only.
- A write API. Every endpoint is a static file; nothing accepts a request body.

## 14. Rollback

Every endpoint is a static file generated by a cron job. Rollback is `git revert` on the shard
build plus deleting the generated `/api/*.json`, after which the client falls back to its
degraded positions-only mode. Bumping `schema` is the only breaking change vector; the client
already refuses a `schema` higher than it knows, so an old client degrades rather than
misrendering.

The 2026-08-19 amendment adds fields without bumping `schema`, which is safe in that direction:
a client built against the earlier document ignores keys it does not know, and every new field is
either always present or explicitly nullable. It is **not** safe in the other direction — a route
file written before the amendment no longer validates, because `next_departure` and `schedule`
are required. Regenerating is the fix; there is no migration, because every file is rewritten
every 60 seconds anyway.
