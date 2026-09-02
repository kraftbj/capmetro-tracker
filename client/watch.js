/*
 * watch.js — saved trips. "The 7:50a 800 SB from Simond/Berkman", kept, and
 * answered from about an hour before until after the bus has cleared the stop.
 *
 * This is the question that actually gets asked most mornings. Answering it on the
 * route board means picking the route, picking the direction, then reading the
 * ladder to work out which of several buses is the right one — arithmetic at the
 * exact moment nobody wants to do arithmetic.
 *
 * WHY RESOLUTION HAPPENS HERE AND NOT ON THE SERVER
 *
 * The runtime can resolve a watch (runtime/lib/watch.php) and writes one file per
 * watch to api/watch/{id}.json. It only does that for watches listed in the server
 * config, which is the wrong shape for a saved trip: a static client cannot add a
 * line to a PHP config file, so no watch a reader creates would ever be resolved.
 *
 * So the client resolves its own. It needs two documents it can already fetch:
 * api/departures/{route}.json for what is scheduled at that stop all service day,
 * and api/route/{route}.json for where the buses are now. Everything below is a
 * join between those two, and every watch stays entirely in this browser.
 *
 * WHY THE ID IS NOT A HASH HERE
 *
 * Contract section 9 hashes the tuple so a URL or an access log never carries a
 * legible description of a child's routine. That reasoning is about the server's
 * filesystem and the network. These watches never reach either: they live in
 * localStorage and are never put in a URL. A plain tuple key is honest about what
 * it is, and hashing it locally would be theatre — the readable original would be
 * sitting in the same store. If a watch ever becomes shareable, it needs the hash
 * and this comment needs deleting.
 */
