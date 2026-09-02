# TODOS

## Client



### Decide whether the map ever gets streets under it

**What:** The map now plots every stop at its true position and joins them in order, so
the line traces the streets and the panel carries north-up and a scale bar. There is still
no basemap beneath it — no street names, no river, no city.

**Why:** The current panel answers "where is she on this route". It does not answer "what
is she near", which is the question if you are driving to pick her up.

**Context:** Deliberately not solved in v0.3.0.0. A tile source is a network dependency and
the board is required to open from a `file://` URL with no server, so no hosted basemap
fits as things stand. Three ways out, in rising cost: commit a single pre-rendered static
image of the service area and put it under the projection (keeps the offline property,
cheap, ages badly); relax the offline requirement and use a tile provider with attribution
(easy, adds a runtime dependency and possibly a bill); or render street geometry from GTFS
`shapes.txt`, which the build does not currently read at all — check whether CapMetro even
publishes it before costing this.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Name the end of a transfer chain

**What:** A chain records where you board each bus but never where you get off the
last one, so the card cannot say "she gets in at 8:40". Add a destination step to
the final leg and lead the card with the arrival.

**Why:** "Will she make the connection" is answered. "When does she actually get
there" is not, and it is the second question every time.

**Context:** Deliberately left out of transfer chains rather than guessed at. The
alternative considered and rejected was using the final trip's last stop as the
arrival: on the 800 that is another forty minutes past where anyone in this
household gets off, so a finished chain would sit on screen looking live. Until
there is a destination, `resolve()` treats the chain as over once the last bus is
boarded, which is honest but says less than it could. One more step in an editor
that already has six is the cost; the connection picker already knows the onward
trip's downstream stops, so the data is in hand.

**Effort:** S
**Priority:** P3
**Depends on:** Transfer chains

### Normalize all-caps stop and route names (ISSUE-003)

**What:** 13 of 2,348 stops arrive entirely upper case from upstream
(`SAN JACINTO/21ST`, `AIRPORT/KOENIG`, `RIVERSIDE/MONTOPOLIS`) and render that way
beside Title Case neighbours. Visible in the route 103 empty state: "Next departure
5:12p from SAN JACINTO/21ST."

**Why:** Cosmetic inconsistency on a board whose whole value is being easy to read
at a glance.

**Context:** Deferred as Low severity by `/qa` on 2026-08-19. Not as trivial as it
looks: a naive title-case corrupts `ABIA Lower Level`, where ABIA is a real acronym.
Needs an acronym allowlist. Any fix MUST be applied identically in
`build/lib/stop-names.mjs` and `runtime/lib/stopnames.php` or it reintroduces
ISSUE-002, the two implementations disagreeing on the same stop. Add cases to both
regression suites.

**Also two route names, found on 2026-08-19 while building the picker:** route 800 arrives as
`800 PLEASANT VALLEY` and 837 as `837-EXPO CENTER`. They were always there; a picker listing
71 routes instead of 6, plus the route chip in the header, makes them visible. 2 of 71. Same
fix and the same acronym allowlist, applied wherever a route long_name is shortened.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Finish the test coverage on the client panels

**What:** The ship coverage audit on 2026-08-19 put the time-axis branch at about 30% of
its changed lines. The P0 gaps are now closed — 30 tests across `client-format-directions`,
`client-rows-directions`, `client-map-directions` and the ladder file. The P1 and P2 items
from that audit are not.

**Why:** The audit's own summary is the argument: the comments in these files are doing work
the tests should be doing. It found one confirmed regression and two silent-blank branches
purely by reading the code, which means the suite was not going to find them.

**Context:** The full list is in `.gstack/coverage-audit.md`, prioritized, with the exact
assertion each missing test should make. The high-value remainder: the layover-not-lateness
stem branch (fires today, nothing sees it), the clamped off-window stem, distinct clipPath
ids between the two BOTH-mode tracks, `axisTicks` returning an empty array on a very narrow
window, and the label-flip at the right edge of the plot. Also worth doing: a
`desktop-1280` Playwright project, since `.dirgroups`, `.vrows--dir` and `.tracks--both`
are untestable end to end without one.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Decide what a clamped stem should look like

**What:** When a bus is due before the visible schedule window opens, its stem is clamped to
the plot edge. It is visible, which is the point, but shorter than its real lateness — while
the caption asserts the stem is "drawn to the same scale as the clock".

**Why:** For exactly the off-window buses the stem fix was written for, that sentence is
false. The file header says a picture contradicting its own number is the failure this board
exists to avoid, so this is the same class of bug, one step further out.

