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
| `?view=trip` | The trip view; add `&bus=2641` to follow a specific bus |
| `?view=trip&bus=2641&state=trip-gone` | The named bus is absent from every payload the session ever sees, so it renders the same "Pick a bus" empty state as never having chosen one. The dimmed-list-with-last-seen-time render path — reached only when a bus that WAS present in an earlier poll drops out of a later one — needs session history a single frozen scenario document cannot carry; it is exercised directly in `tests/node/client-trip.test.mjs` instead. |
| `?view=trip&state=trip-no-anchor` | No anchor: whole trip listed, no arrival times |
| `?view=trip&state=trip-canceled` | Canceled trip: scheduled times only |
| `?view=trip&state=trip-estimated` | Synthetic: half the feed predictions removed, so the feed/estimate divider and `~`/"estimated" markers actually render. The bundled fixture gives every in-service vehicle full feed coverage on its own, so without this the estimate branch — this feature's whole honesty mechanism — cannot be seen or tested at all. |

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
