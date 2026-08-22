# client/ — notes, and things other agents need to know

I own `client/` only. Everything below that touches `build/`, `runtime/`, `tests/`,
`schemas/`, `docs/` or `.github/` is written here rather than changed there.

---

## How to run it

Open `client/index.html` from disk. No server, no build step, no install.

It loads the committed golden fixture through `client/data/route-4-20260819.js`, a
verbatim generated copy of `tests/fixtures/golden/route-4-20260819.json`. The copy
exists because `fetch()` is blocked for `file://` URLs and being openable from disk
is a requirement. Regenerate it with:

```
node client/data/regenerate.js
```

Served over HTTP next to a webroot containing `api/route/{id}.json`, the client
fetches the live file first and only falls back to the bundled fixture, showing a
"Sample data" banner whenever the fallback is what you are looking at.

### State harness

Every row of the design doc's interaction-state table can be forced from the URL,
because a state table that cannot be looked at does not get verified:

| URL | What it shows |
|---|---|
| `?state=loading` | Skeletons; the payload never resolves |
| `?state=empty` | No vehicles — the non-blank empty state |
| `?state=error` | Feed unreachable, retry offered, panels explain themselves |
| `?state=partial` | Some buses have positions but no prediction |
| `?state=stale` | `suppress_adherence: true` — no lateness value anywhere |
| `?state=dead` | Feed down over an hour |
| `?state=schema` | `schema: 2` — the app refuses to render |
| `?state=first-run` | Route picker with the six watched routes |
| `?state=no-timepoints` | Ladder with no timepoint list for either direction |
| `?state=all-states` | Synthetic adherence covering all six states (grayscale check) |
| `?state=ladder-probe` | Synthetic 8+9 timepoint route: the BOTH-mode layout ruler |

Also `?route=4` and `?dir=0|1|both`. The last route and direction persist in
`localStorage`.

The `all-states` and `ladder-probe` scenarios rewrite the fixture and are labelled
on screen as synthetic. They are instruments, not data — nothing in the shipped
board invents a value.

---

## Gaps in the API contract that the design spec depends on

These are the ones that changed what I could build. Each is a request to whoever
owns `docs/api-contract.md`, `schemas/` and the build job.

**1. There is no next-departure field, and the empty state is specified to need one.**
The design doc is explicit that `"No buses on route 350 right now."` alone is the
failure being designed against, and that the line must continue
`"Next departure 2:14pm from Airport/12th."` The route-state payload carries no
scheduled departure for a route with no live vehicles, so the client currently says
so in plain words instead of inventing one. Suggested addition to §1:

```jsonc
"next_departure": {            // null when the service day is over
  "scheduled_at": 1787169240,
  "stop_id": "1368",
  "stop_name": "Pleasant Valley/5th",
  "direction_id": 0,
  "headsign": "4 Mopac WB"
}
```

The client already reads `route.next_departure` defensively and will use it the
moment it appears — no client change needed beyond deleting the fallback sentence.

**2. The golden fixture has timepoints for direction 0 only.**
`route-4-20260819.json` carries three timepoints, all `direction_id: 0`. Two of the
five in-service vehicles are `direction_id: 1` and the design table lists route 4 as
3 timepoints per direction. The client renders an explicit "No timepoints published
for 4 Shady EB" state rather than an empty box, but this looks like a generator bug
or a truncated fixture rather than reality. Worth checking before the ladder is
judged on it.

**3. There are no scheduled times per timepoint, so a time-axis string-line is not
possible from this payload.** The sketch's horizontal axis is clock time; the
payload has clock times only for `adherence.against` (one stop per vehicle). What I
built instead: y is route position (interpolated stop sequence) and **x is signed
schedule deviation**, early left, late right, ±10 min full scale. A healthy route is
a column of dots hugging the spine, which answers the same question. If a true
time-axis string-line is wanted, the contract needs scheduled arrival times per
timepoint per trip — that is a much larger payload and I would question it before
adding it.

