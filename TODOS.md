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

### Transfer chains

**What:** Show a connection as one thing: 800 to the 4, 337 to the 350, 337 to the 7
to the 837.

**Why:** "she rides 800 to the 4 Austin HS run in the mornings and then 4 to 837 on
the way home. The other daughter varies." Two separate route views mean doing the
arithmetic yourself, at the exact moment you are trying not to think.

**Context:** Block continuity via `block_id` already links consecutive trips run by
one vehicle, which is the harder half of this problem. A transfer is the easier
half: two trips, two routes, a shared stop, and enough slack between them. Best
built on top of saved trips, since a chain is a watch with two legs.

**Effort:** L
**Priority:** P2
**Depends on:** Saved trips

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
