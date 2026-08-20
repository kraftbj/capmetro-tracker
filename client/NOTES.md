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

Also `?route=4` and `?dir=0|1|both`, and `?view=board|stops|all|saved`. The last
route, direction and view persist in `localStorage`.

There is no `?state=` scenario for the stops view, and there cannot be a useful
one yet: a stop card needs `api/departures/{route}.json`, the scenarios rewrite
the bundled route fixture, and no departures document is bundled. The view is
covered end to end instead, in `tests/e2e/stops.spec.mjs`, against fixtures the
e2e server serves over HTTP.

The `all-states` and `ladder-probe` scenarios rewrite the fixture and are labelled
on screen as synthetic. They are instruments, not data — nothing in the shipped
board invents a value.

---

## The stops link (`#plan=`)

The fourth view. A **saved trip** is one named departure — "the 7:50a 800 SB from
Simond/Berkman". A **stop** is a place and a time of day — "the 4 eastbound from
Campbell/5th in the afternoons" — and it resolves to the next few departures,
because which of the afternoon's buses gets caught is decided on the day.

### The grammar

```
https://bus.dillo.dev/#plan=1;800.1.6293.am;4.0.3337.am;4.1.6243.pm
                            │ └───────────┘
                            │  route . direction . stop . window
                            └ format version
```

`direction` is the GTFS `direction_id`, `0` or `1` — not a compass letter, since
which of the two is northbound is a property of the route. `window` is `am`
(04:00–12:00), `pm` (12:00–20:00), `all`, or an explicit `HHMM-HHMM` whose end may
run past midnight (`2200-0200` is 22:00 to 26:00 in service-day seconds, the same
convention every other clock in this contract uses). It is optional and defaults
to `all`.

A window decides which SECTION a stop lands in, never whether it is on the page.
An afternoon stop at seven in the morning sits under "Later today" with its next
departure printed, because "where did my stop go" is a worse question than "why is
that one greyed out".

Malformed entries are dropped and the rest still open. A plan is not a
transaction; if four of five stops parse, the reader is standing at one of the
four.

### Why the fragment, and not the query — and what that does not buy

Contract §9 hashes the watch tuple for one stated reason: *"so a URL or server log
never carries a legible description of a child's daily routine."* A feature whose
whole point is a URL has to answer that rather than inherit it.

The fragment answers the half about **passive** leakage. Browsers do not send it,
so `bus.dillo.dev`'s access log sees `GET /` however many stops the link carries,
and it does not ride along in a `Referer` header either. `index.html` declares
`referrer: no-referrer` as well as the vhost doing so, because the board is also
meant to open from disk, where no vhost applies.

**It is not the guarantee the hash gives, and an earlier draft of this file said it
was.** The sha256 in §9 is one-way: no decoder exists, only guess-and-check against
a stop you already suspect. This encoding is reversible and *this application is
the decoder* — paste a link into the board and the stops are on screen, named, with
times. No stop table needed, and stop ids are public GTFS besides. The true claim,
which is still worth having:

> The server never learns which stops a link carries. Anyone the link is *given* to
> can open it and read them, which is the entire point of sharing it.

A link somebody chose to send is a different thing from a URL that leaks into logs
and referrers by itself, and only the second is what §9 is about.

One thing the fragment does not hide: opening a plan immediately fetches that
plan's **routes**, so the access log does learn the route set — just not the stops,
the directions or the times.

A `?plan=` query is still accepted, because a link that has been through three
messaging apps can arrive in any shape — and is rewritten into the fragment via
`replaceState` before any fetch goes out, with the banner saying so. That does not
un-send the request that already reached the server; it stops the leak repeating on
reload and on the next share.

### What a link may carry

At most 12 entries across at most 6 routes, and the rest of the fragment is
dropped. Every surviving entry becomes a route whose schedule and live payload are
fetched, and the refresh timer re-runs the set every 60 seconds; a fragment with a
few hundred entries is a few hundred requests a minute from one phone, and a wedged
board with the fan on is indistinguishable from the app being broken. The commute
this shipped for has five entries on three routes.

A link is also the first untrusted string this codebase feeds into paths that only
ever saw internal state. `departures['constructor']` on a plain object returns the
`Object` function — truthy, so an `|| []` fallback never fires, with a `.length` of
1 and nothing at `[0]` — and the next read threw during render, blanking the board.
Guarded once in `watch.rowsFor()`, which every caller goes through, and the
route-keyed caches in `app.js` are `Object.create(null)`.

### Turnarounds, which are the reason this is not a list of times

Three of the five stops this was built for are turnaround points: route 4 eastbound
starts at Campbell/5th and at Veterans/Atlanta, route 837 northbound starts at
Republic Square. **There is no eastbound bus approaching Campbell/5th, ever.** The
bus that answers the question is westbound until it gets there, turns its headsign
round and leaves as the eastbound trip. A board that looks for an approaching
eastbound vehicle shows a scheduled time and no bus — the exact blank the design
doc calls the failure this project exists to avoid.

Three published facts answer it, and the card says which one it is using:

