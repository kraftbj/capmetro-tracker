# Design: Trip View — "follow this bus"

Written 2026-08-25
Branch: trunk
Status: APPROVED
Supersedes nothing. Additive to `capmetro-dispatch-board.md`.

## Problem Statement

Every panel on the board today answers a question anchored at a **stop** or at a **route**:

- `rows.js` / `ladder.js` / `map.js` — what is this route doing?
- `near.js` — which bus is coming to the stop I am standing at?
- `stopboard.js` — what is coming to this stop next?
- `watch.js` — is my saved departure on time?

Nothing answers the question anchored at a **bus**: *I am on, or waiting for, vehicle #2641 —
where does it go from here, and when does it get there?*

That question comes up when a rider is already aboard and wants to know when to get off,
when a parent is tracking a kid mid-trip, and when a departure has been picked and the
interesting part is the rest of the run rather than the boarding.

This view is the transpose of the stop board: **one bus, many stops**, where the stop board is
one stop, many buses.

## Stated constraint from the owner

> "i'll have to use it in production to see what needs to be different at this point"

This is a **v1 to be judged in production**, on `bus.dillo.dev`, by using it. That constraint
is load-bearing on the approach chosen below: it favours the option that can ship without a
contract amendment, a schema change or a coordinated deploy, because the fastest path to a
real verdict is the one where the client changes alone.

It does **not** license shipping something unverified. The corpus check in the Test Strategy
below still runs against real generated output before this lands, per `CLAUDE.md`.

## Requirements

Settled with the owner before design, each an explicit choice among alternatives:

1. **Entry point** — a fourth tab with its own route + bus picker, reachable without going
   through the route board first. (Alternatives rejected: expanding an existing bus row;
   pushing a full screen from a row.)
2. **Extent** — every stop still ahead of the bus, minor stops included, ending where the trip
   ends. A footer line names what the bus becomes next. (Rejected: whole trip with passed stops
   dimmed; timepoints-only with expansion; continuing into the next block trip.)
3. **Estimate rule** — feed ETA where CapMetro publishes one; past that, carry forward the
   deviation implied at the **last stop the feed did predict** and hold it flat. (Rejected:
   `scheduled + adherence.seconds`, the anchor deviation `stopboard.js` uses; moving the
   computation server-side.)
4. **Emphasis** — rider-facing. Countdown leads, clock times follow. (Rejected: dispatcher
   framing with per-stop deviation columns; a combined dense row.)
5. **Assembly** — client-side, from the two documents other panels already fetch. (Rejected: a
   new `/api/trip/{trip_id}.json` endpoint.)

## Verified Data Facts

Measured against **real generated output** — `.local/test-webroot`, the 2026-08-19 capture,
all 71 routes — not against `tests/fixtures/golden/route-4-20260819.json`. `CLAUDE.md` requires
this: the golden fixture is route 4 only, and both bugs `/qa` found on 2026-08-19 came from
route 7 and the full corpus while a fixture-only pass reported clean.

| Fact | Measured |
|---|---|
| Trips recoverable by transposing `departures` on `trip_index` | 4,112 |
| In-service vehicles whose `trip_id` is absent from its route's departures doc | **0 / 249** |
| Prediction rows whose `stop_id` is absent from that trip's stop list | **0 / 4,525** |
| In-service vehicles with a usable `adherence.against` anchor | **249 / 249** |
| Anchors matching a departures row on **both** `stop_id` and `scheduled_at` | **249 / 249** |
| Live anchors whose stop appears more than once in its own trip | **1** |
| Stops ahead of a bus carrying a CapMetro ETA | **4,526 / 5,842 (77.5%)** |
| Stops ahead needing the estimate | 1,316 (22.5%) |
| Stops ahead per bus | p50 **19**, p90 **50**, max **93** |
| Trips visiting one stop twice | **234**, of which **16** had a live bus |
| Trips where arrival order disagrees with `stops[].stop_sequence` | **2,221 / 4,112** |
| Adjacent prediction pairs going backwards in time | **0 / 4,276** |
| Carry-forward rule vs. anchor-deviation rule, on estimated stops | differs >60s on **76.5%**, >120s on **58.9%**, max **908s** |
| Widest departures document (route 10) | 144,785 B; parse 0.5 ms, full transpose + sort 3.2 ms |
| Route 4 departures document | 57,783 B |