**4. `alerts[].stop_ids` contains duplicates.** All three alerts in the fixture
repeat their stop id (`["940","940"]`). Harmless here, but it will double-count if
anything ever groups by stop.

**5. Stop-name shortening (task D8) has a capitalisation artefact.** `"8Th/Lavaca"`
in the fixture. Rule 3 of §7 standardises directional suffixes but nothing
normalises an intercapped ordinal. Cosmetic, build-side.

**6. Not built, and out of the four-panel hierarchy I was given:** the watchlist
(`/api/watch/{id}.json`, §9) and the all-buses view (`/api/all.json`, §8). The
design doc's state table has rows for both. They need their own panels and a
saved-watch creation gesture, which the design doc itself still lists as an
unresolved decision.

---

## Nearest stop / "when is my bus here" (`near.js`)

Answers a rider's question rather than a dispatcher's: which bus is coming to the
stop I am standing at, and when. Uses `navigator.geolocation` and nothing else —
no tile server, no geocoder, no key, no network call.

- **The fix never leaves the browser and is never stored.** Not sent, not logged,
  and deliberately not in `localStorage` next to the saved route and direction.
  A saved route is a preference; a saved position is a record of where somebody
  was. The permission prompt is only ever raised by tapping the button.
- **It does not measure the distance to a bus.** That number is wrong in a way
  that looks right: the nearest bus by metres is routinely one on the parallel
  street going the other way. Instead the USER is snapped to a stop, and
  `Vehicle.predictions` says which buses still have that stop ahead of them —
  presence in that list IS "approaching", so there is no distance derivative to
  get wrong. `bearing` could not have helped either: 208 of 392 vehicles in the
  capture do not report one.
- **Stops are matched by `stop_id`, never `stop_sequence`**, because route 4 runs
  a 17-stop baseline on five services and a 19-stop one on three others.
- **Every time shown is the agency's own `predicted_at`.** Nothing here adds a
  deviation to a scheduled time or divides a distance by a speed, and the
  countdown is measured against `generated_at` like every other age on the board.
  When the feed is stale the server sends an empty list and the panel says why,
  because a countdown is the number a rider acts on fastest.
- **It renders in the banner slot above the rows, not as a fourth panel.** The
  rows/ladder/map order is settled; this is a stated answer in the slot the
  staleness banners already use. The vehicle rows get a marker, not a re-sort —
  promoting "your" bus above a very late one would defeat the sort.
- **Verified on `file://`** (the board must open from disk). Measured, not
  assumed: Chromium reports `isSecureContext: true` there and exposes
  `navigator.geolocation`, so the common claim that `file://` is not a secure
  context does not hold for it. The panel gates on `isSecureContext` itself
  rather than on the protocol, so a browser where it IS false says "this page
  cannot ask" instead of blaming the reader. What the harness cannot show is a
  real permission *prompt* on an opaque `file://` origin, since headless has no
  prompt UI; a browser that refuses to grant one reports the same code 1 a
  person tapping Block does, so that message names both possibilities rather
  than picking one. Still worth ten minutes in a real browser opened from disk.
- **The arrival time is shared with the stop board.** Both panels answer "when
  does this bus reach this stop", so both read `fmt.predictionFor()` first.
  stopboard.js used to add the bus's current lateness to the scheduled time,
  which assumes the deviation measured at whatever stop the bus is approaching
  still holds by the time it reaches yours — across the corpus the two disagree
  by over a minute on 64% of comparable pairs and by up to 53 minutes. It keeps
  that estimate as a fallback, because predictions only cover stops ahead of a
  bus inside the 45-minute window (4,528 of 9,865 departures); the rest are
  buses that have not started yet.

  **A stop board row shows its lateness badge only when the badge and the time
  are the same computation.** Making the time more accurate broke the identity
  that used to hold — the row prints an arrival, a scheduled time and a badge,
  so a reader can subtract, and 1,438 of 4,205 rendered rows would have been
  off by more than two minutes with 325 pointing opposite ways. On a
  feed-sourced row the badge, the state colour and the signed number go; the
  scheduled time is printed always instead, since it becomes the only thing
  saying how late the bus is *here*. The bus's overall state survives as a
  phrase — "running very late" — because a word can carry the scope a bare
  number cannot: a bus eleven minutes late at its anchor that reaches this stop
  five minutes late is the feed modelling recovery, not a contradiction.

