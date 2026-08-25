# Trip View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth view to the board that answers "I am on bus #2641 — where does it go from here, and when does it get there", listing every stop still ahead of a chosen bus with its scheduled time and an arrival time.

**Architecture:** Entirely client-side. Three new pure functions in `client/format.js` join two documents the app already fetches — `/api/route/{id}.json` for the live vehicle and `/api/departures/{id}.json` for the service day's scheduled stop times — and a new panel `client/trip.js` renders the result. No change to `runtime/`, `build/`, `schemas/`, or `docs/api-contract.md`.

**Tech Stack:** ES5-flavoured classic browser scripts on `window.CMB` (no build step, no modules — the board must open from a `file://` URL). vitest for unit tests, Playwright for e2e, PHP runtime only as the generator of test input.

**Spec:** `docs/designs/trip-view.md` — read it before starting. Every "why" in this plan is argued there.

## Global Constraints

- **No ES modules in `client/`.** Classic scripts attaching to `window.CMB`, loaded in dependency order from `client/index.html`. ES modules are blocked on `file://` and opening from disk is a requirement.
- **No new dependencies.** Not in `package.json`, not vendored, not a CDN link.
- **Times render in `America/Chicago`** via the existing `fmt.clock()` family, never the device timezone.
- **"Now" is `generated_at`.** The client never uses the device clock to judge freshness.
- **No inferred number may be indistinguishable from a published one.** Estimated times carry a `~` prefix and the word `estimated`.
- **Commit message style:** sentence-form imperative describing the change, no `feat:`/`fix:` prefixes, no AI credit, no `@` notation, no `#N`. Match the existing log, e.g. *"Nearest stop, and when the next bus reaches it"*.
- **Never make an existing test fail.** `npm test` must pass at the end of every task.
- **`build/lib/stop-names.mjs` and `runtime/lib/stopnames.php` are not touched by this work.**

---

### Task 1: `fmt.stopTimesForTrip` — the transpose

Recovers one trip's full ordered stop list from the stop-major departures document.

**Files:**
- Modify: `client/format.js` (add functions; extend the export object at `client/format.js:228-248`)
- Test: `tests/node/client-trip-format.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `fmt.stopTimesForTrip(dep, tripId)` → `Array<{stop_id: string, stop_name: string, scheduled_at: number, ordinal: number}>` ordered by `scheduled_at` ascending, or `null`.

- [ ] **Step 1: Write the failing test**

Create `tests/node/client-trip-format.test.mjs`:

```javascript
/**
 * fmt.stopTimesForTrip / stopsAheadOf / arrivalPlan — the trip view's whole join.
 *
 * Each case here is a measured fact from docs/designs/trip-view.md, not a
 * hypothetical. The corpus these numbers come from is the 2026-08-19 capture
 * across all 71 routes; tests/node/trip-corpus.test.mjs re-checks them against
 * real generated output.
 */
import { describe, expect, it } from 'vitest'
import { gateClient, loadClient } from './helpers/client.mjs'

const client = loadClient(['format.js'])
const t = gateClient(client, 'fmt', it)

/* A departures document shaped exactly like contract section 16. */
const DEP = {
  service_day_start_epoch: 1000000,
  stops: [
    { stop_id: 'A', stop_name: 'Alpha', direction_id: 0, stop_sequence: 1 },
    { stop_id: 'B', stop_name: 'Bravo', direction_id: 0, stop_sequence: 2 },
    { stop_id: 'C', stop_name: 'Charlie', direction_id: 0, stop_sequence: 3 },
    { stop_id: 'B', stop_name: 'Bravo NB', direction_id: 1, stop_sequence: 9 },
  ],
  trips: [
    { id: 'T1', direction_id: 0, headsign: 'one', start_time: '00:00:00' },
    { id: 'T2', direction_id: 1, headsign: 'two', start_time: '00:10:00' },
  ],
  departures: {
    A: [[0, 0]],
    B: [[60, 0], [600, 1]],
    C: [[120, 0]],
  },
}

