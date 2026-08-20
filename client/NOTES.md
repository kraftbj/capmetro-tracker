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
  of wait. All four numbers are read off this feed rather than off a standard, and
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

- **`TIGHT_S` compares with `<=`, and that is load-bearing.** It equals
  `MIN_SLACK_S`, and the editor offers a connection at `>= MIN_SLACK_S`, so a strict
  `<` graded the tightest connection the board will ever offer as comfortable. The
  two constants being equal is what makes this invisible on a read; there is a test
  asserting the verdict at exactly that value.

- **The walk is charged with a 1.4 circuity factor.** Great-circle distance is
  accurate to centimetres here and still wrong for the purpose: the straight line
  between two stops is not a path anyone walks, and Pleasant Valley is a divided
  arterial. Kept as a separate constant from `WALK_SPEED_MS` because they are
  different claims — one about the street, one about the rider — and a blended
  number would leave neither checkable. This is also what lets `WALK_RADIUS_M` stay
  at 300 m when the cited examples only cover 215: the wide pairs are offered but
  priced, at 5.8 minutes for a 300 m hop.

- **A connection's verdict is computed from predicted times, and says which halves
  are predictions.** A bus that is not reporting contributes its scheduled time and
  the card prints "the timetable, not a prediction". A suppressed lateness is treated
  as absent, not as zero — the `adherence.view()` contract already decides when a
  number may be shown, and this reads that flag rather than re-deciding.

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