### The three facts that changed the design

**Ordering must come from `arrival_seconds`.** On 2,221 of 4,112 trips the consensus
`stops[].stop_sequence` disagrees with actual arrival order. §16 of the contract already says
that field is "published for ordering and for display beside a stop, never as a key"; this is
that sentence with a number attached. Any ordering or cut derived from it — including comparing
it against `progress.current_stop_sequence` — is wrong on more than half the corpus.

**Stops repeat within a trip.** 234 trips visit the same `stop_id` twice, 16 of them under a
live bus at capture time. Every join in this view is therefore positional, not by `stop_id`.

**Carry-forward is a materially different answer from the anchor rule**, not a refinement of
it: the two disagree by more than a minute on three quarters of estimated stops and by up to
fifteen minutes. Picking between them was a real decision, not a tidy-up.

### What was NOT measured, and must not be claimed

**That carry-forward is more accurate.** No capture in this repo records what actually happened
later, so there is no ground truth to score either rule against. What is measured is that the
two rules *differ*. The argument for carry-forward is structural rather than empirical: it
inherits the feed's own modelling of dwell and recovery as far as the feed goes, and only then
holds flat, whereas the anchor rule discards that modelling for every stop including the ones
CapMetro predicted directly.

`client/NOTES.md` already records the closest thing to evidence: for the anchor rule, the
extrapolation and the feed disagree by more than a minute on 64% of comparable pairs and by up
to 53 minutes. That is a reason to prefer the feed wherever it exists, which both rules do; it
is not a measurement of the two fallbacks against reality.

Anyone extending this should treat scoring the two rules against a later capture as open work.

## Approach

**Client-side assembly from documents already fetched.** No runtime change, no schema change,
no contract amendment, no deploy coupling.

Two sources, both already used by other panels:

- `/api/route/{route_id}.json` — live, refetched every 60s. Supplies the vehicle, its
  `trip.trip_id`, its `predictions`, its `adherence`, its `block.next_trip`, its `staleness`.
- `/api/departures/{route_id}.json` — static for the service day, fetched once per route per
  session by `app.js` `loadDepartures()`. Supplies every stop of every active trip with a
  scheduled time.

The transpose costs 3.2 ms on route 10, the widest of the 71, and this view needs only one
trip, so a filtered single pass is cheaper still.

### Rejected: a per-trip endpoint

`/api/trip/{trip_id}.json` with the join pre-computed would keep contract §0's "the client
makes no inference" literally true. It was rejected because it is ~4,100 files per service day,
a contract amendment, a new schema, and a deploy the view would have to wait on — against a
stated constraint that the fastest route to a production verdict wins.

**The escape hatch is recorded rather than taken.** Move the join server-side if any of these
becomes true:

- the transpose measures over ~50 ms on real phone hardware;
- a third panel needs the same join, making the client the second copy of a rule (the
  `ISSUE-002` failure mode `CLAUDE.md` names explicitly);
- the estimate rule comes to need data the client cannot see.

### On "the client makes no inference"

The contract's preamble states it in bold, and this view does infer: 22.5% of its rows are computed, not
published. That rule has already been softened once, deliberately and with measurements, in
`stopboard.js`, which falls back to `scheduled + lateness` for the 5,337 of 9,865 departures
that predictions do not cover. This view extends the same precedent rather than setting one.

What the rule is actually protecting is that **an inferred number must never be indistinguishable
from a published one**. That is preserved here: computed times are prefixed `~`, they sit below
a divider that says where CapMetro's times stopped, and the suppression rules below refuse to
compute anything at all when the board cannot stand behind it.