**Context:** Found by the ship coverage audit on 2026-08-19. Two ways out: hedge the caption
for clamped stems, or mark a clamped stem visually — a dashed cap or an arrowhead saying it
continues past the edge. The second is better and needs a test either way.

**Effort:** S
**Priority:** P2
**Depends on:** None

## Infrastructure

### Re-capture the feed fixtures against a current publication

**What:** `tests/fixtures/feeds-20260819/` is a live capture from 2026-08-19, paired with
`tests/fixtures/shards-260818_1456/`. The pair is internally consistent and the suite is green
against it, but it is now two publications behind: `260826_0956` starts on service date
2026-08-26, so the captured service day does not exist in the current feed at all.

**Why:** Nothing is broken today — the acceptance criteria bind to the frozen pair and cover
all 71 routes. What the age costs is realism: the fixtures cannot exercise anything CapMetro
has changed since, and every new capture drifts further from what the board actually serves.

**Context:** A capture wants a date carrying a one-off service, for the reason
`tests/fixtures/README.md` gives — an ordinary weekday hides trip-id instability, which is
exactly what saved watches have to survive. In `260826_0956` the remaining such dates are
**2026-08-27, 08-28, 08-29 and 08-30, then nothing until 2026-10-31.** Re-capture both halves
together: `ShardFreshnessTest` asserts they agree, so half a re-pin fails loudly.

**Effort:** M
**Priority:** P2
**Tracking:** https://github.com/kraftbj/capmetro-tracker/issues/12

### Nothing tells anyone when the schedule pipeline breaks

**What:** The GTFS job failed on 2026-08-27 and the board sat on a superseded schedule until a
person looked at the site and thought the notice seemed wrong. A failed Action, an `ok:false`
health file and a failed `capmetro-update.service` are each visible only to someone already
looking in the right place.

**Why:** The runtime now tells riders what is wrong. It tells the operator nothing.

**Context:** `health.json` already carries the whole diagnosis; the gap is that nobody reads
it. Alert on persistence, not on a single poll — one failed upstream fetch flips `ok` to false
routinely.

**Effort:** S
**Priority:** P2
**Tracking:** https://github.com/kraftbj/capmetro-tracker/issues/11

### Deploy it somewhere you can actually open on a phone

**What:** The board runs locally and nowhere else. Get the static client onto GitHub
Pages and the PHP runtime onto the Linode.

**Why:** Until it has a URL, the board cannot answer a question at a bus stop, which
is the only place the question gets asked.

**Context:** The hosting shape was settled during planning: GitHub Pages for the
static client, the existing Linode for the PHP runtime that polls the realtime
feeds, no new paid services. `.github/workflows/gtfs.yml` already rebuilds the
schedule shards and commits them only when `feed_version` changes. What is missing
is the deploy half: a Pages workflow, the runtime installed on the Linode with a
cron or timer driving `generate-api.php`, and CORS or a shared origin between the
two. Run `/setup-deploy` then `/land-and-deploy`.

**Effort:** M
**Priority:** P0
**Depends on:** None

### Replace git-committed schedule shards with a transport that does not grow history

**What:** The daily GitHub Actions job commits regenerated per-route schedule shards
into the repo, and the Linode picks them up with `git pull`. Replace this later with
a transport that does not accumulate history.

**Why:** Shards total about 4.3 MB gzipped across 71 routes. A rebuild that touches
most of them adds meaningful history every time. Git stores each revision, so a repo
that starts small becomes a multi-gigabyte clone eventually.

**Context:** Decided during `/plan-eng-review` on 2026-08-19. Three options were
weighed: (A) commit shards and `git pull`, (B) publish to GitHub Pages and fetch
over HTTPS at runtime, (C) build shards on the Linode in PHP. A was chosen for v1
because it is versioned, revertable, needs no secrets, and has no runtime network
dependency. C was rejected because PHP has no maintained GTFS static parsing
library. B remains the most likely replacement. The `feed_version` gate has already
landed and cut the write rate from daily to roughly three times a year, which may
defer this indefinitely — reassess only if `.git` becomes unwieldy. It was 7.1 MB
with the first shard set committed.

**Effort:** M
**Priority:** P4
**Depends on:** None

## Design

### Write a real DESIGN.md via /design-consultation

**What:** The plan carries a minimum-viable token set (six semantic colours with
measured contrast, plus glyphs) inside `docs/designs/capmetro-dispatch-board.md`.
Replace it with an actual design system.

