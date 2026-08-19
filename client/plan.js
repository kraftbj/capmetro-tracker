/*
 * plan.js — a link that carries the stops someone actually waits at, and offers
 * to keep them on the phone that opened it.
 *
 * WHAT THIS IS, AND WHY IT IS NOT A SAVED TRIP
 *
 * watch.js answers "the 7:50a 800 SB from Simond/Berkman" — one named departure,
 * pinned to a clock time. That is the right shape when the trip is the thing you
 * catch. It is the wrong shape for a commute, because a commute is a PLACE and a
 * TIME OF DAY: "the 800 southbound from Simond in the mornings", "the 4 eastbound
 * from Campbell/5th in the afternoons". You take whichever bus is next. Pinning
 * 7:50:00 means that on the day you leave four minutes late the board is watching
 * a bus you are not going to catch.
 *
 * So a plan entry is (route, direction, stop, time-of-day window) and it resolves
 * to the NEXT few departures, not one. Everything else — the join between the
 * schedule and the live feed, the states, the words — is the same problem watch.js
 * already solved, and this file reuses its functions rather than restating them.
 * Two implementations of one join is ISSUE-002 waiting to happen.
 *
 * TURNAROUNDS, WHICH ARE THE HALF THAT IS ACTUALLY HARD
 *
 * Three of the five stops this was built for are turnaround points: route 4
 * eastbound starts at Campbell/5th and at Veterans/Atlanta, route 837 northbound
 * starts at Republic Square. There is no eastbound bus approaching Campbell/5th,
 * ever. The bus you will board is a WESTBOUND bus until the moment it gets there,
 * turns its headsign around and leaves as your eastbound trip. A board that only
 * looks for eastbound vehicles shows an empty stop and a scheduled time, which is
 * exactly the "no bus is coming" blank the design doc calls the failure this
 * project exists to avoid.
 *
 * Two facts answer it, and both are already published:
 *
 *   the schedule side  departures.trips[].block_id links the inbound leg to the
 *                      outbound one. The latest arrival at this stop, on the same
 *                      block, in the other direction, IS the bus — scheduled.
 *   the live side      vehicle.block.next_trip (§2) is the server's own block
 *                      continuity, with is_direction_flip already computed. A
 *                      vehicle whose next_trip is our departure is our bus, right
 *                      now, wherever it is.
 *
 * And the case the owner named specifically — "the next EB departure so we don't
 * miss a bus that is waiting at that point" — is the third: a vehicle reported
 * STOPPED_AT the turnaround, either already on the outbound trip or still on the
 * inbound one. It is sitting there. That gets said in words, because a bus you can
 * see out of the window is not the same news as one that is eight minutes away.
 *
 * WHAT IS DELIBERATELY NOT DONE: when the inbound bus is nine minutes late, the
 * outbound departure it becomes will almost certainly leave late too. This file
 * does not compute that number. The board's rule is that nothing on it is
 * invented, and a predicted departure derived from another trip's lateness is an
 * invention with a plausible face. Both facts are printed next to each other
 * instead, and the arithmetic — which is one subtraction — is left to a reader who
 * can see where the number came from.
 *
 * WHY THE LINK IS A FRAGMENT
 *
 * Contract §9 hashes the watch tuple for one stated reason: "so a URL or server
 * log never carries a legible description of a child's daily routine." A feature
 * whose whole point is a URL has to answer that, not inherit it.
 *
 * It is answered twice over. The plan lives in the '#' fragment, which browsers do
 * not send to the server — bus.dillo.dev's access log gets 'GET /' and nothing
 * else, no matter how many stops the link carries. And the encoding is numeric ids
 * only: '4.1.6243.pm' names no street, no child and no clock time. Reading it
 * needs the stop table, which is the same bar as reading the sha256. A '?plan='
 * query is still accepted, because a link that has been through three messaging
 * apps may arrive in any shape, but it is rewritten into the fragment on arrival
 * so it stops leaking on the next reload.
 */