## Architecture

### New file

`client/trip.js` — the view. Loaded after `watch.js`, before `app.js`, in `index.html`.
Classic script on `window.CMB`, matching every other panel; ES modules are blocked on `file://`
and opening from disk is a requirement.

### New functions in `client/format.js`

They live in `format.js`, not in `trip.js`, because `format.js` is already the home of
`predictionFor()` and `hasFix()` for exactly this reason: a rule with two copies drifts, and
the first symptom is one screen rendering one bus two ways. `CLAUDE.md` names this as
`ISSUE-002`, which has already happened once in this repo.

#### `fmt.stopTimesForTrip(dep, tripId)`

Returns the full ordered stop list of one trip, or `null`.

1. Resolve `trip_index` by scanning `dep.trips` for `id === tripId`. Memoize the id → index map
   per departures document; it is built once per route per session.
2. One pass over `dep.departures`, collecting `{ stop_id, arrival_seconds }` for rows whose
   `trip_index` matches.
3. Sort by `arrival_seconds` ascending, ties broken by `stop_id`, so two runs order identically.
4. Attach `stop_name` from `dep.stops`, matched on `(stop_id, direction_id)` using the trip's
   own `direction_id`, falling back to any row with that `stop_id`.
5. Emit `{ stop_id, stop_name, scheduled_at, ordinal }` where
   `scheduled_at = dep.service_day_start_epoch + arrival_seconds` and `ordinal` is the 0-based
   position within the trip.

`ordinal` is the row's identity for rendering and for tests. `stop_id` cannot be, because it is
not unique within a trip on the 234 trips that visit one stop twice, and a DOM key that collides
renders one of the two passes over the other.

Returns `null` when `dep.service_day_start_epoch` is `null`. §16 is explicit that a client
seeing `null` must not compute absolute times from that document.

#### `fmt.stopsAheadOf(stopTimes, vehicle)`

Cuts the list to the stops still ahead of the bus.

The cut is at `vehicle.adherence.against`, matched on **both** `stop_id` and `scheduled_at`, so
a trip that visits a stop twice cuts at the correct pass. The anchor is §2's own "first stop at
or after `current_stop_sequence`", so this reuses the server's definition of where the bus is
rather than inventing a second one. It resolved for 249 of 249 in-service vehicles in the capture, and matched a departures row on
**both** halves of that key every time — the scheduled time is not a defensive extra, it is
exact. One of those 249 anchors sits on a trip that visits its stop twice, so the time half is
doing real work in this capture rather than guarding a hypothetical.

It does **not** compare `progress.current_stop_sequence` against `stops[].stop_sequence`. Those
are different numbering schemes and disagree on 2,221 of 4,112 trips.

Returns the whole list uncut, flagged, when there is no anchor — see States.

#### `fmt.arrivalPlan(stopsAhead, vehicle, staleness)`

Walks the trip's stops and `vehicle.predictions` as **two ordered cursors**, carrying a running
deviation `dev`, initialised from `vehicle.adherence.seconds`:

- For each stop, if the next unconsumed prediction row's `stop_id` matches, consume it:
  `predicted_at` is the feed's, `source` is `'feed'`, and `dev` is **reset** to
  `predicted_at − scheduled_at`.
- Otherwise `predicted_at = scheduled_at + dev` and `source` is `'estimate'`.

Consuming in order rather than looking up by `stop_id` is what distinguishes the two passes of
a repeat stop. This is deliberately **not** a call to `fmt.predictionFor()` — see Known Issues.

Output is monotonic by construction: the feed's own rows are monotonic (0 backward steps across 4,276
adjacent pairs, all 249 vehicles), and an estimated row is `scheduled + dev` over ascending
scheduled times with `dev` held flat. No clamping is applied, and none should be added without
first measuring a real backward step.

**It returns scheduled times only, with `predicted_at` null throughout, when:**

