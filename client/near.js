/*
 * near.js — "which of these buses is coming to ME, and when".
 *
 * The rest of the board answers a dispatcher's question: is her bus late. This
 * answers a rider's, and it is a different question with a different failure
 * mode. It uses the browser's own Geolocation API and nothing else — no tile
 * server, no geocoder, no places API, no key, no network call of any kind. The
 * fix is read, used to pick a stop, and thrown away when the tab closes; it is
 * never stored, never sent anywhere, and deliberately never written to
 * localStorage even though the route and direction are.
 *
 * Three rules earned their place the hard way.
 *
 * 1. STRAIGHT-LINE DISTANCE TO A BUS IS THE WRONG ANSWER, and it is wrong in a
 *    way that looks right. The nearest bus by metres is routinely one on the
 *    parallel street running the other way, which will never pick you up, while
 *    the bus that will is two miles up the line. Worse, "is it getting closer"
 *    cannot be measured by watching that distance shrink: the board refreshes
 *    every 60s, a phone fix is good to 20–100m, and the difference between two
 *    samples that far apart is mostly noise. Bearing cannot rescue it either —
 *    208 of the 392 vehicles in the 2026-08-19 capture report no bearing at all.
 *
 *    So this file never measures a bus-to-user distance. It snaps the USER to a
 *    stop, once, and then asks the payload which buses have that stop still
 *    ahead of them. Vehicle.predictions only ever contains stops at or ahead of
 *    the bus, so a bus that appears in an arrivals list is approaching by
 *    construction. "Closest and coming closer" stops being a derivative and
 *    becomes a lookup.
 *
 * 2. THE TIME IS THE FEED'S, NOT OURS. Every arrival time here is a
 *    predicted_at the agency published for that stop on that trip. Nothing in
 *    this file adds a deviation to a scheduled time, interpolates between
 *    stops, or divides a distance by a speed. When the payload has no
 *    prediction for your stop the panel says so; it does not estimate. A
 *    countdown is the most confidently-read number on a transit screen and the
 *    one nobody forgives being invented.
 *
 * 3. NOW IS generated_at. The board's clock is the payload's clock everywhere
 *    else (see client/NOTES.md) and a countdown is not the place to introduce a
 *    second one — a device clock two minutes fast would silently shave two
 *    minutes off every arrival on the board.
 *
 * Rendered in the banner slot above the vehicle rows, not as a fourth panel:
 * the panel order (rows, ladder, map) is a settled decision and this is not a
 * panel, it is a stated answer in the same slot the staleness banners use.
 */