describe('stopTimesForTrip', () => {
  t('returns the trip in arrival order with absolute scheduled times', (fmt) => {
    expect(fmt.stopTimesForTrip(DEP, 'T1')).toEqual([
      { stop_id: 'A', stop_name: 'Alpha', scheduled_at: 1000000, ordinal: 0 },
      { stop_id: 'B', stop_name: 'Bravo', scheduled_at: 1000060, ordinal: 1 },
      { stop_id: 'C', stop_name: 'Charlie', scheduled_at: 1000120, ordinal: 2 },
    ])
  })

  t('names a stop from the trip’s own direction, not the other one', (fmt) => {
    /* Stop B is published twice, once per direction, with different names.
       T2 runs direction 1, so it must read "Bravo NB". */
    expect(fmt.stopTimesForTrip(DEP, 'T2')[0].stop_name).toBe('Bravo NB')
  })

  t('orders by arrival time, never by stops[].stop_sequence', (fmt) => {
    /* On 2,221 of 4,112 trips the consensus sequence disagrees with arrival
       order. Here D carries a LOWER stop_sequence than E but is reached later,
       which is the shape of that disagreement. */
    const dep = {
      service_day_start_epoch: 0,
      stops: [
        { stop_id: 'D', stop_name: 'Delta', direction_id: 0, stop_sequence: 2 },
        { stop_id: 'E', stop_name: 'Echo', direction_id: 0, stop_sequence: 40 },
      ],
      trips: [{ id: 'S', direction_id: 0 }],
      departures: { D: [[900, 0]], E: [[300, 0]] },
    }
    expect(fmt.stopTimesForTrip(dep, 'S').map((s) => s.stop_id)).toEqual(['E', 'D'])
  })

  t('keeps both passes of a trip that visits one stop twice', (fmt) => {
    /* 234 trips in the corpus do this; 16 had a live bus on them. */
    const dep = {
      service_day_start_epoch: 0,
      stops: [{ stop_id: 'L', stop_name: 'Loop', direction_id: 0, stop_sequence: 1 }],
      trips: [{ id: 'S', direction_id: 0 }],
      departures: { L: [[100, 0], [500, 0]] },
    }
    const stops = fmt.stopTimesForTrip(dep, 'S')
    expect(stops).toHaveLength(2)
    expect(stops.map((s) => s.scheduled_at)).toEqual([100, 500])
    expect(stops.map((s) => s.ordinal)).toEqual([0, 1])
  })

  t('returns null when service_day_start_epoch is null', (fmt) => {
    /* Contract section 16: a client that sees null must not compute absolute
       times from this document. */
    expect(fmt.stopTimesForTrip({ ...DEP, service_day_start_epoch: null }, 'T1')).toBeNull()
  })

  t('returns null for a trip the document does not carry', (fmt) => {
    expect(fmt.stopTimesForTrip(DEP, 'nope')).toBeNull()
  })

  t('returns null rather than throwing on a missing document', (fmt) => {
    expect(fmt.stopTimesForTrip(null, 'T1')).toBeNull()
    expect(fmt.stopTimesForTrip({}, 'T1')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/node/client-trip-format.test.mjs`
Expected: FAIL — `fmt.stopTimesForTrip is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `client/format.js`, insert immediately after `predictionFor()` (which ends at `client/format.js:154`):

```javascript
  /*
   * ---- the trip view's join --------------------------------------------
   *
   * These three turn "which bus" into "which stops, when". They live here
   * rather than in trip.js for the reason predictionFor() and hasFix() do:
   * a rule with two copies drifts, and the first symptom is one screen
   * rendering one bus two ways. CLAUDE.md calls that ISSUE-002, and it has
   * already happened once in this repo.
   */

  /*
   * trip_id -> index into dep.trips, memoized for the document currently in
   * hand. One entry is enough: the trip view has one route open at a time,
   * and rebuilding the map for route 10's 127 trips costs nothing anyway.
   */
  var tripIndexDoc = null;
  var tripIndexMap = null;

  function tripIndexOf(dep, tripId) {
    if (tripIndexDoc !== dep) {
      tripIndexMap = Object.create(null);
      var trips = dep.trips || [];
      for (var i = 0; i < trips.length; i++) { tripIndexMap[trips[i].id] = i; }
      tripIndexDoc = dep;
    }
    var found = tripIndexMap[tripId];
    return found === undefined ? null : found;
  }

  /*
   * stop_id -> display name for one direction. A stop serving both directions
   * is published twice with a different name each time (section 16), so the
   * trip's own direction wins and the other is only a fallback for a stop the
   * pair does not cover.
   */
  function stopNamesFor(dep, directionId) {
    var out = Object.create(null);
    var stops = dep.stops || [];
    var i;
    for (i = 0; i < stops.length; i++) {
      if (!(stops[i].stop_id in out)) { out[stops[i].stop_id] = stops[i].stop_name; }
    }
    for (i = 0; i < stops.length; i++) {
      if (stops[i].direction_id === directionId) { out[stops[i].stop_id] = stops[i].stop_name; }
    }
    return out;
  }

  /*
   * One trip's whole ordered stop list, transposed out of the stop-major
   * departures document. Null when it cannot be built.
   *
   * ORDER COMES FROM arrival_seconds AND NOTHING ELSE. Not stops[].stop_sequence:
   * that is the sequence the greatest number of today's trips agree on, and it
   * disagrees with real arrival order on 2,221 of the corpus's 4,112 trips.
   * Section 16 says so in words ("never as a key"); that is the number.
   *
   * `ordinal` is the row's identity for rendering and for tests. stop_id cannot
   * be: 234 trips visit one stop twice, and a key that collides renders one pass
   * over the other.
   */
  function stopTimesForTrip(dep, tripId) {
    if (!dep || !dep.departures || !dep.trips) return null;
    if (dep.service_day_start_epoch === null || dep.service_day_start_epoch === undefined) return null;

    var index = tripIndexOf(dep, tripId);
    if (index === null) return null;

    var rows = [];
    var byStop = dep.departures;
    for (var stopId in byStop) {
      if (!Object.prototype.hasOwnProperty.call(byStop, stopId)) continue;
      var list = byStop[stopId] || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i][1] === index) {
          rows.push({ stop_id: String(stopId), arrival_seconds: list[i][0] });
        }
      }
    }
    if (!rows.length) return null;

    rows.sort(function (a, b) {
      if (a.arrival_seconds !== b.arrival_seconds) return a.arrival_seconds - b.arrival_seconds;
      return a.stop_id < b.stop_id ? -1 : a.stop_id > b.stop_id ? 1 : 0;
    });

    var names = stopNamesFor(dep, dep.trips[index].direction_id);
    return rows.map(function (r, i) {
      return {
        stop_id: r.stop_id,
        stop_name: names[r.stop_id] || r.stop_id,
        scheduled_at: dep.service_day_start_epoch + r.arrival_seconds,
        ordinal: i
      };
    });
  }
```

Then add to the export object, after `predictionFor: predictionFor` at `client/format.js:247` (add a comma to that line):

```javascript
    predictionFor: predictionFor,
    stopTimesForTrip: stopTimesForTrip
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/node/client-trip-format.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the whole node suite to confirm nothing regressed**

Run: `npm run test:node`
Expected: PASS. `format.js` is loaded by most client tests, so a syntax error here fails many files at once.

- [ ] **Step 6: Commit**

```bash
git add client/format.js tests/node/client-trip-format.test.mjs
git commit -m "Recover a trip's stop list from the stop-major departures document"
```

---

### Task 2: `fmt.stopsAheadOf` — the cut

Trims the trip to the stops still ahead of a given bus.

**Files:**
- Modify: `client/format.js` (add function; extend the export object)
- Test: `tests/node/client-trip-format.test.mjs` (extend)

**Interfaces:**
- Consumes: `fmt.stopTimesForTrip(dep, tripId)` from Task 1.
- Produces: `fmt.stopsAheadOf(stopTimes, vehicle)` → `{stops: Array<StopTime>, anchored: boolean}` or `null`. `StopTime` is Task 1's element shape, unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/node/client-trip-format.test.mjs`:

```javascript
const TRIP = [
  { stop_id: 'A', stop_name: 'Alpha', scheduled_at: 1000, ordinal: 0 },
  { stop_id: 'B', stop_name: 'Bravo', scheduled_at: 2000, ordinal: 1 },
  { stop_id: 'C', stop_name: 'Charlie', scheduled_at: 3000, ordinal: 2 },
]

const busAt = (stopId, scheduledAt) => ({
  in_service: true,
  trip: { trip_id: 'T1', schedule_relationship: 'SCHEDULED' },
  adherence: { state: 'late', seconds: 60, against: { stop_id: stopId, scheduled_at: scheduledAt } },
  predictions: [],
})

describe('stopsAheadOf', () => {
  t('cuts at the anchor and keeps it', (fmt) => {
    /* A bus STOPPED_AT your stop is still an arrival you can board, so the
       anchor stop itself stays in the list. */
    const out = fmt.stopsAheadOf(TRIP, busAt('B', 2000))
    expect(out.anchored).toBe(true)
    expect(out.stops.map((s) => s.stop_id)).toEqual(['B', 'C'])
  })

  t('cuts on stop_id AND scheduled_at, so a repeat stop cuts at the right pass', (fmt) => {
    /* Measured: all 249 live anchors match a departures row on both halves of
       this key, and one of them sits on a trip that visits its stop twice. */
    const loop = [
      { stop_id: 'L', stop_name: 'Loop', scheduled_at: 1000, ordinal: 0 },
      { stop_id: 'M', stop_name: 'Mid', scheduled_at: 2000, ordinal: 1 },
      { stop_id: 'L', stop_name: 'Loop', scheduled_at: 3000, ordinal: 2 },
    ]
    const out = fmt.stopsAheadOf(loop, busAt('L', 3000))
    expect(out.stops.map((s) => s.ordinal)).toEqual([2])
  })

  t('reports anchored false and keeps the whole trip when there is no anchor', (fmt) => {
    const noAnchor = { in_service: true, trip: { trip_id: 'T1' }, adherence: { state: 'unknown', seconds: null, against: null } }
    const out = fmt.stopsAheadOf(TRIP, noAnchor)
    expect(out.anchored).toBe(false)
    expect(out.stops).toHaveLength(3)
  })

  t('reports anchored false when the anchor is not in the trip', (fmt) => {
    const out = fmt.stopsAheadOf(TRIP, busAt('Z', 9999))
    expect(out.anchored).toBe(false)
    expect(out.stops).toHaveLength(3)
  })

  t('returns null when there is no trip to cut', (fmt) => {
    expect(fmt.stopsAheadOf(null, busAt('B', 2000))).toBeNull()
  })

  t('does not mutate the list it was given', (fmt) => {
    const before = JSON.stringify(TRIP)
    fmt.stopsAheadOf(TRIP, busAt('B', 2000))
    expect(JSON.stringify(TRIP)).toBe(before)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/node/client-trip-format.test.mjs`
Expected: FAIL — `fmt.stopsAheadOf is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `client/format.js`, immediately after `stopTimesForTrip`:

```javascript
  /*
   * The stops still ahead of one bus, cut from its own trip.
   *
   * The cut is adherence.against, which section 2 defines as the first stop at
   * or after progress.current_stop_sequence with a usable time. Reusing the
   * server's answer means there is one definition of "where the bus is" rather
   * than two that can disagree.
   *
   * It matches on stop_id AND scheduled_at. Both halves are load-bearing: 234
   * trips visit one stop twice and matching on the id alone would cut at the
   * first pass every time. Measured across the corpus, all 249 live anchors
   * matched a departures row on both halves exactly, and one of them was on a
   * repeat-stop trip.
   *
   * It never compares progress.current_stop_sequence against
   * stops[].stop_sequence. Those are different numbering schemes and disagree
   * on 2,221 of 4,112 trips.
   *
   * anchored:false means "we could not tell where this bus is". The caller
   * shows the whole trip and says so; it does not guess.
   */
  function stopsAheadOf(stopTimes, vehicle) {
    if (!stopTimes) return null;
    var against = vehicle && vehicle.adherence && vehicle.adherence.against;
    if (against) {
      for (var i = 0; i < stopTimes.length; i++) {
        if (stopTimes[i].stop_id === String(against.stop_id) &&
            stopTimes[i].scheduled_at === against.scheduled_at) {
          return { stops: stopTimes.slice(i), anchored: true };
        }
      }
    }
    return { stops: stopTimes.slice(), anchored: false };
  }
```

Extend the export object (add a comma to the `stopTimesForTrip` line):

```javascript
    stopTimesForTrip: stopTimesForTrip,
    stopsAheadOf: stopsAheadOf
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/node/client-trip-format.test.mjs`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add client/format.js tests/node/client-trip-format.test.mjs
git commit -m "Cut a trip at the bus, on both halves of the anchor key"
```

---

### Task 3: `fmt.arrivalPlan` — feed times, then the estimate

Attaches an arrival time and its provenance to each stop ahead.

**Files:**
- Modify: `client/format.js` (add function; extend the export object)
- Test: `tests/node/client-trip-format.test.mjs` (extend)

**Interfaces:**
- Consumes: `fmt.stopsAheadOf(...)` from Task 2.
- Produces: `fmt.arrivalPlan(stopsAhead, vehicle, staleness)` → `{reason: string|null, rows: Array<{stop_id, stop_name, scheduled_at, ordinal, predicted_at: number|null, source: 'feed'|'estimate'|null}>}`. `reason` is one of `'stale_data'`, `'trip_canceled'`, `'no_anchor'`, `'no_adherence'`, `'no_predictions'`, or `null` when times were produced.

- [ ] **Step 1: Write the failing test**

Append to `tests/node/client-trip-format.test.mjs`:

```javascript
const AHEAD = { anchored: true, stops: TRIP }

const bus = (over) => ({
  in_service: true,
  trip: { trip_id: 'T1', schedule_relationship: 'SCHEDULED' },
  adherence: { state: 'late', seconds: 60, against: { stop_id: 'A', scheduled_at: 1000 } },
  predictions: [],
  ...over,
})

describe('arrivalPlan', () => {
  t('uses the feed’s own time where the feed has one', (fmt) => {
    const plan = fmt.arrivalPlan(AHEAD, bus({ predictions: [[1, 'A', 1030], [2, 'B', 2090]] }), null)
    expect(plan.reason).toBeNull()
    expect(plan.rows.slice(0, 2).map((r) => [r.predicted_at, r.source]))
      .toEqual([[1030, 'feed'], [2090, 'feed']])
  })

  t('carries forward the deviation from the LAST feed row, not the anchor', (fmt) => {
    /* The anchor says +60. The feed's last row says +90 at B. C must be
       3000+90, not 3000+60. This is the whole point of the chosen rule: the
       two answers differ by more than a minute on 76.5% of estimated stops. */
    const plan = fmt.arrivalPlan(AHEAD, bus({ predictions: [[1, 'A', 1030], [2, 'B', 2090]] }), null)
    expect(plan.rows[2]).toMatchObject({ stop_id: 'C', predicted_at: 3090, source: 'estimate' })
  })

  t('falls back to the anchor deviation before any feed row is seen', (fmt) => {
    const plan = fmt.arrivalPlan(AHEAD, bus({ predictions: [[3, 'C', 3120]] }), null)
    expect(plan.rows.map((r) => [r.predicted_at, r.source])).toEqual([
      [1060, 'estimate'],
      [2060, 'estimate'],
      [3120, 'feed'],
    ])
  })

  t('distinguishes the two passes of a repeat stop', (fmt) => {
    const loop = {
      anchored: true,
      stops: [
        { stop_id: 'L', stop_name: 'Loop', scheduled_at: 1000, ordinal: 0 },
        { stop_id: 'M', stop_name: 'Mid', scheduled_at: 2000, ordinal: 1 },
        { stop_id: 'L', stop_name: 'Loop', scheduled_at: 3000, ordinal: 2 },
      ],
    }
    const v = bus({ predictions: [[1, 'L', 1010], [2, 'M', 2020], [3, 'L', 3030]] })
    expect(fmt.arrivalPlan(loop, v, null).rows.map((r) => r.predicted_at))
      .toEqual([1010, 2020, 3030])
  })

  t('does not stall when a prediction names a stop the trip does not list', (fmt) => {
    /* Measured 0/4,525 in the corpus, but a stalled cursor would silently drop
       every later feed row, which is a bad way to be wrong. */
    const v = bus({ predictions: [[9, 'ZZZ', 1234], [2, 'B', 2090]] })
    const plan = fmt.arrivalPlan(AHEAD, v, null)
    expect(plan.rows[1]).toMatchObject({ stop_id: 'B', predicted_at: 2090, source: 'feed' })
  })

  t('produces times that never go backwards', (fmt) => {
    const v = bus({ predictions: [[1, 'A', 1030], [2, 'B', 2090]] })
    const times = fmt.arrivalPlan(AHEAD, v, null).rows.map((r) => r.predicted_at)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
  })

  const noTimes = (plan, reason) => {
    expect(plan.reason).toBe(reason)
    expect(plan.rows).toHaveLength(3)
    expect(plan.rows.every((r) => r.predicted_at === null && r.source === null)).toBe(true)
    expect(plan.rows.map((r) => r.scheduled_at)).toEqual([1000, 2000, 3000])
  }

  t('publishes no arrival time at all when the feed is stale', (fmt) => {
    const v = bus({ predictions: [[1, 'A', 1030]] })
    noTimes(fmt.arrivalPlan(AHEAD, v, { suppress_adherence: true }), 'stale_data')
  })

  t('publishes no arrival time at all for a canceled trip', (fmt) => {
    const v = bus({ trip: { trip_id: 'T1', schedule_relationship: 'CANCELED' }, predictions: [[1, 'A', 1030]] })
    noTimes(fmt.arrivalPlan(AHEAD, v, null), 'trip_canceled')
  })

  t('publishes no arrival time at all when the bus could not be located', (fmt) => {
    noTimes(fmt.arrivalPlan({ anchored: false, stops: TRIP }, bus({}), null), 'no_anchor')
  })

  t('publishes no arrival time at all when there is no deviation to carry', (fmt) => {
    const v = bus({ adherence: { state: 'unknown', seconds: null, against: { stop_id: 'A', scheduled_at: 1000 } } })
    noTimes(fmt.arrivalPlan(AHEAD, v, null), 'no_adherence')
  })

  t('publishes no arrival time at all when the prediction list is empty', (fmt) => {
    /* Section 2: the list is empty, never absent, when the board cannot stand
       behind a time. An empty list is a statement, not a gap to fill in. */
    noTimes(fmt.arrivalPlan(AHEAD, bus({ predictions: [] }), null), 'no_predictions')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/node/client-trip-format.test.mjs`
Expected: FAIL — `fmt.arrivalPlan is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `client/format.js`, immediately after `stopsAheadOf`:

```javascript
  /*
   * An arrival time for each stop ahead, and where that time came from.
   *
   * Feed first: 77.5% of the stops ahead of a bus carry CapMetro's own
   * predicted arrival, and those are published unmodified.
   *
   * For the remaining 22.5%, the deviation implied at the LAST stop the feed
   * did predict is carried forward and held flat. The alternative — the
   * deviation at the bus's current anchor, which stopboard.js uses — is a
   * materially different answer, not a rounding of this one: the two disagree
   * by more than a minute on 76.5% of estimated stops and by up to 15 minutes.
   * Carrying forward inherits the feed's own modelling of dwell and recovery as
   * far as the feed goes; the anchor rule throws that modelling away.
   *
   * Neither rule has been measured against ground truth. No capture in this
   * repo records what actually happened later. The argument above is structural
   * and should not be written up as though it were measured.
   *
   * Predictions are consumed with a FORWARD-ONLY CURSOR, matched positionally,
   * never looked up by stop_id. That is what tells the two passes of a
   * repeat-stop trip apart. It is deliberately not a call to predictionFor(),
   * which matches on stop_id alone and returns the first pass for both.
   *
   * Output is monotonic by construction: the feed's rows are monotonic (0
   * backward steps across 4,276 adjacent pairs), and an estimate is an
   * ascending scheduled time plus a flat deviation. Nothing is clamped, and
   * nothing should be until a real backward step has been measured.
   */
  function arrivalPlan(stopsAhead, vehicle, staleness) {
    var stops = (stopsAhead && stopsAhead.stops) || [];
    var adherence = (vehicle && vehicle.adherence) || {};
    var predictions = (vehicle && vehicle.predictions) || [];
    var trip = (vehicle && vehicle.trip) || {};

    var reason =
      (staleness && staleness.suppress_adherence) ? 'stale_data'
        : trip.schedule_relationship === 'CANCELED' ? 'trip_canceled'
          : !stopsAhead || !stopsAhead.anchored ? 'no_anchor'
            : (adherence.seconds === null || adherence.seconds === undefined) ? 'no_adherence'
              : !predictions.length ? 'no_predictions'
                : null;

    if (reason) {
      return {
        reason: reason,
        rows: stops.map(function (s) {
          return {
            stop_id: s.stop_id, stop_name: s.stop_name, scheduled_at: s.scheduled_at,
            ordinal: s.ordinal, predicted_at: null, source: null
          };
        })
      };
    }

    var deviation = adherence.seconds;
    var cursor = 0;

    return {
      reason: null,
      rows: stops.map(function (s) {
        var hit = -1;
        for (var k = cursor; k < predictions.length; k++) {
          if (predictions[k] && String(predictions[k][1]) === s.stop_id) { hit = k; break; }
        }
        var predictedAt;
        var source;
        if (hit >= 0) {
          predictedAt = predictions[hit][2];
          deviation = predictedAt - s.scheduled_at;
          source = 'feed';
          cursor = hit + 1;
        } else {
          predictedAt = s.scheduled_at + deviation;
          source = 'estimate';
        }
        return {
          stop_id: s.stop_id, stop_name: s.stop_name, scheduled_at: s.scheduled_at,
          ordinal: s.ordinal, predicted_at: predictedAt, source: source
        };
      })
    };
  }
```

Extend the export object (add a comma to the `stopsAheadOf` line):

```javascript
    stopsAheadOf: stopsAheadOf,
    arrivalPlan: arrivalPlan
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/node/client-trip-format.test.mjs`
Expected: PASS, 24 tests.

- [ ] **Step 5: Run the whole node suite**

Run: `npm run test:node`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/format.js tests/node/client-trip-format.test.mjs
git commit -m "Prefer the agency's arrival time, then carry its own deviation forward"
```

---

### Task 4: A departures fixture, so the view opens from disk

Without this the trip view cannot render on `file://` at all, and opening from disk is a requirement of this project.

**Files:**
- Create: `tests/fixtures/golden/departures-4-20260819.json`
- Create: `client/data/departures-4-20260819.js` (generated — do not hand-write)
- Modify: `client/data/regenerate.js`
- Modify: `client/index.html:39` (add the script tag)
- Modify: `client/app.js:216-237` (`loadDepartures` gains the disk fallback `load()` already has)
- Test: `tests/node/fixture-invariants.test.mjs` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `window.CMB_FIXTURES_DEPARTURES['4']` — a departures document shaped per contract section 16. `app.js` gains `embeddedDepartures(routeId)` returning a deep copy or `null`.

- [ ] **Step 1: Generate the real departures document**

Run the runtime job against the committed fixtures, exactly as `tests/run-all.sh` does, then copy route 4's departures document into the golden fixtures. This is real generated output, not a hand-built file.

```bash
php runtime/generate-api.php \
  --config=runtime/config.fixture.php \
  --fixtures=tests/fixtures/feeds-20260819 \
  --out=.local/test-webroot \
  --now=1787152239 --quiet
cp .local/test-webroot/api/departures/4.json tests/fixtures/golden/departures-4-20260819.json
wc -c tests/fixtures/golden/departures-4-20260819.json
```

Expected: about 57,783 bytes. If the file is missing or the byte count is wildly different, stop — the generator did not run, and a hand-written substitute would verify nothing.

- [ ] **Step 2: Write the failing test**

Append to `tests/node/fixture-invariants.test.mjs`:

```javascript
describe('the bundled departures fixture', () => {
  it('is present, and is the route 4 document the runtime writes', () => {
    const dep = JSON.parse(
      readFileSync(path.join(ROOT, 'tests/fixtures/golden/departures-4-20260819.json'), 'utf8')
    )
    expect(dep.route_id).toBe('4')
    expect(dep.service_date).toBe('20260819')
    expect(typeof dep.service_day_start_epoch).toBe('number')
    expect(dep.trips.length).toBeGreaterThan(0)
    expect(Object.keys(dep.departures).length).toBeGreaterThan(0)
  })

  it('is bundled for file:// verbatim, with no second spelling', () => {
    /* The client copy exists because fetch() is blocked on file:// URLs. If the
       two ever differ, the board shows one thing from disk and another over
       HTTP, which is the failure mode this assertion exists to catch. */
    const src = readFileSync(path.join(ROOT, 'tests/fixtures/golden/departures-4-20260819.json'), 'utf8')
    const bundled = readFileSync(path.join(ROOT, 'client/data/departures-4-20260819.js'), 'utf8')
    expect(bundled).toContain(src.replace(/\s+$/, ''))
  })
})
```

If `readFileSync`, `path` or `ROOT` are not already imported in that file, add them to match the imports already at the top of it.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/node/fixture-invariants.test.mjs`
Expected: FAIL on the second test — `client/data/departures-4-20260819.js` does not exist.

- [ ] **Step 4: Teach `regenerate.js` about the second document kind**

In `client/data/regenerate.js`, replace the `SOURCES` constant and the loop with:

```javascript
const SOURCES = [
  {
    kind: 'route',
    global: 'CMB_FIXTURES',
    routeId: '4',
    file: 'tests/fixtures/golden/route-4-20260819.json',
    dest: 'route-4-20260819.js',
  },
  /*
   * The departures document is bundled too, because the trip view needs a
   * scheduled stop time for every stop and there is nowhere else on file:// to
   * get one. It is the real generated file, not a trimmed one: an approximation
   * cannot verify anything, and CLAUDE.md is explicit about that.
   */
  {
    kind: 'departures',
    global: 'CMB_FIXTURES_DEPARTURES',
    routeId: '4',
    file: 'tests/fixtures/golden/departures-4-20260819.json',
    dest: 'departures-4-20260819.js',
  },
]

const HEADER = [
  '/*',
  ' * Generated copy of %SRC%, verbatim.',
  ' * It exists because fetch() is blocked for file:// URLs, and the board must be',
  ' * openable straight from disk with no server. app.js prefers a real HTTP fetch',
  ' * whenever one is available and only falls back to this.',
  ' * Regenerate: node client/data/regenerate.js',
  ' */',
  'window.%GLOBAL% = window.%GLOBAL% || {};',
  'window.%GLOBAL%["%ID%"] =',
  ''
].join('\n');

for (const src of SOURCES) {
  const json = fs.readFileSync(path.join(REPO, src.file), 'utf8').replace(/\s+$/, '');
  const out = HEADER
    .replaceAll('%GLOBAL%', src.global)
    .replace('%SRC%', src.file)
    .replace('%ID%', src.routeId) + json + ';\n';
  const dest = path.join(DIR, src.dest);
  fs.writeFileSync(dest, out);
  console.log(`wrote ${path.relative(REPO, dest)} (${out.length} bytes)`);
}
```

Note the existing `HEADER` above it must be deleted — this block replaces both the old `SOURCES` and the old `HEADER`.

- [ ] **Step 5: Regenerate and verify the test passes**

```bash
node client/data/regenerate.js
npx vitest run tests/node/fixture-invariants.test.mjs
```

Expected: two files written; tests PASS.

- [ ] **Step 6: Load the bundle and wire the disk fallback**

In `client/index.html`, after line 39 (`<script src="data/route-4-20260819.js"></script>`):

```html
<script src="data/departures-4-20260819.js"></script>
```

In `client/app.js`, immediately after `embedded()` (which ends at `client/app.js:121`):

```javascript
  /*
   * The departures document from disk. Same reason as embedded(): a file://
   * board has nothing to fetch, and without a schedule the trip view has no
   * scheduled column and therefore no answer at all.
   */
  function embeddedDepartures(routeId) {
    var f = global.CMB_FIXTURES_DEPARTURES && global.CMB_FIXTURES_DEPARTURES[routeId];
    return f ? deepCopy(f) : null;
  }
```

Then in `loadDepartures` (`client/app.js:216`), replace the `.catch` at `client/app.js:233-236` with:

```javascript
      .catch(function () {
        /* From disk the fixture IS the answer, not a fallback after a timeout. */
        var disk = embeddedDepartures(routeId);
        if (disk) {
          state.departures[routeId] = disk;
          state.depStatus[routeId] = 'ok';
        } else {
          state.depStatus[routeId] = 'error';
        }
        render();
      });
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. The stop board also reads `state.departures`, so this change gives it a schedule on `file://` for the first time — confirm no existing e2e assertion depended on it being absent.

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/golden/departures-4-20260819.json client/data/departures-4-20260819.js \
        client/data/regenerate.js client/index.html client/app.js tests/node/fixture-invariants.test.mjs
git commit -m "Bundle route 4's schedule so the board still answers from disk"
```

---

### Task 5: `client/trip.js` — the panel

The picker and the stop list. States are Task 6; this task ships the happy path.

**Files:**
- Create: `client/trip.js`
- Modify: `client/index.html:46` (add the script tag after `stopboard.js`)
- Modify: `client/app.js:69` (state comment), `:361` (tab list), `:380` (`selectView`), `:421` (`onBoard`), `:653` (render dispatch); add `paintTrip()` next to `paintSaved()` at `client/app.js:776`
- Modify: `client/styles.css` (panel styles)
- Test: `tests/node/client-trip.test.mjs` (create)

**Interfaces:**
- Consumes: `fmt.stopTimesForTrip`, `fmt.stopsAheadOf`, `fmt.arrivalPlan` (Tasks 1-3); `S.el`, `S.clear`, `S.notice` from `client/states.js`; `fmt.directionsForRows`, `fmt.clock`, `fmt.clockSpoken`, `fmt.directionTag` from `client/format.js`.
- Produces: `window.CMB.trip.render(host, model, opts)` and `window.CMB.trip.buses(routeData)`.
  - `model` is `{route: <route doc|null>, dep: <departures doc|null>, vehicleId: <string|null>, now: <number>}`.
  - `opts` is `{picking: 'bus'|null, routes: <catalog array>, onPickRoute(), onPickBus(), onChooseBus(vehicleId)}`.
  - `buses(routeData)` → `[{id, label, direction_id, headsign, start_epoch, in_service, adherence_state}]` sorted by `direction_id` then `start_epoch`.

- [ ] **Step 1: Write the failing test**

Create `tests/node/client-trip.test.mjs`:

```javascript
/**
 * trip.js — the view anchored at a bus rather than at a stop or a route.
 *
 * This covers the model the panel builds. What it looks like on a 412px screen
 * is tests/e2e/trip.spec.mjs; this file is the logic underneath it.
 */
import { describe, expect, it } from 'vitest'
import { gateClient, renderClient, textDeep } from './helpers/client.mjs'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'watch.js', 'trip.js'])
const t = gateClient(client, 'trip', it)

const ROUTE = {
  schema: 1,
  generated_at: 5000,
  route: { id: '4', short_name: '4', long_name: '4-SHADY', directions: [{ id: 0, headsign: '4 Shady EB' }] },
  staleness: { level: 'fresh', suppress_adherence: false },
  vehicles: [
    {
      vehicle_id: '2641', label: '2641', route_id: '4', in_service: true,
      trip: { trip_id: 'T1', direction_id: 0, headsign: '4 Shady EB', start_epoch: 900, schedule_relationship: 'SCHEDULED' },
      progress: { current_stop_sequence: 1, current_stop_id: 'A', current_status: 'IN_TRANSIT_TO' },
      predictions: [[1, 'A', 1030]],
      adherence: { state: 'late', seconds: 30, glyph: 'up-triangle', against: { stop_id: 'A', stop_name: 'Alpha', scheduled_at: 1000 }, reason: null },
    },
    {
      vehicle_id: '2305', label: '2305', route_id: '4', in_service: false,
      adherence: { state: 'deadhead', seconds: null, glyph: 'ring', against: null, reason: null },
    },
  ],
}

const DEP = {
  service_day_start_epoch: 0,
  stops: [
    { stop_id: 'A', stop_name: 'Alpha', direction_id: 0, stop_sequence: 1 },
    { stop_id: 'B', stop_name: 'Bravo', direction_id: 0, stop_sequence: 2 },
  ],
  trips: [{ id: 'T1', direction_id: 0, headsign: '4 Shady EB' }],
  departures: { A: [[1000, 0]], B: [[2000, 0]] },
}

const host = () => client.cmb.states.el('div', 'host')

describe('the bus list the picker offers', () => {
  t('carries every vehicle, in service or not', (trip) => {
    expect(trip.buses(ROUTE).map((b) => b.id)).toEqual(['2641', '2305'])
  })

  t('marks the deadhead as unpickable rather than hiding it', (trip) => {
    /* rows.js sets this precedent deliberately: a board that hides a bus it was
       handed is worse than one showing a bus you cannot act on. */
    const deadhead = trip.buses(ROUTE).filter((b) => b.id === '2305')[0]
    expect(deadhead.in_service).toBe(false)
  })
})

describe('the stop list', () => {
  t('renders one row per stop ahead, with both times', (trip) => {
    const h = host()
    trip.render(h, { route: ROUTE, dep: DEP, vehicleId: '2641', now: 5000 }, { routes: [] })
    const text = textDeep(h)
    expect(text).toContain('Alpha')
    expect(text).toContain('Bravo')
  })

  t('marks an estimated time and leaves a feed time unmarked', (trip) => {
    const h = host()
    trip.render(h, { route: ROUTE, dep: DEP, vehicleId: '2641', now: 5000 }, { routes: [] })
    /* A has a feed prediction; B does not, so B is the estimated one. */
    expect(textDeep(h)).toContain('estimated')
  })

  t('says so, and shows no arrival time, when the feed is stale', (trip) => {
    const stale = { ...ROUTE, staleness: { level: 'stale', suppress_adherence: true } }
    const h = host()
    trip.render(h, { route: stale, dep: DEP, vehicleId: '2641', now: 5000 }, { routes: [] })
    const text = textDeep(h)
    expect(text).not.toMatch(/in \d+ min/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/node/client-trip.test.mjs`
Expected: SKIP with "client/trip.js does not exist yet" (the helper gates on missing files). Treat a skip here as the failing state.

- [ ] **Step 3: Write `client/trip.js`**

```javascript
/*
 * trip.js — "I am on this bus. Where does it go from here, and when?"
 *
 * Every other panel is anchored at a stop or at a route. This one is anchored
 * at a BUS, which is the transpose of stopboard.js: one bus and many stops,
 * where that panel is one stop and many buses.
 *
 * It invents nothing that format.js has not already named. The three functions
 * it leans on — stopTimesForTrip, stopsAheadOf, arrivalPlan — live there rather
 * than here so that a second panel asking the same question cannot answer it
 * differently. CLAUDE.md calls the alternative ISSUE-002.
 */
(function (global) {
  'use strict';

  var fmt = global.CMB.fmt;
  var adhLib = global.CMB.adherence;
  var S = global.CMB.states;
  var el = S.el;

  /* Every vehicle on the route, grouped for the picker. */
  function buses(routeData) {
    var vehicles = (routeData && routeData.vehicles) || [];
    return vehicles.map(function (v) {
      return {
        id: String(v.vehicle_id),
        label: v.label || String(v.vehicle_id),
        direction_id: v.trip ? v.trip.direction_id : null,
        headsign: v.trip ? v.trip.headsign : null,
        start_epoch: v.trip ? v.trip.start_epoch : null,
        in_service: !!v.in_service,
        adherence_state: v.adherence ? v.adherence.state : 'unknown'
      };
    }).sort(function (a, b) {
      if (a.in_service !== b.in_service) return a.in_service ? -1 : 1;
      var da = a.direction_id === null ? 99 : a.direction_id;
      var db = b.direction_id === null ? 99 : b.direction_id;
      if (da !== db) return da - db;
      return (a.start_epoch || 0) - (b.start_epoch || 0);
    });
  }

  function vehicleById(routeData, vehicleId) {
    var vehicles = (routeData && routeData.vehicles) || [];
    for (var i = 0; i < vehicles.length; i++) {
      if (String(vehicles[i].vehicle_id) === String(vehicleId)) return vehicles[i];
    }
    return null;
  }

  /*
   * A countdown, measured against generated_at. Never the device clock: every
   * other age on this board comes from the server, and a phone with a wrong
   * clock would otherwise be the only thing saying the bus is late.
   */
  function untilText(seconds) {
    if (seconds === null || seconds === undefined) return '';
    if (seconds < 30) return 'due';
    if (seconds < 90) return 'in 1 min';
    var m = Math.round(seconds / 60);
    if (m < 60) return 'in ' + m + ' min';
    var h = Math.floor(m / 60);
    var rem = m % 60;
    return 'in ' + h + 'h' + (rem ? ' ' + rem + 'm' : '');
  }

  function pickerRow(label, value, onClick) {
    var b = el('button', 'trip__pick');
    b.type = 'button';
    b.appendChild(el('span', 'trip__pick-label', label));
    b.appendChild(el('span', 'trip__pick-value', value || 'choose'));
    b.appendChild(el('span', 'trip__pick-caret', '▾'));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  /* One stop. Countdown leads; the two clock times sit under it. */
  function stopRow(row, now, showEstimate) {
    var li = el('li', 'tripstop' + (row.source === 'estimate' ? ' tripstop--est' : ''));

    var lead = el('span', 'tripstop__when',
      row.predicted_at === null ? '' : untilText(row.predicted_at - now));
    li.appendChild(lead);

    li.appendChild(el('span', 'tripstop__name', row.stop_name));

    var times = el('span', 'tripstop__times');
    times.appendChild(el('span', 'tripstop__sched', fmt.clock(row.scheduled_at)));
    if (row.predicted_at !== null) {
      times.appendChild(el('span', 'tripstop__arrow', '→'));
      times.appendChild(el('span', 'tripstop__pred',
        (row.source === 'estimate' ? '~' : '') + fmt.clock(row.predicted_at)));
      if (row.source === 'estimate' && showEstimate) {
        /* The divider says where the feed stopped, but a screen reader meets
           each row on its own, so the word travels with the row too. */
        times.appendChild(el('span', 'tripstop__tag', 'estimated'));
      }
    }
    li.appendChild(times);

    li.setAttribute('aria-label', row.stop_name + ', scheduled ' + fmt.clockSpoken(row.scheduled_at) +
      (row.predicted_at === null ? ', no arrival time available'
        : ', ' + (row.source === 'estimate' ? 'estimated ' : 'expected ') + fmt.clockSpoken(row.predicted_at)));
    return li;
  }

  /*
   * The open bus picker. Deadheads are listed and disabled rather than filtered
   * out: rows.js sets that precedent deliberately, because a board that hides a
   * bus it was handed is worse than one showing a bus you cannot act on.
   */
  function busList(routeData, opts) {
    var wrap = el('div', 'trip__buslist');
    var rows = buses(routeData);

    if (!rows.length) {
      wrap.appendChild(S.notice('empty', 'No buses on this route right now',
        'Nothing is reporting a position. Pick another route, or come back when service starts.'));
      return wrap;
    }

    var lastGroup = null;
    rows.forEach(function (b) {
      var group = b.in_service
        ? fmt.directionTag(b.headsign, b.direction_id)
        : 'Not in service';
      if (group !== lastGroup) {
        wrap.appendChild(el('h3', 'trip__busgroup', group));
        lastGroup = group;
      }
      var btn = el('button', 'trip__bus');
      btn.type = 'button';
      btn.disabled = !b.in_service;
      btn.appendChild(el('b', 'trip__bus-id', '#' + b.label));
      btn.appendChild(el('span', 'trip__bus-sign',
        b.in_service ? (b.headsign || 'in service') : 'no trip assigned'));
      if (b.start_epoch) {
        btn.appendChild(el('span', 'trip__bus-start', 'started ' + fmt.clock(b.start_epoch)));
      }
      btn.setAttribute('aria-label', 'Bus ' + b.label +
        (b.in_service ? ', ' + (b.headsign || 'in service') : ', not in service, cannot be followed'));
      if (b.in_service && opts.onChooseBus) {
        btn.addEventListener('click', function () { opts.onChooseBus(b.id); });
      }
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function render(host, model, opts) {
    S.clear(host);
    opts = opts || {};

    var route = model.route;
    var dep = model.dep;
    var now = model.now;

    var picker = el('div', 'trip__picker');
    picker.appendChild(pickerRow('Route',
      route && route.route ? (route.route.short_name || route.route.id) : null,
      opts.onPickRoute));

    var vehicle = vehicleById(route, model.vehicleId);
    picker.appendChild(pickerRow('Bus',
      vehicle ? '#' + (vehicle.label || vehicle.vehicle_id) +
        (vehicle.trip ? ' · ' + vehicle.trip.headsign : '') : null,
      opts.onPickBus));
    host.appendChild(picker);

    if (opts.picking === 'bus') {
      host.appendChild(busList(route, opts));
      return;
    }

    if (!vehicle) {
      host.appendChild(S.notice('empty', 'Pick a bus',
        'Choose a route and a bus to see every stop still ahead of it, when it is ' +
        'scheduled there, and when it should actually arrive.'));
      return;
    }

    var view = adhLib.view(vehicle, route.staleness);
    var head = el('div', 'trip__head');
    head.appendChild(el('b', 'trip__id', '#' + (vehicle.label || vehicle.vehicle_id)));
    head.appendChild(el('span', 'trip__sign',
      vehicle.trip ? vehicle.trip.headsign : 'not in service'));
    head.appendChild(el('span', 'trip__state', view.label));
    host.appendChild(head);

    if (!vehicle.trip) {
      host.appendChild(S.notice('empty', 'This bus has no trip assigned',
        'It is deadheading — running without passengers, with no scheduled stops to list.'));
      return;
    }
    if (!dep) {
      host.appendChild(S.skeletonRows(6));
      return;
    }

    var stopTimes = fmt.stopTimesForTrip(dep, vehicle.trip.trip_id);
    if (!stopTimes) {
      /*
       * Two different causes, and they get two different sentences. A null
       * service_day_start_epoch means section 16 forbids computing absolute
       * times from this document at all; a missing trip means the schedule
       * simply does not know this run. Telling a reader the wrong one sends
       * them looking in the wrong place.
       */
      if (dep.service_day_start_epoch === null || dep.service_day_start_epoch === undefined) {
        host.appendChild(S.notice('empty', 'The schedule cannot be read today',
          'The departure board did not resolve a service date, so no scheduled time in it ' +
          'can be placed on the clock. Nothing here would be trustworthy.'));
      } else {
        host.appendChild(S.notice('empty', 'No schedule for this trip',
          'Today’s departure board does not carry trip ' + vehicle.trip.trip_id +
          ', so there are no scheduled times to show against it.'));
      }
      return;
    }

    var ahead = fmt.stopsAheadOf(stopTimes, vehicle);
    var plan = fmt.arrivalPlan(ahead, vehicle, route.staleness);

    var count = el('p', 'trip__count', plan.reason && !ahead.anchored
      ? fmt.plural(plan.rows.length, 'scheduled stop', 'scheduled stops') + ' on this trip'
      : fmt.plural(plan.rows.length, 'stop', 'stops') + ' ahead');
    host.appendChild(count);

    if (plan.reason) { host.appendChild(reasonNotice(plan.reason, vehicle)); }

    var list = el('ol', 'tripstops');
    var dividerDrawn = false;
    plan.rows.forEach(function (row, i) {
      if (!dividerDrawn && row.source === 'estimate' && i > 0 && plan.rows[i - 1].source === 'feed') {
        list.appendChild(el('li', 'tripstops__divider', 'CapMetro’s times end here'));
        dividerDrawn = true;
      }
      var li = stopRow(row, now, true);
      if (i === plan.rows.length - 1) li.appendChild(el('span', 'tripstop__end', '(end)'));
      list.appendChild(li);
    });
    host.appendChild(list);

    var next = vehicle.block && vehicle.block.next_trip;
    if (next) {
      var foot = el('p', 'trip__next',
        'Then becomes ' + (next.route_short_name ? next.route_short_name + ' ' : '') +
        (next.headsign || 'its next trip') + ', ' + fmt.clock(next.start_epoch) +
        ' from ' + (next.start_stop_name || 'its next start'));
      if (vehicle.block.confidence !== 'high') {
        /* Section 4: continuation is verified on route 4 only. Saying it plainly
           beats a footnote nobody opens. */
        foot.appendChild(el('span', 'trip__next-caveat',
          ' — block continuation is unverified on this route'));
      }
      host.appendChild(foot);
    }
  }

  function reasonNotice(reason, vehicle) {
    if (reason === 'stale_data') {
      return S.notice('stale', 'No arrival times right now',
        'The realtime feed is too old to stand behind an arrival time, so only the ' +
        'scheduled times are shown.');
    }
    if (reason === 'trip_canceled') {
      return S.notice('empty', 'CapMetro has canceled this trip',
        'No bus is running it today. The scheduled times below are what it would have been.');
    }
    if (reason === 'no_anchor') {
      return S.notice('empty', 'Cannot tell where this bus is',
        'The feed does not say which stop it is approaching, so the whole trip is listed ' +
        'and no arrival time is offered.');
    }
    if (reason === 'no_adherence') {
      return S.notice('empty', 'No lateness measured for this bus',
        'Without it there is nothing to project from, so only the scheduled times are shown.');
    }
    return S.notice('empty', 'CapMetro is not predicting this trip',
      'It publishes no arrival times for this bus, so only the scheduled times are shown.');
  }

  global.CMB = global.CMB || {};
  global.CMB.trip = {
    render: render,
    buses: buses,
    untilText: untilText
  };
})(window);
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/node/client-trip.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the shell**

`client/index.html` — after line 46 (`<script src="stopboard.js"></script>`):

```html
<script src="trip.js"></script>
```

`client/app.js:69` — widen the comment:

```javascript
    view: 'board',       /* board | all | trip | saved | saved-edit */
```

`client/app.js:69` block — add to `state`, next to `openBuses`:

```javascript
    tripBusId: null,     /* the vehicle the trip view is following, this session only */
    tripPicking: null,   /* null | 'bus' — is the bus list open */
    tripLastSeen: null,  /* {vehicle, at} — the followed bus's last appearance */
```

`client/app.js:358-362` — add the tab between `all` and `saved`:

```javascript
      { id: 'board', label: 'Route' },
      { id: 'all', label: 'All buses' },
      { id: 'trip', label: 'Trip' },
      { id: 'saved', label: 'Saved' }
```

`client/app.js:380` — in `selectView`, before `render()`:

```javascript
    if (id === 'trip') { loadDepartures(state.routeId); }
```

`client/app.js:653` — add the dispatch line after the `saved-edit` one:

```javascript
    if (state.view === 'trip') { paintTrip(); return; }
```

`client/app.js:776` — add beside `paintSaved()`:

```javascript
  /*
   * The trip view. It needs both documents: the live one for the bus and the
   * schedule for the stops. loadDepartures is idempotent and is called from
   * selectView, not from here — a render that starts a fetch is a render that
   * can trigger another render.
   */
  function paintTrip() {
    var band = el('section', 'band band--trip');
    dom.main.appendChild(band);
    global.CMB.trip.render(band, {
      route: state.data,
      dep: state.departures[state.routeId] || null,
      vehicleId: state.tripBusId,
      now: (state.data && state.data.generated_at) || null
    }, {
      routes: catalog(),
      picking: state.tripPicking,
      onPickRoute: function () { state.pickerOpen = !state.pickerOpen; render(); },
      onPickBus: function () {
        state.tripPicking = state.tripPicking === 'bus' ? null : 'bus';
        render();
      },
      onChooseBus: function (id) {
        state.tripBusId = id;
        state.tripPicking = null;
        state.tripLastSeen = null;   /* a new bus starts with no history */
        render();
      }
    });
  }
```

`client/app.js:421` — the route chip and direction toggle are both hidden whenever the view is
not the board, so `onPickRoute` would open a picker nobody can see. The trip view is
route-scoped and needs the chip; it has no direction filter and must not get one. Split the
single flag in two:

```javascript
    /*
     * The route chip means something on any route-scoped view — the board and
     * the trip view both answer questions about one route. The direction toggle
     * belongs to the board alone: the trip view is already scoped to one bus,
     * and a filter that changes nothing on screen reads as the app being broken.
     */
    var routeScoped = state.view === 'board' || state.view === 'trip';
    dom.routechip.hidden = !routeScoped;
    dom.dirgroup.hidden = state.view !== 'board';
    if (!routeScoped) { dom.picker.hidden = true; }
```

Check the lines immediately after `client/app.js:421` for other uses of `onBoard` and route them
to whichever of the two flags matches their meaning.

- [ ] **Step 6: Add the styles**

In `client/styles.css`, following the conventions already in the file (tokens from `tokens.css`, 44px minimum targets, no horizontal overflow at 412px), add rules for: `.trip__picker`, `.trip__pick`, `.trip__buslist`, `.trip__busgroup`, `.trip__bus`, `.trip__bus-id`, `.trip__bus-sign`, `.trip__bus-start`, `.trip__head`, `.trip__count`, `.tripstops`, `.tripstop`, `.tripstop--est`, `.tripstop__when`, `.tripstop__name`, `.tripstop__times`, `.tripstops__divider`, `.trip__end`, `.trip__next`, `.trip--gone`.

Requirements, not suggestions:
- `.trip__pick` must be at least 44px tall.
- `.tripstop__when` is a fixed-width column so the countdowns form one vertical strip, matching how `rows.js` aligns its badges.
- `.tripstop--est` must be distinguishable in **grayscale** — the project screenshots and desaturates to check this. Use weight or opacity, not hue alone.
- `.tripstops__divider` reads as a rule with a label, not as a stop.
- `.trip__bus[disabled]` must look unavailable without looking like an error — a deadhead is
  normal, not a fault.
- `.trip--gone` dims the whole list. It must stay readable: the point is that the last answer
  survives, not that it is hidden.

- [ ] **Step 7: Look at it**

Run: `npm run test:e2e:server` in one shell, then open `http://localhost:<port>/client/index.html?view=trip` (the port is printed by the server). Confirm the picker appears, a bus can be chosen, and the stop list renders with a divider.

Also open `client/index.html` directly from disk and confirm the same, which is what Task 4 exists for.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add client/trip.js client/index.html client/app.js client/styles.css tests/node/client-trip.test.mjs
git commit -m "A view anchored at a bus, and the stops it still has ahead"
```

---

### Task 6: States, the harness, and the URL

Every row of the spec's state table, forced from the URL, because a state table that cannot be looked at does not get verified.

**Files:**
- Modify: `client/trip.js` (the vanished-bus state)
- Modify: `client/app.js` (query handling for `view`, `bus`; `?state=` scenarios)
- Modify: `client/states.js` (`STATE_SCENARIOS` entries)
- Modify: `client/NOTES.md` (the harness table)
- Test: `tests/node/client-trip.test.mjs` (extend)

**Interfaces:**
- Consumes: `window.CMB.trip.render` (Task 5).
- Produces: `model.lastSeen` — an optional `{vehicle, at}` on the trip model. When `vehicleId` names a bus absent from `model.route.vehicles` and `lastSeen.vehicle` is that bus, the panel renders the previous list dimmed rather than clearing.

- [ ] **Step 1: Write the failing test**

Append to `tests/node/client-trip.test.mjs`:

```javascript
describe('when the followed bus leaves the feed', () => {
  t('keeps the last list on screen and says when it was last seen', (trip) => {
    /* A bus vanishes for several ordinary reasons — the trip ended, it went out
       of service, the feed dropped it for one poll — and all of them happen
       while someone is reading the screen. Clearing the answer at the moment it
       is being used, with no trace of what it said, is the failure here. */
    const gone = { ...ROUTE, vehicles: [] }
    const h = host()
    trip.render(h, {
      route: gone, dep: DEP, vehicleId: '2641', now: 5000,
      lastSeen: { vehicle: ROUTE.vehicles[0], at: 4000 },
    }, { routes: [] })
    const text = textDeep(h)
    expect(text).toMatch(/no longer in the feed/i)
    expect(text).toContain('Alpha')
  })

  t('offers the picker rather than a dead end', (trip) => {
    const gone = { ...ROUTE, vehicles: [] }
    const h = host()
    trip.render(h, {
      route: gone, dep: DEP, vehicleId: '2641', now: 5000,
      lastSeen: { vehicle: ROUTE.vehicles[0], at: 4000 },
    }, { routes: [] })
    expect(textDeep(h)).toMatch(/Bus/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/node/client-trip.test.mjs`
Expected: FAIL — the panel renders the "Pick a bus" empty state instead of the dimmed list.

- [ ] **Step 3: Implement the vanished state**

In `client/trip.js` `render()`, replace the `if (!vehicle)` block with:

```javascript
    /*
     * A bus that has left the feed keeps its answer on screen, dimmed, with a
     * last-seen time. The list is being read at the moment the bus disappears —
     * a trip ending, a vehicle going out of service, one dropped poll all look
     * the same from here — and taking the answer away leaves no trace of what
     * it said. Dimmed-and-labelled says what is known and what is no longer.
     */
    var stale = null;
    if (!vehicle && model.lastSeen && model.lastSeen.vehicle &&
        String(model.lastSeen.vehicle.vehicle_id) === String(model.vehicleId)) {
      vehicle = model.lastSeen.vehicle;
      stale = model.lastSeen.at;
      host.classList.add('trip--gone');
    }

    if (!vehicle) {
      host.appendChild(S.notice('empty', 'Pick a bus',
        'Choose a route and a bus to see every stop still ahead of it, when it is ' +
        'scheduled there, and when it should actually arrive.'));
      return;
    }

    if (stale !== null) {
      host.appendChild(S.notice('stale', 'This bus is no longer in the feed',
        'Last seen at ' + fmt.clock(stale) + '. The stops below are what it said then, ' +
        'not what is happening now. Pick another bus to start again.'));
    }
```

Ensure `host.classList` exists — if `S.el` returns a node without `classList` under the test stub, set a class string instead: `host.className += ' trip--gone';`.

- [ ] **Step 4: Track the last-seen bus in `app.js`**

`state.tripLastSeen` was already declared in Task 5. In `paintTrip()`, before calling `render`, refresh it:

```javascript
    var live = null;
    ((state.data && state.data.vehicles) || []).forEach(function (v) {
      if (String(v.vehicle_id) === String(state.tripBusId)) live = v;
    });
    if (live && state.data) {
      state.tripLastSeen = { vehicle: deepCopy(live), at: state.data.generated_at };
    }
```

and pass `lastSeen: state.tripLastSeen` in the model.

- [ ] **Step 5: Add the URL parameters**

`?view=` already works — `client/app.js:910` reads `q.view || recall('view')`. Only the bus is new.

In `boot()`, beside that line, add:

```javascript
  /*
   * The bus is a URL parameter but NOT a stored preference, and that asymmetry
   * with `view` and `route` is deliberate. A vehicle id means a different trip
   * an hour later, so recalling one would show the wrong bus with nothing on
   * screen saying it had changed.
   */
  if (q.bus) { state.tripBusId = String(q.bus); }
```

Do **not** add `store('bus', ...)` anywhere.

- [ ] **Step 6: Add the harness scenarios**

In `client/states.js` `STATE_SCENARIOS`, add entries that exercise the trip view's rows. Each mutates the fixture payload the same way the existing scenarios do:

```javascript
    'trip-gone': {
      note: 'TRIP VIEW — the followed bus has left the feed',
      apply: function (d) { d.vehicles = []; return d; }
    },
    'trip-no-anchor': {
      note: 'TRIP VIEW — the feed does not say where the bus is',
      apply: function (d) {
        d.vehicles.forEach(function (v) {
          if (!v.in_service) return;
          v.adherence = { state: 'unknown', seconds: null, glyph: 'question',
                          against: null, reason: 'no_progress' };
        });
        return d;
      }
    },
    'trip-canceled': {
      note: 'TRIP VIEW — CapMetro has canceled this trip',
      apply: function (d) {
        d.vehicles.forEach(function (v) {
          if (v.trip) v.trip.schedule_relationship = 'CANCELED';
          v.predictions = [];
        });
        return d;
      }
    },
```

The existing `?state=stale`, `?state=dead`, `?state=loading`, `?state=error` and `?state=empty` scenarios already cover the remaining rows once the trip view is reachable with `?view=trip`.

- [ ] **Step 7: Document the harness**

In `client/NOTES.md`, add to the state-harness table:

```markdown
| `?view=trip` | The trip view; add `&bus=2641` to follow a specific bus |
| `?view=trip&state=trip-gone` | The followed bus has left the feed — dimmed list, last-seen time |
| `?view=trip&state=trip-no-anchor` | No anchor: whole trip listed, no arrival times |
| `?view=trip&state=trip-canceled` | Canceled trip: scheduled times only |
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/node/client-trip.test.mjs && npm run test:node`
Expected: PASS.

- [ ] **Step 9: Look at every new state**

With the e2e server running, open each of the four URLs above and confirm each renders the state it names, with no arrival time visible on the last three.

- [ ] **Step 10: Commit**

```bash
git add client/trip.js client/app.js client/states.js client/NOTES.md tests/node/client-trip.test.mjs
git commit -m "Keep the answer on screen when the bus leaves the feed"
```

---

### Task 7: The corpus check

The route-4 fixture is not a pass. `CLAUDE.md` requires this, and the 2026-08-19 QA history is why.

**Files:**
- Create: `tests/node/trip-corpus.test.mjs`

**Interfaces:**
- Consumes: `fmt.stopTimesForTrip`, `fmt.stopsAheadOf`, `fmt.arrivalPlan` (Tasks 1-3); `readGenerated`, `requireGenerated`, `routeFiles`, `API` from `tests/node/helpers/webroot.mjs`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `tests/node/trip-corpus.test.mjs`:

```javascript
/**
 * The trip view's join over the WHOLE generated corpus, not the fixture.
 *
 * CLAUDE.md records why this file exists: the golden fixture is route 4, the
 * smallest of the six watched routes, and both bugs a previous QA pass found
 * came from route 7 and the full 2,348-stop corpus while a fixture-only run
 * reported clean. Route 4 has 3 timepoints and 5 buses; route 300 has 608
 * prediction rows and route 10 has 8,825 departures.
 *
 * These bind to a webroot the runtime job wrote, and skip with a reason when
 * there is none. tests/run-all.sh generates one before it starts.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { gateClient, loadClient } from './helpers/client.mjs'
import { API, readGenerated, requireGenerated, routeFiles } from './helpers/webroot.mjs'

const client = loadClient(['format.js'])
const t = (name, fn) =>
  it(name, (ctx) => {
    requireGenerated(ctx)
    if (!client.cmb?.fmt) ctx.skip(client.reason ?? 'window.CMB.fmt is not defined')
    return fn(client.cmb.fmt)
  })

/* Every (route doc, departures doc) pair the webroot carries. */
function eachRoute(fn) {
  const files = routeFiles()
  expect(files.length, 'no route files in the generated webroot').toBeGreaterThan(0)
  for (const f of files) {
    const route = readGenerated(f)
    const depPath = path.join(API, 'departures', `${route.route.id}.json`)
    if (!existsSync(depPath)) continue
    fn(route, readGenerated(depPath), path.basename(f))
  }
}

/* Every in-service bus with a trip, across every route. */
function eachBus(fn) {
  eachRoute((route, dep, name) => {
    for (const v of route.vehicles || []) {
      if (!v.in_service || !v.trip) continue
      fn(v, route, dep, `${name} #${v.vehicle_id}`)
    }
  })
}

describe('the trip join across every generated route', () => {
  t('resolves a stop list for every in-service bus', (fmt) => {
    let checked = 0
    eachBus((v, route, dep, where) => {
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      expect(stops, `${where}: trip ${v.trip.trip_id} not in its departures document`).not.toBeNull()
      expect(stops.length, where).toBeGreaterThan(0)
      checked++
    })
    expect(checked, 'no in-service buses found').toBeGreaterThan(0)
  })

  t('orders every stop list by scheduled time', (fmt) => {
    eachBus((v, route, dep, where) => {
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      for (let i = 1; i < stops.length; i++) {
        expect(stops[i].scheduled_at, `${where} at ordinal ${i}`)
          .toBeGreaterThanOrEqual(stops[i - 1].scheduled_at)
      }
    })
  })

  t('cuts at the anchor for every bus that has one', (fmt) => {
    /* Measured 249/249 on the 2026-08-19 capture. A drop here means the anchor
       and the departures document have stopped agreeing on a scheduled time,
       which would silently turn every trip into an unanchored one. */
    let anchored = 0
    let total = 0
    eachBus((v, route, dep) => {
      if (!v.adherence?.against) return
      total++
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      if (fmt.stopsAheadOf(stops, v).anchored) anchored++
    })
    expect(total).toBeGreaterThan(0)
    expect(anchored, `only ${anchored} of ${total} anchors matched a departures row`).toBe(total)
  })

  t('joins every prediction row positionally, losing none', (fmt) => {
    eachBus((v, route, dep, where) => {
      if (!v.predictions?.length) return
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      const plan = fmt.arrivalPlan(fmt.stopsAheadOf(stops, v), v, route.staleness)
      if (plan.reason) return
      const fromFeed = plan.rows.filter((r) => r.source === 'feed').length
      const inWindow = v.predictions.filter((p) =>
        plan.rows.some((r) => r.stop_id === String(p[1]))).length
      expect(fromFeed, `${where}: feed rows lost between predictions and the plan`).toBe(inWindow)
    })
  })

  t('never produces an arrival time that goes backwards', (fmt) => {
    eachBus((v, route, dep, where) => {
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      const plan = fmt.arrivalPlan(fmt.stopsAheadOf(stops, v), v, route.staleness)
      if (plan.reason) return
      for (let i = 1; i < plan.rows.length; i++) {
        expect(plan.rows[i].predicted_at, `${where} at ordinal ${i}`)
          .toBeGreaterThanOrEqual(plan.rows[i - 1].predicted_at)
      }
    })
  })

  t('produces an arrival time for every stop, or none at all', (fmt) => {
    /* Half a list of times is the worst outcome: a reader cannot tell which
       rows are answers and which are gaps. */
    eachBus((v, route, dep, where) => {
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      const plan = fmt.arrivalPlan(fmt.stopsAheadOf(stops, v), v, route.staleness)
      const withTime = plan.rows.filter((r) => r.predicted_at !== null).length
      expect(withTime === 0 || withTime === plan.rows.length, where).toBe(true)
    })
  })

  t('publishes no arrival time anywhere when adherence is suppressed', (fmt) => {
    eachBus((v, route, dep, where) => {
      if (!route.staleness?.suppress_adherence) return
      const stops = fmt.stopTimesForTrip(dep, v.trip.trip_id)
      const plan = fmt.arrivalPlan(fmt.stopsAheadOf(stops, v), v, route.staleness)
      expect(plan.rows.every((r) => r.predicted_at === null), where).toBe(true)
    })
  })
})
```

- [ ] **Step 2: Generate a webroot and run it**

```bash
php runtime/generate-api.php --config=runtime/config.fixture.php \
  --fixtures=tests/fixtures/feeds-20260819 --out=.local/test-webroot \
  --now=1787152239 --quiet
CAPMETRO_WEBROOT=.local/test-webroot npx vitest run tests/node/trip-corpus.test.mjs
```

Expected: PASS, 7 tests, none skipped. **A skip here is a failure of this task** — `tests/run-all.sh` has a comment explaining that a skip which reads as a pass is worse than a failure, and this is exactly that situation.

- [ ] **Step 3: Confirm it binds automatically through `npm test`**

Run: `npm test`
Expected: the run-all script generates the webroot itself and these 7 tests run rather than skip.

- [ ] **Step 4: Commit**

```bash
git add tests/node/trip-corpus.test.mjs
git commit -m "Check the trip join against all 71 routes, not route 4"
```

---

### Task 8: End-to-end, docs, and the full pass

**Files:**
- Create: `tests/e2e/trip.spec.mjs`
- Modify: `client/NOTES.md` (a section on the view, as the other panels have)
- Modify: `CHANGELOG.md`
- Modify: `VERSION`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the e2e spec**

Create `tests/e2e/trip.spec.mjs`, following the structure of `tests/e2e/near.spec.mjs` (read it first for the server fixture and the 412px viewport setup):

```javascript
/**
 * The trip view at 412px, against the bundled fixture.
 *
 * The unit tests cover the join. This covers what a person actually meets: the
 * picker, the divider, the countdown column, and the states where the board
 * must refuse to show a time.
 */
import { expect, test } from '@playwright/test'

test.describe('trip view', () => {
  test('picks a bus and lists the stops ahead of it', async ({ page }) => {
    await page.goto('/client/index.html?view=trip&route=4')
    await expect(page.locator('.trip__picker')).toBeVisible()
    await page.locator('.trip__pick').nth(1).click()
    await page.locator('.trip__buslist button').first().click()
    await expect(page.locator('.tripstop')).not.toHaveCount(0)
    await expect(page.locator('.tripstop__sched').first()).toBeVisible()
  })

  test('draws the feed/estimate divider exactly once', async ({ page }) => {
    await page.goto('/client/index.html?view=trip&route=4&bus=2641')
    const dividers = page.locator('.tripstops__divider')
    expect(await dividers.count()).toBeLessThanOrEqual(1)
  })

  test('shows no arrival time when the feed is stale', async ({ page }) => {
    await page.goto('/client/index.html?view=trip&route=4&bus=2641&state=stale')
    await expect(page.locator('.tripstop__pred')).toHaveCount(0)
    await expect(page.getByText(/no arrival times right now/i)).toBeVisible()
  })

  test('keeps the list when the bus leaves the feed', async ({ page }) => {
    await page.goto('/client/index.html?view=trip&route=4&bus=2641&state=trip-gone')
    await expect(page.getByText(/no longer in the feed/i)).toBeVisible()
  })

  test('does not overflow horizontally at 412px', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 })
    await page.goto('/client/index.html?view=trip&route=4&bus=2641')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    )
    expect(overflow).toBe(false)
  })

  test('every target is at least 44px', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 })
    await page.goto('/client/index.html?view=trip&route=4&bus=2641')
    for (const b of await page.locator('.band--trip button').all()) {
      const box = await b.boundingBox()
      if (box) expect(box.height).toBeGreaterThanOrEqual(44)
    }
  })
})
```

The selectors `.trip__buslist` and the bus-picker markup are introduced by Task 5's step 6 (`onPickBus`). If the class names in the implementation differ, fix the test to match the implementation — do not add markup solely to satisfy a selector.

- [ ] **Step 2: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS. Fix real failures; do not weaken an assertion to get a green run.

- [ ] **Step 3: Grayscale check**

Screenshot the view and desaturate it, as the project already does for `?state=all-states`:

```bash
npx playwright screenshot --viewport-size=412,915 \
  "http://localhost:<port>/client/index.html?view=trip&route=4&bus=2641" \
  .local/trip-view.png
```

Confirm by eye that estimated rows remain distinguishable from feed rows with no color. If they do not, fix `.tripstop--est` in `client/styles.css` and re-check.

- [ ] **Step 4: Write the panel's section in `client/NOTES.md`**

Add a section in the same voice as the existing "Nearest stop" one, covering: what question the view answers; that ordering comes from `arrival_seconds` and why (the 2,221-trip finding); that predictions are consumed positionally and why (`predictionFor`'s repeat-stop bug, which this view avoids and `near.js`/`stopboard.js` still have); the carry-forward rule and the explicit statement that it is unmeasured against ground truth; and the decision to keep the dimmed list when a bus vanishes.

- [ ] **Step 5: Update `CHANGELOG.md` and `VERSION`**

Add an entry in the style of the existing ones — prose explaining what changed and why, not a bare bullet list. Bump `VERSION` from `0.4.0` to `0.5.0`: this is a new user-facing view, not a fix.

- [ ] **Step 6: Full suite, all four**

Run: `npm test`
Expected: schema PASS, vitest PASS, phpunit PASS, playwright PASS. No suite skipped for a reason this work introduced.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/trip.spec.mjs client/NOTES.md CHANGELOG.md VERSION
git commit -m "Cover the trip view end to end, and write down what it assumes"
```

---

## Deployment

Per `CLAUDE.md`, this project merges to `trunk` and then updates the box:

```bash
ssh <host> 'sudo /srv/capmetro/src/deploy/update.sh'
curl -sf https://bus.dillo.dev/api/health.json | grep -q '"ok":true'
```

Nothing in this work changes `runtime/`, so the generator's next firing is unaffected and there is no window where the board is down. The client is static files under the webroot and takes effect on the next page load.

The spec's stated purpose is a production verdict, so after deploying, the questions worth carrying back are: does the countdown column read at a glance; is the single divider enough signal that a time is estimated; and is a 50-stop list (p90) usable or does it need the timepoint collapse that was rejected in design.