(function (global) {
  'use strict';

  var fmt = global.CMB.fmt;
  var adhLib = global.CMB.adherence;
  var S = global.CMB.states;
  var el = S.el;

  /* watch.js owns the schedule/live join. This file borrows it whole. */
  var W = global.CMB.watch;

  var STORE_KEY = 'cmb.plan';
  var FORMAT = '1';

  /* How many departures a card shows. Two is what you act on; the third is there
   * so a bus you have just missed does not leave the card looking empty. */
  var SHOW = 3;

  /* A departure stops being offerable this long after it was due. Generous,
   * because a bus that is late has not gone. */
  var GONE_S = 120;

  /*
   * Time-of-day windows, in seconds since the start of the service day.
   *
   * These are coarse on purpose. The point of a window is to keep the afternoon
   * stops off the screen at seven in the morning, not to describe a timetable —
   * the timetable is what the card is for. A window that had to be right to the
   * minute would be one more thing to maintain when school hours change.
   */
  var WINDOWS = {
    am: [4 * 3600, 12 * 3600],
    pm: [12 * 3600, 20 * 3600],
    all: [0, 30 * 3600]
  };

  /* ---- the link -------------------------------------------------------- */

  /*
   * '1;800.1.6293.am;4.0.3337.am;4.1.6243.pm'
   *
   * Version, then one 'route.direction.stop.window' per entry. Fields are
   * percent-encoded so a stop id containing a separator cannot split an entry in
   * half; today every id in this feed is digits, and relying on that would be a
   * silent break the first time it is not true.
   */
  function encode(entries) {
    return [FORMAT].concat((entries || []).map(function (e) {
      return [
        enc(e.route_id),
        String(e.direction_id),
        enc(e.stop_id),
        e.window || 'all'
      ].join('.');
    })).join(';');
  }

  /*
   * encodeURIComponent leaves '.' alone — it is an unreserved mark — and '.' is
   * the field separator here, so an id containing one silently split an entry in
   * half and took the whole entry down with it. Every id in this feed is digits
   * today; relying on that is the kind of assumption that breaks once, quietly,
   * years later.
   */
  function enc(s) {
    return encodeURIComponent(String(s)).replace(/\./g, '%2E');
  }

  /*
   * Decode, dropping anything malformed rather than refusing the whole link.
   *
   * A plan is not a transaction. If four of five entries parse, showing four
   * stops beats showing an error page: the reader is standing at one of the four.
   * Returns null only when nothing at all survived, which is the case the caller
   * has to tell apart from "no link at all".
   */
  function decode(text) {
    var parts = String(text || '').split(';').filter(function (p) { return p !== ''; });
    if (!parts.length) return null;
    if (parts[0] !== FORMAT) return null;

    var entries = [];
    for (var i = 1; i < parts.length; i++) {
      var f = parts[i].split('.');
      if (f.length < 3) continue;
      var dir = parseInt(f[1], 10);
      if (dir !== 0 && dir !== 1) continue;
      var routeId = safeDecode(f[0]);
      var stopId = safeDecode(f[2]);
      if (!routeId || !stopId) continue;
      var win = f.length > 3 && f[3] ? f[3] : 'all';
      if (!windowRange(win)) continue;
      entries.push({
        route_id: routeId,
        direction_id: dir,
        stop_id: stopId,
        window: win
      });
    }
    return entries.length ? entries : null;
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  /* Two entries are the same stop-in-a-window; the key is what dedupes a link
   * against what is already saved. */
  function keyFor(e) {
    return [e.route_id, e.direction_id, e.stop_id, e.window || 'all'].join('|');
  }

  function sameSet(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    var ka = a.map(keyFor).sort().join('');
    var kb = b.map(keyFor).sort().join('');
    return ka === kb;
  }

  /*
   * The plan the current location carries, from the fragment first and the query
   * only as a rescue. `fromQuery` is reported so the caller can move it out of the
   * query string, where it does not belong.
   */
  function fromLocation(loc) {
    var hash = String((loc && loc.hash) || '').replace(/^#/, '');
    var found = paramOf(hash, 'plan');
    if (found) {
      var viaHash = decode(found);
      if (viaHash) return { entries: viaHash, fromQuery: false, raw: found };
    }
    var search = String((loc && loc.search) || '').replace(/^\?/, '');
    var q = paramOf(search, 'plan');
    if (q) {
      var viaQuery = decode(q);
      if (viaQuery) return { entries: viaQuery, fromQuery: true, raw: q };
    }
    return null;
  }

  /* One key out of an '&'-joined parameter string, in either half of a URL. */
  function paramOf(text, name) {
    var bits = String(text || '').split('&');
    for (var i = 0; i < bits.length; i++) {
      var eq = bits[i].indexOf('=');
      if (eq === -1) continue;
      if (safeDecode(bits[i].slice(0, eq)) !== name) continue;
      return safeDecode(bits[i].slice(eq + 1));
    }
    return null;
  }

  /*
   * The link to hand somebody else. Always a fragment, never a query.
   *
   * The plan is NOT percent-encoded again on the way out. Every field was
   * already escaped by enc(), so the ';' and '.' left in the string are
   * structural and both are legal in a fragment — and re-encoding them turned a
   * link somebody has to read off a screen and trust into '1%3B800%2E1%2E6293'.
   * decode() accepts either form, so a link that has been mangled into the
   * escaped shape by something in between still opens.
   */
  function linkFor(entries, base) {
    var origin = String(base || '').split('#')[0].split('?')[0];
    return origin + '#plan=' + encode(entries);
  }

  /* ---- storage --------------------------------------------------------- */

  function stored() {
    try {
      var raw = global.localStorage.getItem(STORE_KEY);
      var list = raw ? JSON.parse(raw) : null;
      if (Object.prototype.toString.call(list) !== '[object Array]') return null;
      var clean = list.filter(function (e) {
        return e && e.route_id && e.stop_id &&
          (e.direction_id === 0 || e.direction_id === 1);
      });
      return clean.length ? clean : null;
    } catch (e) {
      /* Private mode, disabled storage, a value someone edited by hand. An
       * unreadable store is an absent one; it never takes the board down. */
      return null;
    }
  }

  function save(entries) {
    try {
      global.localStorage.setItem(STORE_KEY, JSON.stringify(entries || []));
      return true;
    } catch (e) {
      return false;
    }
  }

  function clear() {
    try { global.localStorage.removeItem(STORE_KEY); return true; } catch (e) { return false; }
  }

  /* Every route a plan touches, so the caller can fetch them all up front rather
   * than one at a time as cards paint. */
  function routesIn(entries) {
    var seen = {};
    var out = [];
    (entries || []).forEach(function (e) {
      if (seen[e.route_id]) return;
      seen[e.route_id] = true;
      out.push(e.route_id);
    });
    return out;
  }

  /* ---- windows --------------------------------------------------------- */

  /*
   * A named window, or an explicit 'HHMM-HHMM'. An end before the start wraps
   * past midnight and is expressed in service-day seconds past 86400, which is
   * the same convention every other time in this contract uses: 25:10 is a real
   * and different departure from 01:10 and is never wrapped back.
   */
  function windowRange(name) {
    if (WINDOWS[name]) return WINDOWS[name];
    var m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(name || ''));
    if (!m) return null;
    var from = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60;
    var to = parseInt(m[3], 10) * 3600 + parseInt(m[4], 10) * 60;
    if (to <= from) to += 86400;
    return [from, to];
  }

  function inWindow(name, secondsIntoDay) {
    var r = windowRange(name);
    if (!r) return true;
    return secondsIntoDay >= r[0] && secondsIntoDay < r[1];
  }

  function windowLabel(name) {
    if (name === 'am') return 'mornings';
    if (name === 'pm') return 'afternoons';
    if (name === 'all') return 'all day';
    var r = windowRange(name);
    if (!r) return name;
    return fmt.serviceClock(W.clockOf(r[0])) + '–' + fmt.serviceClock(W.clockOf(r[1] % 86400));
  }

  /* ---- turnarounds ----------------------------------------------------- */

  /*
   * Is this departure the START of its trip here?
   *
   * Compared against the trip's own published start_time rather than against a
   * stop_sequence of 1. Sequence numbers come from whichever pattern a trip runs,
   * and route 4 publishes six patterns in one direction; start_time is the trip's
   * own first timed stop and is exact. A trip that starts here had to arrive from
   * somewhere, which is the question the rest of this section answers.
   */
  function startsHere(trip, arrivalSeconds) {
    var start = W.secondsOf(trip && trip.start_time);
    return start !== null && start === arrivalSeconds;
  }

  /*
   * The scheduled leg that brings the bus in: same block, other direction, latest
   * arrival at this stop that is not after our departure.
   *
   * Block continuity is the only honest link here. Two trips sharing a stop and a
   * plausible gap is a guess; two trips sharing a block_id is the agency saying
   * one vehicle runs both.
   */
  function inboundLeg(dep, stopId, directionId, trip, arrivalSeconds) {
    if (!trip || !trip.block_id) return null;
    var other = W.departuresAt(dep, stopId, directionId === 0 ? 1 : 0);
    var best = null;
    for (var i = 0; i < other.length; i++) {
      if (other[i].trip.block_id !== trip.block_id) continue;
      if (other[i].trip.id === trip.id) continue;
      if (other[i].seconds > arrivalSeconds) continue;
      if (!best || other[i].seconds > best.seconds) best = other[i];
    }
    return best;
  }

  /*
   * The vehicle the server says will run this trip next — block continuity as
   * already computed in §2, is_direction_flip included. Preferred over matching
   * the scheduled inbound trip id, because this is what the feed reports now and
   * the schedule is what was planned yesterday.
   */
  function vehicleFeeding(route, tripId) {
    var vs = (route && route.vehicles) || [];
    for (var i = 0; i < vs.length; i++) {
      var nt = vs[i].block && vs[i].block.next_trip;
      if (nt && nt.trip_id === tripId) return vs[i];
    }
    return null;
  }

  function atStop(vehicle, stopId) {
    var p = vehicle && vehicle.progress;
    return !!(p && p.current_stop_id === stopId && p.current_status === 'STOPPED_AT');
  }

  /* ---- resolution ------------------------------------------------------ */

  /*
   * One plan entry against one departures document and one live route payload.
   *
   * Every branch names a state the UI has copy for, and there is no default. The
   * reasons a stop has nothing to show are not interchangeable: "this stop is not
   * served in this direction today", "the last bus has gone" and "the schedule has
   * not loaded" call for three different things from someone standing outside.
   */
  function resolve(entry, dep, route, now, opts) {
    opts = opts || {};
    var base = {
      entry: entry,
      key: keyFor(entry),
      stop_name: entry.stop_id,
      headsign: null,
      direction_tag: entry.direction_id === 0 ? 'A' : 'B',
      departures: [],
      in_window: true,
      is_turnaround: false
    };

    if (!dep) {
      /*
       * "Not loaded yet" and "will never load" are the same blank card and
       * completely different news, so the caller supplies the reason it alone
       * knows: a board opened from a file has no origin to fetch a schedule from
       * and is never going to have one.
       */
      return extend(base, { state: 'no-schedule',
        detail: opts.schedule_detail ||
          'The schedule for route ' + entry.route_id + ' has not loaded yet.' });
    }

    var meta = stopMeta(dep, entry.stop_id, entry.direction_id);
    if (meta) base.stop_name = meta.stop_name;

    var nowS = now - dep.service_day_start_epoch;
    base.in_window = inWindow(entry.window, nowS);
    base.day_type = dep.day_type;

    var rows = W.departuresAt(dep, entry.stop_id, entry.direction_id);
    if (!rows.length) {
      return extend(base, { state: 'unserved',
        detail: 'No trip serves this stop in this direction today.' });
    }

    base.headsign = rows[0].trip.headsign;
    base.direction_tag = fmt.directionTag(rows[0].trip.headsign, entry.direction_id);

    var models = [];
    for (var i = 0; i < rows.length && models.length < SHOW; i++) {
      var m = departureModel(rows[i], entry, dep, route, now);
      /* Scheduled time is the filter, not the prediction: a bus running late is
       * still ahead of you, and dropping it because the clock passed its
       * scheduled time is how a board loses the bus you are about to catch. */
      if (m.due_at < now - GONE_S) continue;
      models.push(m);
    }

    /*
     * Scheduled order picks the candidates; DUE order is what gets printed. A
     * bus twenty minutes late and the one behind it running on time arrive
     * together, and on a card headed "next bus" the one that actually gets here
     * first has to be the one at the top.
     */
    models.sort(function (a, b) { return a.due_at - b.due_at; });

    base.departures = models;
    base.is_turnaround = models.length > 0 && models.every(function (m) { return m.starts_here; });

    if (!models.length) {
      return extend(base, { state: 'done',
        detail: 'The last one today has gone. Back tomorrow.' });
    }
    return extend(base, { state: 'ok', next: models[0] });
  }

  function departureModel(row, entry, dep, route, now) {
    var trip = row.trip;
    var scheduledAt = dep.service_day_start_epoch + row.seconds;

    var vehicle = W.vehicleForTrip(route, trip.id);
    var view = vehicle ? adhLib.view(vehicle, route && route.staleness) : null;
    var lateness = view && view.seconds !== null && view.seconds !== undefined ? view.seconds : null;
    var predictedAt = lateness === null ? null : scheduledAt + lateness;
    var dueAt = predictedAt === null ? scheduledAt : predictedAt;

    var leg = inboundLeg(dep, entry.stop_id, entry.direction_id, trip, row.seconds);
    var feeder = vehicle ? null : vehicleFeeding(route, trip.id);
    if (!feeder && !vehicle && leg) feeder = W.vehicleForTrip(route, leg.trip.id);

    var inbound = null;
    if (leg || feeder) {
      var fView = feeder ? adhLib.view(feeder, route && route.staleness) : null;
      var fSched = leg ? dep.service_day_start_epoch + leg.seconds : null;
      var fLate = fView && fView.seconds !== null && fView.seconds !== undefined ? fView.seconds : null;
      var fDue = fSched === null ? null : (fLate === null ? fSched : fSched + fLate);
      inbound = {
        trip: leg ? leg.trip : null,
        scheduled_at: fSched,
        due_at: fDue,
        seconds_until: fDue === null ? null : fDue - now,
        vehicle: feeder,
        view: fView,
        at_stop: atStop(feeder, entry.stop_id),
        /* The scheduled leg names the direction best. Without one, the feeder's
         * own trip still does — and with neither there is no direction to name,
         * which the copy has to handle rather than print an empty phrase. */
        direction_tag: leg ? fmt.directionTag(leg.trip.headsign, entry.direction_id === 0 ? 1 : 0)
          : feeder && feeder.trip ? fmt.directionTag(feeder.trip.headsign, feeder.trip.direction_id)
            : null
      };
    }

    var here = atStop(vehicle, entry.stop_id);
    var boarding = here ? 'here'
      : vehicle ? 'enroute'
        : inbound && inbound.at_stop ? 'waiting'
          : inbound && inbound.vehicle ? 'inbound'
            : inbound && inbound.trip ? 'scheduled'
              : 'none';

    return {
      trip: trip,
      scheduled_at: scheduledAt,
      predicted_at: predictedAt,
      due_at: dueAt,
      seconds_until: dueAt - now,
      vehicle: vehicle,
      view: view,
      at_stop: here,
      starts_here: startsHere(trip, row.seconds),
      inbound: inbound,
      boarding: boarding,
      is_special: !!trip.is_special
    };
  }

  function stopMeta(dep, stopId, directionId) {
    var stops = (dep && dep.stops) || [];
    for (var i = 0; i < stops.length; i++) {
      if (stops[i].stop_id === stopId && stops[i].direction_id === directionId) return stops[i];
    }
    for (var j = 0; j < stops.length; j++) {
      if (stops[j].stop_id === stopId) return stops[j];
    }
    return null;
  }

  function extend(a, b) {
    for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k];
    return a;
  }

  /*
   * In-window stops first, then by how soon the next bus is due.
   *
   * The window decides the section, not the visibility. An afternoon stop at
   * seven in the morning is still on the page, further down, with its next
   * departure printed — because "where did my stop go" is a worse question than
   * "why is that one greyed out".
   */
  function sortModels(models) {
    var RANK = { ok: 0, 'no-schedule': 1, done: 2, unserved: 3 };
    return models.slice().sort(function (a, b) {
      if (a.in_window !== b.in_window) return a.in_window ? -1 : 1;
      var ra = RANK[a.state] === undefined ? 9 : RANK[a.state];
      var rb = RANK[b.state] === undefined ? 9 : RANK[b.state];
      if (ra !== rb) return ra - rb;
      var sa = a.next ? a.next.seconds_until : Infinity;
      var sb = b.next ? b.next.seconds_until : Infinity;
      return sa - sb;
    });
  }

  function describe(entry, model) {
    return 'route ' + entry.route_id + ' ' +
      ((model && model.direction_tag) || (entry.direction_id === 0 ? 'A' : 'B')) +
      ' from ' + ((model && model.stop_name) || entry.stop_id);
  }

  /* ---- render ---------------------------------------------------------- */

  /*
   * One departure line. The due time leads, because that is the answer; the
   * boarding sentence follows, because at a turnaround the answer is incomplete
   * without it.
   */
  function departureLine(m, model, isFirst) {
    var box = el('div', 'stopdep' + (isFirst ? ' stopdep--next' : ''));

    var line = el('p', 'stopdep__line');
    line.appendChild(el('span', 'stopdep__due', fmt.clock(m.due_at)));
    line.appendChild(el('span', 'stopdep__until', W.untilText(m.seconds_until)));
    if (m.view) line.appendChild(adhLib.badge(m.view, { small: !isFirst }));
    box.appendChild(line);

    if (m.predicted_at !== null && m.predicted_at !== m.scheduled_at) {
      box.appendChild(el('p', 'stopdep__sched', 'Scheduled ' + fmt.clock(m.scheduled_at)));
    }

    var note = el('p', 'stopdep__note');
    note.textContent = boardingText(m, model);
    box.appendChild(note);

    if (m.is_special) {
      box.appendChild(el('p', 'stopdep__note stopdep__note--flag',
        'Special run — it does not follow the usual pattern of stops.'));
    }
    return box;
  }

  /*
   * The sentence under the time. At an ordinary stop it is one clause about the
   * bus on the trip. At a turnaround it is the whole point of the card: which
   * inbound bus becomes this departure, and whether it is already standing there.
   */
  function boardingText(m, model) {
    var busName = m.vehicle ? 'Bus ' + (m.vehicle.label || m.vehicle.vehicle_id) : null;
    var feeder = m.inbound && m.inbound.vehicle;
    var feederName = feeder ? 'Bus ' + (feeder.label || feeder.vehicle_id) : null;
    /*
     * "the 10:14a WB" when the schedule names the leg, and nothing at all when
     * it does not. An earlier draft fell back to the words "the other
     * direction", which printed "as the the other direction" and, worse, claimed
     * a turnaround at stops that do not have one.
     */
    var leg = namedLeg(m);

    if (m.boarding === 'here') {
      return busName + ' is at the stop now.';
    }
    if (m.boarding === 'waiting') {
      return feederName + ' is already standing at this stop' +
        (leg ? ', in on ' + leg : '') + ', and goes back out as this trip.';
    }
    if (m.boarding === 'inbound') {
      var eta = m.inbound.seconds_until === null || m.inbound.seconds_until === undefined
        ? '' : ' — due here ' + W.untilText(m.inbound.seconds_until);
      var late = latenessClause(m.inbound.view);
      return leg
        ? feederName + ' brings it in on ' + leg + eta + late + '.'
        : feederName + ' runs this trip next; it is finishing another one first' + late + '.';
    }
    if (m.boarding === 'scheduled') {
      return leg
        ? 'Comes in on ' + leg + '. No bus is reporting on that trip yet.'
        : 'No bus is reporting on this trip yet.';
    }
    if (m.boarding === 'enroute') {
      return busName + ' is on this trip now.';
    }
    return model && model.is_turnaround
      ? 'No bus is reporting on this trip yet, and the schedule does not say which one brings it in.'
      : 'No bus is reporting on this trip yet. That is normal until it starts its run.';
  }

  /* ", running 4 minutes late" — but "and on time", because "running on time to
   * the second" is not a sentence anyone says. Empty when there is no value to
   * report, which is the one case that must never be filled in. */
  function latenessClause(view) {
    if (!view || view.seconds === null || view.seconds === undefined) return '';
    var words = fmt.lateSpoken(view.seconds);
    return words.indexOf('on time') === 0 ? ', and ' + words : ', running ' + words;
  }

  /* "the 10:14a WB", or null when the inbound leg has no time or no direction to
   * name — half a phrase is worse than none. */
  function namedLeg(m) {
    var inb = m.inbound;
    if (!inb || inb.scheduled_at === null || inb.scheduled_at === undefined) return null;
    if (!inb.direction_tag) return null;
    return 'the ' + fmt.clock(inb.scheduled_at) + ' ' + inb.direction_tag;
  }

  function card(model, opts) {
    var entry = model.entry;
    var box = el('article', 'stopcard stopcard--' + model.state +
      (model.in_window ? '' : ' stopcard--later'));

    var head = el('div', 'stopcard__head');
    var title = el('p', 'stopcard__title');
    title.appendChild(el('span', 'stopcard__route', entry.route_id));
    title.appendChild(el('span', 'stopcard__dir', model.direction_tag));
    title.appendChild(el('span', 'stopcard__stop', model.stop_name));
    head.appendChild(title);

    var tags = el('p', 'stopcard__tags');
    tags.appendChild(el('span', 'stopcard__when', windowLabel(entry.window)));
    if (model.is_turnaround) {
      var t = el('span', 'stopcard__turn', 'turnaround');
      t.title = 'This is where the route turns around. Your bus arrives going the ' +
        'other way and leaves from here.';
      tags.appendChild(t);
    }
    head.appendChild(tags);
    box.appendChild(head);

    if (model.state === 'ok') {
      var listEl = el('div', 'stopcard__deps');
      model.departures.forEach(function (m, i) {
        listEl.appendChild(departureLine(m, model, i === 0));
      });
      box.appendChild(listEl);
    } else {
      box.appendChild(S.notice('empty', headlineFor(model), model.detail || null));
    }

    box.appendChild(el('p', 'sr-only', spokenFor(model)));

    if (opts && opts.onRemove) {
      var del = el('button', 'stopcard__remove');
      del.type = 'button';
      del.textContent = 'Remove';
      del.setAttribute('aria-label', 'Remove ' + describe(entry, model) + ' from this phone');
      del.addEventListener('click', function () { opts.onRemove(model.key); });
      box.appendChild(del);
    }
    return box;
  }

  function headlineFor(model) {
    if (model.state === 'done') return 'Nothing left today';
    if (model.state === 'unserved') return 'Not served today';
    if (model.state === 'no-schedule') return 'Schedule not loaded';
    return 'Nothing to show';
  }

  /* Everything the badges and the layout carry, said once in words. */
  function spokenFor(model) {
    var lead = describe(model.entry, model) + '. ';
    if (model.state !== 'ok') return lead + (model.detail || 'Nothing to show.');
    var m = model.next;
    var when = 'Next bus due ' + fmt.clockSpoken(m.due_at) + ', ' +
      W.untilText(m.seconds_until) + '. ';
    var how = boardingText(m, model);
    var late = m.view ? m.view.spoken + '. ' : '';
    return lead + when + late + how;
  }

  /*
   * The whole view. `models` is already sorted by the caller — the board decides
   * order, this file decides appearance — and the offer, when there is one, sits
   * above the cards because it is about all of them.
   */
  function render(host, models, opts) {
    opts = opts || {};
    S.clear(host);
    host.appendChild(el('p', 'band__head', 'Stops'));

    if (opts.offer) host.appendChild(offerBanner(opts));

    if (!models || !models.length) {
      host.appendChild(S.notice('empty',
        'No stops on this phone yet.',
        'A stops link carries the places you wait — a route, a direction, a stop and ' +
        'whether it is a morning or an afternoon one. Open one and this board will ' +
        'offer to keep it here.'));
      return host;
    }

    var now = models.filter(function (m) { return m.in_window; });
    var later = models.filter(function (m) { return !m.in_window; });

    if (now.length) {
      var listEl = el('div', 'stopcards');
      now.forEach(function (m) { listEl.appendChild(card(m, opts)); });
      host.appendChild(listEl);
    } else {
      host.appendChild(S.notice('empty',
        'Nothing is in its window right now.',
        'Every stop below is saved for a different part of the day. They are still ' +
        'listed, with the next bus at each, so nothing has quietly disappeared.'));
    }

    if (later.length) {
      host.appendChild(el('p', 'stopcards__head', 'Later today'));
      var laterList = el('div', 'stopcards');
      later.forEach(function (m) { laterList.appendChild(card(m, opts)); });
      host.appendChild(laterList);
    }

    if (opts.link) host.appendChild(shareBox(opts));

    if (opts.saved && opts.onForget) {
      var forget = el('button', 'btn');
      forget.type = 'button';
      forget.textContent = 'Forget these stops';
      forget.addEventListener('click', opts.onForget);
      host.appendChild(forget);
    }
    return host;
  }

  /*
   * The offer. Two buttons, both of which leave the reader looking at their
   * stops: keeping them only changes whether the link is needed next time.
   */
  function offerBanner(opts) {
    var box = el('div', 'offer');
    box.setAttribute('role', 'status');
    box.appendChild(el('strong', 'offer__head',
      'This link carries ' + fmt.plural(opts.offer.length, 'stop', 'stops') + '.'));
    box.appendChild(el('span', 'offer__detail',
      'Keep them on this phone and the board opens on them next time, with no link.'));

    var row = el('div', 'offer__row');
    var keep = el('button', 'btn btn--primary');
    keep.type = 'button';
    keep.textContent = 'Keep on this phone';
    keep.addEventListener('click', opts.onKeep);
    row.appendChild(keep);

    var once = el('button', 'btn');
    once.type = 'button';
    once.textContent = 'Just this once';
    once.addEventListener('click', opts.onDismiss);
    row.appendChild(once);
    box.appendChild(row);

    if (opts.cameFromQuery) {
      box.appendChild(el('p', 'hint',
        'That link had the stops in the web address, where the server can see them. ' +
        'They have been moved into the part after the # , which never leaves this ' +
        'phone. Share the link below instead.'));
    }
    return box;
  }

  function shareBox(opts) {
    var box = el('div', 'share');
    box.appendChild(el('p', 'share__head', 'Link to these stops'));
    var field = el('input', 'share__field');
    field.type = 'text';
    field.readOnly = true;
    field.value = opts.link;
    field.setAttribute('aria-label', 'Link to these stops');
    field.addEventListener('focus', function () { field.select(); });
    box.appendChild(field);
    box.appendChild(el('p', 'hint',
      'Everything after the # stays in the browser — opening this link tells the ' +
      'server nothing about which stops it carries.'));
    return box;
  }

  global.CMB.plan = {
    STORE_KEY: STORE_KEY,
    FORMAT: FORMAT,
    SHOW: SHOW,
    GONE_S: GONE_S,
    WINDOWS: WINDOWS,
    encode: encode,
    decode: decode,
    keyFor: keyFor,
    sameSet: sameSet,
    fromLocation: fromLocation,
    linkFor: linkFor,
    stored: stored,
    save: save,
    clear: clear,
    routesIn: routesIn,
    windowRange: windowRange,
    windowLabel: windowLabel,
    inWindow: inWindow,
    startsHere: startsHere,
    inboundLeg: inboundLeg,
    vehicleFeeding: vehicleFeeding,
    resolve: resolve,
    sortModels: sortModels,
    describe: describe,
    boardingText: boardingText,
    render: render
  };
})(window);