Gap 3 above is now partly closed: `Vehicle.predictions` gives per-stop predicted
times, so a rider-facing arrival time no longer has to be invented. A true
time-axis string-line would still need scheduled times per timepoint per trip.

---

## Decisions I made that reviewers should check

- **The badge sits in the leftmost column, not after the vehicle id.** The approved
  sketch orders them id-then-badge. The written spec says the badge must be the
  strongest repeated object, fixed-column aligned so the eye scans one vertical
  strip. Leftmost does that better; the id moved into the first meta line where it
  is still the first thing read. If the sketch order is load-bearing, this is a
  one-line change in `rows.js`.

- **Rows sort worst-news-first** (very late, late, early, unknown, on time), then by
  trip start. A dispatch board should surface the problem, not the schedule order.
  Deadheads are always listed, in their own "not in service" group, in every
  direction filter — they have no direction, so filtering them out would make a bus
  disappear for no reason the user can see.

- **BOTH mode keeps the pitch and grows the page, rather than compressing to fit.**
  The design doc worried that route 7 stacks to 17 rows at 23.8px. Measured with
  `?state=ladder-probe` at 412px: 17 rows, **44px pitch on every row**, accordion
  buttons 47×44, ladder band 1158px tall. So the answer to "keep pitch ≥ 24px" is
  yes, at the cost of the ladder no longer fitting one screen in BOTH mode. That
  trade is deliberate: the glance the ladder exists for is the single-direction
  view, and BOTH is an explicit request for more.

- **The map is a schematic, and says so.** Real coordinates projected into the
  route's own bounding box, no basemap, labelled "Schematic · no basemap yet". A
  tile source is a network dependency and this board has to open from disk.

- **Times render in `America/Chicago`, not the device timezone.** The question is
  always what time it is on the route.

- **"Now" is `generated_at`.** The client never uses the device clock to judge
  freshness; every age comes from `staleness.oldest_feed_age_s`.

- **A transfer is a PAIR of stops within a short walk, not a shared stop id.**
  `chain.js` finds connections geometrically because on this feed the headline
  example cannot be found any other way: routes 800 and 4 share **zero** stop ids
  and meet at Pleasant Valley under two ids 27 m apart. Radius 300 m, walking pace
  1.2 m/s charged against the slack, minimum 2 minutes of slack, maximum 45 minutes
  from alighting to the onward departure, walk included. All four numbers are read off this feed rather than off a standard, and
  all four are exported so a test can assert against them instead of restating them.

- **`chain.js` uses `watch.js` rather than copying it.** Departure matching, the
  service-day clock and the trip-to-vehicle join are one rule each, and ISSUE-002 is
  what two copies of one rule cost. It is loaded after `watch.js` and throws on load
  if that is not there, rather than failing one `undefined` at a time.

- **A chain is over when the last bus is BOARDED, not when it finishes its run.**
  Nothing records where the rider gets off the final leg, so the last boarding is the
  only honest end marker. Using the trip's final stop would leave a finished chain on
  screen for another forty minutes on the 800. The cost is that the card cannot say
  "she gets in at 8:40" — see `TODOS.md`.