**Why:** `/plan-design-review` scored this 2/10 because no DESIGN.md exists. Every
future decision — spacing scale, type ramp, component vocabulary, elevation, focus
rings — gets made ad hoc and inconsistently. The token set covers colour and nothing
else.

**Context:** Decided during `/plan-design-review` on 2026-08-19. Best done now
rather than earlier: the real components exist to systematize rather than being
guessed at in advance. Target devices are Pixel 8a and Pixel 10 Pro, dark theme
only.

**Effort:** M
**Priority:** P3
**Depends on:** None

## Completed

### Fall back to the protobuf positions feed when the JSON one stalls

**What:** On 2026-09-01 `vehiclepositions.json` (`cuc7-ywmd`) froze at 12:40:09 CDT for over
four hours while CapMetro's protobuf publication of the same feed (`eiei-9rpf`) stayed current
to the second. Read the PB twin when the JSON is stale, converting it to the same camelCase
shape so nothing downstream changes.

**Why:** The data was never missing. The board spent an afternoon showing four-hour-old
positions, and because `cm_staleness()` takes the oldest feed, it also suppressed lateness for
trip updates that were 39 seconds fresh.

**Context:** The stall was upstream and only on the publish side — the file served a clean 200
throughout, and Socrata's per-publish blob UUID never advanced. The decoder landed in its own
`runtime/lib/gtfsrt.php` rather than inside `fetch.php`, returning the `cm_fetch_json()` array
shape. The enum mapping was the part to watch, as expected: `scheduleRelationship` and
`currentStatus` are strings in the JSON and integers in the PB, and `adherence.php` compares
`CANCELED` by name, so a bad mapping would have changed lateness silently.

Review turned up the failure modes that freshness alone does not cover, and they were the
interesting ones. An empty protobuf with a current header beat a stale-but-populated JSON on
age and reported `ok:true` while emptying the board — no staleness error fires on a feed that
has nothing in it to be stale. A wire-type mismatch on an enum field raised a TypeError out of
a decoder whose entire premise is that it degrades instead of failing. Invalid UTF-8 from the
wire would have made `json_encode()` return false and `write.php` correctly refuse to write —
one bad byte in one vehicle label costing every file that vehicle appears in. And a fourth
full-budget HTTP request put the worst case over the unit's `TimeoutStartSec=50`, on exactly
the runs where upstream is already misbehaving.

**Still open:** the differential proof. Unit tests show the decoder matches the GTFS-RT spec;
only a capture with both publications healthy shows it matches CapMetro's JSON *export*, and
the JSON feed was still stalled when this shipped.
`GtfsRtDecoderTest::testDecodedProtobufMatchesTheJsonExportForTheSameObservations` is written
and skips with that reason until `tests/fixtures/feeds-pb-differential/` exists.

**Effort:** M
**Priority:** P2
**Tracking:** https://github.com/kraftbj/capmetro-tracker/issues/14
**Completed:** 2026-09-02, PR 15. Needs the differential capture the next time both
publications are healthy at once.

### `update.sh` silently ignored systemd unit changes

**What:** `deploy/update.sh` never touches `/etc/systemd/system`; only `install.sh` writes
unit files. So a committed change to `capmetro-generate.timer` or `capmetro-update.timer`
merged, deployed, and never took effect, with nothing reporting the difference.

**Why:** Found on 2026-08-27 while fixing the update timer's firing hour — 04:17 on a box
running `Etc/UTC`, seven hours *before* the GTFS job commits at 11:20, so a rebuilt schedule
waited a full day. That fix reached the box; the box kept firing at 04:17.

**Context:** Took the fail-loudly option rather than having `update.sh` install units itself:
restarting a timer from inside the service that timer started is its own hazard.
`install.sh` records a sha256 fingerprint of the four unit *sources* into
`/etc/capmetro/installed-units.sha256`; `update.sh` compares and exits **3** — distinct from
1, which means the deploy failed — after the code and schedule are already live. It
fingerprints sources rather than diffing installed files because `install.sh` renders three
of the four units, so the installed copy never equals the source.

Four review rounds, and in each one the previous round's fix opened the next hole: a test
rewrite unpinned the call sites, a `readonly` repair made the exit code inheritable from the
environment, and the extraction that finally made the write testable stopped reporting its
own failures. The recurring class throughout was a check that silently passes. Along the way
it also turned out `install.sh` itself would not run — `php -m | grep -q` races under
`pipefail` and reported every extension missing — which would have made the documented remedy
fail on first use.

