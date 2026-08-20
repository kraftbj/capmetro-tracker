/*
 * stopboard.js — "I am standing at this stop. What is coming?"
 *
 * The next two buses each way at one stop on one route. It is the question a
 * printed timetable answers badly and a dispatch board should answer well,
 * because the interesting part is never the schedule.
 *
 * WHY "NEXT" MEANS PREDICTED ARRIVAL AND NOT SCHEDULED TIME
 *
 * Measured on route 800 at Simond SB at 10:10 in the 2026-08-19 capture:
 *
 *   sched 09:52   bus 8005, 20 min late   arrives 10:12
 *   sched 10:02   bus 8025,  6 min late   arrives 10:08   (gone)
 *   sched 10:12   bus 8058,  on time      arrives 10:12
 *
 * Ranked by SCHEDULED time, the next bus is the 10:12 and the 09:52 has been
 * filtered out for being in the past. Ranked by when a bus will actually turn
 * up, two buses arrive in the same minute and then nothing comes for twelve.
 * The second reading is true and it is the one that changes what a person does.
 *
 * So a departure is upcoming when its PREDICTED arrival is still ahead, and the
 * list is sorted the same way. A bus whose scheduled time has passed is still
 * coming, and saying otherwise is the single most useful thing this panel can
 * get wrong.
 */