- **A leg the feed cannot supply a lateness for refuses the verdict, it does not
  fall back to the timetable.** Refusing to read `null` as zero is only half the
  job; the other half is where the `null` leads. The timetable always reads *on
  time*, so substituting it is never neutral — it moves the verdict optimistically
  on exactly the input that should make it cautious. There is one case where it is
  still honest, and it is the only one: **no vehicle on a live feed**, where the
  bus has not started its run and the schedule is the prior. Everything else is a
  refusal, and `unknown` is a reachable verdict. Measured: the same chain, same
  ten-minutes-late bus, graded `missed` fresh and `made` dead.

  Two ways this was got wrong, both found by review, both because the reasoning
  above was written where the code could not act on it:

  - `suppress_adherence` is a property of the **route**, and it was read inside
    `if (out.vehicle)`. The refusal therefore only fired when the frozen snapshot
    happened to contain that leg's bus. On a cron that died before the bus
    appeared, "no vehicle" and "a vehicle we have stopped hearing from" are the
    same observation and the join cannot tell them apart. Read it from
    `route.staleness`, before the join, always.
  - The refusal covered `stale_data` and none of the other unknown reasons, so a
    reporting bus with `no_trip_update` graded confidently and was called "not
    reporting yet" with its badge on the same card. The copy needs three
    sentences, not one: a bus in a dead feed's snapshot **is** on the road, a bus
    missing from one cannot be described either way, and a bus on a live feed with
    no lateness published is reporting perfectly well.

- **A refused verdict must not come back as a number somewhere else.** Three did.
  `end_at` retired the chain on `predicted_board_at`, which on an ungraded leg is
  the timetable — so the card went to "Gone. Back tomorrow" about a bus still at
  the kerb; an ungraded chain now stands down on the clock (`UNGRADED_HOLD_S`).
  The headline counted down to the same time in the largest type on the card. And
  the two times under the verdict were printed unlabeled in the slot used for real
  predictions, where they subtract to the withheld answer in the reader's head.

- **The walk is recomputed from current stop positions on every render.** Everything
  else in a chain is re-resolved from current documents; the walk was the one frozen
  value, so a cost-model change reached new chains and not saved ones. The stored
  metres survive only as a fallback for a stop with no fix, and even then the
  seconds are re-derived rather than trusted.

- **A canceled leg is never graded.** `resolveLeg()` checks `trip.canceled` before
  the vehicle join, because every check after it concludes "not reporting yet" —
  which reads as *not yet* when it means *never*, and would then grade the transfer
  against a timetable for a bus that is not running. Same order `watch.js` uses, and
  for the same reason its comment records. Transfers either side of a canceled leg
  are `void`, not graded.

- **Grading stops at the first change that cannot be made.** Everything downstream
  of a missed, broken or canceled change is `void` and says why, rather than showing
  a slack figure computed from a bus the rider will not be on. Grading each transfer
  independently printed "Connection holds" six lines under "Connection missed" on a
  three-leg chain, which is the shipped path for "337 to the 7 to the 837".

- **`TIGHT_S` is five minutes, and deliberately not `MIN_SLACK_S`.** The two used
  to be the same two minutes, on the reasoning that offering a connection and
  trusting one are the same judgment. They are not. The estimator holds the first
  leg's *currently observed* lateness constant all the way to the alighting stop,
  and for a bus twenty minutes upstream that number moves by minutes before it
  arrives — so a three-minute verdict sat inside the noise of the measurement that
  produced it and still read "Connection holds". Nothing is hidden by the higher
  threshold: those connections still appear, still print their slack, and still say
  which half of the sum is measured. They say "tight" instead. The comparison is
  `<=`, which mattered acutely while the constants were equal (a strict `<` graded
  the tightest connection the board will ever offer as comfortable) and is still
  the honest boundary. Tests assert the verdict at `MIN_SLACK_S`, at `MIN_SLACK_S
  + 1`, at `TIGHT_S` and at `TIGHT_S + 1`.

