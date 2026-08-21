# Route-State API Contract

Status: DRAFT
Version: schema 1
Written: 2026-08-19
Amended: 2026-08-19 — added `route.next_departure` (§1) and the windowed timepoint schedule
`schedule` (§3.2); made `alerts[].stop_ids` an explicit set (§5); added ordinal normalization as
§7 rule 4; acceptance criteria 11 to 14. Purely additive: no existing field changed shape, so
`schema` stays **1**.
Amended: 2026-08-19 — added two endpoint kinds, the route catalog `/api/routes.json` (§15) and
the service-day departure board `/api/departures/{route_id}.json` (§16), the latter carrying
`service_day_start_epoch` and `day_type`; acceptance criteria 15 to 19. Both are new files. No
existing field changed shape, so `schema` stays **1**.
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
| `/api/routes.json` | `schemas/routes.schema.json` |
| `/api/departures/{id}.json` | `schemas/departures.schema.json` |

The committed fixtures in `tests/fixtures/feeds-20260819/` are the inputs; schema validation of
generated output is a test, not a convention. There are **six endpoint kinds**; the route
endpoint and the departure board are each one kind with one file per route.

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

  "predictions": [                      // absent when in_service is false; see below
    [43, "6243", 1787152563],           // [stop_sequence, stop_id, predicted_at]
    [44, "1977", 1787152701]
  ],

  "adherence": {
    "state": "late",                    // early | ontime | late | very_late | unknown | deadhead
    "seconds": 183,                     // null when state is unknown or deadhead
    "glyph": "up-triangle",             // left-triangle|circle|up-triangle|square|question|ring
    "against": {                        // null when state is unknown or deadhead
      "stop_id": "6243",
      "stop_name": "Campbell/5th",
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
    "skips": [ { "stop_id": "6243", "stop_name": "Campbell/5th" } ]
  },

  "block": {                            // absent when in_service is false
    "block_id": "1010",
    "confidence": "low",                // high | low  (see §4)
    "spans_routes": true,               // this block's trips are not all on one route
    "route_ids": ["1", "4", "485"],     // every route the block covers, sorted
    "is_last_trip": false,              // true when the build says this trip ENDS the block (§4)
    "next_trip": {                      // null when this is the last trip of the block
      "trip_id": "3014770_15088",
      "route_id": "4",                  // the SUCCESSOR's route, which need not be this bus's
      "route_short_name": "4",          // null only when route_id is null
      "direction_id": 1,
      "start_time": "10:21:00",
      "start_epoch": 1787155260,
      "start_stop_id": "6243",
      "start_stop_name": "Campbell/5th",
      "is_direction_flip": true         // the whole point: this bus becomes the other direction
    }
  }
}
```

`spans_routes`, `route_ids`, `is_last_trip`, `next_trip.route_id` and `next_trip.route_short_name`
are **additive**. The runtime always writes them; the schema deliberately leaves them out of
`required` so a capture taken before they existed still validates, and `schema` stays `1`. A client
that does not read them behaves exactly as it did.

### `predictions` — when this bus reaches each stop still ahead of it

`adherence.against` answers "is she late" and is anchored at whichever stop the bus is
approaching. It cannot answer "when does this bus reach MY stop", because the reader's stop
is almost never the anchor. `predictions` publishes the rest of the trip update's own
arrival times so a client can answer that without inventing anything: nothing may add a
deviation to a scheduled time, interpolate between stops, or divide a distance by a speed.

Rows are `[stop_sequence, stop_id, predicted_at]`, ascending by `stop_sequence`. Compact
triples rather than objects because this is bulk repeated data in a document re-fetched
every 60 seconds; objects cost about three times the bytes.

Rows start from the §2 anchor rule — one shared implementation, so the two cannot drift on
what "the stops ahead of this bus" means:

- `stopSequence` at or after `progress.current_stop_sequence` — at, not after: a bus
  `STOPPED_AT` your stop is still an arrival you can board;
- no entry whose `scheduleRelationship` is `SKIPPED`;
- no entry with neither an arrival nor a departure time; arrival wins when both are present.

Publishing then applies three further bounds that the anchor does not:

- no entry without a `stopId`, which nothing could join to a stop;
- nothing beyond the §3.2 forward window (`generated_at + after_s`, 45 minutes). Predictions
  decay with horizon and the board already declares that window as how far ahead it looks;
- nothing more than 90 seconds in the PAST. The sequence filter keeps stops at or ahead of
  the bus, but the positions feed lags the trip updates feed, so a stop the bus has
  physically passed keeps its original time and stays in the list. Sorted soonest-first that
  row lands at the top of a client's panel and a negative countdown reads as "due" — a rider
  told a bus that left twenty minutes ago is arriving now. The 90s grace is the window a
  client already treats as "due", so a bus seconds overdue still shows.

So `adherence.against` is normally the first row of this list joined to its scheduled time,
but **a client must not assume `predictions[0]` is the anchor**: the extra bounds can drop
the anchor row while the adherence number that was measured against it still stands.

**The list is empty, never absent, when the board cannot stand behind a time**: when
`staleness.suppress_adherence` is true, when `current_stop_sequence` is null, when the trip
is `CANCELED` — row 2 of the §2 table already refuses to score one, and a countdown to a bus
that is never coming is the same error told more confidently — or when the trip has no
usable prediction left. Suppression matters more here than it does for lateness:
an arrival time reads as a countdown and a rider acts on it immediately, so a stale one is
the more confidently wrong of the two.

**`/api/all.json` strips the field entirely** (§8). The fleet view asks whether anything
unusual is happening, not when a bus reaches a stop, and it carries every vehicle in the
system — keeping predictions there takes that document from 317 KB to 422 KB to answer a
question the view does not ask.

Measured cost where it IS published, over the 2026-08-19 capture: 4,525 rows across all 71
route files, 104 KB in total. Route 4 goes from 16 KB to 17 KB, route 7 from 42 KB to 49 KB,
and the worst route in the system (300) from 44 KB to 53 KB.

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

### Why the grade is what it is — `spans_routes` and `route_ids`

A `low` grade used to arrive unexplained: a bus could be on time, in service, and graded `low`
with nothing in the payload saying that its block interlines. `route_ids` is the block's whole
route set and `spans_routes` is whether that set is larger than one, both copied from `blocks.json`
rather than recounted from the trip list — the build already decided this, and one definition of a
fact is the rule (see ISSUE-002).

On the 2026-08-19 capture, 35 of 249 in-service vehicles are on a block that spans routes, and 26
of the 85 `low` grades cite `block_spans_multiple_routes`. Block 1010 is the worked example: 92
trips across routes 1, 4 and 485.

`spans_routes: true` does **not** imply `confidence: "low"`. The build grades each handoff, not
each block, so a same-route handoff inside a multi-route block can still be `high` — 6 of the 35
are. Read the two fields as what they are: `confidence` grades this continuation, `spans_routes`
describes the block it sits in.

A vehicle whose trip is not in the schedule at all reports `route_ids: []` and
`spans_routes: false` alongside the `block_id: null` it already reported. That pairing says "no
block", which is a different claim from "a block covering no routes".

### `next_trip.route_id` — what the bus becomes

The route of the **successor**, taken from the successor. It is equal to the vehicle's own
`route_id` on most blocks, and that is exactly the trap: filling it from the current route would
look correct on all 214 single-route blocks in the capture and be wrong on precisely the 7
continuations the field exists for. Bus 2754 finishes a 50 and starts a 152; bus 2256 finishes a
315 and starts a 333.

`next_trip.route_id` is always a member of the enclosing `block.route_ids`. That invariant is
swept over every generated route file rather than spot-checked, because a successor naming a route
its own block does not cover is a join bug and would be invisible wherever the two coincide.

Both fields are `null` only if the build named a successor without naming its route. No trip in
the current feed does that, and the runtime says `null` rather than guessing if one ever does.

### `is_last_trip` — pulling in, versus not knowing

`true` when the build graded the trip `last_trip_of_block`, which is it stating that this bus ends
its block here.

It is deliberately **not** `next_trip === null`. Those are two different facts: "the bus is pulling
into the garage" is an assertion, and "we could not resolve a successor" is an absence, and a
client should not have to guess which one an empty `next_trip` means. In the current feed they
coincide — all 2,115 null successors across the 71 shards carry `last_trip_of_block` and nothing
else — so reading the assertion costs nothing today and keeps the two distinguishable if a future
build starts emitting unresolvable continuations.

A trip missing from the schedule reports `is_last_trip: false`: it is not evidence that the bus is
done, only that we know nothing. This matters after a GTFS republish, when every live trip id
stops resolving at once; the failure mode to avoid is rendering the whole fleet as pulling in.

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

The same rule governs the rider's own position. The client's nearest-stop feature reads the
browser's Geolocation API, and the fix is used in the page and discarded: there is no
endpoint that accepts a position, none is logged, and unlike the saved route and direction it
is deliberately never written to `localStorage` — a saved route is a preference, a saved
position is a record of where somebody was. Any future endpoint taking a coordinate would be
a change to this section first.

---

## 7. Stop name shortening

Upstream names are long and parenthetical (`"Dove Springs NB (Pleasant Valley/Stassney)"`), and
clip mid-word on a 412px ladder. The build job emits both `stop_name` (shortened) and
`stop_name_full`. Shortening is deterministic, applied in order:

1. Drop a trailing parenthetical group.
2. Drop a leading street number (`"4999 7th/Shady"` becomes `"7th/Shady"`).

   > Every example in this document shows the SHORTENED value in `stop_name`, because that
   > is the field this section defines. The upstream string, street number and all, is
   > always available beside it in `stop_name_full`. Three examples in §2 and §3 used to
   > print `504 Campbell/5th` in `stop_name`, contradicting this rule; the build and the
   > runtime both emit `Campbell/5th`, and it was the examples that were wrong. A client
   > author coding against them would have matched on a value the API never sends.
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
5. If the name is still over **25** characters — the schema cap, not the stem budget —
   truncate at the last boundary under 24 and append `…`. **Never truncate mid-word.**

   A **boundary is a space OR a slash.** Austin stop names are `Street/CrossStreet` with no
   space around the slash, so a space-only rule discards a whole cross street:
   `Pleasant Valley/Turnstone` has its only space at index 8 and collapses to `Pleasant…`,
   throwing away sixteen usable characters. Breaking on a slash as well yields
   `Pleasant Valley/…`, which reads as a deliberate stop short of the cross street.

   The two boundary kinds keep different budgets, because they keep different text. Cutting
   AT a space DROPS it, so a space at index *i* keeps *i* characters and *i* may reach 24.
   A slash is KEPT, so a slash at index *i* keeps *i + 1* characters and *i* must stop one
   earlier. Search the first 25 characters for a space and the first 24 for a slash; take
   whichever boundary is later. A single token longer than the budget has no boundary to
   fall back to, so cut one character short of it and mark the cut.

   Two shapes are legal and no others. The stem is always a literal prefix of the
   post-rule-4 name, and either it ends with a slash, or the name continues with a space.
   Anything else is a word cut in half.

   > **Cap 25, stem budget 24.** Testing the stem budget to decide whether to truncate at
   > all truncated thirteen real stops that already fitted exactly, turning
   > `Bluff Springs/BitterCreek` into `Bluff…`. That was ISSUE-001. The two numbers are not
   > interchangeable and the check that chooses between them uses the cap.

---

## 8. `GET /api/all.json`

Every vehicle in the system, including deadheads. Same `Vehicle` shape as §2 **except that
`predictions` is stripped** (see §2), same envelope fields (`schema`, `generated_at`, `feeds`,
`staleness`), with `route` and `timepoints` omitted and a `counts` block added:

```jsonc
{ "counts": { "total": 392, "in_service": 249, "deadhead": 143, "routes_active": 46 } }
```

"Same `Vehicle` shape" is literal and is enforced rather than restated: `all.json` republishes the
objects the route files were built from, and both documents validate the one `vehicle` definition
in `schemas/common.schema.json`. So `block.spans_routes`, `block.route_ids`, `block.is_last_trip`
and `block.next_trip.route_id` are here too, and the map cannot end up describing a bus
differently from the route board.

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
- One near-exception, added with §16: `/api/departures/*` is almost entirely static — it changes
  when `service_date` or `feed_version` changes, both of which are in the payload — so it may be
  served with a max-age up to the end of the service day. Serving it `no-cache` is safe but
  wasteful: 2.8 MB re-fetched for a document that overwhelmingly did not change.

  **It is not wholly free of realtime fields, and a client must not treat it as such.** Each
  trip carries `canceled`, added in 0.4.0.0, which is derived from the live TripUpdates feed and
  can therefore change at any point during a service day. A cached copy freezes it at fetch time.

  A client must read cancellation from **both** carriers and take the union:

  - `departures.trips[].canceled` — the state when the document was fetched. Still needed: it
    covers a trip canceled before the page loaded that has since aged out of the live window.
  - `route.schedule.canceled_trips` — rebuilt from live TripUpdates on every generator run, and
    scoped to the schedule window (−15/+45 minutes). This is the only carrier that can deliver a
    cancellation announced after the departures document was cached.

  Neither alone is sufficient. Reading only the cached field is the bug this note exists to
  prevent: a trip canceled at 10:05 for a 10:13 departure never reaches a tab opened at 07:00,
  which is precisely the case the cancellation work was written for.

  The union only ever adds cancellations, and a client cannot currently take one back. A trip
  reinstated after being canceled keeps showing as canceled for as long as the cached departures
  document lives — which today means until the page is reloaded, because `loadDepartures()`
  returns early on any document it already holds and nothing evicts one. "Until it refetches" is
  not an escape hatch a reader can rely on; say the reload out loud rather than implying a refresh
  that does not happen.

  The asymmetry itself is deliberate. The failure it leaves is "you did not board a bus that was
  running", against "you waited for a bus that was never coming", and only the second one leaves
  somebody at a stop. A client that adds eviction — refetching a document whose `service_date` has
  passed, or aging one out — narrows the window and should, but it does not change which direction
  the union is allowed to err in.

  `/api/routes.json` stays `no-cache`: its vehicle counts move every run.

---

## 12. Acceptance criteria

1. All four endpoints validate against their JSON Schema in `schemas/` for the 2026-08-19 fixture.
2. Generating from the fixture produces `adherence.state` values covering all six states, with at
   least one `deadhead`, one `unknown` with `reason: "no_trip_update"`, and one `unknown` with
   `reason: "trip_canceled"`.
3. A route 4 vehicle on the 08:15 or 16:15 trip has `pattern.is_special: true` and names
   Veterans/Atlanta in `adds` and Campbell/5th in `skips`.
4. At least one route 4 vehicle has `block.next_trip.is_direction_flip: true`.
4a. Bus 2867 on route 4 reports `block.route_ids: ["1", "4", "485"]` and
    `block.spans_routes: true`, and at least one vehicle system-wide has a
    `block.next_trip.route_id` that differs from its own `route_id` (7 do in the fixture).
    Across every generated route file, `block.next_trip.route_id` is always a member of
    that vehicle's `block.route_ids`.
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
15. `/api/routes.json` carries one row for each of the 71 generated route files, ordered
    `1, 2, 3, 4, 5, 7, 10, 18, 20, 30, 50, 103, …` — the 10 after the 7, not between the 1 and
    the 103. Routes `454`, `491`, `492` and `493` appear with `has_service_today: false` rather
    than being omitted, and summing `vehicles.in_service` over every row gives **249**, which is
    `/api/all.json`'s `counts.in_service` for the same run.
16. `/api/departures/800.json` carries **196** trips of the 903 in the extract and **42** stop
    rows over **40** distinct stops, `6558` and `5926` each appearing once per direction. Stop
    `6293` has **98** departures, among them `[28329, 27]` — 07:52:09 on trip `3010894_22201`,
    `direction_id: 1`, which is the trip criterion 9 resolves from the same tuple. That stop's
    row reports `is_timepoint: false`, which is why §3.2 cannot answer this watch.
17. No `arrival_seconds` in any departure board is wrapped at 86400. Route 800's largest on
    2026-08-19 is `89760`, which is 24:56:00 and must survive as `89760`.
18. `trips[].is_special` in a departure board agrees with `vehicle.pattern.is_special` in the
    matching route file for every vehicle whose trip appears in both. On 2026-08-19 there are 86
    special trips across 10 routes, 8 of them on route 4, and none of them currently has a bus —
    the Austin High runs are the 08:15 and 16:15, and `generated_at` is 10:10:39.
19. `/api/departures/800.json` reports `service_day_start_epoch: 1787115600` and
    `day_type: "weekday"` for 20260819, and the two endpoints agree about when every trip is due:
    for every row of `/api/route/800.json`'s `schedule.directions[].trips[]` whose trip also
    appears in the board, `service_day_start_epoch + first arrival_seconds` equals that row's
    `start_epoch`, and `service_day_start_epoch + arrival_seconds` at each timepoint equals
    `start_epoch + offsets[i]` for the same column.

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
file written before the amendment no longer validates, because `next_departure`, `schedule` and
`predictions` are required — the first two at the top level, `predictions` on every in-service
vehicle of a route document (§2). Regenerating is the fix; there is no migration, because every file is rewritten
every 60 seconds anyway.

---

## 15. `GET /api/routes.json`

The route catalog. One row per route that has a generated `/api/route/{id}.json`, and nothing
else.

It exists because the client cannot know what routes there are. The build generates **71** route
files; the picker shipped against a hard-coded list of six, which is wrong the day CapMetro adds
a route and wrong silently — a rider who searches for the 335 gets an empty screen and no reason
why. Fetching 71 route files to find out is not an alternative: this file is fetched on first
paint, before the user has chosen anything.

```jsonc
{
  "schema": 1,
  "generated_at": 1787152239,
  "service_day": {                       // the SYSTEM service day, as in §8
    "date": "20260819",
    "service_ids": ["17-172", "20-172", "29-172", "3-172", "9-172"],
    "is_exception_day": true
  },
  "routes": [
    {
      "id": "800",
      "short_name": "800",
      "long_name": "800 PLEASANT VALLEY",   // verbatim; see below
      "directions": [
        { "id": 0, "headsign": "800 Mueller NB" },
        { "id": 1, "headsign": "800 Goodnight SB" }
      ],
      "vehicles": { "in_service": 14, "out_of_service": 0 },
      "has_service_today": true
    }
  ]
}
```

**Order is how a human reads route numbers.** A `short_name` that is entirely digits sorts by
numeric value; everything else sorts alphabetically after all of them. Ties fall through to the
lowercased `short_name` and then to `id`, so two runs over one feed emit byte-identical files.
Lexicographic order is not merely untidy here, it is unusable: it reads `10 < 103 < 18 < 2`, which
puts the 10 nine rows above the 4. On this feed the first rows are `1, 2, 3, 4, 5, 7, 10, 18, 20,
30, 50, 103, …`. No route in feed `260818_1456` has a letter in its `short_name`; the second
bucket exists because §0 makes route ids strings precisely because that is not guaranteed, and a
lettered route sorting into the middle of the numbers would be worse than one sorting to the end.

**`long_name` is published verbatim**, leading `"{id}-"` and all, exactly as
`/api/route/{id}.json` publishes it. The client may strip the prefix; the server does not. One
string with two spellings across two documents is worse than a prefix the client removes in one
place, and consistency between the two files is what lets a client cache either one.

**`vehicles` is the same live join as §8**, counted off each route's own `Vehicle` objects using
their `in_service` flag rather than recounted from the feed, so the number on the picker row and
the number of rows on that route's board cannot disagree. Measured on the 2026-08-19 fixture:
summing `in_service` over all 71 rows gives **249**, which is exactly `all.json`'s
`counts.in_service`. `out_of_service` is **0 on every route**, and that is a fact about the feed,
not a bug: all 143 out-of-service vehicles report no `routeId` at all, so none can be attributed
to a route. The field is still published, because §0 forbids the client inferring a number from
an absent key, and because a feed that did start attributing deadheads to a route should change
one of this document's numbers rather than its shape.

**`has_service_today` is `false` when no trip on that route is active for the current service
date**, and the row is published either way. Four routes — `454`, `491`, `492`, `493` — qualify on
2026-08-19. Hiding them would hand the client an inference to make; a picker that can say "the 492
does not run today" is strictly better than one where the 492 is missing. The boolean is read off
the trip list of that route's §16 departure board rather than off the calendar, so a route whose
calendar names a service that has no trips today is not advertised and then opened onto an empty
board.

`service_day` is the **system** service day, the same block `/api/all.json` carries. A per-route
calendar cannot go in one envelope field — it would have to be 71 different answers at once — and
each row's own answer is `has_service_today`.

Measured size, 2026-08-19 fixture, compact as `runtime/` writes it: **17,179 B raw, 2,781 B
gzipped** for all 71 routes. That is the whole justification for the field list: it carries the
picker's row and the two numbers a row can show, and nothing a user only wants after choosing a
route.

---

## 16. `GET /api/departures/{route_id}.json`

One service day of scheduled departures for one route: **every stop, every active trip, no
window**. One file per route, same as §1.

This is what a saved watch is built from. The worked example throughout this project is *"the
7:50a 800 SB from Simond/Berkman"*, and the client has to let a user pick that departure from a
list before there is anything to watch. Nothing already published can answer it:

- `route.schedule` (§3.2) is windowed to `generated_at - 900 .. + 2700` and carries **timepoints
  only**. At 6am it does not contain the 7:50 at all, and stop `6293` Simond SB is a **minor**
  stop that never appears in it at any hour of any day.
- `route.timepoints` (§3) is a row set for the ladder, not a list of times.
- `route.next_departure` (§1) is exactly one trip.

So this document drops the two restrictions that keep §3.2 small, and pays for them in bytes. It
is a separate file rather than a bigger route file for exactly that reason: the route file is
regenerated and re-fetched every 60 seconds, and this one only changes when the service date or
the GTFS `feed_version` does.

```jsonc
{
  "schema": 1,
  "generated_at": 1787152239,
  "route_id": "800",
  "service_date": "20260819",             // what every arrival_s below counts from
  "service_day_start_epoch": 1787115600,  // that date's midnight, resolved server-side
  "day_type": "weekday",                  // weekday | saturday | sunday, as in the §9 tuple
  "feed_version": "260818_1456",          // so a cached copy can be told from a current one
  "stops": [
    { "stop_id": "6293", "stop_name": "Simond SB",
      "stop_name_full": "Simond SB (Berkman/Simond)",
      "direction_id": 1, "stop_sequence": 2,
      "lat": 30.296149, "lon": -97.700385, "is_timepoint": false }
  ],
  "trips": [
    { "id": "3010894_22201", "direction_id": 1, "headsign": "800 Goodnight SB",
      "start_time": "07:50:00", "block_id": "800005", "is_special": false }
  ],
  "departures": {
    "6293": [ [18122, 1], [19022, 3], /* … */ [28329, 27] ]   // 28329 = 07:52:09, trips[27]
  }
}
```

### `service_day_start_epoch` and `day_type`

Both are answers the client would otherwise have to compute in a browser, and both are timezone
traps the server has already solved exactly once.

**`service_day_start_epoch`** is epoch seconds of service-day midnight for `service_date`. It is
the anchor every `arrival_seconds` below is measured from:

> for any trip, `service_day_start_epoch + arrival_seconds` **is** the absolute epoch at which
> that stop is scheduled, and for the trip's **first** stop it equals the `start_epoch` that the
> same trip's row carries in `route.schedule` (§3.2) and that `Vehicle.trip.start_epoch` (§2)
> carries for the bus running it.

That is one number with three publishers, and they are required to agree. Acceptance criterion 19
checks it at the trip start **and at every timepoint column** of every windowed trip, because
agreeing on the start alone is not enough: the client plots a live vehicle against the ladder from
an arrival part-way through a trip.

Computed server-side by the §2 rule — noon on the service date in `America/Chicago`, minus twelve
hours — because that form is the only one that survives both DST transitions. Re-deriving it in
ES5 in a browser is the same trap, reimplemented, and getting it wrong is an hour's error on two
days a year on a document whose only job is telling a parent when to be at a stop.

**`day_type`** is `weekday`, `saturday` or `sunday` for `service_date`, spelled exactly as the §9
watch tuple spells it (`800|1|6293|07:52:09|weekday`), so the client can decide whether a saved
watch applies today without parsing `YYYYMMDD` in a second timezone. There is one definition of
the word in the codebase and this is the same call the tuple is checked against. The fourth value
§9 allows, `exception`, is a property of a saved watch and not of the calendar, so it never
appears here.

Both are `null` **only** when `service_date` is not a valid `YYYYMMDD`. The cron job cannot
produce that — it passes `cm_service_date_for()`'s output — but a plausible-looking `0` or
`"weekday"` would make every absolute time in the document silently wrong, and §0 is explicit that
`0` must never stand for unknown. A client that sees `null` must not compute absolute times from
this file.

### `departures`

**`departures[stop_id]` is an array of `[arrival_seconds, trip_index]`**, ascending by
`arrival_seconds`, ties broken by `trip_index`. Two elements exactly, in that order.

- **`arrival_seconds` is seconds since the START of the service day**, on the GTFS clock. It is
  never an epoch and **never wrapped at 86400**: a 25:10:00 arrival is `90600` and stays `90600`.
  Route 800's largest on this date is `89760`, which is 24:56:00. Wrapping would sort the last
  bus of the night to the top of the morning list and hand a rider the 1:10am when they asked for
  the first one of the day. Resolve it to epoch by the §2 service-day rule; `service_date` is in
  the payload so the client can.
- **`trip_index` indexes `trips[]`.** It is the only join between a departure and the headsign,
  direction and block that describe it. Offsets and an index rather than repeated objects for the
  same reason §3.2 gives: the key names would otherwise repeat once per departure, and there are
  4,116 of them on route 800.
- **The key is the `stop_id` alone**, not a `(stop, direction)` pair. A rider standing at a stop
  wants that stop's departures; the direction is a property of the trip they pick, and
  `trips[trip_index].direction_id` answers it in one lookup. Keying by the pair would force the
  client to build `"6293|1"` by string concatenation and to read two lists to answer one
  question. The two route 800 stops that serve both directions (`6558`, `5926`) therefore have
  one merged, time-ordered list each, which is also what a rider at a shared bay actually sees.

### `stops`

**One entry per `(stop_id, direction_id)`.** A stop serving both directions is emitted twice,
with the same `stop_id` and different `direction_id` — 42 rows over 40 distinct stops on route
800. One row could only name one direction, so a direction filter built on a single row would
silently drop half of that stop's service, and it is the half the rider going the other way
needs.

- `stop_name` is shortened per §7 and comes from the shard's stop table, which has already been
  through `cm_shorten_stop_name()`. There is no second shortening path.
- `stop_sequence` is **the sequence the greatest number of today's trips agree on**, ties breaking
  toward the lower number. A stop does not have one sequence: a short-turn or special pattern
  starting mid-route gives it a much lower one, so the minimum would let a handful of
  Austin-High-style runs reorder a list built from ninety ordinary ones, and "first seen" would
  make the answer depend on trip id ordering. It is published for ordering and for display beside
  a stop, never as a key.
- `is_timepoint` is true when **any** of today's trips marks the stop as a timepoint. GTFS carries
  the flag per stop time, not per stop, so a short-turn pattern that omits it would otherwise
  demote a stop the printed timetable sets in bold. It is also the field that makes this
  document's premise checkable: `6293` is `false`, which is why §3.2 cannot answer this watch.
- `stops` is sorted by `direction_id`, then `stop_sequence`, then `stop_id`.

### `trips`

**Only trips whose `service_id` is active for `service_date`**, resolved by the §9
`calendar_dates.txt` rule. On route 800 that is **196 of the 903** trips in the extract.
Publishing all 903 would be four and a half times the bytes and every extra row would be a
departure that does not happen today, which on a picker is not merely wasteful but wrong.

Ordered by scheduled start ascending, then `trip_id`. *Scheduled start* is the arrival at the
trip's **first stop** — the same value §3.2 calls `start_epoch` and the same one
`Vehicle.trip.start_epoch` carries — so the ordering, and therefore every `trip_index`, is stable
across two runs on one feed and a diff between two days is readable.

`block_id` and `headsign` may be `null`. **`is_special` is the same flag as §2's
`pattern.is_special`**, computed by the same function: a pattern the build calls special is still
the ordinary run on the days it is itself the baseline, so the answer depends on the trip's own
`service_id`. Two definitions would eventually disagree about the Austin High run and the board
would call a bus special while the picker called it ordinary. On 2026-08-19 there are 86 special
trips across 10 routes, 8 of them on route 4.

### A route with no service today

Written anyway, with `stops: []`, `trips: []` and `departures: {}`. §15 lists those four routes,
so the client will fetch this file for them; an empty but well-formed document is an answer, and a
404 is a guess. `departures` is an object even when empty — a client indexing it by stop id must
never be handed an array.

### Measured size cost

Route 800, 2026-08-19 fixture, compact as `runtime/` writes it. Compressed figures are `gzip -9
-n` over the written bytes.

| | raw | gzipped |
|---|---|---|
| `/api/departures/800.json` — 196 trips, 42 stop rows, 4,116 departures | 81,756 B | 19,467 B |
| of which `departures` | 47,442 B | |
| of which `trips` | 25,873 B | |
| of which `stops` | 8,240 B | |
| widest route on this feed (`10`) | 142,642 B | 39,914 B |
| all 71 routes on disk | 2.8 MB | |

The two restrictions that keep it there are the active-service filter and the decision to carry
one row per departure instead of one object per departure. Dropping the service filter would take
route 800 past 350 KB.

Unlike `/api/route/{id}.json` this file does **not** change every 60 seconds — nothing in it comes
from a realtime feed — so §11's `no-cache` is the wrong policy for it. It changes only when
`service_date` or `feed_version` changes, both of which are in the payload, and a client that has
today's copy for a route does not need to fetch it again today.

