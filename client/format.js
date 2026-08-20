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
   * The agency's own predicted arrival for one vehicle at one stop, or null.
   *
   * Rows are Vehicle.predictions triples, [stop_sequence, stop_id, predicted_at].
   * Matching is on stop_id, never stop_sequence: route 4 runs a 17-stop baseline
   * on five services and a 19-stop one on three others, so one physical stop does
   * not carry one sequence across every trip.
   *
   * Lives here because near.js and stopboard.js both answer "when does this bus
   * reach this stop" and must not answer it differently on the same screen.
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
    predictionFor: predictionFor
  };
})(window);
