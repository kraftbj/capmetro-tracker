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

  var STORE_KEY = 'cmb.chains';

  /* ---- the numbers that decide whether a connection is offered ---------- */

  /*
   * How far a transfer may walk. 300 m is about a four minute walk and it is
   * chosen from the feed rather than from a standard: every real connection this
   * household makes lands under 100 m, and the widest genuine one — 7th/Calles
   * across to the MetroRapid platform — is 215 m. Beyond 300 m the pairs stop
   * being transfers and start being coincidences of geography, and a picker full
   * of coincidences is a picker nobody reads.
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
   * The least slack a connection may be built with. Below two minutes it is not a
   * connection, it is a coin toss, and offering it in the editor would make the
   * board complicit in a missed bus.
   */
  var MIN_SLACK_S = 120;

  /*
   * The most a connection may wait. Forty-five minutes is generous, deliberately:
   * on the suburban half of this network the real 337-to-350 connection waits
   * twenty-one minutes and a tighter cap would have called it impossible. Past
   * this it is not a connection either, it is two trips that happen to share a
   * kerb.
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

  /* The watch window, and the same reasoning: before it a chain is a plan, inside
   * it a chain is news. Measured from the FIRST leg's departure. */
  var BEFORE_S = 3600;

  /* Measured from the LAST leg's arrival, not the first leg's departure: a chain
   * is not over until the last bus has been and gone. */
  var AFTER_S = 900;

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

  function add(chain) {
    var all = list();
    var k = keyFor(chain);
    if (all.filter(function (x) { return keyFor(x) === k; }).length) return all;
    all.push(chain);
    writeStore(all);
    return all;
  }

  function remove(k) {
    var all = list().filter(function (x) { return keyFor(x) !== k; });
    writeStore(all);
    return all;
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

  /* Always rounded up. A transfer that needs 66.4 seconds of walking needs 67. */
  function walkSeconds(distanceM) {
    if (distanceM === null || distanceM === undefined) return null;
    return Math.ceil(distanceM / WALK_SPEED_MS);
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
          if (row.seconds > ready + MAX_WAIT_S) return;
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

    out.vehicle = watchLib.vehicleForTrip(route, out.trip.id);
    if (out.vehicle) {
      out.view = adhLib.view(out.vehicle, route && route.staleness);
      /*
       * `seconds` is null whenever the feed will not stand behind a number —
       * an unknown state, a deadhead, or adherence suppressed for staleness. A
       * null is not a zero: treating it as "on time" would print a confident
       * prediction built on nothing, which is the one thing a board like this
       * must not do.
       */
      if (out.view.seconds !== null && out.view.seconds !== undefined) {
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
  function resolveTransfer(prev, next, prevDep) {
    var out = {
      state: 'unknown',
      alight_stop_id: next.leg.alight_stop_id,
      alight_stop_name: next.leg.alight_stop_name || next.leg.alight_stop_id,
      walk_m: typeof next.leg.walk_m === 'number' ? next.leg.walk_m : null,
      walk_s: typeof next.leg.walk_s === 'number' ? next.leg.walk_s
        : walkSeconds(next.leg.walk_m),
      alight_at: null,
      predicted_alight_at: null,
      board_at: next.board_at,
      predicted_board_at: next.predicted_board_at,
      slack_s: null,
      scheduled_slack_s: null,
      assumed: []
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

    var walk = out.walk_s === null ? 0 : out.walk_s;
    out.scheduled_slack_s = out.board_at - out.alight_at - walk;
    out.slack_s = out.predicted_board_at - out.predicted_alight_at - walk;

    if (prev.lateness === null) out.assumed.push('arriving');
    if (next.lateness === null) out.assumed.push('onward');

    if (out.slack_s < 0) out.state = 'missed';
    else if (out.slack_s < TIGHT_S) out.state = 'tight';
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

    var transfers = [];
    for (var i = 1; i < resolvedLegs.length; i++) {
      transfers.push(resolveTransfer(resolvedLegs[i - 1], resolvedLegs[i],
        deps[resolvedLegs[i - 1].leg.route_id]));
    }
    base.transfers = transfers;

    if (transfers.filter(function (t) { return t.state === 'broken'; }).length) {
      return extend(base, { state: 'broken',
        detail: 'One of the buses in this chain no longer stops where the change was made. ' +
          'The schedule has changed since this was saved.' });
    }

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
      shifted: resolvedLegs.filter(function (r) { return r.shifted; }).length > 0,
      is_special: resolvedLegs.filter(function (r) { return r.trip && r.trip.is_special; }).length > 0
    });

    if (now > endAt + AFTER_S) model.state = 'passed';
    else if (now < first.board_at - BEFORE_S) model.state = 'upcoming';
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

  var TRANSFER_RANK = { missed: 0, tight: 1, broken: 2, unknown: 3, made: 4 };

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
    unknown: 'Connection unknown'
  };

  /*
   * The sentence under the verdict. Each state gets its own, because "tight" and
   * "missed" call for completely different actions and a shared phrasing would
   * blur the one distinction the card is for.
   */
  function connectionDetail(t) {
    if (!t) return '';
    var walk = t.walk_m === null ? '' :
      (t.walk_m === 0 ? 'Same stop' : 'A ' + t.walk_m + ' m walk') + ' at ' + t.alight_stop_name + '. ';
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
    return walk + 'Not enough is known about these buses to say.';
  }

  /*
   * Which halves of the sum are measured and which are assumed. Said out loud
   * because a prediction built partly on a timetable is a weaker claim than one
   * built on two buses being watched, and the reader is entitled to know which
   * one they are looking at.
   */
  function assumptionNote(t) {
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
       * can check the arithmetic rather than take it on trust. Predicted where
       * there is a prediction; the scheduled pair is what the walk is measured
       * between when there is not.
       */
      row.appendChild(el('p', 'chaincard__transfertimes',
        'In ' + fmt.clock(t.predicted_alight_at) + ' · out ' +
        fmt.clock(t.predicted_board_at) +
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
        model.state === 'upcoming' || model.state === 'passed') {
      var line = el('p', 'chaincard__line');
      if (model.state === 'passed') {
        line.textContent = 'Gone · ' + watchLib.untilText(model.seconds_until);
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

  /* Everything the verdict colour and the badge carry, said in words. */
  function spoken(model) {
    var head = describe(model.chain) + '. ';
    if (model.state === 'passed') return head + 'Already gone.';
    if (model.state === 'upcoming') return head + 'Due ' + fmt.clockSpoken(model.due_at) + '.';
    if (model.state === 'live' || model.state === 'no-vehicle') {
      var t = model.connection;
      return head + 'Due ' + fmt.clockSpoken(model.due_at) + '. ' +
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
    live: 0, 'no-vehicle': 1, upcoming: 2, passed: 3,
    broken: 4, 'not-today': 5, 'no-schedule': 6
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

  function step(n, label, chosen, build, open) {
    var box = el('section', 'step' + (open ? ' step--open' : ''));
    var head = el('p', 'step__head');
    head.appendChild(el('span', 'step__n', String(n)));
    head.appendChild(el('span', 'step__label', label));
    if (chosen) head.appendChild(el('span', 'step__chosen', chosen));
    box.appendChild(head);
    if (open && build) box.appendChild(build());
    return box;
  }

  function cleanName(s) { return String(s || '').replace(/^\d+-/, ''); }

  function routeLabel(routes, id) {
    var r = routes.filter(function (x) { return x.id === id; })[0];
    return r ? (r.short_name || r.id) + ' · ' + cleanName(r.long_name) : String(id);
  }

  function dirLabel(dirs, id) {
    var d = dirs.filter(function (x) { return x.id === id; })[0];
    return d && d.headsign ? d.headsign : 'Direction ' + id;
  }

  function stopName(stops, id) {
    var s = stops.filter(function (x) { return x.stop_id === id; })[0];
    return s ? s.stop_name : id;
  }

  global.CMB.chain = {
    STORE_KEY: STORE_KEY,
    WALK_RADIUS_M: WALK_RADIUS_M,
    WALK_SPEED_MS: WALK_SPEED_MS,
    MIN_SLACK_S: MIN_SLACK_S,
    MAX_WAIT_S: MAX_WAIT_S,
    TIGHT_S: TIGHT_S,
    MAX_LEGS: MAX_LEGS,
    BEFORE_S: BEFORE_S,
    AFTER_S: AFTER_S,
    list: list,
    add: add,
    remove: remove,
    keyFor: keyFor,
    isWellFormed: isWellFormed,
    routesIn: routesIn,
    metres: metres,
    walkSeconds: walkSeconds,
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