- `staleness.suppress_adherence` is true;
- `trip.schedule_relationship` is `CANCELED`;
- there is no anchor, or `adherence.seconds` is null;
- `predictions` is empty.

This mirrors §2's own rule that the server publishes an empty `predictions` list rather than a
countdown it cannot stand behind, and `near.js`'s note that a countdown is the number a rider
acts on fastest, so a stale one is the most damaging thing on the screen.

## Interface

```
┌──────────────────────────────────────┐
│ Route │ All buses │ Trip │ Saved     │
└──────────────────────────────────────┘

  Route  [ 4  ·  5 in service  ▾ ]
  Bus    [ #2641  4 Shady EB  ▾ ]

  #2641 · 4 Shady EB · running 3 min late

    in 2 min    Campbell/5th
                10:23a → 10:26a
    in 5 min    Veterans/Atlanta
                10:26a → 10:29a
    ── CapMetro's times end here ────────
    in 10 min   8th/Congress
                10:31a → ~10:33a  estimated
    in 31 min   Pleasant Valley/5th   (end)
                10:52a → ~10:54a  estimated

    → then becomes 4 Mopac WB, 11:04a
```

### Picker

Routes from `routes.json`, already fetched on first paint, each row carrying its
`vehicles.in_service` count. The four routes where `has_service_today` is false are shown and
labelled, never hidden — §15 makes that point directly, and a picker that can say "the 492 does
not run today" beats one where the 492 is simply missing.

Buses from the route document, grouped by direction via `fmt.directionsForRows` — the shared
list, so a bus cannot appear here in a group the rows have no column for — and sorted by
`trip.start_epoch` within each group.

Deadheads are listed in their own group, unselectable, reading "no trip assigned". `rows.js`
sets this precedent deliberately: a board that hides a bus it was handed is worse than one that
shows a bus you cannot act on.

### Rows

- **Countdown leads**, computed against `generated_at`. Never the device clock — the client
  never uses the device clock to judge freshness, and every other age on the board comes from
  the server.
- Scheduled and predicted clock times on the second line, in `America/Chicago`, because the
  question is always what time it is on the route.
- `~` prefixes an estimated time.
- **One divider** where the feed's times run out, rather than a badge on every row. The feed/
  estimate split is a single boundary in a sorted list, so it is a horizontal rule, not a
  property repeated 50 times down the page. Every estimated row also carries the word
  `estimated`, so the distinction survives being read out of context by a screen reader.
- The last row is marked `(end)`.
- Footer from `block.next_trip` when present, carrying §4's confidence caveat on every route
  other than 4, where block continuation is the only one verified.

Scroll is expected and accepted: p50 19 stops ahead, p90 50, max 93. At the 412px target this
is a long page, and that is the honest shape of the answer.

## Interaction states

Every row gets a `?state=` harness entry, per the `client/NOTES.md` convention that a state
table which cannot be looked at does not get verified.

| State | Screen |
|---|---|
| No bus picked | The picker, and a sentence saying what the view answers |
| Loading | Skeleton rows |
| Route has no service today | Named, from `has_service_today`; picker stays open |
| No buses in service on the route | Says so; offers the route's next departure if published |
| Departures document not yet fetched | Skeleton; `loadDepartures` is idempotent and already running |
| `service_day_start_epoch` is null | No times at all, with the reason. §16 forbids computing them |
| Stale (`suppress_adherence`) | Scheduled column only, banner explains |
| Trip `CANCELED` | Scheduled column only, stated plainly: no bus is running this trip |
| No anchor / empty predictions | Full scheduled trip, no cut, no estimates, reason named |
| **Followed bus leaves the feed** | List stays, dimmed, "no longer in the feed, last seen 10:34a", re-pick offered |
| Schema mismatch | The app already refuses to render; unchanged |