- **A verdict requires evidence; there is no default.** `gradeDecision()` is
  written as an exhaustive set of named cases with no fall-through, and that shape
  is the point. It was previously an enumeration of reasons to *refuse*, which
  means it had a default, and the default was "grade it" — so every case nobody had
  thought of graded confidently from the timetable. Four review rounds each found
  another one and each fixed it by adding a fifth refusal. The last one found was
  `route === null`, which is the state **every page load starts in**, because the
  live route map is built from payloads that have already landed and the chain
  paints before they do: the first frame of every visit printed "Connection holds"
  beside the board's own "No live data for route N" banner. Adding a case here
  means adding a branch, not discovering later that an unnamed one graded.

- **The walk is charged with a 1.4 circuity factor.** Great-circle distance is
  accurate to centimetres here and still wrong for the purpose: the straight line
  between two stops is not a path anyone walks, and Pleasant Valley is a divided
  arterial. Kept as a separate constant from `WALK_SPEED_MS` because they are
  different claims — one about the street, one about the rider — and a blended
  number would leave neither checkable. This is also what lets `WALK_RADIUS_M` stay
  at 300 m when the cited examples only cover 215: the wide pairs are offered but
  priced, at 5.8 minutes for a 300 m hop.

- **A connection's verdict is computed from predicted times, and says which halves
  are predictions.** A bus that has not started its run contributes its scheduled
  time and the card prints "the timetable, not a prediction". A lateness the feed
  will not supply is treated as absent rather than as zero, and refuses the verdict
  outright — the `adherence.view()` contract already decides when a number may be
  shown, and this reads that rather than re-deciding it.

- **The Saved view ages the payloads it holds.** `staleness` describes the feed
  when the file was generated and cannot speak for the minutes since, so a route
  fetched once and never refreshed kept saying `fresh` for the life of the tab and
  was graded with full confidence against hour-old positions. `liveRouteMap()` adds
  the time this browser has held each document to the age the server measured and
  applies the contract's own thresholds to the sum. `Date.now()` is the right clock
  for that and the wrong one almost anywhere else here: it subtracts two readings of
  the same local clock and never compares one with a time in a payload.

- **A cached schedule is evicted only when it is STRICTLY older than the board's
  service day, and eviction marks the route rather than clearing its fetch guard.**
  Both halves are a request loop otherwise. Evicting on "different" threw away
  today's schedule whenever the board was on the embedded fixture; clearing the
  guard let the eviction refetch inside the paint that evicted. `YYYYMMDD` compares
  chronologically as text, which is why no parsing is involved.

---

## Verification performed

Rendered headless at 412×915 (`gstack browse`) against the golden fixture.

- All 6 fixture vehicles render: 2858, 2867, 2216, 2701, 2641 in service, 2305 as
  deadhead. Confirmed by DOM query, not by eye alone.
- Interpolation: with the first accordion collapsed, #2701 (`stop_sequence` 5) sits
  between the Pleasant Valley/5th and 8th/Congress timepoints; expanding that
  segment lands it exactly on 7th/Northwestern, which is stop 4181 — the stop the
  feed actually reports it at. Edge cases unit-checked in the browser: before the
  first anchor, exact hit, between anchors, past the last, null sequence, no
  anchors.
- `?state=stale` and `?state=dead`: no lateness value renders anywhere. Scanned the
  full rendered text and every SVG label for `[+−-]\d+m` — no matches. The deviation
  axis drops its minute labels too, since a scale implies a reading.
- Grayscale: `?state=all-states` screenshotted and converted to grey. Every state
  still separable.
- Focus order: route chip → WB → EB → BOTH → each vehicle row → each accordion →
  alerts. All targets ≥ 44px.
- No horizontal overflow at 412px; no console errors.

Not verified on real hardware, and not verified under `prefers-reduced-motion`
(the headless harness has no media emulation) — the reduced-motion rules are
code-level only: animations off, durations zeroed, transitions disabled.