| What is known | The card says |
|---|---|
| The trip is cancelled | "CANCELED · CapMetro has canceled this trip. No bus is coming for it." |
| A vehicle is on the outbound trip and `STOPPED_AT` the stop | "Bus 2867 is at the stop now." |
| A vehicle is on the inbound leg and `STOPPED_AT` the stop | "Bus 2867 is standing at this stop now, in on the 3:04p WB, and goes back out as this trip." |
| A vehicle is running the inbound leg elsewhere | "Bus 2867 brings it in on the 3:04p WB — due here in 4 minutes, running 35 seconds late." |
| The inbound leg itself is cancelled | "The 3:04p WB that would bring this bus in is canceled, and nothing in the schedule says what runs this trip instead." |
| Only the schedule knows | "Comes in on the 3:04p WB. No bus is reporting on that trip yet." |

**A continuation the feed has not confirmed is a likelihood, not a fact** —
contract §4, and the same hedge `rows.js` `continuationText()` makes: "Bus 8021
*likely* brings it in on the 10:20a SB". The word is on every line; what it means
is said once per card, because three identical caveats in a row bury the times the
card exists to show. That is not an edge case here. Every route 837 block in the
2026-08-19 capture is `confidence: low`, so it is the ordinary reading on one of
the three turnarounds this shipped for, and it matters more on this card than on
the rows band — the whole point of a turnaround card is answering "is a bus
actually coming for me" at a stop where none is visible, which is exactly where a
false certainty costs somebody a wait in the dark.

**Cancellations, ranking and the grace window are `stopboard.js`'s**, not restated
here: `plan.js` calls `stopboard.upcoming()` and decorates each departure with the
turnaround facts. So a departure is upcoming when its *predicted* arrival is still
ahead, a cancelled one is listed and does not consume one of the three slots, and a
cancelled trip gets no continuation reasoning at all — "Bus 8021 brings it in"
printed beside CANCELED is the contradiction this board exists to avoid. Those
rules were paid for once, when a kid waited for a bus that was never coming.

The inbound leg gets the same check. "Comes in on the 3:04p WB. No bus is
reporting on that trip yet" means *it has not started*, and using it for *it is
never running* is the confusion cancellations exist to remove — worst here, since
the inbound leg is the only evidence a bus is coming at a stop where none is
visible. The whole-block case never reaches that code (the outbound is cancelled
too, and `decorate()` returns first), so what it covers is one leg of a block
called off on its own. The real capture only cancels whole blocks, so the test
edits a fixture rather than pretending the case is in the data.

**The screen-reader summary mirrors the card, not just its first row.** The card
lists a cancellation and then the buses still running; taking only the first entry
meant that when the soonest departure was cancelled a screen-reader user heard
"cancelled" and nothing else — the half of the message that sends someone home.

### Known gap: a mid-day cancellation

`trip.canceled` lives only in the departures document, which is now kept for the
service day it describes. `canceled_trips` is published on the *route* payload and
rebuilt every 60 seconds, and no client code reads it. So a trip cancelled at
10:05 for a 10:13 departure does not reach a tab that was opened at 07:00 — on the
stops view or the Next-buses band. This is a trunk gap rather than one this view
introduced (the same hole exists on `stopboard.js`), and it is being fixed there;
the eviction rule here is what decides how long the stale copy lives, so both
halves belong in view together.

The live half comes from `vehicle.block.next_trip` (§2), the server's own block
continuity with `is_direction_flip` already computed, falling back to the vehicle
running the scheduled inbound leg — route 837 publishes `next_trip` without ever
setting `is_direction_flip`, so that flag is read as extra information and never as
a gate. The scheduled half comes from `departures.trips[].block_id`: the latest
arrival at this stop, on the same block, in the other direction. Block continuity
is the only honest link. Two trips sharing a stop and a plausible gap is a guess;
two trips sharing a `block_id` is the agency saying one vehicle runs both.

Whether a stop is a turnaround is **detected, never encoded in the link** — a
departure is compared against its own trip's published `start_time`, so a schedule
change three times a year cannot leave a hand-written flag lying about the
geometry. It is also compared against `start_time` rather than a `stop_sequence`
of 1, because sequence numbers belong to whichever pattern a trip runs and route 4
publishes six patterns in one direction.

### What is deliberately not computed

When the inbound bus is nine minutes late, the outbound departure it becomes will
almost certainly leave late too. The board does not print that number. Both facts
are shown next to each other and the subtraction — which is one subtraction — is
left to a reader who can see where it came from. A predicted departure derived from
another trip's lateness is an invention with a plausible face, and nothing on this
board invents a value.

### Verified

Rendered at 412×915 against **real generated output** (`.local/test-webroot` from
`runtime/generate-api.php` over the committed shards), not the golden fixture,
because CLAUDE.md says so and because the fixture is route 4 only.

- All five stops resolve. Campbell/5th, Veterans/Atlanta and Republic Square are
  detected as turnarounds; Simond SB and 7th/Pleasant Valley are not.
- The inbound sentence names a real bus, a real leg and a real lateness on all
  three turnarounds: "Bus 2867 brings it in on the 10:14a WB — due here in 4
  minutes, running 35 seconds late."
- No horizontal overflow at 412px; no console errors.
- From a `file://` URL the cards say the schedule is fetched rather than bundled
  and that this view needs the board served — not "loading", which would be a lie
  with a spinner attached.
- The cancelled 10:13 northbound at Republic Square renders as CANCELED with no
  bus attributed to it, and does not displace a running departure from the three.

Not verified on real hardware.

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