(function (global) {
  'use strict';

  var fmt = global.CMB.fmt;
  var adhLib = global.CMB.adherence;
  var S = global.CMB.states;
  var el = S.el;

  var STORE_KEY = 'cmb.watches';

  /*
   * The window the reader asked for: "from ~an hour before until after the bus
   * makes that stop". Before it opens, a watch is a plan; inside it, a watch is
   * news. AFTER_S is generous because a very late bus has not "passed" just
   * because its scheduled time has.
   */
  var BEFORE_S = 3600;
  var AFTER_S = 900;

  /* A schedule can shift by a minute or two between feed versions without the trip
   * being a different trip. Beyond this, treat it as a different departure and say
   * so rather than silently watching a bus the reader did not choose. */
  var DRIFT_TOLERANCE_S = 600;

  /* ---- storage --------------------------------------------------------- */

  /* Both readers of untrusted shapes want this: the stored watch list, which the
   * reader can edit by hand, and a departures row set reached by a stop id off
   * the URL. It was written out twice before rowsFor arrived. */
  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function readStore() {
    try {
      var raw = global.localStorage.getItem(STORE_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return isArray(list) ? list : [];
    } catch (e) {
      /* Private mode, disabled storage, or a corrupted value. An unreadable store
       * is an empty one; it must never take the board down with it. */
      return [];
    }
  }

  function writeStore(list) {
    try {
      global.localStorage.setItem(STORE_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      return false;
    }
  }

  function keyFor(w) {
    return [w.route_id, w.direction_id, w.stop_id, w.scheduled_time, w.day_type].join('|');
  }

  function list() {
    return readStore().filter(function (w) {
      return w && w.route_id && w.stop_id && w.scheduled_time && w.day_type;
    });
  }

  /*
   * Returns whether the store now holds the watch, not just the new list.
   *
   * writeStore already reports a refusal — Safari private browsing, an exhausted
   * quota, storage switched off — and every caller used to discard it, so the UI
   * announced "saved" on a write that did not happen and the trip was gone on the
   * next load. That is the failure this board is otherwise careful about: not
   * that something broke, but that the interface said it worked.
   */
  function add(w) {
    var all = list();
    var k = keyFor(w);
    if (all.filter(function (x) { return keyFor(x) === k; }).length) {
      return { list: all, saved: true };   /* already there; nothing to write */
    }
    all.push(w);
    return { list: all, saved: writeStore(all) };
  }

  /*
   * Reports whether the store actually dropped it, for the same reason add()
   * does — and with more at stake.
   *
   * A refused save loses something the reader wanted kept. A refused DELETE keeps
   * something the reader asked to destroy, and what it keeps is a legible
   * statement of which stop a child stands at, at what time, on which days. On a
   * borrowed or shared phone that is the whole of the harm.
   *
   * What the reader saw before this was a dead button: the card stayed, nothing
   * moved, nothing was said. Every render rebuilds the list from a fresh read of
   * the store — `list()`, not the array returned here — so a write that did not
   * happen simply does not show up. The `list` in the return shape is read by
   * the tests and by nothing in the client, and it should stay that way: a
   * render path that trusted it INSTEAD of the store is what would produce the
   * vanishing card this comment used to describe.
   *
   * Private browsing is not the case here — nothing was written to delete. The
   * cases are an exhausted quota, or storage switched to read-only mid-session.
   */
  function remove(k) {
    var all = list().filter(function (x) { return keyFor(x) !== k; });
    return { list: all, removed: writeStore(all) };
  }

  /* ---- pure helpers ---------------------------------------------------- */

  /*
   * Seconds since the start of the service day back to a GTFS clock string. Hours
   * past 24 are kept rather than wrapped: 25:10:00 is a real and different
   * departure from 01:10:00, and wrapping it would silently match the wrong trip.
   */
  function clockOf(seconds) {
    var s = Math.max(0, Math.round(seconds));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return pad(h) + ':' + pad(m) + ':' + pad(sec);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function secondsOf(clock) {
    var bits = String(clock || '').split(':');
    if (bits.length < 2) return null;
    var h = parseInt(bits[0], 10);
    var m = parseInt(bits[1], 10);
    var s = bits.length > 2 ? parseInt(bits[2], 10) : 0;
    if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
    return h * 3600 + m * 60 + s;
  }

  /*
   * The rows at one stop, looked up the only way that is safe.
   *
   * `departures[stopId]` is a bare lookup on a plain object parsed from JSON, so
   * it also reaches Object.prototype. A stop id of `constructor` returns the
   * Object function: truthy, so an `|| []` fallback never fires, with a `.length`
   * of 1 and no element at [0]. The next line reads `rows[0][1]` and throws, and
   * because that happens during render the whole board goes blank.
   *
   * The stop id is not always internal. app.js takes `?stop=` straight from the
   * query string, so any link can choose it. The guard belongs here, at the one
   * lookup every caller goes through, rather than in whichever caller happens to
   * be holding an untrusted id today.
   */
  function rowsFor(departures, stopId) {
    if (!departures) return [];
    if (!Object.prototype.hasOwnProperty.call(departures, stopId)) return [];
    var rows = departures[stopId];
    return isArray(rows) ? rows : [];
  }

  /*
   * Every departure at one stop, in the watched direction, as {seconds, trip}.
   * The departures document keys by stop_id alone because a stop can be served in
   * both directions; the direction filter is the trip's, not the stop's.
   */
  function departuresAt(dep, stopId, directionId) {
    if (!dep || !dep.departures) return [];
    var rows = rowsFor(dep.departures, stopId);
    var trips = dep.trips || [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var trip = trips[rows[i][1]];
      if (!trip) continue;
      if (directionId !== null && directionId !== undefined && trip.direction_id !== directionId) continue;
      out.push({ seconds: rows[i][0], trip: trip });
    }
    return out;
  }

  /*
   * The departure a saved watch names. Exact clock match first, because that is
   * what the reader picked. A near match is accepted within DRIFT_TOLERANCE_S and
   * reported as shifted, so a schedule change reads as "your 7:50 is 7:52 now"
   * rather than as the watch quietly breaking.
   */
  function matchDeparture(rows, scheduledTime) {
    var want = secondsOf(scheduledTime);
    if (want === null) return null;
    var best = null;
    var bestDistance = Infinity;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].seconds === want) return { row: rows[i], shifted: false, drift: 0 };
      /*
       * `distance` is how far away, `drift` is which way — and they must be kept apart.
       * Comparing an unsigned distance against a stored signed drift makes every earlier
       * departure look infinitely near, so a watch saved for 7:51 matched the 7:42 bus
       * instead of the 7:52 one standing right next to it.
       */
      var distance = Math.abs(rows[i].seconds - want);
      if (distance <= DRIFT_TOLERANCE_S && distance < bestDistance) {
        bestDistance = distance;
        best = { row: rows[i], shifted: true, drift: rows[i].seconds - want };
      }
    }
    return best;
  }

  function vehicleForTrip(route, tripId) {
    var vs = (route && route.vehicles) || [];
    for (var i = 0; i < vs.length; i++) {
      if (vs[i].trip && vs[i].trip.trip_id === tripId) return vs[i];
    }
    return null;
  }

  /* ---- resolution ------------------------------------------------------ */

  /*
   * The whole feature in one pure function, so it is testable without a DOM and so
   * the states below are enumerated rather than emerging from render order.
   *
   * Every branch returns a `state` the UI has copy for. There is deliberately no
   * default: a watch that cannot be resolved must say which of the several very
   * different reasons applies, because "no bus" and "wrong day" and "this stop is
   * closed today" call for completely different actions from a parent.
   */
  /*
   * Whether the agency has called this trip off, reading BOTH carriers.
   *
   * `trip.canceled` rides api/departures/{route}.json, which the client fetches
   * once and keeps: contract section 16 declares that document free of realtime
   * fields precisely so it can be cached to the end of the service day, and
   * 0.4.0.0 then added one to it. The two facts are incompatible, and the cached
   * copy is the side that loses -- a trip canceled at 10:05 for a 10:13
   * departure cannot reach a tab opened at 07:00. That is the same failure the
   * cancellation work existed to close, on a longer fuse: it works when you open
   * the page after the cancellation publishes, and not when you leave it open.
   *
   * `route.schedule.canceled_trips` is rebuilt from the live TripUpdates on
   * every generator run, so it carries what the cached document cannot. It is
   * scoped to the schedule window (-15/+45 minutes), which is where the
   * near-term answers this guards are drawn from anyway.
   *
   * A union, not a replacement. The cached list still covers a trip canceled
   * before the page loaded that has since aged out of the live window, and the
   * live list covers everything announced since. Neither alone is enough.
   */
  function isCanceled(trip, route) {
    if (!trip) { return false; }
    if (trip.canceled) { return true; }
    var live = route && route.schedule && route.schedule.canceled_trips;
    if (!live || !live.length) { return false; }
    var id = String(trip.id);
    for (var i = 0; i < live.length; i++) {
      if (String(live[i]) === id) { return true; }
    }
    return false;
  }

  /*
   * ---- who is going to run this trip ------------------------------------
   *
   * A departure with no bus joined to it was rendered "no bus reporting yet", which
   * reads as "it has not started". That sentence covers three states that call for
   * completely different actions from someone standing at the stop, and it is the same
   * flattening that once rendered a CANCELED trip as "not reporting" and left a kid
   * waiting for a bus that was never coming. One level down, the same harm:
   *
   *   2026-09-01, the 16:49 run on block 4091. The board said "no bus reporting yet" at
   *   16:49, at 16:55, at 16:59. CapMetro published the cancellation at 16:59, ten
   *   minutes after the bus was due out. For those ten minutes the board's sentence was
   *   indistinguishable from the one it prints for a bus that is simply early in its
   *   layover, and somebody stood at 5th/West Lynn reading it.
   *
   * What the board can actually know, given `block_id` on every trip in the departures
   * document and `block` on every live vehicle:
   *
   *   live       — a bus is on this trip right now. Nothing to infer.
   *   inbound    — no bus on THIS trip, but one is working this block on an earlier run.
   *                It exists, it is out, and it is coming. Naming it is the difference
   *                between "no bus reporting yet" and "2810 is two runs away".
   *   unassigned — no bus anywhere on this block, and this trip is not due out yet. The
   *                honest state for a fresh pull-out: nobody can name the vehicle,
   *                CapMetro's own app included, because the assignment does not exist
   *                until a bus starts reporting. Benign, and it must not read as alarm.
   *   overdue    — no bus anywhere on this block and this trip's own start time has
   *                PASSED. This is the one that is news. It does not claim a
   *                cancellation, because we have not been told of one; it states the
   *                observation, which is already more than the feed is saying.
   *   unknown    — we may not say. No route document, a stale feed, or a trip with no
   *                block. A dead feed and a dead bus produce the identical observation
   *                — no vehicle — and calling that overdue would read the silence of a
   *                broken feed as news about a bus.
   *
   * `unknown` is checked FIRST and deliberately. Every other state here is an assertion
   * about the world, and none of them may be made from a snapshot that stopped updating.
   */

  /* A bus can begin reporting a little after its booked start without anything being
     wrong. Below this it is a layover; above it, the trip is late to exist. */
  var OVERDUE_GRACE_S = 120;

  /*
   * The longest gap between two of a block's runs on one route that still reads as a
   * layover. Above it the block was plausibly away on another route, where this route's
   * payload cannot see its bus, and no claim about a missing bus may be made.
   */
  var INTERLINE_GAP_S = 5400;

  function tripStartEpoch(dep, trip) {
    if (!dep || !trip) { return null; }
    var s = secondsOf(trip.start_time);
    if (s === null || dep.service_day_start_epoch === undefined) { return null; }
    return dep.service_day_start_epoch + s;
  }

  /* Every trip of one block on this route, in running order. */
  function tripsInBlock(dep, blockId) {
    if (!dep || !blockId) { return []; }
    return ((dep && dep.trips) || []).filter(function (t) {
      return String(t.block_id) === String(blockId);
    }).sort(function (a, b) {
      return (secondsOf(a.start_time) || 0) - (secondsOf(b.start_time) || 0);
    });
  }

  /*
   * How many runs sit between the bus and this trip, or null when it cannot be counted.
   *
   * Counted over this route's trips only, which is all the departures document holds.
   * A block that interlines is away on another route for part of its day, so the count
   * is unavailable rather than wrong: null prints "is working this block" and a number
   * prints "two runs away", and inventing a number from a partial list would be the
   * second kind of sentence built on the first kind of knowledge.
   */
  function runsAhead(dep, vehicle, trip) {
    var current = vehicle && vehicle.trip && vehicle.trip.trip_id;
    if (!current) { return null; }
    var seq = tripsInBlock(dep, trip.block_id);
    var from = -1, to = -1;
    for (var i = 0; i < seq.length; i++) {
      if (String(seq[i].id) === String(current)) { from = i; }
      if (String(seq[i].id) === String(trip.id)) { to = i; }
    }
    if (from === -1 || to === -1 || to <= from) { return null; }
    return to - from;
  }

  function vehiclesOnBlock(route, blockId) {
    if (!blockId) { return []; }
    return ((route && route.vehicles) || []).filter(function (v) {
      return v.block && String(v.block.block_id) === String(blockId);
    });
  }

  function coverageFor(dep, route, trip, now) {
    var out = {
      state: 'unknown', vehicle: null, runs_ahead: null,
      start_epoch: tripStartEpoch(dep, trip), overdue_s: null
    };
    if (!trip || !route) { return out; }
    /* A snapshot that has stopped updating cannot say a bus is missing. */
    if (route.staleness && route.staleness.suppress_adherence) { return out; }

    var onIt = vehicleForTrip(route, trip.id);
    if (onIt) { out.state = 'live'; out.vehicle = onIt; return out; }

    if (!trip.block_id) { return out; }

    /*
     * The successor claim first, because it is exact: a vehicle publishing
     * next_trip.trip_id for this trip is one run away by the build's own chaining.
     * The block match behind it catches the same bus further out, where there is no
     * published claim to read.
     */
    var mates = vehiclesOnBlock(route, trip.block_id);
    var claimant = null;
    for (var i = 0; i < mates.length; i++) {
      var nt = mates[i].block && mates[i].block.next_trip;
      if (nt && String(nt.trip_id) === String(trip.id)) { claimant = mates[i]; break; }
    }
    if (claimant) {
      out.state = 'inbound'; out.vehicle = claimant; out.runs_ahead = 1;
      return out;
    }
    if (mates.length) {
      out.state = 'inbound'; out.vehicle = mates[0];
      out.runs_ahead = runsAhead(dep, mates[0], trip);
      return out;
    }

    /* Nothing is on this block. Only the clock separates "not out yet" from news. */
    if (out.start_epoch === null || now === null || now === undefined) { return out; }
    if (now <= out.start_epoch + OVERDUE_GRACE_S) { out.state = 'unassigned'; return out; }

    /*
     * Past its time with nothing on the block — but "nothing on the block" is read from
     * THIS ROUTE's vehicle list, and an interlined block spends part of its day on
     * another route where this payload cannot see it. Block 1010 leaves route 4 at 16:19
     * and works route 1 until midnight; a route 4 trip it returned for would look
     * abandoned while the bus was running perfectly well two routes over, and a late
     * bus wrongly reported missing is the same class of lie as a missing bus reported
     * on time.
     *
     * So `overdue` is claimed only where the block cannot be somewhere else:
     *
     *   - the trip is the block's FIRST of the day. A pull-out has no prior work, so
     *     there is nowhere else for it to be. This is the 4091 case, and the one that
     *     went unannounced for ten minutes on 2026-09-01.
     *   - or the block's previous run on this route was recent enough to be a layover
     *     rather than an excursion. Consecutive same-route runs sit 30-60 minutes apart
     *     by start time; an interline gap is hours. Beyond the threshold we do not know,
     *     and `unknown` is the honest answer.
     */
    var seq = tripsInBlock(dep, trip.block_id);
    var idx = -1;
    for (var j = 0; j < seq.length; j++) {
      if (String(seq[j].id) === String(trip.id)) { idx = j; break; }
    }
    if (idx > 0) {
      var prev = secondsOf(seq[idx - 1].start_time);
      var mine = secondsOf(trip.start_time);
      if (prev === null || mine === null || mine - prev > INTERLINE_GAP_S) { return out; }
    }

    out.state = 'overdue';
    out.overdue_s = now - out.start_epoch;
    return out;
  }

  function resolve(watch, dep, route, now) {
    var base = { watch: watch, key: keyFor(watch) };

    if (!dep) {
      return extend(base, { state: 'no-schedule',
        detail: 'The schedule for route ' + watch.route_id + ' has not loaded yet.' });
    }
    if (dep.day_type !== watch.day_type) {
      return extend(base, { state: 'not-today',
        detail: 'Saved for a ' + watch.day_type + '. Today is a ' + dep.day_type + '.' });
    }

    var rows = departuresAt(dep, watch.stop_id, watch.direction_id);
    if (!rows.length) {
      return extend(base, { state: 'unserved',
        detail: 'No trip serves this stop in this direction today.' });
    }

    var match = matchDeparture(rows, watch.scheduled_time);
    if (!match) {
      return extend(base, { state: 'unresolved',
        detail: 'Nothing leaves this stop at ' + fmt.serviceClock(watch.scheduled_time) +
          ' today. The schedule may have changed.' });
    }

    var trip = match.row.trip;
    var scheduledAt = dep.service_day_start_epoch + match.row.seconds;

    /*
     * Before anything else. A canceled trip has no vehicle, so every check
     * below it would conclude "no bus is reporting on this trip yet" - which
     * reads as "it has not started" when it means "it is never coming". That
     * exact sentence was on screen while a kid waited at a stop.
     */
    if (isCanceled(trip, route)) {
      return extend(base, {
        state: 'canceled',
        trip: trip,
        scheduled_at: scheduledAt,
        due_at: scheduledAt,
        seconds_until: scheduledAt - now,
        detail: 'CapMetro has canceled this trip. No bus is running it today.'
      });
    }
    var vehicle = vehicleForTrip(route, trip.id);
    var view = vehicle ? adhLib.view(vehicle, route && route.staleness) : null;
    var lateness = view && view.seconds !== null && view.seconds !== undefined ? view.seconds : null;
    var predictedAt = lateness === null ? null : scheduledAt + lateness;
    var dueAt = predictedAt === null ? scheduledAt : predictedAt;

    var model = extend(base, {
      trip: trip,
      vehicle: vehicle,
      view: view,
      shifted: match.shifted,
      drift: match.drift,
      scheduled_at: scheduledAt,
      predicted_at: predictedAt,
      due_at: dueAt,
      seconds_until: dueAt - now,
      is_special: !!trip.is_special
    });

    if (now > dueAt + AFTER_S) {
      model.state = 'passed';
    } else if (now < scheduledAt - BEFORE_S) {
      model.state = 'upcoming';
    } else if (!vehicle) {
      model.state = 'no-vehicle';
    } else {
      model.state = 'live';
    }
    return model;
  }

  function extend(a, b) {
    for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k];
    return a;
  }

  /* ---- how long until, in words ---------------------------------------- */

  /*
   * Never a bare number of minutes for something hours away — "in 137 min" is not
   * a thing anyone reads at 6am. Under an hour it is minutes, because that is when
   * minutes are the unit you act on.
   */
  function untilText(seconds) {
    if (seconds === null || seconds === undefined) return '';
    var s = Math.round(seconds);
    if (s < -60) return fmt.plural(Math.round(-s / 60), 'minute', 'minutes') + ' ago';
    if (s < 60) return 'now';
    var m = Math.round(s / 60);
    if (m < 60) return 'in ' + fmt.plural(m, 'minute', 'minutes');
    var h = Math.floor(m / 60);
    var rem = m % 60;
    return 'in ' + h + 'h' + (rem ? ' ' + rem + 'm' : '');
  }

  /* ---- render ---------------------------------------------------------- */

  function describe(w) {
    return fmt.serviceClock(w.scheduled_time) + ' route ' + w.route_id + ' ' +
      (w.direction_tag || (w.direction_id === 0 ? 'A' : 'B')) + ' from ' + w.stop_name;
  }

  function card(model, opts) {
    var w = model.watch;
    var box = el('article', 'watchcard watchcard--' + model.state);

    var head = el('div', 'watchcard__head');
    var title = el('p', 'watchcard__title');
    title.appendChild(el('span', 'watchcard__time', fmt.serviceClock(w.scheduled_time)));
    title.appendChild(el('span', 'watchcard__route', w.route_id));
    title.appendChild(el('span', 'watchcard__dir', w.direction_tag ||
      (w.direction_id === 0 ? 'A' : 'B')));
    head.appendChild(title);
    head.appendChild(el('p', 'watchcard__stop', w.stop_name));
    box.appendChild(head);

    var line = el('p', 'watchcard__line');

    if (model.state === 'live' && model.view) {
      /*
       * The one line the whole feature exists to print. It leads with the answer
       * — when the bus will actually be here — and puts the schedule second,
       * because a parent needs the prediction and can infer the delay from it.
       */
      line.appendChild(el('span', 'watchcard__due', fmt.clock(model.due_at)));
      line.appendChild(el('span', 'watchcard__until', untilText(model.seconds_until)));
      box.appendChild(line);
      box.appendChild(adhLib.badge(model.view));
      /*
       * The scheduled time is second, and stays second even when there is no
       * prediction to lead with. A reader standing at a stop needs to know when
       * the bus comes; the schedule is context for that number, not a substitute
       * they should have to subtract from.
       */
      box.appendChild(el('p', 'watchcard__detail',
        'Scheduled ' + fmt.clock(model.scheduled_at) + ' · ' + model.view.label));
      box.appendChild(el('p', 'watchcard__bus',
        'Bus ' + (model.vehicle.label || model.vehicle.vehicle_id)));
    } else if (model.state === 'no-vehicle') {
      line.textContent = fmt.clock(model.scheduled_at) + ' · ' + untilText(model.seconds_until);
      box.appendChild(line);
      box.appendChild(el('p', 'watchcard__detail',
        'No bus is reporting on this trip yet. That is normal until it starts its run, ' +
        'and it means there is no lateness to show — not that the trip is canceled.'));
    } else if (model.state === 'upcoming') {
      line.textContent = fmt.clock(model.scheduled_at) + ' · ' + untilText(model.seconds_until);
      box.appendChild(line);
      box.appendChild(el('p', 'watchcard__detail',
        'Tracking starts an hour before it is due.'));
    } else if (model.state === 'canceled') {
      line.appendChild(el('span', 'watchcard__canceled', 'CANCELED'));
      box.appendChild(line);
      box.appendChild(el('p', 'watchcard__detail', model.detail));
    } else if (model.state === 'passed') {
      line.textContent = 'Gone · ' + untilText(model.seconds_until);
      box.appendChild(line);
      box.appendChild(el('p', 'watchcard__detail',
        'Due ' + fmt.clock(model.due_at) + '. Back tomorrow.'));
    } else {
      line.textContent = 'Nothing to show';
      box.appendChild(line);
      box.appendChild(el('p', 'watchcard__detail', model.detail || ''));
    }

    if (model.shifted) {
      box.appendChild(el('p', 'watchcard__note',
        'Saved as ' + fmt.serviceClock(w.scheduled_time) + '; today it leaves ' +
        fmt.serviceClock(clockOf(secondsOf(w.scheduled_time) + model.drift)) + '.'));
    }
    if (model.is_special) {
      box.appendChild(el('p', 'watchcard__note',
        'This is a special run. It does not follow the route’s usual pattern of stops.'));
    }

    /* Everything the badge and the state class carry, said in words. */
    var spoken = describe(w) + '. ' +
      (model.state === 'live'
        ? 'Due ' + fmt.clockSpoken(model.due_at) + ', ' + model.view.spoken + '.'
        : model.state === 'canceled' ? 'Canceled. No bus is running this trip today.'
          : model.state === 'passed' ? 'Already gone.'
          : model.state === 'upcoming' ? 'Due ' + fmt.clockSpoken(model.scheduled_at) + '.'
            : (model.detail || 'Nothing to show.'));
    var sr = el('p', 'sr-only', spoken);
    box.appendChild(sr);

    var del = el('button', 'watchcard__remove');
    del.type = 'button';
    del.textContent = 'Remove';
    del.setAttribute('aria-label', 'Remove the saved trip ' + describe(w));
    del.addEventListener('click', function () {
      var res = remove(model.key);
      /* The trip goes with the result: the announcement has to name what left,
       * and this is the only place that still knows. */
      if (opts && opts.onChange) opts.onChange(res, w);
    });
    box.appendChild(del);

    return box;
  }

  /*
   * models is an array of resolve() results, already sorted by the caller: the
   * board decides order, this file decides appearance.
   */
  function render(host, models, opts) {
    opts = opts || {};
    S.clear(host);

    var head = el('p', 'band__head', 'Saved trips');
    host.appendChild(head);

    if (!models || !models.length) {
      host.appendChild(S.notice('empty',
        'No saved trips yet.',
        'Save a departure you wait for — a route, a stop and a time — and it will ' +
        'show up here from an hour before it is due until after it has gone.'));
      if (opts.onAdd) {
        var b = el('button', 'btn btn--primary');
        b.type = 'button';
        b.textContent = 'Save a trip';
        b.addEventListener('click', opts.onAdd);
        host.appendChild(b);
      }
      return host;
    }

    var listEl = el('div', 'watchlist');
    models.forEach(function (m) { listEl.appendChild(card(m, opts)); });
    host.appendChild(listEl);

    if (opts.onAdd) {
      var add = el('button', 'btn');
      add.type = 'button';
      add.textContent = 'Save another trip';
      add.addEventListener('click', opts.onAdd);
      host.appendChild(add);
    }
    return host;
  }

  /*
   * Sort order: what needs attention first. A bus that is due soon outranks one
   * due later, and anything already gone or not running today sinks. This is the
   * same principle the vehicle rows use — worst news first — applied to time.
   */
  function sortModels(models) {
    var RANK = { live: 0, canceled: 1, 'no-vehicle': 2, upcoming: 3, passed: 4, unresolved: 5, unserved: 6, 'not-today': 7, 'no-schedule': 8 };
    return models.slice().sort(function (a, b) {
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
   * Four choices in a fixed order: route, direction, stop, time. The order is not
   * arbitrary — each one narrows the next, and the last is a list of real
   * departures rather than a free text field. A time picker would let a reader
   * save 7:50 for a stop whose buses leave at 7:52 and 8:07, and the watch would
   * then be permanently "shifted" or permanently broken. Choosing from what is
   * actually scheduled makes an unresolvable watch impossible to create.
   *
   * state is owned by the caller and passed back in, so the editor is a pure
   * function of it. That keeps app.js the single owner of what is on screen.
   */
  function renderEditor(host, state, opts) {
    opts = opts || {};
    S.clear(host);
    host.appendChild(el('p', 'band__head', 'Save a trip'));

    var routes = state.routes || [];
    var dep = state.departures;

    /* 1. Route. */
    host.appendChild(step(1, 'Route', state.route_id
      ? routeLabel(routes, state.route_id) : null, function () {
      var grid = el('div', 'routegrid');
      routes.forEach(function (r) {
        var b = el('button', 'routegrid__item');
        b.type = 'button';
        if (r.id === state.route_id) b.classList.add('is-on');
        b.appendChild(el('span', 'routegrid__id', r.short_name || r.id));
        b.appendChild(el('span', 'routegrid__name', cleanName(r.long_name)));
        b.addEventListener('click', function () { opts.onPickRoute(r.id); });
        grid.appendChild(b);
      });
      return grid;
    }, state.route_id === null || state.route_id === undefined));

    if (state.route_id === null || state.route_id === undefined) return host;

    if (!dep) {
      /*
       * Same sentence, same reason, as the Next-buses notice in stopboard.js:
       * "it only loads once" stopped being true when the schedule started
       * expiring at the service-day roll, and this notice is exactly what a
       * reader sees at the moment it is provably false -- the editor is handed
       * usableDepartures(), so a withheld schedule lands here.
       */
      host.appendChild(S.notice('empty', 'Loading the schedule for route ' + state.route_id + '…',
        'One file for the whole service day. It is fetched again when the ' +
        'service day rolls over.'));
      return host;
    }

    /* 2. Direction. */
    var dirs = directionsOf(routes, state.route_id, dep);
    host.appendChild(step(2, 'Direction', state.direction_id === null ||
      state.direction_id === undefined ? null : dirLabel(dirs, state.direction_id), function () {
      var row = el('div', 'chiprow');
      dirs.forEach(function (d) {
        var b = el('button', 'chipbtn');
        b.type = 'button';
        if (d.id === state.direction_id) b.classList.add('is-on');
        b.textContent = d.headsign || ('Direction ' + d.id);
        b.addEventListener('click', function () { opts.onPickDirection(d.id); });
        row.appendChild(b);
      });
      return row;
    }, state.direction_id === null || state.direction_id === undefined));

    if (state.direction_id === null || state.direction_id === undefined) return host;

    /* 3. Stop, in the order the bus visits them. */
    var stops = stopsFor(dep, state.direction_id);
    host.appendChild(step(3, 'Stop', state.stop_id ? stopName(stops, state.stop_id) : null, function () {
      var wrap = el('div', 'stoplist');
      if (!stops.length) {
        wrap.appendChild(S.notice('empty', 'No stops in this direction today.', null));
        return wrap;
      }
      stops.forEach(function (st) {
        var b = el('button', 'stoplist__item');
        b.type = 'button';
        if (st.stop_id === state.stop_id) b.classList.add('is-on');
        b.appendChild(el('span', 'stoplist__name', st.stop_name));
        if (st.is_timepoint) b.appendChild(el('span', 'stoplist__tag', 'timepoint'));
        b.addEventListener('click', function () { opts.onPickStop(st.stop_id); });
        wrap.appendChild(b);
      });
      return wrap;
    }, !state.stop_id));

    if (!state.stop_id) return host;

    /* 4. Departure, from what is actually scheduled. */
    var rows = departuresAt(dep, state.stop_id, state.direction_id);
    host.appendChild(step(4, 'Departure', null, function () {
      var wrap = el('div', 'timegrid');
      if (!rows.length) {
        wrap.appendChild(S.notice('empty', 'Nothing is scheduled at this stop today.',
          'Pick another stop, or check back when the schedule changes.'));
        return wrap;
      }
      rows.forEach(function (r) {
        var b = el('button', 'timegrid__item');
        b.type = 'button';
        b.appendChild(el('span', 'timegrid__time', fmt.serviceClock(clockOf(r.seconds))));
        if (r.trip.is_special) b.appendChild(el('span', 'timegrid__tag', 'special'));
        b.setAttribute('aria-label', fmt.serviceClock(clockOf(r.seconds)) + ' from ' +
          stopName(stops, state.stop_id) + (r.trip.is_special ? ', special run' : ''));
        b.addEventListener('click', function () {
          opts.onSave({
            route_id: String(state.route_id),
            direction_id: state.direction_id,
            direction_tag: fmt.directionTag(r.trip.headsign, state.direction_id),
            stop_id: state.stop_id,
            stop_name: stopName(stops, state.stop_id),
            scheduled_time: clockOf(r.seconds),
            day_type: dep.day_type
          });
        });
        wrap.appendChild(b);
      });
      return wrap;
    }, true));

    host.appendChild(el('p', 'hint',
      'Saved for a ' + dep.day_type + '. Weekday, Saturday and Sunday run different ' +
      'schedules, so each one is its own saved trip.'));
    return host;
  }

  /* One numbered step: its answer when made, its choices when it is the open one. */
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

  /*
   * The directions the catalog publishes, falling back to the ones the departures
   * document's own trips report. The catalog is the better source because it
   * carries headsigns; the fallback keeps the editor usable for a route whose
   * catalog entry is thin rather than showing an empty step.
   */
  function directionsOf(routes, routeId, dep) {
    var r = routes.filter(function (x) { return x.id === routeId; })[0];
    if (r && r.directions && r.directions.length) return r.directions;
    var seen = {};
    ((dep && dep.trips) || []).forEach(function (t) {
      if (seen[t.direction_id] === undefined) seen[t.direction_id] = t.headsign || null;
    });
    return Object.keys(seen).map(function (k) {
      return { id: Number(k), headsign: seen[k] };
    }).sort(function (a, b) { return a.id - b.id; });
  }

  function dirLabel(dirs, id) {
    var d = dirs.filter(function (x) { return x.id === id; })[0];
    return d && d.headsign ? d.headsign : 'Direction ' + id;
  }

  function stopsFor(dep, directionId) {
    return ((dep && dep.stops) || [])
      .filter(function (s) { return s.direction_id === directionId; })
      .sort(function (a, b) { return a.stop_sequence - b.stop_sequence; });
  }

  function stopName(stops, id) {
    var s = stops.filter(function (x) { return x.stop_id === id; })[0];
    return s ? s.stop_name : id;
  }

  global.CMB.watch = {
    STORE_KEY: STORE_KEY,
    BEFORE_S: BEFORE_S,
    AFTER_S: AFTER_S,
    DRIFT_TOLERANCE_S: DRIFT_TOLERANCE_S,
    list: list,
    add: add,
    remove: remove,
    keyFor: keyFor,
    clockOf: clockOf,
    secondsOf: secondsOf,
    rowsFor: rowsFor,
    departuresAt: departuresAt,
    matchDeparture: matchDeparture,
    vehicleForTrip: vehicleForTrip,
    isCanceled: isCanceled,
    coverageFor: coverageFor,
    tripsInBlock: tripsInBlock,
    tripStartEpoch: tripStartEpoch,
    resolve: resolve,
    untilText: untilText,
    sortModels: sortModels,
    describe: describe,
    render: render,
    renderEditor: renderEditor,
    stopsFor: stopsFor,
    directionsOf: directionsOf,
    /*
     * The step-based editor's presentation, exported because chain.js builds the
     * same one. They were copy-pasted there first, which is the shape CLAUDE.md
     * forbids after ISSUE-002: two implementations of one rule drift, and here the
     * first symptom would be the two editors numbering or labeling their steps
     * differently on one screen.
     */
    step: step,
    cleanName: cleanName,
    routeLabel: routeLabel,
    dirLabel: dirLabel,
    stopName: stopName
  };
})(window);
