/*
 * chain.js — transfer chains. "800 to the 4", "337 to the 350", "337 to the 7 to
 * the 837", each shown as ONE thing rather than as two or three separate boards.
 *
 * THE QUESTION THIS ANSWERS
 *
 * A saved trip (watch.js) answers "when is her bus". A chain answers the question
 * that actually gets asked when a journey has a change in it: "is she going to
 * make the connection". Those are not the same question and the second one cannot
 * be read off two copies of the first. Two route boards side by side mean doing
 * the arithmetic yourself — subtract this arrival from that departure, remember
 * which bus is four minutes down — at the exact moment nobody wants to do
 * arithmetic. So the subtraction happens here, once, and the card leads with the
 * answer.
 *
 * WHY A TRANSFER IS A PAIR OF STOPS, NOT ONE STOP
 *
 * The obvious implementation is to intersect the two routes' stop ids and call
 * the shared ones transfer points. On this feed that silently fails for the exact
 * example the feature was asked for: route 800 and route 4 share ZERO stop ids.
 * They meet at Pleasant Valley, where 800's MetroRapid station `1369` and route
 * 4's local stop `938` are twenty-seven metres apart and are simply two different
 * stops in the extract. An intersection would have reported "these routes do not
 * connect" about a connection two of this household's children make daily.
 *
 * So a transfer is an ALIGHTING stop on one leg and a BOARDING stop on the next,
 * within a short walk of each other, and the walk is charged against the slack
 * rather than assumed free. Same-stop transfers are the zero-metre case of that
 * rule, not a separate one.
 *
 * WHY THE CONNECTION LIST IS BUILT FROM REAL DEPARTURES
 *
 * The editor never offers a connection that does not exist. It walks the actual
 * downstream stops of the actual trip the reader picked, finds the actual
 * departures of the onward route, and offers what is left. The same reasoning
 * watch.js gives for picking a time from a list rather than typing one: a chain
 * assembled from plausible-looking times would be permanently broken, and the
 * reader would have no way to tell that from a bus running late.
 *
 * WHAT IS SHARED WITH watch.js AND WHY
 *
 * Departure matching, the service-day clock and the trip-to-vehicle join are the
 * same rules here as there, so they are USED from watch.js rather than copied.
 * CLAUDE.md is explicit after ISSUE-002 about what two implementations of one
 * rule cost: they drift, and the first symptom is one screen disagreeing with
 * itself. A chain that matched a departure by a different rule than a saved trip
 * would eventually name a different bus for the same time.
 */