**Effort:** S (became M)
**Priority:** P2
**Tracking:** https://github.com/kraftbj/capmetro-tracker/issues/10
**Completed:** 2026-08-28, PR 13 (`8b43897`). Needs `sudo deploy/install.sh` on the box once
to write the first record.

### Regenerate the golden route 4 fixture and make the block fields required

**What:** `tests/fixtures/golden/route-4-20260819.json` predates
`block.spans_routes`, `route_ids`, `is_last_trip` and `next_trip.route_id`, so those five
fields are in the schemas' `properties` but deliberately not in `required`.

**Why:** Presence on live output is currently enforced only by a PHPUnit sweep. Making the
fields required in the schema is the stronger guarantee, and it cannot be done while a
committed fixture would fail it.

**Context:** Left alone by the block-routes lane because the fixture feeds the e2e suite.
Regenerate it from the 2026-08-19 feeds, confirm the e2e specs still pass against it, then
promote the five fields to `required` in `schemas/common.schema.json` and drop the
`$comment` explaining their absence.

**Effort:** S
**Priority:** P3
**Depends on:** None

**Completed:** v0.4.0.0 (2026-08-19)


### Rebuild the all-buses board around buses, not around triage

**What:** Drop the "Needs a look" band. List every route with all of its buses, and make
any bus tappable for a detail view.

**Why:** Owner's words: *"I don't care about 'needs a look' — I don't actually work at
capmetro."* The band ranks by what a dispatcher would triage, which is the wrong reader.
The board is for someone finding a specific bus, not for someone managing a fleet.

**Detail view, and exactly what the payload can back:**

| Field | Source | Notes |
|---|---|---|
| Route + headsign | `trip.route_id`, `trip.headsign` | |
| Next stop | `adherence.against.stop_name` | |
| Time to next stop | `adherence.against.predicted_at` minus now | already the number the badge is derived from |
| Scheduled at that stop | `adherence.against.scheduled_at` | the pair is what makes lateness legible |
| Current location | `position.lat/lon`, `position.speed_mps` | |
| Status | `progress.current_status` | `IN_TRANSIT_TO` / `STOPPED_AT` / `INCOMING_AT` |
| What it does next | `block.next_trip` | the direction flip, when confidence allows |
| Special run | `pattern.is_special`, `adds`, `skips` | |

**Previous stop is NOT directly available and needs a decision.** `progress` gives
`current_stop_sequence`; the stop one before it has to be looked up in a route-scoped stop
list, and `api/all.json` carries no stops at all. Three ways: fetch `api/route/{id}.json`
when a bus is tapped (cheap, one file, already generated); add a `previous_stop` to the
vehicle in the generator (cleanest for the client, a contract change); or drop the field.
Fetching on tap is probably right — the detail view is a deliberate action, not a hover.

**Out of service, what actually exists:** `vehicle_id`, `label`, `position` (lat, lon,
`speed_mps`), `position_at`. No trip, no route, no headsign, nothing else. So the owner's
instinct is right that there is little to show: location, whether it is moving or parked,
and how long since it last reported. Anything more would be invented.

**Context:** The current design is in `client/allbuses.js` and its 20 tests. The count
strip is worth keeping; the triage band is not. 392 vehicles across 48 routes, 143 of them
out of service.

**Effort:** M
**Priority:** P1
**Depends on:** None

**Completed:** v0.4.0.0 (2026-08-19)


### Order the vehicle rows by position along the route, not by lateness

**What:** `client/rows.js` sorts by adherence severity — worst news first. Order them by
where each bus actually is along the route instead, so the list reads in running order and
lines up with the ladder beside it.

**Why:** Owner's words: *"ordered by how late they are makes zero sense... the top one
should be the one that is the most in that direction (e.g. a SB ladder should have the most
southbound one at the top)."* Severity order is dispatcher thinking, the same wrong frame
the all-buses triage band had. A rider is asking "which bus is nearest me", and that is a
question about position.