(function (global) {
  'use strict';

  var fmt = global.CMB.fmt;
  var adhLib = global.CMB.adherence;
  var S = global.CMB.states;
  var W = global.CMB.watch;
  var el = S.el;

  /*
   * A bus due half a minute ago is still worth showing: the rider is standing
   * there and the feed is up to 60s stale by design. Dropping it the instant
   * its predicted time passes makes the panel flicker at exactly the wrong
   * moment.
   */
  var GRACE_S = 90;

  /** Every direction the stop is served in, in id order. */
  function directionsAt(dep, stopId) {
    var seen = Object.create(null);
    ((dep && dep.departures && dep.departures[stopId]) || []).forEach(function (row) {
      var trip = (dep.trips || [])[row[1]];
      if (trip && seen[trip.direction_id] === undefined) {
        seen[trip.direction_id] = trip.headsign || null;
      }
    });
    return Object.keys(seen)
      .map(function (k) { return { id: Number(k), headsign: seen[k] }; })
      .sort(function (a, b) { return a.id - b.id; });
  }

  /*
   * One direction's upcoming departures, richest first. `route` may be null:
   * the schedule alone still answers the question, just without predictions,
   * which is the honest state before a route's live file has loaded.
   */
  function upcoming(dep, route, stopId, directionId, now, count) {
    var rows = W.departuresAt(dep, stopId, directionId);
    var suppressed = !!(route && route.staleness && route.staleness.suppress_adherence);
    var out = [];

    rows.forEach(function (row) {
      var scheduledAt = dep.service_day_start_epoch + row.seconds;
      var vehicle = route ? W.vehicleForTrip(route, row.trip.id) : null;
      var view = vehicle ? adhLib.view(vehicle, route.staleness) : null;
      var lateness = view && view.seconds !== null && view.seconds !== undefined ? view.seconds : null;

      /*
       * WHERE THE ARRIVAL TIME COMES FROM, in order of preference.
       *
       * 1. Vehicle.predictions -- the agency's own predicted arrival for THIS
       *    stop on THIS trip.
       * 2. scheduled + lateness, which is this stop's scheduled time plus the
       *    deviation measured at whatever stop the bus is currently approaching.
       *
       * (2) was the only option before the route document published (1), and it
       * quietly assumes the deviation at the anchor stop still holds by the time
       * the bus reaches yours. It does not: across the 2026-08-19 corpus the two
       * disagree by more than a minute on 64% of comparable (stop, bus) pairs,
       * by more than two minutes on 41%, and by up to 53 minutes. The feed models
       * recovery and dwell between the anchor and here; the extrapolation cannot.
       *
       * (2) is still needed and is not going away: predictions only cover stops
       * ahead of a bus inside the 45-minute window, which is 4,528 of the 9,865
       * departures a rider might be looking at. The rest are buses that have not
       * started their trip yet, and for those the extrapolation is the only
       * answer there is.
       *
       * The badge beside this time is left alone. It is adherence.view() -- the
       * bus's own server-owned lateness state -- and recomputing a second
       * lateness from these numbers is exactly the second vocabulary this file
       * must not grow.
       */
      var fromFeed = fmt.predictionFor(vehicle, stopId);
      var predictedAt = fromFeed ? fromFeed.predicted_at
        : lateness === null ? null : scheduledAt + lateness;
      var dueAt = predictedAt === null ? scheduledAt : predictedAt;

      if (dueAt < now - GRACE_S) { return; }

      out.push({
        trip: row.trip,
        canceled: !!row.trip.canceled,
        vehicle: vehicle,
        view: view,
        suppressed: suppressed,
        scheduled_at: scheduledAt,
        predicted_at: predictedAt,
        due_at: dueAt,
        seconds_until: dueAt - now,
        is_special: !!row.trip.is_special
      });
    });

    out.sort(function (a, b) { return a.due_at - b.due_at; });

    /*
     * A canceled departure stays on the list and does not count toward the two
     * being asked for. "Your 5:40 is canceled, the 5:57 is running" is a usable
     * answer; dropping the 5:40 leaves a hole in the timetable that reads as a
     * gap in service and tells a person at the stop nothing.
     *
     * On 2026-08-19 the client could not see a cancellation at all and rendered
     * one as "no bus reporting yet", which reads as "it has not started". A kid
     * waited at a stop for a bus that was never coming.
     */
    var want = count === undefined ? 2 : count;
    var picked = [];
    var live = 0;
    for (var i = 0; i < out.length && live < want; i++) {
      picked.push(out[i]);
      if (!out[i].canceled) { live++; }
    }
    return picked;
  }

  /**
   * The whole panel as data. Pure, so the ranking rule above is testable
   * without a DOM.
   */
  function nextAtStop(dep, route, stopId, now, count) {
    if (!dep || !stopId) { return []; }
    return directionsAt(dep, stopId).map(function (d) {
      return {
        direction_id: d.id,
        headsign: d.headsign,
        tag: fmt.directionTag(d.headsign, d.id),
        departures: upcoming(dep, route, stopId, d.id, now, count)
      };
    });
  }

  /** The stop's own record, for its name and whether it is a timepoint. */
  function stopMeta(dep, stopId) {
    var rows = ((dep && dep.stops) || []).filter(function (s) { return s.stop_id === stopId; });
    return rows[0] || null;
  }

  /* ---- render ---------------------------------------------------------- */

  function departureRow(d) {
    var row = el('article', 'nextbus nextbus--' +
      (d.canceled ? 'canceled' : d.view ? d.view.state : 'scheduled'));

    var when = el('p', 'nextbus__when');
    when.appendChild(el('span', 'nextbus__clock', fmt.clock(d.due_at)));
    if (d.canceled) {
      /*
       * The word, not a colour and not a strike-through alone. A struck-out
       * time is ambiguous at a glance and invisible to a screen reader, and
       * this is the one line on the panel that must not be misread.
       */
      when.appendChild(el('span', 'nextbus__canceled', 'CANCELED'));
      row.appendChild(when);
      row.appendChild(el('p', 'nextbus__sched',
        'CapMetro has canceled this trip. No bus is coming for it.'));
      row.appendChild(el('p', 'sr-only',
        fmt.clock(d.scheduled_at) + ' is canceled. No bus is running this trip.'));
      return row;
    }
    when.appendChild(el('span', 'nextbus__until', W.untilText(d.seconds_until)));
    row.appendChild(when);

    if (d.view && !d.suppressed && d.predicted_at !== null) {
      row.appendChild(adhLib.badge(d.view, { small: true }));
      /*
       * The scheduled time is printed only when it differs from the prediction.
       * Repeating "10:12, scheduled 10:12" on an on-time bus is noise on the
       * line a reader is scanning fastest.
       */
      if (Math.abs(d.predicted_at - d.scheduled_at) >= 60) {
        row.appendChild(el('p', 'nextbus__sched', 'scheduled ' + fmt.clock(d.scheduled_at)));
      }
      row.appendChild(el('p', 'nextbus__bus',
        'bus ' + (d.vehicle.label || d.vehicle.vehicle_id) + ' · ' + d.view.label));
    } else if (d.suppressed) {
      row.appendChild(el('p', 'nextbus__sched', 'scheduled · lateness unavailable'));
    } else {
      /*
       * No vehicle on the trip yet. That is normal before a run starts, and it
       * is NOT the same as "on time" - saying nothing would let a reader assume
       * a prediction exists.
       */
      row.appendChild(el('p', 'nextbus__sched', 'scheduled · no bus reporting yet'));
    }

    if (d.is_special) {
      row.appendChild(el('p', 'nextbus__note', 'special run · skips some usual stops'));
    }

    row.appendChild(el('p', 'sr-only',
      fmt.clock(d.due_at) + ', ' + W.untilText(d.seconds_until) +
      (d.view && !d.suppressed && d.predicted_at !== null
        ? ', ' + d.view.spoken + ', scheduled ' + fmt.clockSpoken(d.scheduled_at)
        : ', scheduled, no live prediction') + '.'));
    return row;
  }

  function directionBlock(group) {
    var box = el('section', 'nextdir');
    var head = el('p', 'nextdir__head');
    head.appendChild(el('span', 'dirtag', group.tag));
    head.appendChild(el('span', 'nextdir__sign', group.headsign || ('Direction ' + group.direction_id)));
    box.appendChild(head);

    if (!group.departures.length) {
      box.appendChild(el('p', 'nextdir__none', 'Nothing further today in this direction.'));
      return box;
    }
    var list = el('div', 'nextbuses');
    group.departures.forEach(function (d) { list.appendChild(departureRow(d)); });
    box.appendChild(list);
    return box;
  }

  /**
   * opts:
   *   stopId      the selected stop, or null
   *   stops       every stop on the route, for the picker
   *   picking     true to show the picker rather than the answer
   *   onPick(id)  a stop was chosen
   *   onChange()  ask to open or close the picker
   *   status      'ok' | 'loading' | 'error'
   */
  function render(host, dep, route, now, opts) {
    opts = opts || {};
    S.clear(host);

    var head = el('div', 'band__head');
    head.appendChild(el('h2', 'band__title', 'Next buses'));
    host.appendChild(head);

    if (!dep) {
      host.appendChild(S.notice('empty', 'Loading this route’s schedule…',
        'One file for the whole service day, so it only loads once.'));
      return host;
    }

    var stops = (dep.stops || []).slice().sort(function (a, b) {
      return a.direction_id - b.direction_id || a.stop_sequence - b.stop_sequence;
    });

    if (opts.picking || !opts.stopId) {
      host.appendChild(el('p', 'band__sub', 'Pick a stop'));
      var wrap = el('div', 'stoplist');
      var seen = Object.create(null);
      stops.forEach(function (st) {
        /* A stop served both ways appears once; the answer covers both. */
        if (seen[st.stop_id]) { return; }
        seen[st.stop_id] = true;
        var b = el('button', 'stoplist__item');
        b.type = 'button';
        if (st.stop_id === opts.stopId) { b.classList.add('is-on'); }
        b.appendChild(el('span', 'stoplist__name', st.stop_name));
        if (st.is_timepoint) { b.appendChild(el('span', 'stoplist__tag', 'timepoint')); }
        b.addEventListener('click', function () { opts.onPick(st.stop_id); });
        wrap.appendChild(b);
      });
      host.appendChild(wrap);
      return host;
    }

    var meta = stopMeta(dep, opts.stopId);
    var sub = el('p', 'band__sub');
    sub.appendChild(el('span', null, meta ? meta.stop_name : opts.stopId));
    var change = el('button', 'linkbtn');
    change.type = 'button';
    change.textContent = 'change stop';
    change.addEventListener('click', opts.onChange);
    sub.appendChild(change);
    host.appendChild(sub);

    var groups = nextAtStop(dep, route, opts.stopId, now, 2);
    if (!groups.length) {
      host.appendChild(S.notice('empty', 'No bus serves this stop today.',
        'It may be closed, or only served on another day type.'));
      return host;
    }

    var cols = el('div', 'nextdirs');
    groups.forEach(function (g) { cols.appendChild(directionBlock(g)); });
    host.appendChild(cols);

    host.appendChild(el('p', 'track__cap',
      'Ordered by when a bus will actually arrive, not by its scheduled time, ' +
      'so a late bus stays on the list until it has been.'));
    return host;
  }

  global.CMB.stopboard = {
    GRACE_S: GRACE_S,
    directionsAt: directionsAt,
    upcoming: upcoming,
    nextAtStop: nextAtStop,
    stopMeta: stopMeta,
    render: render
  };
})(window);