(function (global) {
  'use strict';

  var fmt = global.CMB.fmt;
  var adhLib = global.CMB.adherence;
  var S = global.CMB.states;
  var el = S.el;

  /*
   * Loaded after watch.js, and useless without it. Failing here with a legible
   * message beats every downstream call failing on `undefined` one at a time.
   */
  var watchLib = global.CMB.watch;
  if (!watchLib) throw new Error('chain.js requires watch.js to be loaded first');

  /*
   * The step-based editor's presentation, used from watch.js rather than copied.
   * Both editors speak the same visual language — numbered steps that collapse to
   * their answer — so two copies would eventually number or label them differently
   * on one screen, which is the ISSUE-002 failure this file's header describes and
   * which it was already avoiding for departure matching.
   */
  var step = watchLib.step;
  var cleanName = watchLib.cleanName;
  var routeLabel = watchLib.routeLabel;
  var dirLabel = watchLib.dirLabel;
  var stopName = watchLib.stopName;

  var STORE_KEY = 'cmb.chains';

  /* ---- the numbers that decide whether a connection is offered ---------- */

  /*
   * How far a transfer may walk, as the crow flies.
   *
   * The three connections this household actually makes land under 100 m, and the
   * widest one anybody has pointed at — 7th/Calles across to the MetroRapid
   * platform — is 215 m. Those numbers do NOT on their own justify 300: measured
   * over the whole feed, a 300 m radius offers 2,086 connections across the six
   * watched routes, and 650 of them are wider than 215 m. That is the majority of
   * the extra reach, not a rounding.
   *
   * It is still 300, deliberately, and the defence is the cost model rather than
   * the radius. A hard 215 m cap would be fitted to three examples nobody checked
   * against the other sixty-five routes, and it would silently drop genuine
   * transfers the same way an id intersection dropped 800-to-4. Instead the wide
   * ones are OFFERED but PRICED: with WALK_CIRCUITY below, a 300 m hop is charged
   * 350 seconds — near six minutes — so it only survives against a departure with
   * real slack behind it, and the reader sees the metres on the row before they
   * pick it.
   *
   * Beyond 300 m the pairs stop being transfers and start being coincidences of
   * geography, and a picker full of coincidences is a picker nobody reads.
   */
  var WALK_RADIUS_M = 300;

  /*
   * Walking pace, metres per second. 1.2 is slow on purpose. The riders here are
   * children with backpacks crossing Pleasant Valley, not a fit adult on an empty
   * concourse, and every second this underestimates is a second of slack the card
   * promises and the pavement does not deliver.
   */
  var WALK_SPEED_MS = 1.2;

  /*
   * Straight-line metres are not walked metres.
   *
   * metres() returns a great-circle distance, and the spherical approximation in it
   * is accurate to centimetres at this range — but the straight line between two
   * stops is not a path anyone can walk. Pleasant Valley, the junction this whole
   * feature was built for, is a divided arterial: the two stops are 27 m apart and
   * the walk between them crosses six lanes at a signal.
   *
   * 1.4 is the standard circuity factor for a street grid and it is the honest
   * multiplier on a rectilinear detour (a two-leg right-angle walk is √2 ≈ 1.41 of
   * the diagonal). It does not model a signal cycle; the slow pace above absorbs
   * some of that.
   *
   * Charged as a separate factor rather than folded into WALK_SPEED_MS because they
   * are different claims — one about the rider, one about the street — and a single
   * blended number would leave neither checkable. Both errors ran the same way:
   * making a connection look easier than it is.
   */
  var WALK_CIRCUITY = 1.4;

  /*
   * The least slack a connection may be built with. Below two minutes it is not a
   * connection, it is a coin toss, and offering it in the editor would make the
   * board complicit in a missed bus.
   */
  var MIN_SLACK_S = 120;

  /*
   * The most a connection may wait, measured from stepping off the first bus to
   * the second one leaving — walking time included, because the walk is part of
   * the time a child is out of a seat and not part of a discount against it.
   *
   * Forty-five minutes is generous, deliberately: on the suburban half of this
   * network the real 337-to-350 connection waits twenty-one minutes and a tighter
   * cap would have called it impossible. Past this it is not a connection either,
   * it is two trips that happen to share a kerb.
   */
  var MAX_WAIT_S = 2700;

  /*
   * Live slack below this reads as "tight" rather than "fine". It is the same two
   * minutes MIN_SLACK_S uses, because the threshold for offering a connection and
   * the threshold for trusting one are the same judgement.
   */
  var TIGHT_S = 120;

  /*
   * Three legs, because "337 to the 7 to the 837" is the longest journey anyone
   * in this household actually makes and a fourth leg has never been asked for.
   * The cap is here rather than implied by the UI so that a hand-edited store
   * cannot produce a card the layout was never designed for.
   */
  var MAX_LEGS = 3;

  /*
   * The window, same reasoning as a saved trip: before it a chain is a plan, inside
   * it a chain is news. Measured from the FIRST leg's departure.
   *
   * These deliberately do NOT reuse watch.js's constants even though the values
   * currently match. There they are measured from one departure; here BEFORE_S is
   * measured from the first leg and AFTER_S from the last, so a chain's window is
   * as long as the journey. Aliasing them would tie two spans that answer different
   * questions to one number and make a future change to either silently move both.
   * Departure matching IS shared, because that is one rule; this is two.
   */
  var BEFORE_S = 3600;

  /* Measured from the LAST leg's BOARDING — see the note in resolve() on why a
   * chain is over once the final bus has been caught. */
  var AFTER_S = 900;

  /*
   * Extra time a chain stays on screen when the last leg could not be graded.
   *
   * `end_at` retires a card by asserting the final bus has been boarded, and the
   * prediction it normally uses IS that assertion. Where the leg is ungraded there
   * is no prediction: `predicted_board_at` falls back to the timetable, which reads
   * exactly like a bus running on time, and the card retired to "Gone. Back
   * tomorrow" on the strength of a number this same file declined to trust one
   * screen earlier. A bus last seen ten minutes down had not left.
   *
   * So an ungraded chain stands down on the clock instead, and the window is the
   * one the feed itself defines: `stale` begins at 600 s of feed age (contract
   * section 1), so a suppressed feed is by definition at least ten minutes behind
   * what it describes and the bus may be at least that much further along than
   * anything visible. The errors are not symmetric — retiring late leaves a card up
   * a few minutes too long, retiring early tells a parent a bus has gone while it
   * is still at the kerb — so the hold is deliberately the whole window rather than
   * a fraction of it.
   */
  var UNGRADED_HOLD_S = 600;

  /* ---- storage --------------------------------------------------------- */

  function readStore() {
    try {
      var raw = global.localStorage.getItem(STORE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Object.prototype.toString.call(parsed) === '[object Array]' ? parsed : [];
    } catch (e) {
      /* Private mode, disabled storage, or a corrupted value. An unreadable store
       * is an empty one; it must never take the board down with it. */
      return [];
    }
  }

  function writeStore(rows) {
    try {
      global.localStorage.setItem(STORE_KEY, JSON.stringify(rows));
      return true;
    } catch (e) {
      return false;
    }
  }

  /*
   * The key is every leg's tuple joined end to end. Two chains that board the same
   * buses at the same stops at the same times ARE the same chain, however they were
   * assembled, so the key has to be built from all of it and not from the first leg
   * plus a count.
   *
   * Not hashed, for the reason watch.js gives at length: these never reach a URL, a
   * server or a log, so hashing would be theatre with the readable original sitting
   * beside it in the same store.
   */
  function keyFor(chain) {
    return legsOf(chain).map(function (leg) {
      return [leg.route_id, leg.direction_id, leg.stop_id, leg.scheduled_time,
        leg.alight_stop_id || ''].join('|');
    }).join('>>') + '@' + (chain.day_type || '');
  }

  function legsOf(chain) {
    return (chain && chain.legs) || [];
  }

  /*
   * A chain is well formed when it has two or three legs, every leg names a route,
   * a stop and a time, and every leg after the first says where it was reached
   * from. A one-leg chain is a saved trip and belongs in watch.js; anything else
   * here is a corrupted store, and the board drops it rather than rendering a card
   * with holes in it.
   */
  function isWellFormed(chain) {
    var legs = legsOf(chain);
    /*
     * Type before shape. `legs.length` on a non-array is `undefined`, and every
     * comparison below against `undefined` is false — so an object slipped through
     * validation and then threw on `legs[0].route_id` inside resolve(), taking the
     * whole Saved view down until the store was cleared by hand. A hand-edited
     * store is the declared threat model two comments up; this is the hole in it.
     */
    if (Object.prototype.toString.call(legs) !== '[object Array]') return false;
    if (legs.length < 2 || legs.length > MAX_LEGS) return false;
    if (!chain.day_type) return false;
    for (var i = 0; i < legs.length; i++) {
      var leg = legs[i];
      if (!leg || !leg.route_id || !leg.stop_id || !leg.scheduled_time) return false;
      if (i > 0 && !leg.alight_stop_id) return false;
    }
    return true;
  }

  function list() {
    return readStore().filter(isWellFormed);
  }

  /*
   * Returns whether the chain is now in the store, NOT the list.
   *
   * The caller has to be able to tell a refusal from a success. When localStorage
   * says no — Safari private browsing, quota, storage switched off — the old
   * signature made that indistinguishable from a save, so the board announced
   * "Saved …", navigated away from a six-step editor, and landed on a view reading
   * "No transfer chains yet". The reader cannot tell that from their own mistake,
   * so they do it again.
   *
   * An already-saved duplicate is a success: the chain is in the store, which is
   * what the caller asked for.
   */
  function add(chain) {
    var all = list();
    var k = keyFor(chain);
    if (all.filter(function (x) { return keyFor(x) === k; }).length) return true;
    all.push(chain);
    return writeStore(all);
  }

  function remove(k) {
    var all = list().filter(function (x) { return keyFor(x) !== k; });
    return writeStore(all);
  }

  /* Every route id a chain names, deduplicated, so the caller knows what to fetch. */
  function routesIn(chain) {
    var seen = {};
    var out = [];
    legsOf(chain).forEach(function (leg) {
      if (seen[leg.route_id]) return;
      seen[leg.route_id] = true;
      out.push(leg.route_id);
    });
    return out;
  }

  /* ---- geography ------------------------------------------------------- */

  /*
   * Metres between two stops. Haversine on a sphere, which is accurate to a few
   * parts in a thousand at this latitude and over these distances — the error at
   * 300 m is well under a metre, and the walking-pace assumption above is worth a
   * hundred times more than that.
   *
   * A stop with no fix is not "at the equator", it is unknown, and returning null
   * keeps it out of every comparison rather than silently placing it 3,000 km away
   * and calling that too far. `lat`/`lon` are 0 in the departures document when the
   * shard has no position for a stop, and 0,0 is in the Atlantic.
   */
  function metres(a, b) {
    if (!hasFix(a) || !hasFix(b)) return null;
    var R = 6371000;
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLon = (b.lon - a.lon) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function hasFix(s) {
    return !!s && typeof s.lat === 'number' && typeof s.lon === 'number' &&
      isFinite(s.lat) && isFinite(s.lon) && !(s.lat === 0 && s.lon === 0);
  }

  /*
   * How long the walk actually takes: the straight-line distance stretched by the
   * circuity factor, at the slow pace, always rounded up. A transfer that needs
   * 66.4 seconds of walking needs 67.
   */
  function walkSeconds(distanceM) {
    if (distanceM === null || distanceM === undefined) return null;
    return Math.ceil((distanceM * WALK_CIRCUITY) / WALK_SPEED_MS);
  }

  /* ---- reading a departures document ----------------------------------- */

  /*
   * One row per stop id, first occurrence wins. The document carries one entry per
   * (stop, direction), so a stop served both ways appears twice with the same
   * position; either row answers "where is this stop".
   */
  function stopIndex(dep) {
    var map = {};
    ((dep && dep.stops) || []).forEach(function (s) {
      if (!map[s.stop_id]) map[s.stop_id] = s;
    });
    return map;
  }

  /*
   * Where one trip goes after a given point in its run, as {stop_id, seconds}.
   *
   * The departures document is keyed by stop and each entry names a trip index, so
   * a trip's own itinerary has to be recovered by sweeping every stop. That reads
   * backwards and it is: the document is shaped for "what leaves this stop", which
   * is the question a picker asks. The sweep is over roughly four thousand rows on
   * the widest route in this feed, runs once per editor keystroke at most, and is
   * the cost of not shipping a second copy of the schedule in a different shape.
   */
  function downstreamStops(dep, tripIndex, afterSeconds) {
    var table = (dep && dep.departures) || {};
    var out = [];
    Object.keys(table).forEach(function (stopId) {
      var rows = table[stopId] || [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i][1] !== tripIndex) continue;
        if (afterSeconds !== null && afterSeconds !== undefined && rows[i][0] <= afterSeconds) continue;
        out.push({ stop_id: stopId, seconds: rows[i][0] });
      }
    });
    out.sort(function (a, b) {
      return a.seconds - b.seconds || (a.stop_id < b.stop_id ? -1 : a.stop_id > b.stop_id ? 1 : 0);
    });
    return out;
  }

  /* One trip's scheduled time at one stop, or null when it does not call there. */
  function tripTimeAt(dep, tripIndex, stopId) {
    var rows = ((dep && dep.departures) || {})[stopId] || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][1] === tripIndex) return rows[i][0];
    }
    return null;
  }

  /*
   * The index of a trip in the departures document, by trip id. Resolution matches
   * a departure and gets a trip object back; the sweep above needs its index.
   */
  function tripIndexOf(dep, tripId) {
    var trips = (dep && dep.trips) || [];
    for (var i = 0; i < trips.length; i++) {
      if (trips[i].id === tripId) return i;
    }
    return -1;
  }

  /* ---- finding connections --------------------------------------------- */

  /*
   * Every way to get from one trip onto one direction of another route.
   *
   * Returns rows the editor can render directly and the store can keep verbatim:
   * where you get off, how far you walk, when the onward bus leaves, and how much
   * of the wait is actually spare once the walk is paid for.
   *
   * Only the EARLIEST feasible onward departure is offered per pair of stops. A
   * list carrying the 8:16, the 8:36 and the 8:56 from the same kerb is three rows
   * saying one thing, and the later two are worse in every respect than the first.
   * Different kerbs stay in, because they are genuinely different choices: a longer
   * walk for an earlier bus is a trade a reader may want to make, and only they know
   * whether the shorter walk is worth eight minutes.
   */
  function connections(fromDep, tripIndex, boardSeconds, toDep, toDirectionId) {
    if (!fromDep || !toDep) return [];
    var fromStops = stopIndex(fromDep);
    var onward = ((toDep && toDep.stops) || []).filter(function (s) {
      return toDirectionId === null || toDirectionId === undefined ||
        s.direction_id === toDirectionId;
    });
    var out = [];

    downstreamStops(fromDep, tripIndex, boardSeconds).forEach(function (hop) {
      var alight = fromStops[hop.stop_id];
      if (!alight) return;

      onward.forEach(function (board) {
        var distance = metres(alight, board);
        if (distance === null || distance > WALK_RADIUS_M) return;
        var walk = walkSeconds(distance);
        var ready = hop.seconds + walk;

        var best = null;
        watchLib.departuresAt(toDep, board.stop_id, toDirectionId).forEach(function (row) {
          if (row.seconds < ready + MIN_SLACK_S) return;
          /*
           * Measured from ALIGHTING, not from `ready`. MAX_WAIT_S is a judgement
           * about how long a child is standing around between buses, and the walk
           * is part of that time, not a discount against it. Capping `ready +
           * MAX_WAIT_S` made the real ceiling the stated 45 minutes PLUS the walk —
           * 49 minutes before circuity landed and 50.8 after, so the walk-model fix
           * silently widened the gap between what this constant does and what its
           * own comment says it does.
           */
          if (row.seconds - hop.seconds > MAX_WAIT_S) return;
          if (best === null || row.seconds < best.seconds) best = row;
        });
        if (best === null) return;

        out.push({
          alight_stop_id: alight.stop_id,
          alight_stop_name: alight.stop_name,
          alight_seconds: hop.seconds,
          board_stop_id: board.stop_id,
          board_stop_name: board.stop_name,
          board_seconds: best.seconds,
          walk_m: Math.round(distance),
          walk_s: walk,
          /* What is left after the walk is paid for — the number that decides
             whether this is a connection or a hope. */
          slack_s: best.seconds - ready,
          trip: best.trip
        });
      });
    });

    /*
     * Earliest onward bus first, then the shorter walk. Earliest first because it
     * is the one that gets there soonest, which is what a connection is for; the
     * walk breaks ties because when two kerbs offer the same bus, the near one
     * wins and there is nothing to weigh up.
     */
    out.sort(function (a, b) {
      return a.board_seconds - b.board_seconds || a.walk_m - b.walk_m ||
        (a.board_stop_id < b.board_stop_id ? -1 : 1);
    });

    var seen = {};
    return out.filter(function (c) {
      var k = c.alight_stop_id + '>' + c.board_stop_id;
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  /*
   * The connections available to continue a part-built chain.
   *
   * The editor knows which legs are fixed and which route is being changed onto;
   * this turns that into the actual list, including the step app.js would otherwise
   * have to do itself — recovering the last leg's trip index from its scheduled
   * departure. Keeping it here means the editor's list and a saved chain's
   * resolution agree by construction, since both go through matchDeparture.
   */
  function connectionsFor(legs, deps, onwardRouteId, onwardDirectionId) {
    if (!legs || !legs.length) return [];
    var last = legs[legs.length - 1];
    var fromDep = deps[last.route_id];
    var toDep = deps[onwardRouteId];
    if (!fromDep || !toDep) return [];
    if (onwardDirectionId === null || onwardDirectionId === undefined) return [];

    var match = watchLib.matchDeparture(
      watchLib.departuresAt(fromDep, last.stop_id, last.direction_id),
      last.scheduled_time
    );
    if (!match) return [];
    var index = tripIndexOf(fromDep, match.row.trip.id);
    if (index < 0) return [];
    return connections(fromDep, index, match.row.seconds, toDep, onwardDirectionId);
  }

  /* ---- resolution ------------------------------------------------------ */

  /*
   * One leg, resolved against its own route's two documents.
   *
   * `deps` maps route id to that route's departures document and `routes` maps
   * route id to its live route payload, because a chain spans routes and no single
   * pair of documents can answer it. Everything a chain knows about lateness comes
   * through here.
   */
  function resolveLeg(leg, dep, route) {
    var out = {
      leg: leg,
      resolved: false,
      reason: null,
      /* The agency has called this trip off. Distinct from "no bus is reporting":
         one means not yet, the other means never. */
      canceled: false,
      /*
       * Why this leg's lateness may not be used, or null when it may be. Distinct
       * again from cancellation: not "no bus" but "a bus we cannot judge".
       *
       *   'feed_stale'  — the ROUTE's feed has stopped updating. Nothing it says,
       *     and nothing it fails to say, can be read as current.
       *   'no_lateness' — the feed is current and a bus IS joined to this trip,
       *     but it publishes no lateness for it: any of the unknown reasons in
       *     the contract's decision table other than staleness.
       *
       * Both refuse the verdict. They are kept apart because the card has to say
       * which one it is, and the two sentences are not interchangeable — one is
       * about the feed, the other is about one bus on a working feed.
       */
      ungraded: null,
      trip: null,
      trip_index: -1,
      vehicle: null,
      view: null,
      lateness: null,
      shifted: false,
      drift: 0,
      board_seconds: null,
      board_at: null,
      predicted_board_at: null
    };
    if (!dep) { out.reason = 'no-schedule'; return out; }

    var rows = watchLib.departuresAt(dep, leg.stop_id, leg.direction_id);
    if (!rows.length) { out.reason = 'unserved'; return out; }

    var match = watchLib.matchDeparture(rows, leg.scheduled_time);
    if (!match) { out.reason = 'unresolved'; return out; }

    out.resolved = true;
    out.trip = match.row.trip;
    out.trip_index = tripIndexOf(dep, match.row.trip.id);
    out.shifted = match.shifted;
    out.drift = match.drift;
    out.board_seconds = match.row.seconds;
    out.board_at = dep.service_day_start_epoch + match.row.seconds;

    /*
     * Before the vehicle join, and before anything can stand in for it.
     *
     * A canceled trip has no vehicle, so every line below would conclude "not
     * reporting yet" and the transfer would then be graded against the timetable
     * for a bus that is not running — which is how this card could print
     * "Connection holds" about a leg the agency has already called off. watch.js
     * checks cancellation first for the same reason, and its comment records that
     * the "not reporting yet" sentence was on screen while a kid waited at a stop.
     *
     * On the 2026-08-19 feed there are 100 canceled trips across 10 routes,
     * including 14 on route 837 and 8 on route 7 — both legs of "337 to the 7 to
     * the 837", which is one of the three journeys this feature was asked for. This
     * is the shipped path, not a corner.
     *
     * `isCanceled` from watch.js, not `trip.canceled`: the flag on the departures
     * document rides a file the client caches for the whole session, so it cannot
     * carry a cancellation announced after the tab was opened — which is precisely
     * the case a chain is open for. The union with the live window is one rule and
     * it lives in one place.
     */
    if (watchLib.isCanceled(out.trip, route)) {
      out.canceled = true;
      /*
       * The scheduled time stands as this leg's time — not as a prediction, but
       * because the window arithmetic above (is this chain upcoming, or already
       * over?) needs SOME time for the leg and the timetable is the only one there
       * is. Leaving it null made `endAt` null, so `now > null + AFTER_S` was true
       * for any clock past 00:15 and a canceled chain rendered as "passed. Back
       * tomorrow" — which is a different wrong answer, not a safer one. Nothing
       * grades against it: every transfer touching a canceled leg is void.
       */
      out.predicted_board_at = out.board_at;
      return out;
    }

    /*
     * Read BEFORE the join, and independently of how the join goes.
     *
     * `suppress_adherence` is a property of the ROUTE — it says this route's feed
     * has stopped updating — and it was previously only consulted inside `if
     * (out.vehicle)`, so the refusal below could only ever fire when the frozen
     * snapshot happened to contain a bus for this trip. Same dead feed, same
     * route: with the vehicle in the snapshot the transfer refused to grade, and
     * without it the transfer graded against the timetable and printed a
     * confident "Connection holds".
     *
     * That is the exact case the reasoning below rules out, and the reasoning was
     * right; it was the code that could not reach it. When a feed dies before a
     * bus appears, "no vehicle at all" and "a vehicle we have stopped hearing
     * from" are the SAME observation, and the vehicle join alone cannot tell them
     * apart. Only the route's own staleness can.
     */
    var routeStale = !!(route && route.staleness && route.staleness.suppress_adherence);

    out.vehicle = watchLib.vehicleForTrip(route, out.trip.id);
    if (out.vehicle) out.view = adhLib.view(out.vehicle, route && route.staleness);

    /*
     * `seconds` is null whenever the feed will not stand behind a number — any of
     * the unknown states, a deadhead, or adherence suppressed for staleness. A
     * null is not a zero: treating it as "on time" would print a confident
     * prediction built on nothing, which is the one thing a board like this must
     * not do.
     *
     * But refusing the zero is only half the job, and the other half is deciding
     * when the TIMETABLE may stand in for the missing number. It always reads "on
     * time", so substituting it is never neutral — it moves the verdict in the
     * optimistic direction, which is the direction that strands somebody. There is
     * exactly one case where that is still the honest answer:
     *
     *   no vehicle, live feed — the bus has not started its run. There is nothing
     *     to know yet, the timetable is the honest prior, and the verdict may be
     *     asserted with `assumed` recording that it rests on one.
     *
     * Everything else is a refusal:
     *
     *   feed stale  — whatever the snapshot holds, it is a photograph of some
     *     minutes ago. A bus in it was last seen ten minutes down; a bus missing
     *     from it may have been running all along. Neither is a reason to reach
     *     for the schedule.
     *   no lateness — there IS a bus, its position is drawn on this very screen,
     *     and the feed simply does not say how late it is. That was previously
     *     narrowed to staleness alone, so a bus with `no_trip_update` — about 7%
     *     of active vehicle trips on this feed — was graded against the timetable
     *     with full confidence and described as "not reporting yet" while its
     *     badge sat on the same card.
     */
    if (routeStale) {
      out.ungraded = 'feed_stale';
    } else if (out.vehicle) {
      if (out.view.seconds === null || out.view.seconds === undefined) {
        out.ungraded = 'no_lateness';
      } else {
        out.lateness = out.view.seconds;
      }
    }
    out.predicted_board_at = out.lateness === null ? out.board_at : out.board_at + out.lateness;
    return out;
  }

  /*
   * The transfer between two resolved legs.
   *
   * Slack is computed from PREDICTED times wherever the feed provides them, which
   * is the whole point: a connection with six scheduled minutes and a first bus
   * nine minutes down is a missed connection, and it is missed an hour before
   * anyone reaches the stop. Where a bus is not reporting, its scheduled time
   * stands in and `assumed` records that it did, so the card can say which half of
   * the sum is a measurement and which half is a timetable.
   */
  function resolveTransfer(prev, next, prevDep, nextDep) {
    var walk = walkFor(prevDep, nextDep, next.leg);
    var out = {
      state: 'unknown',
      alight_stop_id: next.leg.alight_stop_id,
      alight_stop_name: next.leg.alight_stop_name || next.leg.alight_stop_id,
      walk_m: walk.m,
      walk_s: walk.s,
      walk_source: walk.source,
      alight_at: null,
      predicted_alight_at: null,
      board_at: next.board_at,
      predicted_board_at: next.predicted_board_at,
      slack_s: null,
      scheduled_slack_s: null,
      assumed: [],
      /*
       * Which side, if either, could not be judged, and why. Entries are
       * `{ side, why, vehicle }`: the side so the copy can name the right bus, the
       * reason so it can say the right thing about it, and whether a vehicle was
       * actually found so it never describes a bus that is not in the snapshot as
       * being on the road.
       */
      ungraded_legs: []
    };
    if (!prev.resolved || !next.resolved) return out;

    var alightSeconds = tripTimeAt(prevDep, prev.trip_index, next.leg.alight_stop_id);
    if (alightSeconds === null) {
      /*
       * The first leg's trip no longer calls at the stop this chain gets off at.
       * That is a real service change, not a rounding problem, and it breaks the
       * chain rather than degrading it.
       */
      out.state = 'broken';
      return out;
    }
    out.alight_at = prevDep.service_day_start_epoch + alightSeconds;
    out.predicted_alight_at = prev.lateness === null
      ? out.alight_at
      : out.alight_at + prev.lateness;

    var walkCost = out.walk_s === null ? 0 : out.walk_s;
    out.scheduled_slack_s = out.board_at - out.alight_at - walkCost;
    out.slack_s = out.predicted_board_at - out.predicted_alight_at - walkCost;

    /*
     * A leg whose lateness the feed will not supply cannot be graded at all.
     *
     * Every other branch here degrades to the timetable and says so. That is fine
     * when there is no bus yet on a working feed. It is not fine when the feed has
     * stopped updating, and it is not fine when the feed is current but simply
     * carries no lateness for this trip: in both, the timetable stands in for a
     * measurement that was never made or was lost, and the substitution always
     * reads "on time", which is the optimistic end of the range. Reproduced before
     * this was written: the same chain with the same ten-minutes-late bus graded
     * "missed, 2 minutes short" on a fresh feed and "holds, 8 minutes spare" on a
     * dead one.
     *
     * So there is no slack figure here at all. `scheduled_slack_s` survives for the
     * copy to quote as a timetable fact, clearly labeled as one.
     */
    if (prev.ungraded || next.ungraded) {
      out.state = 'unknown';
      out.slack_s = null;
      if (prev.ungraded) {
        out.ungraded_legs.push({ side: 'arriving', why: prev.ungraded, vehicle: !!prev.vehicle });
      }
      if (next.ungraded) {
        out.ungraded_legs.push({ side: 'onward', why: next.ungraded, vehicle: !!next.vehicle });
      }
      return out;
    }

    if (prev.lateness === null) out.assumed.push('arriving');
    if (next.lateness === null) out.assumed.push('onward');

    /*
     * `<=`, not `<`. MIN_SLACK_S and TIGHT_S are both two minutes, and the editor
     * offers a connection when slack is >= MIN_SLACK_S — so with a strict `<` the
     * tightest connection this board will ever offer, the one the comment on
     * MIN_SLACK_S calls "a coin toss", was graded "Connection holds". The two
     * constants being equal is exactly what made that invisible on a read.
     */
    if (out.slack_s < 0) out.state = 'missed';
    else if (out.slack_s <= TIGHT_S) out.state = 'tight';
    else out.state = 'made';
    return out;
  }

  /*
   * The whole feature in one pure function, for the same reason watch.js keeps one:
   * every state the card can show is enumerated here rather than emerging from the
   * order things happen to be rendered in, and all of it is testable without a DOM.
   *
   * `deps` and `routes` are maps from route id, because a chain spans routes.
   */
  function resolve(chain, deps, routes, now) {
    var legs = legsOf(chain);
    var base = { chain: chain, key: keyFor(chain), legs: [], transfers: [] };

    /* list() already drops these, but resolve() is public and a chain with no
     * change in it has no connection to report on. Say so rather than throwing. */
    if (legs.length < 2) {
      return extend(base, { state: 'broken',
        detail: 'A chain needs at least two buses. This one has ' + legs.length + '.' });
    }

    var firstDep = deps[legs[0].route_id];
    if (!firstDep) {
      return extend(base, { state: 'no-schedule',
        detail: 'The schedule for route ' + (legs[0] ? legs[0].route_id : '?') +
          ' has not loaded yet.' });
    }
    /*
     * Every leg's schedule must describe the SAME service day.
     *
     * Departures documents are cached for the session and only change when the
     * service date does, so a board left open across 3 a.m. can hold one document
     * from yesterday and fetch another from today. The two anchor their seconds to
     * different midnights, and subtracting across them gave a transfer twenty-four
     * hours of slack: "Connection holds — 1448 minutes spare". Refusing is the only
     * safe answer; the caller re-fetches and the card recovers on the next paint.
     */
    var dates = {};
    for (var d = 0; d < legs.length; d++) {
      var doc = deps[legs[d].route_id];
      if (doc && doc.service_date) dates[doc.service_date] = true;
    }
    if (Object.keys(dates).length > 1) {
      return extend(base, { state: 'no-schedule',
        detail: 'The schedules loaded for these routes are from different service ' +
          'days, so the times cannot be compared. Reload the board.' });
    }

    if (firstDep.day_type !== chain.day_type) {
      return extend(base, { state: 'not-today',
        detail: 'Saved for a ' + chain.day_type + '. Today is a ' + firstDep.day_type + '.' });
    }

    var resolvedLegs = legs.map(function (leg) {
      return resolveLeg(leg, deps[leg.route_id] || null, routes[leg.route_id] || null);
    });
    base.legs = resolvedLegs;

    var failed = resolvedLegs.filter(function (r) { return !r.resolved; })[0];
    if (failed) {
      return extend(base, {
        state: failed.reason === 'no-schedule' ? 'no-schedule' : 'broken',
        detail: legDetail(failed)
      });
    }

    /*
     * Transfers are graded in order, and grading STOPS at the first one that
     * cannot be made.
     *
     * Grading each independently is what the first version did, and on a three-leg
     * chain it printed "Connection holds" six lines under "Connection missed" — the
     * second verdict computed from a bus the rider will not be on, rendered at the
     * same weight as the first. That is not a weaker claim, it is a claim about
     * nothing, and "337 to the 7 to the 837" is one of the three journeys this
     * feature was asked for, so it is the shipped path.
     *
     * A void transfer says why it is void rather than showing a number nobody
     * should read.
     */
    var transfers = [];
    var dead = null;
    /* Index of the first leg the rider cannot reach; null while the chain holds. */
    var deadFrom = null;
    for (var i = 1; i < resolvedLegs.length; i++) {
      var prev = resolvedLegs[i - 1];
      var next = resolvedLegs[i];
      var prevDep = deps[prev.leg.route_id];
      var nextDep = deps[next.leg.route_id];
      var t;
      if (dead) {
        t = voidTransfer(next, dead, walkFor(prevDep, nextDep, next.leg));
      } else if (prev.canceled || next.canceled) {
        t = voidTransfer(next, 'canceled', walkFor(prevDep, nextDep, next.leg));
      } else {
        t = resolveTransfer(prev, next, prevDep, nextDep);
      }
      transfers.push(t);
      /* Everything downstream of a change that cannot be made is unreachable. */
      if (dead === null && (t.state === 'missed' || t.state === 'broken' ||
          t.state === 'void')) {
        dead = t.state === 'void' ? 'canceled' : t.state;
        /* Leg i is the first one beyond the break. A cancellation ON leg i still
           counts — it may be the very reason the change is void. */
        deadFrom = i;
      }
    }
    base.transfers = transfers;

    if (transfers.filter(function (t) { return t.state === 'broken'; }).length) {
      return extend(base, { state: 'broken',
        detail: 'One of the buses in this chain no longer stops where the change was made. ' +
          'The schedule has changed since this was saved.' });
    }

    /*
     * Only cancellations the reader would actually run into.
     *
     * `dead` is the index of the first leg the cascade could not reach, so a
     * cancellation at or beyond it is not news: they were never going to be on that
     * bus. Counting every leg meant a 3-leg chain with a missed change at transfer 1
     * and a canceled leg 3 led with the cancellation and erased the due time,
     * burying the earlier problem — the one that actually decides the morning.
     */
    var canceledLegs = resolvedLegs.filter(function (r, i) {
      return r.canceled && (deadFrom === null || i <= deadFrom);
    });
    var first = resolvedLegs[0];
    var last = resolvedLegs[resolvedLegs.length - 1];
    /*
     * A chain is over when the last bus has been boarded, not when it finishes its
     * run. Nothing here records where the rider gets OFF the final leg — the chain
     * is a question about catching buses, and once they are on the last one it is
     * answered — so the last boarding is the only honest end marker available. Using
     * the trip's final stop instead would keep a finished chain on screen for the
     * rest of that bus's run, which on the 800 is another forty minutes.
     */
    var endAt = last.predicted_board_at;

    var model = extend(base, {
      first: first,
      last: last,
      /*
       * The chain's headline time is the FIRST leg's departure, predicted where
       * possible. It is the only time in the whole card the reader can still act
       * on: everything after it is a consequence of catching this bus.
       */
      due_at: first.predicted_board_at,
      scheduled_at: first.board_at,
      seconds_until: first.predicted_board_at - now,
      end_at: endAt,
      /* The worst news among the transfers, because a chain is only as good as its
         weakest change and the card must not lead with the one that holds. */
      connection: worstTransfer(transfers),
      canceled: canceledLegs,
      shifted: resolvedLegs.filter(function (r) { return r.shifted; }).length > 0,
      is_special: resolvedLegs.filter(function (r) { return r.trip && r.trip.is_special; }).length > 0
    });

    /*
     * The stand-down, not the prediction, when the last leg could not be graded.
     * See UNGRADED_HOLD_S: without it, refusing to grade a connection also quietly
     * retired the chain on the timetable the refusal was about.
     */
    if (now > endAt + AFTER_S + (last.ungraded ? UNGRADED_HOLD_S : 0)) model.state = 'passed';
    /*
     * Cancellation outranks every live state but not "already gone". A canceled
     * leg is the strongest thing the feed can say about this chain — stronger than
     * where the buses are, because there is no bus — and it needs its own state
     * rather than a badge on a live card, or the card leads with a due time for
     * something that is not coming.
     */
    else if (canceledLegs.length) {
      model.state = 'canceled';
      model.detail = canceledDetail(canceledLegs);
    } else if (now < first.board_at - BEFORE_S) model.state = 'upcoming';
    else if (!first.vehicle) model.state = 'no-vehicle';
    else model.state = 'live';
    return model;
  }

  function legDetail(leg) {
    if (leg.reason === 'no-schedule') {
      return 'The schedule for route ' + leg.leg.route_id + ' has not loaded yet.';
    }
    if (leg.reason === 'unserved') {
      return 'Route ' + leg.leg.route_id + ' does not serve ' +
        (leg.leg.stop_name || leg.leg.stop_id) + ' in this direction today.';
    }
    return 'Route ' + leg.leg.route_id + ' has nothing leaving ' +
      (leg.leg.stop_name || leg.leg.stop_id) + ' at ' +
      fmt.serviceClock(leg.leg.scheduled_time) + ' today. The schedule may have changed.';
  }

  /*
   * The walk for a stored transfer, recomputed from where the stops are TODAY.
   *
   * A chain stores `walk_m`/`walk_s` at save time, and everything else about a
   * chain is re-resolved from current documents on every render — the trip, the
   * times, the vehicle. The walk was the one frozen value, which meant the
   * circuity factor reached chains created after it landed and not the ones people
   * were already relying on: at 300 m that is 100 seconds of slack the current
   * model says is not there, with nothing on screen distinguishing the two.
   *
   * Recomputing also picks up a stop that moved in a GTFS republish. The stored
   * value survives only as a fallback for a stop with no fix, which is the one case
   * `metres()` cannot answer.
   */
  function walkFor(prevDep, nextDep, leg) {
    var from = stopIndex(prevDep)[leg.alight_stop_id];
    var to = stopIndex(nextDep)[leg.stop_id];
    var distance = metres(from, to);
    if (distance !== null) {
      return { m: Math.round(distance), s: walkSeconds(distance), source: 'current' };
    }
    var stored = typeof leg.walk_m === 'number' ? leg.walk_m : null;
    return {
      m: stored,
      /* Recompute the seconds from the stored METRES rather than trusting the
         stored seconds, so an old chain still gets today's cost model. */
      s: stored === null
        ? (typeof leg.walk_s === 'number' ? leg.walk_s : null)
        : walkSeconds(stored),
      source: 'stored'
    };
  }

  /*
   * A change nobody reaches, or one either side of a canceled bus. It carries no
   * slack because there is no honest number to put there: computing one against a
   * departure the rider cannot reach would produce a figure that looks like the
   * others and means nothing.
   */
  function voidTransfer(next, because, walk) {
    walk = walk || { m: null, s: null, source: 'stored' };
    return {
      state: 'void',
      because: because,
      alight_stop_id: next.leg.alight_stop_id,
      alight_stop_name: next.leg.alight_stop_name || next.leg.alight_stop_id,
      walk_m: walk.m,
      walk_s: walk.s,
      walk_source: walk.source,
      alight_at: null,
      predicted_alight_at: null,
      board_at: next.board_at,
      predicted_board_at: next.predicted_board_at,
      slack_s: null,
      scheduled_slack_s: null,
      assumed: [],
      ungraded_legs: []
    };
  }

  /*
   * Which bus was called off, by route and scheduled time. A bare "canceled" would
   * leave the reader to work out which of two or three buses it was, which on a
   * chain is the whole question — the first leg being canceled means leave now for
   * a different route, the last leg means the journey is fine until the end.
   */
  function canceledDetail(canceled) {
    var which = canceled.map(function (r) {
      return 'the ' + fmt.serviceClock(watchLib.clockOf(r.board_seconds)) + ' route ' +
        r.leg.route_id;
    });
    var list = which.length === 1 ? which[0]
      : which.slice(0, -1).join(', ') + ' and ' + which[which.length - 1];
    return 'CapMetro has canceled ' + list + '. ' +
      (canceled.length === 1 ? 'No bus is running that trip today.'
        : 'No buses are running those trips today.');
  }

  /* void ranks below the real verdicts: a change nobody reaches is not the news,
     the thing upstream of it is. */
  var TRANSFER_RANK = { missed: 0, tight: 1, broken: 2, void: 3, unknown: 4, made: 5 };

  function worstTransfer(transfers) {
    var sorted = transfers.slice().sort(function (a, b) {
      var ra = TRANSFER_RANK[a.state] === undefined ? 9 : TRANSFER_RANK[a.state];
      var rb = TRANSFER_RANK[b.state] === undefined ? 9 : TRANSFER_RANK[b.state];
      if (ra !== rb) return ra - rb;
      return (a.slack_s === null ? Infinity : a.slack_s) -
        (b.slack_s === null ? Infinity : b.slack_s);
    });
    return sorted[0] || null;
  }

  function extend(a, b) {
    for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k];
    return a;
  }

  /* ---- words ----------------------------------------------------------- */

  /*
   * Slack in words. Never a bare signed number: "-3 min" beside a bus is ambiguous
   * about which way the error runs, and the whole card exists to remove exactly
   * that kind of arithmetic.
   */
  function slackText(seconds) {
    if (seconds === null || seconds === undefined) return 'no timing';
    if (seconds < 0) return minutesWord(-seconds) + ' short';
    if (Math.round(seconds / 60) === 0) return 'no spare time';
    return minutesWord(seconds) + ' spare';
  }

  /*
   * A count of minutes, never rounded down to nothing. Thirty-four seconds short
   * of a connection is "1 minute short": it is not "0 minutes", which reads as
   * having made it.
   */
  function minutesWord(seconds) {
    return fmt.plural(Math.max(1, Math.round(Math.abs(seconds) / 60)), 'minute', 'minutes');
  }

  var CONNECTION_LABEL = {
    made: 'Connection holds',
    tight: 'Tight connection',
    missed: 'Connection missed',
    broken: 'Chain broken',
    void: 'Not reached',
    unknown: 'Connection unknown'
  };

  /*
   * Why a change could not be graded, in words that stay true about the bus in
   * question — which is the whole difficulty here.
   *
   * There are three different situations and they were all previously rendered as
   * one sentence about a stale feed, or worse, as "not reporting yet":
   *
   *   a bus in the snapshot on a dead feed — it IS on the road, its badge is drawn
   *     on this very card, and only the feed has gone quiet.
   *   no bus in the snapshot on a dead feed — we cannot even say whether it is
   *     running. Saying it "is on the road" would invent a bus; saying it "is not
   *     reporting yet" would read the silence of a dead feed as news about a bus.
   *   a bus on a LIVE feed carrying no lateness — the feed is current and the bus
   *     is in it, so nothing is late or missing except the one number this card
   *     needs. "Not reporting" is flatly false.
   *
   * Every clause below is checkable against what is on screen beside it.
   */
  var UNGRADED_SUBJECT = { arriving: 'The first bus', onward: 'The onward bus' };

  function ungradedClause(u) {
    if (u.why === 'feed_stale') {
      return u.vehicle
        ? UNGRADED_SUBJECT[u.side] + ' is on the road but its feed has stopped updating'
        : UNGRADED_SUBJECT[u.side] + ' is not in the feed at all, and that feed has ' +
          'stopped updating, so its absence says nothing either way';
    }
    return UNGRADED_SUBJECT[u.side] + ' is on the road but the feed carries no ' +
      'lateness for its trip';
  }

  function ungradedSentence(list) {
    return list.map(ungradedClause).join('. ') +
      '. There is no lateness to grade this change with.';
  }

  /*
   * The sentence under the verdict. Each state gets its own, because "tight" and
   * "missed" call for completely different actions and a shared phrasing would
   * blur the one distinction the card is for.
   */
  function connectionDetail(t) {
    if (!t) return '';
    var walk = t.walk_m === null ? '' :
      (t.walk_m === 0 ? 'Same stop' : 'A ' + t.walk_m + ' m walk') + ' at ' + t.alight_stop_name + '. ';
    /*
     * Void first, and with no walk sentence in front of it. Describing the walk to
     * a change nobody reaches is the same mistake as grading it: true of the
     * timetable, irrelevant to today.
     */
    if (t.state === 'void') {
      if (t.because === 'canceled') {
        return 'Not reached — one of these buses is canceled.';
      }
      if (t.because === 'broken') {
        return 'Not reached — the change before this one no longer exists.';
      }
      return 'Not reached — the change before this one is missed.';
    }
    if (t.state === 'missed') {
      return walk + 'The first bus gets in after the second one leaves, by ' +
        minutesWord(t.slack_s) + '. Plan on the next one.';
    }
    if (t.state === 'tight') {
      return walk + 'Almost no room for the first bus to lose any more time.';
    }
    if (t.state === 'made') {
      return walk + 'There is room here for the first bus to run a little late.';
    }
    if (t.ungraded_legs && t.ungraded_legs.length) {
      /*
       * Names the timetable gap, and refuses to call it slack. The number is real
       * — it is what the schedule says — but the thing the reader wants is the gap
       * after lateness, and that is exactly what has gone missing.
       */
      var scheduled = t.scheduled_slack_s === null ? ''
        : ' The timetable allows ' + minutesWord(t.scheduled_slack_s) + ' here.';
      return walk + ungradedSentence(t.ungraded_legs) + scheduled;
    }
    return walk + 'Not enough is known about these buses to say.';
  }

  /*
   * Which halves of the sum are measured and which are assumed. Said out loud
   * because a prediction built partly on a timetable is a weaker claim than one
   * built on two buses being watched, and the reader is entitled to know which
   * one they are looking at.
   */
  function assumptionNote(t) {
    /* An ungraded leg is not an assumption, it is a refusal — connectionDetail
     * already says so, and "not reporting yet" would be false twice over about a
     * bus whose badge is drawn on the same screen. */
    if (t && t.ungraded_legs && t.ungraded_legs.length) return null;
    if (!t || !t.assumed || !t.assumed.length) return null;
    if (t.assumed.length === 2) {
      return 'Neither bus is reporting yet, so this is the timetable, not a prediction.';
    }
    if (t.assumed[0] === 'arriving') {
      return 'The first bus is not reporting yet, so its scheduled arrival is used here.';
    }
    return 'The onward bus is not reporting yet, so it is assumed to run on time.';
  }

  function describe(chain) {
    var legs = legsOf(chain);
    return fmt.serviceClock(legs[0].scheduled_time) + ' ' +
      legs.map(function (l) { return 'route ' + l.route_id; }).join(' to ') +
      ' from ' + (legs[0].stop_name || legs[0].stop_id);
  }

  function routeSummary(chain) {
    return legsOf(chain).map(function (l) { return l.route_id; }).join(' → ');
  }

  /* ---- render ---------------------------------------------------------- */

  function legHead(leg, model) {
    var row = el('div', 'chaincard__leg');
    var title = el('p', 'chaincard__legtitle');
    title.appendChild(el('span', 'chaincard__legtime',
      fmt.serviceClock(model && model.board_seconds !== null
        ? watchLib.clockOf(model.board_seconds) : leg.scheduled_time)));
    title.appendChild(el('span', 'chaincard__legroute', leg.route_id));
    title.appendChild(el('span', 'chaincard__legdir', leg.direction_tag ||
      (leg.direction_id === 0 ? 'A' : 'B')));
    row.appendChild(title);
    row.appendChild(el('p', 'chaincard__legstop', leg.stop_name || leg.stop_id));
    return row;
  }

  function transferRow(t) {
    var row = el('div', 'chaincard__transfer chaincard__transfer--' + t.state);
    var head = el('p', 'chaincard__verdict');
    head.appendChild(el('span', 'chaincard__verdictlabel',
      CONNECTION_LABEL[t.state] || t.state));
    if (t.slack_s !== null) {
      head.appendChild(el('span', 'chaincard__slack', slackText(t.slack_s)));
    }
    row.appendChild(head);
    row.appendChild(el('p', 'chaincard__transferdetail', connectionDetail(t)));

    if (t.alight_at !== null && t.board_at !== null) {
      /*
       * The two times the slack is the difference between, printed so the reader
       * can check the arithmetic rather than take it on trust.
       *
       * Named when they are the timetable. On an ungraded change these are the
       * scheduled pair — there is nothing else for them to be — and printing them
       * unlabeled in the slot the card uses for real predictions put the conclusion
       * back on screen in pieces immediately after withholding it. Two clock times
       * side by side subtract to a slack figure in the reader's head whether or not
       * the card was willing to do it for them.
       */
      var ungraded = !!(t.ungraded_legs && t.ungraded_legs.length);
      row.appendChild(el('p', 'chaincard__transfertimes',
        (ungraded ? 'Timetable only · in ' : 'In ') +
        fmt.clock(ungraded ? t.alight_at : t.predicted_alight_at) + ' · out ' +
        fmt.clock(ungraded ? t.board_at : t.predicted_board_at) +
        (t.walk_s ? ' · ' + Math.round(t.walk_s / 60) + ' min walk' : '')));
    }
    var note = assumptionNote(t);
    if (note) row.appendChild(el('p', 'chaincard__note', note));
    return row;
  }

  function card(model, opts) {
    var chain = model.chain;
    var legs = legsOf(chain);
    var box = el('article', 'chaincard chaincard--' + model.state +
      (model.connection ? ' chaincard--conn-' + model.connection.state : ''));

    var head = el('div', 'chaincard__head');
    var title = el('p', 'chaincard__title');
    title.appendChild(el('span', 'chaincard__routes', routeSummary(chain)));
    title.appendChild(el('span', 'chaincard__legcount',
      fmt.plural(legs.length - 1, 'change', 'changes')));
    head.appendChild(title);
    head.appendChild(el('p', 'chaincard__from',
      'from ' + (legs[0].stop_name || legs[0].stop_id)));
    box.appendChild(head);

    if (model.state === 'live' || model.state === 'no-vehicle' ||
        model.state === 'upcoming' || model.state === 'passed' ||
        model.state === 'canceled') {
      var line = el('p', 'chaincard__line');
      if (model.state === 'passed') {
        line.textContent = 'Gone · ' + watchLib.untilText(model.seconds_until);
      } else if (model.state === 'canceled') {
        /*
         * No due time on this line. Printing one beside the word CANCELED invites
         * the reader to act on it, and there is nothing coming at that time.
         */
        line.appendChild(el('span', 'chaincard__canceled', 'CANCELED'));
      } else if (model.first && model.first.ungraded) {
        /*
         * The scheduled time, said as the schedule.
         *
         * `due_at` is `predicted_board_at`, and on an ungraded leg that IS the
         * timetable — so the headline read "due 7:52a · in 12 minutes" about a bus
         * last seen twelve minutes down, in the largest type on the card, while the
         * verdict two lines below refused to grade the same bus. A countdown is a
         * prediction whatever it is built from; this one is not available, so the
         * slot says what the number actually is instead of pretending.
         */
        line.appendChild(el('span', 'chaincard__due', fmt.clock(model.scheduled_at)));
        line.appendChild(el('span', 'chaincard__until', 'scheduled'));
      } else {
        line.appendChild(el('span', 'chaincard__due', fmt.clock(model.due_at)));
        line.appendChild(el('span', 'chaincard__until',
          watchLib.untilText(model.seconds_until)));
      }
      box.appendChild(line);

      if (model.state === 'live' && model.first.view) {
        box.appendChild(adhLib.badge(model.first.view));
        box.appendChild(el('p', 'chaincard__detail',
          'First bus scheduled ' + fmt.clock(model.scheduled_at) + ' · ' +
          model.first.view.label));
        box.appendChild(el('p', 'chaincard__bus',
          'Bus ' + (model.first.vehicle.label || model.first.vehicle.vehicle_id)));
      } else if (model.state === 'no-vehicle') {
        box.appendChild(el('p', 'chaincard__detail',
          'The first bus is not reporting yet. That is normal until it starts its run.'));
      } else if (model.state === 'upcoming') {
        box.appendChild(el('p', 'chaincard__detail',
          'Tracking starts an hour before the first bus is due.'));
      } else if (model.state === 'passed') {
        box.appendChild(el('p', 'chaincard__detail',
          'The last bus was due to leave at ' + fmt.clock(model.end_at) + '. Back tomorrow.'));
      } else if (model.state === 'canceled') {
        box.appendChild(el('p', 'chaincard__detail', model.detail || ''));
      }

      /* Legs and the changes between them, in the order they are ridden. */
      var body = el('div', 'chaincard__legs');
      body.appendChild(legHead(legs[0], model.legs[0]));
      for (var i = 1; i < legs.length; i++) {
        body.appendChild(transferRow(model.transfers[i - 1]));
        body.appendChild(legHead(legs[i], model.legs[i]));
      }
      box.appendChild(body);
    } else {
      box.appendChild(el('p', 'chaincard__line', 'Nothing to show'));
      box.appendChild(el('p', 'chaincard__detail', model.detail || ''));
    }

    if (model.shifted) {
      box.appendChild(el('p', 'chaincard__note',
        'At least one of these buses leaves at a slightly different time than when ' +
        'this chain was saved.'));
    }
    if (model.is_special) {
      box.appendChild(el('p', 'chaincard__note',
        'This chain uses a special run. It does not follow the route’s usual ' +
        'pattern of stops.'));
    }

    box.appendChild(el('p', 'sr-only', spoken(model)));

    var del = el('button', 'chaincard__remove');
    del.type = 'button';
    del.textContent = 'Remove';
    del.setAttribute('aria-label', 'Remove the saved chain ' + describe(chain));
    del.addEventListener('click', function () {
      remove(model.key);
      if (opts && opts.onChange) opts.onChange();
    });
    box.appendChild(del);
    return box;
  }

  /* Everything the verdict color and the badge carry, said in words. */
  function spoken(model) {
    var head = describe(model.chain) + '. ';
    if (model.state === 'passed') return head + 'Already gone.';
    if (model.state === 'canceled') return head + (model.detail || 'Canceled.');
    if (model.state === 'upcoming') return head + 'Due ' + fmt.clockSpoken(model.due_at) + '.';
    if (model.state === 'live' || model.state === 'no-vehicle') {
      var t = model.connection;
      /* Same refusal as the headline: a screen reader must not be handed a
         prediction the card itself would not print. */
      var due = model.first && model.first.ungraded
        ? 'Scheduled ' + fmt.clockSpoken(model.scheduled_at) + ', with no live time. '
        : 'Due ' + fmt.clockSpoken(model.due_at) + '. ';
      return head + due +
        (t ? (CONNECTION_LABEL[t.state] || t.state) + ', ' + slackText(t.slack_s) + '.' : '');
    }
    return head + (model.detail || 'Nothing to show.');
  }

  function render(host, models, opts) {
    opts = opts || {};
    S.clear(host);
    host.appendChild(el('p', 'band__head', 'Transfer chains'));

    if (!models || !models.length) {
      host.appendChild(S.notice('empty',
        'No transfer chains yet.',
        'A chain is a journey with a change in it — the 800 to the 4, say. Save one ' +
        'and this shows whether the connection holds, instead of leaving you to ' +
        'compare two boards.'));
      if (opts.onAdd) {
        var b = el('button', 'btn btn--primary');
        b.type = 'button';
        b.textContent = 'Save a chain';
        b.addEventListener('click', opts.onAdd);
        host.appendChild(b);
      }
      return host;
    }

    var listEl = el('div', 'chainlist');
    models.forEach(function (m) { listEl.appendChild(card(m, opts)); });
    host.appendChild(listEl);

    if (opts.onAdd) {
      var add = el('button', 'btn');
      add.type = 'button';
      add.textContent = 'Save another chain';
      add.addEventListener('click', opts.onAdd);
      host.appendChild(add);
    }
    return host;
  }

  /*
   * Worst news first, same principle as the vehicle rows and the saved trips: a
   * missed connection outranks a live one however far away it is, because it is
   * the only card on the screen that needs a decision made about it.
   */
  var RANK = {
    live: 0, canceled: 1, 'no-vehicle': 2, upcoming: 3, passed: 4,
    broken: 5, 'not-today': 6, 'no-schedule': 7
  };

  function sortModels(models) {
    return models.slice().sort(function (a, b) {
      var ca = a.connection && (a.connection.state === 'missed' || a.connection.state === 'tight');
      var cb = b.connection && (b.connection.state === 'missed' || b.connection.state === 'tight');
      var liveA = a.state === 'live' || a.state === 'no-vehicle';
      var liveB = b.state === 'live' || b.state === 'no-vehicle';
      if (liveA && liveB && ca !== cb) return ca ? -1 : 1;
      var ra = RANK[a.state] === undefined ? 9 : RANK[a.state];
      var rb = RANK[b.state] === undefined ? 9 : RANK[b.state];
      if (ra !== rb) return ra - rb;
      var sa = a.seconds_until === undefined ? Infinity : a.seconds_until;
      var sb = b.seconds_until === undefined ? Infinity : b.seconds_until;
      return sa - sb;
    });
  }

  /* ---- the editor ------------------------------------------------------ */

  /*
   * A chain is built forwards, one leg at a time, because that is the only order in
   * which each choice can be narrowed by the last one. The first leg is exactly the
   * saved-trip editor's four steps — route, direction, stop, departure — and the
   * steps after it are two: which route you change onto, and which of the real
   * connections you take.
   *
   * `state` is owned by the caller and passed back in, so this stays a pure
   * function of it and app.js remains the single owner of what is on screen.
   */
  function renderEditor(host, state, opts) {
    opts = opts || {};
    S.clear(host);
    host.appendChild(el('p', 'band__head', 'Save a transfer chain'));

    var routes = state.routes || [];
    var legs = state.legs || [];
    var deps = state.departures || {};
    var n = 1;

    /* The legs already fixed, each shown as its answer. */
    legs.forEach(function (leg, i) {
      host.appendChild(step(n++, i === 0 ? 'Start' : 'Change ' + i,
        legSummary(leg), null, false));
    });

    /* The first leg is picked exactly as a saved trip is. */
    if (!legs.length) {
      return firstLegEditor(host, state, opts, routes, deps, n);
    }

    if (legs.length >= MAX_LEGS) {
      host.appendChild(el('p', 'hint',
        'Three buses is as long as a chain goes. Save this one, or remove a leg.'));
      host.appendChild(saveRow(state, opts));
      return host;
    }

    /*
     * Two legs is already a chain, so the save comes BEFORE the optional third.
     * Putting it after would bury the finished article under a step nobody in this
     * household has ever needed more than once.
     */
    var onward = state.onward || {};
    if (legs.length >= 2 && !onward.route_id) host.appendChild(saveRow(state, opts));

    /* Onward: which route do you change onto? */
    host.appendChild(step(n++, legs.length >= 2 ? 'Add another change' : 'Change onto',
      onward.route_id ? routeLabel(routes, onward.route_id) : null, function () {
      var grid = el('div', 'routegrid');
      routes.filter(function (r) {
        /* Changing onto the route you are already on is not a transfer. */
        return r.id !== legs[legs.length - 1].route_id;
      }).forEach(function (r) {
        var b = el('button', 'routegrid__item');
        b.type = 'button';
        if (r.id === onward.route_id) b.classList.add('is-on');
        b.appendChild(el('span', 'routegrid__id', r.short_name || r.id));
        b.appendChild(el('span', 'routegrid__name', cleanName(r.long_name)));
        b.addEventListener('click', function () { opts.onPickOnwardRoute(r.id); });
        grid.appendChild(b);
      });
      return grid;
    }, !onward.route_id));

    if (!onward.route_id) return host;   /* the save row is already above */

    var onwardDep = deps[onward.route_id];
    if (!onwardDep) {
      host.appendChild(S.notice('empty',
        'Loading the schedule for route ' + onward.route_id + '…',
        'This is one file for the whole service day, so it only loads once.'));
      return host;
    }

    /* Which way on that route. */
    var dirs = watchLib.directionsOf(routes, onward.route_id, onwardDep);
    host.appendChild(step(n++, 'Direction', onward.direction_id === null ||
      onward.direction_id === undefined ? null : dirLabel(dirs, onward.direction_id),
    function () {
      var row = el('div', 'chiprow');
      dirs.forEach(function (d) {
        var b = el('button', 'chipbtn');
        b.type = 'button';
        if (d.id === onward.direction_id) b.classList.add('is-on');
        b.textContent = d.headsign || ('Direction ' + d.id);
        b.addEventListener('click', function () { opts.onPickOnwardDirection(d.id); });
        row.appendChild(b);
      });
      return row;
    }, onward.direction_id === null || onward.direction_id === undefined));

    if (onward.direction_id === null || onward.direction_id === undefined) {
      if (legs.length >= 2) host.appendChild(saveRow(state, opts));
      return host;
    }

    /* The connections that actually exist, from the actual trip picked. */
    var last = legs[legs.length - 1];
    var lastDep = deps[last.route_id];
    var found = state.connections || [];

    host.appendChild(step(n++, 'Connection', null, function () {
      var wrap = el('div', 'connlist');
      if (!lastDep) {
        wrap.appendChild(S.notice('empty', 'The first leg’s schedule is still loading.', null));
        return wrap;
      }
      if (!found.length) {
        wrap.appendChild(S.notice('empty',
          'No connection from the ' + fmt.serviceClock(last.scheduled_time) + ' route ' +
          last.route_id + ' onto route ' + onward.route_id + ' this way.',
          'The two routes may not come within walking distance after this bus passes, ' +
          'or the onward buses may all have gone. Try the other direction, ' +
          'another onward route, or an earlier departure.'));
        return wrap;
      }
      found.forEach(function (c) {
        var b = el('button', 'connlist__item');
        b.type = 'button';
        var top = el('span', 'connlist__times');
        top.appendChild(el('span', 'connlist__board',
          fmt.serviceClock(watchLib.clockOf(c.board_seconds))));
        top.appendChild(el('span', 'connlist__wait',
          Math.round(c.slack_s / 60) + ' min wait'));
        b.appendChild(top);
        b.appendChild(el('span', 'connlist__where',
          'off at ' + c.alight_stop_name + ' ' +
          fmt.serviceClock(watchLib.clockOf(c.alight_seconds)) +
          (c.walk_m === 0 ? ' · same stop'
            : ' · walk ' + c.walk_m + ' m to ' + c.board_stop_name)));
        if (c.trip.headsign) b.appendChild(el('span', 'connlist__headsign', c.trip.headsign));
        b.setAttribute('aria-label',
          'Get off at ' + c.alight_stop_name + ' at ' +
          fmt.serviceClock(watchLib.clockOf(c.alight_seconds)) +
          (c.walk_m === 0 ? ', same stop' : ', walk ' + c.walk_m + ' metres to ' + c.board_stop_name) +
          ', board route ' + onward.route_id + ' at ' +
          fmt.serviceClock(watchLib.clockOf(c.board_seconds)) +
          ', ' + Math.round(c.slack_s / 60) + ' minutes to wait');
        b.addEventListener('click', function () {
          opts.onPickConnection(legFromConnection(c, onward, onwardDep, routes));
        });
        wrap.appendChild(b);
      });
      return wrap;
    }, true));

    if (legs.length >= 2) host.appendChild(saveRow(state, opts));
    return host;
  }

  /* The stored shape of a leg, built from a connection the reader chose. */
  function legFromConnection(c, onward, onwardDep, routes) {
    return {
      route_id: String(onward.route_id),
      direction_id: onward.direction_id,
      direction_tag: fmt.directionTag(c.trip.headsign, onward.direction_id),
      stop_id: c.board_stop_id,
      stop_name: c.board_stop_name,
      scheduled_time: watchLib.clockOf(c.board_seconds),
      alight_stop_id: c.alight_stop_id,
      alight_stop_name: c.alight_stop_name,
      walk_m: c.walk_m,
      walk_s: c.walk_s
    };
  }

  function saveRow(state, opts) {
    var wrap = el('div', 'chainsave');
    var b = el('button', 'btn btn--primary');
    b.type = 'button';
    b.textContent = 'Save this chain';
    b.addEventListener('click', function () {
      opts.onSave({ legs: (state.legs || []).slice(), day_type: state.day_type });
    });
    wrap.appendChild(b);
    /*
     * Named as the browser's refusal, not as an error in the chain. The chain is
     * fine; the store would not take it, and nothing the reader changes about the
     * journey will help.
     */
    if (state.saveFailed) {
      wrap.appendChild(S.notice('warn',
        'This browser would not save the chain.',
        'Private browsing and full storage both do this. Nothing has been stored, ' +
        'and your choices above are still here if you can free some space or ' +
        'open a normal window.'));
    }
    wrap.appendChild(el('p', 'hint',
      'Saved for a ' + (state.day_type || 'weekday') + '. Weekday, Saturday and Sunday ' +
      'run different schedules, so each one is its own chain.'));
    return wrap;
  }

  function legSummary(leg) {
    return fmt.serviceClock(leg.scheduled_time) + ' · ' + leg.route_id + ' ' +
      (leg.direction_tag || '') + ' · ' + (leg.stop_name || leg.stop_id);
  }

  /*
   * The first leg's four steps. Identical in shape to the saved-trip editor, and
   * deliberately not shared with it: that one saves on picking a departure, this
   * one continues to a transfer, and threading a mode flag through both would make
   * each harder to read than the small amount of markup it saves.
   */
  function firstLegEditor(host, state, opts, routes, deps, n) {
    var start = state.start || {};

    host.appendChild(step(n++, 'Route', start.route_id
      ? routeLabel(routes, start.route_id) : null, function () {
      var grid = el('div', 'routegrid');
      routes.forEach(function (r) {
        var b = el('button', 'routegrid__item');
        b.type = 'button';
        if (r.id === start.route_id) b.classList.add('is-on');
        b.appendChild(el('span', 'routegrid__id', r.short_name || r.id));
        b.appendChild(el('span', 'routegrid__name', cleanName(r.long_name)));
        b.addEventListener('click', function () { opts.onPickStartRoute(r.id); });
        grid.appendChild(b);
      });
      return grid;
    }, !start.route_id));

    if (!start.route_id) return host;

    var dep = deps[start.route_id];
    if (!dep) {
      host.appendChild(S.notice('empty',
        'Loading the schedule for route ' + start.route_id + '…',
        'This is one file for the whole service day, so it only loads once.'));
      return host;
    }

    var dirs = watchLib.directionsOf(routes, start.route_id, dep);
    host.appendChild(step(n++, 'Direction', start.direction_id === null ||
      start.direction_id === undefined ? null : dirLabel(dirs, start.direction_id), function () {
      var row = el('div', 'chiprow');
      dirs.forEach(function (d) {
        var b = el('button', 'chipbtn');
        b.type = 'button';
        if (d.id === start.direction_id) b.classList.add('is-on');
        b.textContent = d.headsign || ('Direction ' + d.id);
        b.addEventListener('click', function () { opts.onPickStartDirection(d.id); });
        row.appendChild(b);
      });
      return row;
    }, start.direction_id === null || start.direction_id === undefined));

    if (start.direction_id === null || start.direction_id === undefined) return host;

    var stops = watchLib.stopsFor(dep, start.direction_id);
    host.appendChild(step(n++, 'Stop', start.stop_id
      ? stopName(stops, start.stop_id) : null, function () {
      var wrap = el('div', 'stoplist');
      if (!stops.length) {
        wrap.appendChild(S.notice('empty', 'No stops in this direction today.', null));
        return wrap;
      }
      stops.forEach(function (st) {
        var b = el('button', 'stoplist__item');
        b.type = 'button';
        if (st.stop_id === start.stop_id) b.classList.add('is-on');
        b.appendChild(el('span', 'stoplist__name', st.stop_name));
        if (st.is_timepoint) b.appendChild(el('span', 'stoplist__tag', 'timepoint'));
        b.addEventListener('click', function () { opts.onPickStartStop(st.stop_id); });
        wrap.appendChild(b);
      });
      return wrap;
    }, !start.stop_id));

    if (!start.stop_id) return host;

    var rows = watchLib.departuresAt(dep, start.stop_id, start.direction_id);
    host.appendChild(step(n++, 'Departure', null, function () {
      var wrap = el('div', 'timegrid');
      if (!rows.length) {
        wrap.appendChild(S.notice('empty', 'Nothing is scheduled at this stop today.',
          'Pick another stop, or check back when the schedule changes.'));
        return wrap;
      }
      rows.forEach(function (r) {
        var b = el('button', 'timegrid__item');
        b.type = 'button';
        b.appendChild(el('span', 'timegrid__time',
          fmt.serviceClock(watchLib.clockOf(r.seconds))));
        if (r.trip.is_special) b.appendChild(el('span', 'timegrid__tag', 'special'));
        b.setAttribute('aria-label', fmt.serviceClock(watchLib.clockOf(r.seconds)) +
          ' from ' + stopName(stops, start.stop_id) +
          (r.trip.is_special ? ', special run' : ''));
        b.addEventListener('click', function () {
          opts.onPickStartDeparture({
            route_id: String(start.route_id),
            direction_id: start.direction_id,
            direction_tag: fmt.directionTag(r.trip.headsign, start.direction_id),
            stop_id: start.stop_id,
            stop_name: stopName(stops, start.stop_id),
            scheduled_time: watchLib.clockOf(r.seconds)
          }, dep.day_type);
        });
        wrap.appendChild(b);
      });
      return wrap;
    }, true));

    return host;
  }






  global.CMB.chain = {
    STORE_KEY: STORE_KEY,
    WALK_RADIUS_M: WALK_RADIUS_M,
    WALK_SPEED_MS: WALK_SPEED_MS,
    WALK_CIRCUITY: WALK_CIRCUITY,
    MIN_SLACK_S: MIN_SLACK_S,
    MAX_WAIT_S: MAX_WAIT_S,
    TIGHT_S: TIGHT_S,
    MAX_LEGS: MAX_LEGS,
    BEFORE_S: BEFORE_S,
    AFTER_S: AFTER_S,
    UNGRADED_HOLD_S: UNGRADED_HOLD_S,
    list: list,
    add: add,
    remove: remove,
    keyFor: keyFor,
    isWellFormed: isWellFormed,
    routesIn: routesIn,
    metres: metres,
    walkSeconds: walkSeconds,
    walkFor: walkFor,
    stopIndex: stopIndex,
    downstreamStops: downstreamStops,
    tripTimeAt: tripTimeAt,
    tripIndexOf: tripIndexOf,
    connections: connections,
    connectionsFor: connectionsFor,
    resolveLeg: resolveLeg,
    resolveTransfer: resolveTransfer,
    resolve: resolve,
    slackText: slackText,
    minutesWord: minutesWord,
    connectionDetail: connectionDetail,
    assumptionNote: assumptionNote,
    describe: describe,
    routeSummary: routeSummary,
    sortModels: sortModels,
    render: render,
    renderEditor: renderEditor,
    legFromConnection: legFromConnection
  };
})(window);