**Context:** `progress.current_stop_sequence` is the field; it is already on every
in-service vehicle. Highest sequence is furthest along the route. The open question is
whether the list should run furthest-along-first (matching "most southbound at the top") or
first-stop-first (matching the ladder's own top-to-bottom order). Those disagree, so pick
one deliberately and say which in the caption. Out-of-service buses have no sequence and
should stay in their own group at the bottom.

**Effort:** S
**Priority:** P1
**Depends on:** None

**Completed:** v0.4.0.0 (2026-08-19)


### Show cancelled trips. This is the one that stranded a kid.

**What:** A cancelled trip is invisible everywhere in the client. The stop board, the saved
trips and the ladder all render it as "scheduled · no bus reporting yet", which a reader
correctly parses as "it hasn't started yet" when it actually means "it is never coming".

**Why:** On 2026-08-19 at 17:20 the owner's daughter waited at the Austin High stop for the
17:02 EB special on block 4090. That trip was cancelled. The board could not have told her,
and the stop it serves is the ONLY one that is served once in the morning and once in the
afternoon, so there was no second bus at that stop all day. She was stranded.

**It is not rare.** Live at 17:28 that same day: **187 cancelled trips system-wide, 17 on
route 4 alone** — 16:49, 17:02, 17:40, 17:57, 18:14, 18:31, 19:05, 19:22, 19:39, 19:56 and
more. There was also a route-wide `REDUCED_SERVICE` alert for the day. Cancellation is a
normal operating condition on this system, not an edge case.

**Where the data already is:** the trip updates feed carries
`trip.scheduleRelationship: "CANCELED"`, and `runtime/lib/adherence.php` already knows the
`trip_canceled` reason. But that reason only ever attaches to a VEHICLE, and a cancelled
trip has no vehicle — so it can never surface through that path. The runtime has to read
cancellation off the trip updates feed independently of vehicle matching and publish it as
a property of the TRIP.

**What to build:**
- Runtime: a `canceled` set from the trip updates feed. Publish it on
  `api/departures/{route}.json` trips (`"canceled": true`) so the stop board and saved
  trips can read it, and on the route payload's `schedule.directions[].trips` rows.
- Client: a cancelled departure must say CANCELED in words, must not be counted as "next",
  and must never read as merely un-started. In the stop board it should be shown struck
  through rather than hidden, because "the 5:40 is cancelled" is more useful than the 5:40
  silently not existing.
- The ladder should draw a cancelled diagonal differently, or omit it and say how many it
  omitted.

**Effort:** M
**Priority:** P0
**Depends on:** None

**Completed:** v0.4.0.0 (2026-08-19)


### Give the map a real basemap

**What:** The position panel is a labelled schematic — real coordinates, real
relative geometry, no streets. Add actual cartography.

**Why:** "I like 1 - the map so I have the most info." Relative geometry answers
"which bus is closer"; it does not answer "where is she right now", which is the
question that made you open the app.

**Context:** `client/map.js` says so in its own header: no basemap ships because a
tile source is a network dependency and the board must open from disk. That
constraint is worth re-examining rather than inheriting — the board already fetches
its own JSON over the network, so the offline-from-disk property is mostly
theoretical. Options: raster tiles from a free provider with an attribution
requirement, a vector basemap, or a pre-rendered static image of the service area
committed once. The last one keeps the no-network property and is much less work.

**Effort:** M
**Priority:** P2
**Depends on:** None

**Completed:** v0.3.0.0 (2026-08-19)


### Saved trips: watch a specific stop and time

**What:** Save "the 7:50a 800 SB from Simond/Berkman" and see how that trip is
looking from about an hour before until after the bus clears the stop.

**Why:** This is the question actually being asked most mornings, and answering it
today means picking the route, picking the direction, and reading the ladder to find
which of the several buses is the right one. The backend for this is done and unused.

**Context:** `runtime/lib/watch.php` computes the watch payload, including
`day_type`, and `watch_id` is a sha256-16 of the semantic tuple specifically so a
child's routine never lands in a URL or a server log. Watches are client-local by
design. Missing: the UI to create one (pick route, direction, stop, time), the
storage (localStorage), and the pre/post window rendering. The `day_type` field is
already emitted, so the weekday / Saturday / Sunday distinction is available and
only needs surfacing.

**Effort:** L
**Priority:** P1
**Depends on:** None

**Completed:** v0.3.0.0 (2026-08-19)


### Build the all-buses view

**What:** A second screen showing every vehicle in the system at once, deadheads
included, not scoped to a route.

**Why:** "It also had a screen to simply see all buses, which was also nice but
secondary." Plus, explicitly: "For the all buses view, show the deadhead etc."
Right now `api/all.json` is generated on every run and nothing reads it. Today's
file carries 392 vehicles, 143 of them out of service — that is 36% of the fleet
that the route views deliberately hide and this view is supposed to show.

**Context:** The payload already exists and validates against the schema. It carries
`counts`, `staleness`, `service_day` and the full `vehicles` array with `in_service`
set. The work is entirely client-side: a list or map that does not assume a single
route, and a filter for in-service vs deadhead. `client/rows.js` mostly works
unmodified; what it lacks is a route label per row, since within one route today
that is implied.

**Effort:** M
**Priority:** P1
**Depends on:** None

**Completed:** v0.3.0.0 (2026-08-19)


### Let the route picker reach every route the backend already publishes

**What:** The picker offers six hard-coded routes (4, 7, 337, 350, 800, 837). The
build generates 71 route files. Drive the list from the generated data instead.

**Why:** "I like the current website's option to pick any route and see the buses
for that route, so don't hard code one." Six routes covers the two school runs and
nothing else. The moment either kid takes a different bus, or anyone else opens the
board, it is the wrong six. The data is already there: `.local/webroot/api/route/`
holds 71 files and every one of them renders today if you hand it a route id in the
URL. Only the picker is short.

**Context:** `client/app.js` line 26 has `var WATCHED = [...]` with the six ids and
a comment saying only route 4 had a generated file, which stopped being true once
the build lane finished. The fix needs a routes index the client can fetch: either
add a `routes` array to `api/all.json` (which the client will want anyway for the
all-buses view) or emit a small `api/routes.json` at build time carrying id,
short_name, long_name and the directions each route publishes. Keep the six as a
pinned "favourites" row above the full list; that part of the current design is
worth keeping.

**Effort:** M
**Priority:** P0
**Depends on:** None

**Completed:** v0.3.0.0 (2026-08-19)


### Resolve BOTH-direction ladder rendering

**What:** The direction control is a three-way toggle (direction A / direction B /
BOTH). A and B were specified and rendered; BOTH was not.

**Why:** BOTH is the mode that fixes the turnaround confusion — on route 4 the
5th/Campbell stop is the turnaround, so there is no eastbound bus to see coming; it
is a westbound bus until that stop. That is the most valuable feature in the plan.

**Context:** The plan predicted route 7 would stack to about 16 rows at a cramped
pitch and guessed the answer was mirroring the two directions around a shared time
axis. Wrong guess. The client renders two per-direction ladders, each at full pitch
with its own timepoints, stacked on a phone and side by side on a wide screen. The
pitch problem never arises.

**Effort:** M
**Priority:** P1
**Completed:** v0.1.0.0 (2026-08-19), verified by `/qa` at 412px on route 7 — 6 of 6
southbound and 7 of 7 northbound buses placed. Vehicle rows were grouped to match
the ladders in v0.2.0.0.

### Only commit shards when the upstream GTFS feed_version changes

**What:** Rather than committing regenerated shards daily, commit only when the
upstream schedule actually changes.

**Why:** Cuts repo growth from daily to roughly three times a year, which is how
often CapMetro resets the schedule.

**Context:** Implemented in `.github/workflows/gtfs.yml`: the workflow reads
`data/manifest.json` feed_version before and after the rebuild and commits nothing
when it is unchanged.

**Effort:** S
**Priority:** P2
**Completed:** v0.1.0.0 (2026-08-19)

### Stop names truncated to a single word (ISSUE-001)

**What:** Ladder labels showed `Bluff…`, `Convict…`, `Overton…` — one word plus an
ellipsis, useless as a stop label.

**Why:** Two defects compounding: the early return tested the 24-character stem
budget instead of the 25-character schema cap, so 13 names that already fitted were
truncated anyway; and the boundary search broke only on spaces, while Austin stop
names are `Street/CrossStreet` with no space around the slash.

**Context:** 23 of 2,348 stops affected. Fixed in `build/lib/stop-names.mjs` and
`runtime/lib/stopnames.php` with regression suites in both languages.

**Effort:** S
**Priority:** P1
**Completed:** v0.1.0.0 (2026-08-19), commit `4ef9992`

### Build and runtime disagreed on 9 stop names (ISSUE-002)

**What:** The same stop rendered as `8Th/Lavaca` on the ladder and `8th/Lavaca` on
the vehicle row, because the build implementation was missing the intercapped-ordinal
step the PHP one had.

**Why:** Ladder rows come from the build, vehicle rows from the runtime. Two
spellings of one stop is a visible bug, and the file header said as much before the
requirement was missed.

**Context:** Found only by running both implementations over all 2,326 upstream names
and diffing — nothing in the suite compared them, and neither was wrong on its own
terms. Now 0 disagreements, with a differential test guarding it.

**Effort:** S
**Priority:** P2
**Completed:** v0.1.0.0 (2026-08-19), commit `4ef9992`