(function (global) {
  'use strict';

  var fmt = global.CMB.fmt;
  var S = global.CMB.states;
  var el = S.el;

  var EARTH_RADIUS_M = 6371008.8;

  /*
   * A fix older than this is not "where you are", it is where you were. Two
   * minutes is roughly two board refreshes; past that the panel offers to take
   * a new reading rather than quietly answering for a previous street corner.
   */
  var FIX_MAX_AGE_MS = 120000;

  /* getCurrentPosition options. No watchPosition: a board left open on a phone
     must not hold the GPS awake, and the stop you are standing at does not
     move. enableHighAccuracy because picking between stops ~330m apart is
     exactly the case a coarse network fix gets wrong. */
  var GEO_OPTS = { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 };

  /*
   * Great-circle metres. Same formula as build/lib/geo.mjs, which cannot be
   * imported here: that is an ES module in the build job and this file is a
   * classic script because ES modules are blocked on file:// URLs. The two are
   * not required to stay in lockstep the way the stop-name pair is — nothing
   * renders a value from both — but they are the same formula on purpose.
   */
  function metersBetween(lat1, lon1, lat2, lon2) {
    if (![lat1, lon1, lat2, lon2].every(function (n) {
      return typeof n === 'number' && isFinite(n);
    })) return Infinity;
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLon = (lon2 - lon1) * toRad;
    var a = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /* 0/0 is the Gulf of Guinea, not Austin — the feed's "no position recorded". */
  function hasFix(p) {
    return !!p && typeof p.lat === 'number' && typeof p.lon === 'number' &&
      isFinite(p.lat) && isFinite(p.lon) && !(p.lat === 0 && p.lon === 0);
  }

  /*
   * Every stop the payload publishes for one direction, timepoints and the
   * minor stops between them alike. The minor stops matter more here than
   * anywhere else on the board: route 4 has 6 timepoints and 48 stops, and the
   * stop a rider is actually standing at is a minor one five times out of six.
   */
  /*
   * Stops a bus running THIS direction is predicted to serve but which the
   * direction's published ladder does not list.
   *
   * The ladder is built from the baseline pattern, and a non-baseline trip can
   * add a stop to it — the contract calls these pattern.adds. Route 333 does
   * exactly that: 33 trips serve Brush Country/William in the EB direction and
   * the EB ladder has never heard of it, because the stop is filed under the
   * other direction. Without this, a rider standing there is told no bus is
   * approaching while a bus is genuinely on its way to them.
   *
   * One vehicle in the 2026-08-19 corpus of 71 routes, which is exactly the
   * kind of number that never shows up on route 4 and strands somebody on
   * route 333. The geometry comes from the same document — a stop id names one
   * physical place, so the other direction's published copy is the same corner.
   */
  function patternAddedStops(data, dir, known) {
    var elsewhere = Object.create(null);
    (data.timepoints || []).forEach(function (t) {
      if (hasFix(t)) elsewhere[String(t.stop_id)] = { stop: t, full: t.stop_name_full };
      (t.minor_stops || []).forEach(function (m) {
        if (hasFix(m)) elsewhere[String(m.stop_id)] = { stop: m, full: m.stop_name };
      });
    });

    var extra = [];
    var seen = Object.create(null);
    (data.vehicles || []).forEach(function (v) {
      if (!v.in_service || !v.trip || v.trip.direction_id !== dir) return;
      (v.predictions || []).forEach(function (row) {
        var id = String(row[1]);
        if (known[id] || seen[id]) return;
        var hit = elsewhere[id];
        if (!hit) return;
        seen[id] = true;
        extra.push({
          stop_id: id,
          stop_name: hit.stop.stop_name,
          stop_name_full: hit.full || hit.stop.stop_name,
          stop_sequence: row[0],
          direction_id: dir,
          lat: hit.stop.lat, lon: hit.stop.lon,
          service_status: hit.stop.service_status,
          is_timepoint: false,
          is_pattern_add: true
        });
      });
    });
    return extra;
  }

  function stopsOnRoute(data, dir) {
    var out = [];
    (((data || {}).timepoints) || []).forEach(function (t) {
      if (dir !== undefined && dir !== null && t.direction_id !== dir) return;
      if (hasFix(t)) {
        out.push({
          stop_id: String(t.stop_id),
          stop_name: t.stop_name,
          stop_name_full: t.stop_name_full || t.stop_name,
          stop_sequence: t.stop_sequence,
          direction_id: t.direction_id,
          lat: t.lat, lon: t.lon,
          service_status: t.service_status,
          is_timepoint: true
        });
      }
      (t.minor_stops || []).forEach(function (m) {
        if (!hasFix(m)) return;
        out.push({
          stop_id: String(m.stop_id),
          stop_name: m.stop_name,
          stop_name_full: m.stop_name,
          stop_sequence: m.stop_sequence,
          direction_id: t.direction_id,
          lat: m.lat, lon: m.lon,
          service_status: m.service_status,
          is_timepoint: false
        });
      });
    });
    if (dir !== undefined && dir !== null) {
      /*
       * `known` is every stop id this direction PUBLISHES, including the ones
       * dropped just above for having no usable fix. A stop the ladder already
       * lists is not a pattern add, and re-adding it with the other direction's
       * coordinates would quietly undo the no-fix rule — the document said
       * where that stop is and the answer was unusable, which is not the same
       * as the document never mentioning it.
       */
      var known = Object.create(null);
      (((data || {}).timepoints) || []).forEach(function (t) {
        if (t.direction_id !== dir) return;
        known[String(t.stop_id)] = true;
        (t.minor_stops || []).forEach(function (m) { known[String(m.stop_id)] = true; });
      });
      out = out.concat(patternAddedStops(data || {}, dir, known));
    }
    return out;
  }

  /*
   * The nearest stop to a fix, plus the honest caveat.
   *
   * `ambiguous` is not a magic accuracy threshold. It asks whether this
   * particular fix can actually separate the two nearest candidates: if the
   * accuracy radius is wider than the gap between first and second place, the
   * reading does not know which of them you are at, and saying "you are at
   * Pleasant Valley/5th" would be a guess wearing a fact's clothes. On these
   * routes consecutive stops are a median 331m apart, so a good fix resolves
   * them and a coarse network fix does not.
   */
  function nearestStop(stops, lat, lon, accuracyMeters) {
    if (!stops || !stops.length || !isFinite(lat) || !isFinite(lon)) return null;
    var ranked = stops.map(function (s) {
      return { stop: s, meters: metersBetween(lat, lon, s.lat, s.lon) };
    }).filter(function (r) {
      return isFinite(r.meters);
    }).sort(function (a, b) {
      return a.meters - b.meters;
    });
    if (!ranked.length) return null;
    var best = ranked[0];
    var runnerUp = ranked[1] || null;
    var gap = runnerUp ? runnerUp.meters - best.meters : Infinity;
    return {
      stop: best.stop,
      meters: best.meters,
      runnerUp: runnerUp ? runnerUp.stop : null,
      ambiguous: typeof accuracyMeters === 'number' && isFinite(accuracyMeters)
        ? accuracyMeters > gap
        : false
    };
  }

  /* The prediction row for one stop on one vehicle, or null. Matching is on
     stop_id, not stop_sequence: route 4 runs a 17-stop baseline on five
     services and a 19-stop one on three others, so the same physical stop does
     not carry the same sequence on every trip. */
  function predictionFor(vehicle, stopId) {
    var rows = (vehicle && vehicle.predictions) || [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && String(rows[i][1]) === String(stopId)) {
        return { stop_sequence: rows[i][0], stop_id: String(rows[i][1]), predicted_at: rows[i][2] };
      }
    }
    return null;
  }

  /*
   * Buses that still have this stop ahead of them, soonest first.
   *
   * There is no "is it approaching" test here because there is nothing to test:
   * the server built predictions from stops at or ahead of the bus, so presence
   * in the list IS the approach. A bus that has passed you simply has no row
   * for your stop and does not appear.
   */
  function arrivals(data, stop, now) {
    if (!data || !stop) return [];
    var out = [];
    (data.vehicles || []).forEach(function (v) {
      if (!v.in_service || !v.trip) return;
      if (v.trip.direction_id !== stop.direction_id) return;
      var p = predictionFor(v, stop.stop_id);
      if (!p) return;
      var css = v.progress ? v.progress.current_stop_sequence : null;
      out.push({
        vehicle: v,
        predicted_at: p.predicted_at,
        seconds: p.predicted_at - now,
        /* Null, not zero, when the feed does not say where the bus is: a
           missing sequence must not render as "0 stops away". */
        stops_away: typeof css === 'number' ? p.stop_sequence - css : null
      });
    });
    out.sort(function (a, b) { return a.predicted_at - b.predicted_at; });
    return out;
  }

  /* "due" / "2 min" / "14 min". Sub-minute is not a countdown a rider can act
     on, and a negative one means the bus is behind its own prediction — both
     are the same instruction: it is here or about to be. */
  function countdown(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(seconds)) return null;
    if (seconds < 60) return 'due';
    return Math.round(seconds / 60) + ' min';
  }

  function countdownSpoken(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(seconds)) return 'unknown';
    if (seconds < 60) return 'due now';
    var m = Math.round(seconds / 60);
    return 'in ' + m + ' minute' + (m === 1 ? '' : 's');
  }

  /*
   * Austin measures walking in feet up close and miles beyond that. Inside
   * AT_STOP_M the honest reading is not a distance at all: a phone fix is not
   * good to 20m, so "30 ft away" claims a precision the fix does not have when
   * the real answer is "you are standing at it".
   */
  var AT_STOP_M = 25;

  function walk(meters) {
    if (!isFinite(meters)) return '';
    if (meters < AT_STOP_M) return 'here';
    var feet = meters * 3.28084;
    if (feet < 1000) return Math.round(feet / 10) * 10 + ' ft';
    return (meters / 1609.344).toFixed(1) + ' mi';
  }

  /* ---- rendering -------------------------------------------------------- */

  function geoErrorText(err) {
    if (!err) return 'Your browser did not return a location.';
    /* Codes rather than names: the constants are on the interface, not the
       instance, in some engines. */
    if (err.code === 1) {
      return 'Location permission was declined, so the board cannot tell which stop you are at. ' +
        'Nothing was sent anywhere — the check happens entirely in this browser.';
    }
    if (err.code === 2) {
      return 'Your device could not get a fix. Indoors and underground are the usual reasons.';
    }
    if (err.code === 3) {
      return 'Your device took too long to answer.';
    }
    return 'Your browser did not return a location.';
  }

  function arrivalLine(a, data) {
    var line = el('li', 'near__arrival');

    var when = el('span', 'near__when');
    var text = countdown(a.seconds);
    when.appendChild(el('b', 'fig', text));
    line.appendChild(when);

    var meta = el('span', 'near__ameta');
    meta.appendChild(el('b', 'near__vid', '#' + (a.vehicle.label || a.vehicle.vehicle_id)));
    meta.appendChild(el('span', 'sep', ' · '));
    meta.appendChild(el('span', 'fig', fmt.clock(a.predicted_at)));
    if (a.stops_away !== null && a.stops_away > 0) {
      meta.appendChild(el('span', 'sep', ' · '));
      meta.appendChild(el('span', 'dim', fmt.plural(a.stops_away, 'stop', 'stops') + ' away'));
    }
    line.appendChild(meta);

    line.setAttribute('aria-label',
      'Bus ' + (a.vehicle.label || a.vehicle.vehicle_id) + ' ' + countdownSpoken(a.seconds) +
      ', predicted ' + fmt.clockSpoken(a.predicted_at) +
      (a.stops_away !== null && a.stops_away > 0 ? ', ' + a.stops_away + ' stops away' : '') + '.');
    return line;
  }

  /*
   * One stop's worth of answer. Returns null when there is no stop to report,
   * so the caller can say something better than an empty box.
   */
  function stopBlock(data, found, now, dirLabel) {
    var block = el('section', 'near__stop');
    var head = el('p', 'near__stophead');
    if (dirLabel) {
      head.appendChild(el('span', 'dirtag', dirLabel));
    }
    head.appendChild(el('b', 'near__stopname', found.stop.stop_name_full || found.stop.stop_name));
    head.appendChild(el('span', 'near__walk',
      ' · ' + walk(found.meters) + (found.meters < AT_STOP_M ? '' : ' away')));
    block.appendChild(head);

    if (found.ambiguous && found.runnerUp) {
      block.appendChild(el('p', 'near__caveat',
        'Your location is not precise enough to tell this stop from ' +
        (found.runnerUp.stop_name_full || found.runnerUp.stop_name) + '.'));
    }

    if (found.stop.service_status && found.stop.service_status.state &&
        found.stop.service_status.state !== 'served') {
      block.appendChild(el('p', 'near__caveat',
        'This stop is not being served right now.'));
    }

    var list = arrivals(data, found.stop, now);
    if (!list.length) {
      /*
       * Empty is a feature (design doc §D2), and here it has two distinct
       * causes that must not be blurred: the feed withheld its predictions
       * because the data is stale, or no bus on this route has this stop ahead
       * of it. Only the second one means "nothing is coming".
       */
      var suppressed = data.staleness && data.staleness.suppress_adherence;
      block.appendChild(S.notice('empty',
        suppressed ? 'No arrival times while the feed is behind.'
                   : 'No bus is approaching this stop.',
        suppressed
          ? 'The feed is ' + fmt.age(data.staleness.oldest_feed_age_s) +
            ', so the board is not publishing arrival times it cannot stand behind.'
          : 'Every bus on this route has already passed it, or none is in service ' +
            'in this direction.'));
      return block;
    }

    var ul = el('ul', 'near__arrivals');
    list.forEach(function (a) { ul.appendChild(arrivalLine(a, data)); });
    block.appendChild(ul);
    return block;
  }

  /*
   * render(host, data, opts)
   *   opts.direction  0 | 1 | 'both'
   *   opts.geo        null | {status, lat, lon, accuracy, at, error}
   *   opts.onLocate   click handler for the button
   *   opts.onClear    click handler for dismissing
   */
  function render(host, data, opts) {
    S.clear(host);
    var geo = opts.geo;

    var band = el('section', 'near');
    band.setAttribute('aria-label', 'Nearest stop');

    /* Idle: an offer, never a prompt. The permission dialog is only ever
       raised by an explicit tap — a board that asks for your location the
       moment it loads is a board people close. */
    if (!geo || geo.status === 'idle') {
      var offer = el('div', 'near__offer');
      var b = el('button', 'btn btn--near', 'Use my location');
      b.type = 'button';
      b.addEventListener('click', opts.onLocate);
      offer.appendChild(b);
      offer.appendChild(el('p', 'near__pitch',
        'Finds your nearest stop on this route and when the next bus reaches it. ' +
        'Stays in this browser.'));
      band.appendChild(offer);
      host.appendChild(band);
      return;
    }

    if (geo.status === 'unsupported') {
      band.appendChild(S.notice('empty', 'This browser has no location support.',
        'The board needs the browser\'s own Geolocation API and this one does not offer it.'));
      host.appendChild(band);
      return;
    }

    if (geo.status === 'locating') {
      var wait = el('p', 'near__pitch', 'Getting your location…');
      wait.setAttribute('role', 'status');
      band.appendChild(wait);
      host.appendChild(band);
      return;
    }

    if (geo.status === 'error') {
      band.appendChild(S.notice('error', 'Could not use your location.',
        geoErrorText(geo.error), S.retryButton('Try again', opts.onLocate)));
      host.appendChild(band);
      return;
    }

    /* status === 'ok' */
    var head = el('div', 'near__head');
    head.appendChild(el('h2', 'near__title', 'Nearest stop'));
    var tools = el('span', 'near__tools');
    var again = el('button', 'btn btn--ghost', 'Update');
    again.type = 'button';
    again.addEventListener('click', opts.onLocate);
    tools.appendChild(again);
    var off = el('button', 'btn btn--ghost', 'Hide');
    off.type = 'button';
    off.addEventListener('click', opts.onClear);
    tools.appendChild(off);
    head.appendChild(tools);
    band.appendChild(head);

    if (!data || !data.timepoints || !data.timepoints.length) {
      band.appendChild(S.notice('empty', 'No stops published for this route.',
        'The board cannot place you on a route it has no stop list for.'));
      host.appendChild(band);
      return;
    }

    /*
     * One block per direction in view. A rider standing on a street has a stop
     * on each side of it and the useful one depends on where they are going, so
     * BOTH mode answers for both rather than picking the marginally closer of
     * the pair and being wrong half the time.
     */
    var dirs = opts.direction === 'both'
      ? global.CMB.rows.directionsInLadderOrder(data).map(function (d) { return d.id; })
      : [opts.direction];

    var now = data.generated_at;
    var any = false;
    dirs.forEach(function (dir) {
      var found = nearestStop(stopsOnRoute(data, dir), geo.lat, geo.lon, geo.accuracy);
      if (!found) return;
      any = true;
      band.appendChild(stopBlock(data, found, now,
        dirs.length > 1 ? fmt.directionTagFor(data, dir) : null));
    });

    if (!any) {
      band.appendChild(S.notice('empty', 'No stop on this route has a position.',
        'Nothing published for this direction carries coordinates, so you cannot be placed on it.'));
    }

    var foot = el('p', 'near__foot');
    foot.appendChild(el('span', null, 'Times are the agency\'s own predictions, as of '));
    foot.appendChild(el('span', 'fig', fmt.clock(now)));
    foot.appendChild(el('span', null, '. Your location stays in this browser.'));
    band.appendChild(foot);

    host.appendChild(band);
  }

  /*
   * The vehicles the panel is currently naming, so the rows can be marked. The
   * highlight is a marker on rows that already exist, not a re-sort: the rows
   * are ordered worst-news-first for a reason and quietly promoting "your" bus
   * to the top would hide a very late one above it.
   */
  function highlightedVehicleIds(data, opts) {
    var geo = opts && opts.geo;
    if (!geo || geo.status !== 'ok' || !data || !data.timepoints) return [];
    var dirs = opts.direction === 'both'
      ? global.CMB.rows.directionsInLadderOrder(data).map(function (d) { return d.id; })
      : [opts.direction];
    var ids = [];
    dirs.forEach(function (dir) {
      var found = nearestStop(stopsOnRoute(data, dir), geo.lat, geo.lon, geo.accuracy);
      if (!found) return;
      var list = arrivals(data, found.stop, data.generated_at);
      if (list.length) ids.push(list[0].vehicle.vehicle_id);
    });
    return ids;
  }

  global.CMB.near = {
    render: render,
    stopsOnRoute: stopsOnRoute,
    nearestStop: nearestStop,
    arrivals: arrivals,
    predictionFor: predictionFor,
    metersBetween: metersBetween,
    countdown: countdown,
    countdownSpoken: countdownSpoken,
    walk: walk,
    highlightedVehicleIds: highlightedVehicleIds,
    FIX_MAX_AGE_MS: FIX_MAX_AGE_MS,
    GEO_OPTS: GEO_OPTS
  };
})(window);