The dimmed-and-kept behaviour is deliberate. A bus vanishes for several ordinary reasons — the
trip ended, it went out of service, the feed dropped it for a poll — and all of them happen
while someone is reading the screen. Clearing the list would take the answer away at the moment
it is being used and leave no trace of what it said. Keeping it dimmed with a last-seen time
says what is known and what is no longer known.

## Persistence and URL

- `?view=trip&route=7&bus=2641` for deep links and the harness.
- Route persists in `localStorage`; it already does.
- **The bus does not persist.** A vehicle id means a different trip an hour later, so restoring
  it would silently show the wrong bus with no signal that anything had changed.

## Fixture work

`client/data/` bundles only route 4's **route** document. There is no departures document, so
on `file://` this view has no schedule and cannot render at all. Opening from disk is a
requirement of this project, not a convenience.

Therefore:

- add route 4's departures document to `tests/fixtures/golden/`;
- extend `client/data/regenerate.js` to bundle it alongside the route file, under a
  `window.CMB_FIXTURES` key that distinguishes the two document kinds;
- teach `app.js`'s departures loader the same disk fallback the route loader already has.

It is 57,783 B, and it is the real generated file rather than a trimmed one. A trimmed fixture
is an approximation, and `CLAUDE.md` is explicit that an approximation cannot verify anything.

## Test Strategy

**Unit (vitest)** on the three `format.js` functions, with named cases for each measured fact:

- a trip visiting one stop twice — both passes distinguished, cut landing on the correct one;
- a trip whose arrival order disagrees with `stops[].stop_sequence`;
- `service_day_start_epoch` null → `null` return, no computed times;
- each suppression path → scheduled times only;
- the feed → estimate boundary: `dev` reset on the last feed row and held flat after it;
- an empty `predictions` list under a live anchor.

**E2E (playwright)** at 412px against the fixture: picker, row rendering, the divider, the
vanished-bus state, no horizontal overflow.

**Corpus check over real generated output**, all 71 routes, not the golden fixture. Asserts:
every in-service vehicle's trip resolves in its departures document; every prediction row joins
positionally; every produced list is ordered and monotonic; no list is empty for a bus with a
live anchor. `CLAUDE.md` requires this and the 2026-08-19 QA history is the reason.

## Known issues recorded, not fixed here

**`fmt.predictionFor()` returns the wrong occurrence on a repeat-stop trip.** It matches on
`stop_id` alone, so on the 234 trips that visit a stop twice it returns the first pass for both.
`near.js` and `stopboard.js` both call it. This view does not use it — `arrivalPlan` consumes
predictions positionally instead — so the bug is neither introduced nor inherited here, but it
is real in those two panels and should be fixed on its own terms rather than folded into this
work.

## Not in scope

- Continuation into the next block trip. §4 grades `block.confidence` as `low` on every route
  but 4, so some continuations would be confidently wrong.
- Map integration.
- Saving a trip from this view.
- Passed-stop history.
- Any change to `stopboard.js` or `near.js`.
- Any change to `runtime/`, `schemas/`, `build/`, or `docs/api-contract.md`.

## Success Criteria

1. Picking any in-service bus on any of the 71 routes renders its remaining stops with a
   scheduled time for each.
2. Stops CapMetro predicts show the agency's own time, unmodified.
3. Stops it does not predict show a time marked `~`, below a divider naming the boundary.
4. No time of any kind renders under suppression, cancellation, or a missing anchor.
5. Repeat-stop trips render both passes at their own times.
6. The view opens from `file://` against the bundled fixture.
7. No horizontal overflow at 412px; every target ≥ 44px.
8. The corpus check passes over all 71 routes of real generated output.
9. `npm test` passes.

## Open work

- Score carry-forward against the anchor rule using a later capture as ground truth. Neither
  rule has been measured for accuracy, only for disagreement.
- Measure the transpose on real phone hardware against the ~50 ms escape-hatch threshold.
- Fix `fmt.predictionFor()`'s repeat-stop bug in `near.js` and `stopboard.js`.
