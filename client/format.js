/*
 * format.js — display formatting. The server never formats; the client never
 * computes. Everything here turns a contract value into characters.
 *
 * Times arrive as Unix epoch seconds and are rendered in America/Chicago,
 * because the question is always "what time is it on the route", not "what
 * time is it on this phone".
 */
(function (global) {
  'use strict';

  var AGENCY_TZ = 'America/Chicago';
  var MINUS = '−'; /* U+2212, aligns with the tabular digits */

  var timeFmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: AGENCY_TZ
  });
  var timeSecFmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: AGENCY_TZ
  });

  /* "10:21 AM" -> "10:21a", which is half the width and reads the same. */
  function compactMeridiem(s) {
    return s.replace(/ | /g, '').replace(/AM$/, 'a').replace(/PM$/, 'p');
  }

  function clock(epochSeconds) {
    if (epochSeconds === null || epochSeconds === undefined) return '—';
    return compactMeridiem(timeFmt.format(new Date(epochSeconds * 1000)));
  }

  function clockWithSeconds(epochSeconds) {
    if (epochSeconds === null || epochSeconds === undefined) return '—';
    return timeSecFmt.format(new Date(epochSeconds * 1000)) + ' CT';
  }

  /* Spoken form for screen readers: "10:21 AM". */
  function clockSpoken(epochSeconds) {
    if (epochSeconds === null || epochSeconds === undefined) return 'unknown';
    return timeFmt.format(new Date(epochSeconds * 1000));
  }

  /*
   * Signed lateness, rounded to the minute: "+3m", "−2m", "+0m".
   * Sign is always present so the value reads as a deviation, never a count.
   */
  function signedMinutes(seconds) {
    if (seconds === null || seconds === undefined) return null;
    var mins = Math.round(Math.abs(seconds) / 60);
    return (seconds < 0 ? MINUS : '+') + mins + 'm';
  }

  /* "3 minutes late" / "45 seconds early" / "on time" — for the a11y layer. */
  function lateSpoken(seconds) {
    if (seconds === null || seconds === undefined) return 'lateness unknown';
    var abs = Math.abs(seconds);
    if (abs < 30) return 'on time to the second';
    var word = seconds < 0 ? 'early' : 'late';
    if (abs < 90) return abs + ' seconds ' + word;
    return Math.round(abs / 60) + ' minutes ' + word;
  }

  /* Exact deviation for the expanded row: "3 min 3 s late". */
  function exactLateness(seconds) {
    if (seconds === null || seconds === undefined) return 'unknown';
    var abs = Math.abs(seconds);
    var m = Math.floor(abs / 60);
    var s = abs % 60;
    var parts = [];
    if (m) parts.push(m + ' min');
    if (s || !m) parts.push(s + ' s');
    if (abs < 5) return 'exactly on schedule';
    return parts.join(' ') + (seconds < 0 ? ' early' : ' late');
  }

  /* Feed age, from the server's own count of seconds. Never recomputed here. */
  function age(seconds) {
    if (seconds === null || seconds === undefined) return 'unknown age';
    if (seconds < 90) return seconds + ' sec old';
    var m = Math.round(seconds / 60);
    if (m < 90) return m + ' min old';
    return Math.round(m / 60) + ' hr old';
  }

  /* GTFS service-day clock string "10:05:00" -> "10:05a". Hours may exceed 24. */
  function serviceClock(hhmmss) {
    if (!hhmmss) return '—';
    var bits = hhmmss.split(':');
    var h = parseInt(bits[0], 10);
    var m = bits[1];
    var suffix = h % 24 < 12 ? 'a' : 'p';
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + m + suffix;
  }

  /* "4 Shady EB" -> "EB". Falls back to the letter the toggle needs. */
  function directionTag(headsign, directionId) {
    var m = /\b(NB|SB|EB|WB)\b/.exec(headsign || '');
    if (m) return m[1];
    return directionId === 0 ? 'A' : 'B';
  }

  /*
   * The tag for one direction of one payload. rows.js and map.js each carried a verbatim
   * copy of this lookup, which is the exact shape CLAUDE.md forbids after ISSUE-002: two
   * implementations of one rule drift, and the first symptom is one bus reading "EB" in
   * the rows and "B" on the map. One copy, three callers.
   *
   * It looks past route.directions to the vehicles, because a direction the route does
   * not publish still gets a rows group and that group still needs a legible tag.
   */
  function directionTagFor(data, id) {
    var d = directionsForRows(data).filter(function (x) { return x.id === id; })[0];
    return directionTag(d && d.headsign, id);
  }

  /*
   * Does this object carry a usable coordinate?
   *
   * 0/0 is the Gulf of Guinea, not Austin: the feed uses it for "no position
   * recorded", and plotting it drags a map's whole frame 3,000km south. Lives
   * here rather than in a panel because map.js and near.js both need it and a
   * second copy is how build/lib/stop-names.mjs and runtime/lib/stopnames.php
   * drifted (ISSUE-002). One definition, both callers.
   */
  function hasFix(p) {
    return !!p && typeof p.lat === 'number' && typeof p.lon === 'number' &&
      isFinite(p.lat) && isFinite(p.lon) && !(p.lat === 0 && p.lon === 0);
  }

  /*
   * The SOONEST predicted arrival for one vehicle at one stop, or null.
   *
   * Rows are Vehicle.predictions triples, [stop_sequence, stop_id, predicted_at].
   * Matching is on stop_id, never stop_sequence: route 4 runs a 17-stop baseline
   * on five services and a 19-stop one on three others, so one physical stop does
   * not carry one sequence across every trip.
   *
   * READ THIS BEFORE CALLING IT. Predictions are ordered, so the first stop_id
   * match is the NEXT time this bus reaches that stop. That answers near.js's
   * question exactly -- "I am standing here, when is it coming" -- and it is the
   * right answer even on the 234 trips that visit one stop twice, because the
   * rider wants the next arrival, not a nominated one.
   *
   * It is the WRONG answer for a question about a specific scheduled departure.
   * A trip that serves a stop twice has two departures there, and asked by
   * stop_id alone both get the first pass's time. stopboard.js used to do this:
   * measured over the 2026-08-19 corpus, 6 rendered rows carried the wrong
   * arrival, the worst by 51 minutes, three of them discarding a distinct time
   * CapMetro had published for the second pass. It now joins positionally via
   * stopTimesForTrip/stopsAheadOf/arrivalPlan and keys on scheduled_at instead.
   *
   * So: asking "when next" -> this function. Asking "when on THIS departure"
   * -> the positional join. They are different questions and this file will not
   * pretend otherwise.
   */
  function predictionFor(vehicle, stopId) {
    var rows = (vehicle && vehicle.predictions) || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && String(rows[i][1]) === String(stopId)) {
        return {
          stop_sequence: rows[i][0],
          stop_id: String(rows[i][1]),
          predicted_at: rows[i][2]
        };
      }
    }
    return null;
  }

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
   * Monotonicity holds by construction for two of the three transitions: the
   * feed's own rows are monotonic (0 backward steps across 4,276 adjacent
   * pairs), and consecutive estimated rows cannot go backwards, because a flat
   * deviation over ascending scheduled times preserves order. The third
   * transition, estimate to feed, is NOT guaranteed by construction — the
   * feed's predicted_at is independent of the estimate it follows. Measured on
   * the 2026-08-19 capture, that transition occurs on 9 of 249 buses and goes
   * backwards on none of them. Nothing is clamped, and nothing should be until
   * a real backward step has been measured.
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

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  global.CMB = global.CMB || {};
  /*
   * THE direction list for a payload. Rows, ladder and map all read it, so one bus can
   * never appear in a panel another panel has no column for. Routes 466 and 642 publish
   * one direction only; assuming [0, 1] drew a phantom second ladder.
   *
   * It lives here rather than in rows.js because ladder.js must not depend on rows.js:
   * they are loaded independently and a cross-import broke the ladder's own tests.
   *
   * The fallback is not decoration. route.directions is required by the contract, but a
   * payload arriving without it would otherwise silently drop every row while the
   * vehicles sat plainly in the data. Deriving from the vehicles fails visible, not blank.
   */
  function directionsInOrder(data) {
    var dirs = (data && data.route && data.route.directions) || [];
    if (dirs.length) {
      return dirs.slice().sort(function (a, b) { return a.id - b.id; });
    }
    var seen = Object.create(null);
    ((data && data.vehicles) || []).forEach(function (v) {
      if (v.trip && v.trip.direction_id !== undefined && v.trip.direction_id !== null) {
        seen[v.trip.direction_id] = v.trip.headsign || null;
      }
    });
    return Object.keys(seen)
      .map(function (k) { return { id: Number(k), headsign: seen[k] }; })
      .sort(function (a, b) { return a.id - b.id; });
  }

  function directionIds(data) {
    return directionsInOrder(data).map(function (d) { return d.id; });
  }

  /*
   * THE direction list for panels that draw one entry per VEHICLE, which today means the
   * rows. It is the published list plus any direction a vehicle actually reports, and the
   * difference from directionsInOrder is not cosmetic.
   *
   * The ladder must use the published list: a direction with no timepoints has no ladder
   * to draw, and iterating a direction the route does not publish is what drew the phantom
   * "No timepoints published for direction 1" beside routes 466 and 642.
   *
   * The rows must NOT. Grouping the rows by the published list alone means a bus whose
   * direction_id is missing from route.directions has no group to land in and is dropped
   * from the page with no trace, while the header keeps counting it. Trimming route 4's
   * published directions to one made two of its six rows disappear, one of them a bus in
   * service. A board that hides a bus it was handed is worse than one that draws an
   * unexpected group, so the rows widen the list and the ladder does not.
   */
  function directionsForRows(data) {
    var published = directionsInOrder(data);
    var known = Object.create(null);
    published.forEach(function (d) { known[d.id] = true; });

    var extra = Object.create(null);
    ((data && data.vehicles) || []).forEach(function (v) {
      var id = v.trip && v.trip.direction_id;
      if (id === undefined || id === null || known[id]) { return; }
      if (!(id in extra)) { extra[id] = (v.trip && v.trip.headsign) || null; }
    });

    return published
      .concat(Object.keys(extra).map(function (k) {
        return { id: Number(k), headsign: extra[k] };
      }))
      .sort(function (a, b) { return a.id - b.id; });
  }

  global.CMB.fmt = {
    directionsInOrder: directionsInOrder,
    directionIds: directionIds,
    directionsForRows: directionsForRows,
    directionTagFor: directionTagFor,
    AGENCY_TZ: AGENCY_TZ,
    MINUS: MINUS,
    clock: clock,
    clockWithSeconds: clockWithSeconds,
    clockSpoken: clockSpoken,
    signedMinutes: signedMinutes,
    lateSpoken: lateSpoken,
    exactLateness: exactLateness,
    age: age,
    serviceClock: serviceClock,
    directionTag: directionTag,
    plural: plural,
    hasFix: hasFix,
    predictionFor: predictionFor,
    stopTimesForTrip: stopTimesForTrip,
    stopsAheadOf: stopsAheadOf,
    arrivalPlan: arrivalPlan
  };
})(window);
