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
   * The agency's predicted arrival for ONE departure -- one (trip, stop,
   * scheduled time) triple -- or null.
   *
   * This is deliberately not fmt.predictionFor(). That function matches on
   * stop_id alone and returns the SOONEST occurrence, which is exactly right
   * for near.js ("when does this bus next reach the stop I am standing at")
   * and exactly wrong here. A stop board row is a scheduled departure, and 270
   * (stop, trip) pairs in the 2026-08-19 corpus are stops a trip visits TWICE.
   * Asked by stop_id alone, both rows get the first pass's time: measured over
   * that corpus, 6 rendered rows carried the wrong arrival, the worst by 51
   * minutes, and three of the six discarded a distinct time CapMetro had
   * actually published for the second pass.
   *
   * So the join is positional, through the same three functions the trip view
   * uses, and the row is then found by its own scheduled_at -- an exact key,
   * since that is what a departure row IS.
   */
  function feedArrivalFor(dep, route, vehicle, stopId, scheduledAt) {
    if (!vehicle || !dep) return null;
    var stops = fmt.stopTimesForTrip(dep, vehicle.trip && vehicle.trip.trip_id);
    if (!stops) return null;
    var plan = fmt.arrivalPlan(fmt.stopsAheadOf(stops, vehicle), vehicle,
      route && route.staleness);
    if (plan.reason) return null;
    for (var i = 0; i < plan.rows.length; i++) {
      var r = plan.rows[i];
      if (r.stop_id === String(stopId) && r.scheduled_at === scheduledAt &&
          r.source === 'feed') {
        return { stop_id: r.stop_id, predicted_at: r.predicted_at };
      }
    }
    return null;
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
       * Which of the two a row used decides whether it may also show the
       * adherence badge -- see departureRow(). The badge is not recomputed from
       * these numbers either way: adherence.view() is the one lateness
       * vocabulary, and a second one derived here is exactly what this file must
       * not grow.
       */
      var fromFeed = feedArrivalFor(dep, route, vehicle, stopId, scheduledAt);
      var predictedAt = fromFeed ? fromFeed.predicted_at
        : lateness === null ? null : scheduledAt + lateness;
      var dueAt = predictedAt === null ? scheduledAt : predictedAt;

      if (dueAt < now - GRACE_S) { return; }

      out.push({
        trip: row.trip,
        canceled: W.isCanceled(row.trip, route),
        vehicle: vehicle,
        view: view,
        suppressed: suppressed,
        scheduled_at: scheduledAt,
        predicted_at: predictedAt,
        /* Which of the two sources above this row's time came from. The row
           renders differently for each, because only one of them keeps the
           badge and the time in agreement -- see departureRow(). */
        from_feed: !!fromFeed,
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

  /*
   * WHY A FEED-SOURCED ROW DROPS THE BADGE.
   *
   * The badge is adherence.view() -- the deviation measured at whatever stop the
   * bus is currently approaching. While this row's time was scheduled + that
   * same deviation, the two agreed by construction and the badge was a fair
   * shorthand for the arithmetic.
   *
   * Taking the time from the feed instead made it more accurate and broke that
   * identity. The row prints a time, a scheduled time and a badge, so a reader
   * can subtract -- and across the corpus 1,438 of 4,205 rendered rows would
   * then be off by more than two minutes, with 325 showing a badge and a time
   * pointing in OPPOSITE directions: "15:17, scheduled 15:20" (three early)
   * beside a "+1m" late badge.
   *
   * So on a feed-sourced row the badge, the state colour and the bare signed
   * number all go, and the two times speak for themselves -- scheduled is
   * printed always rather than only when it differs, because it is now the only
   * thing saying how late the bus is HERE. The bus's overall state survives as
   * a phrase, where a word can carry the scope a bare number cannot: a bus
   * running eleven minutes late that reaches this stop five minutes late is not
   * a contradiction, it is the feed modelling recovery, and "running very late"
   * says so without claiming to be this stop's deviation.
   *
   * An extrapolated row is unchanged: there the badge and the time are still
   * the same number, so there is nothing to disagree about.
   */
  function departureRow(d) {
    var stateClass = d.canceled ? 'canceled'
      : d.from_feed ? null
        : d.view ? d.view.state : 'scheduled';
    var row = el('article', 'nextbus' + (stateClass ? ' nextbus--' + stateClass : ''));

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
      if (!d.from_feed) {
        row.appendChild(adhLib.badge(d.view, { small: true }));
      }
      /*
       * On an extrapolated row the scheduled time is printed only when it
       * differs from the prediction: repeating "10:12, scheduled 10:12" on an
       * on-time bus is noise on the line a reader is scanning fastest. On a
       * feed-sourced row it is always printed, because with the badge gone it
       * is the only thing that says how late the bus is at THIS stop.
       */
      if (d.from_feed || Math.abs(d.predicted_at - d.scheduled_at) >= 60) {
        row.appendChild(el('p', 'nextbus__sched', 'scheduled ' + fmt.clock(d.scheduled_at)));
      }
      row.appendChild(el('p', 'nextbus__bus',
        'bus ' + (d.vehicle.label || d.vehicle.vehicle_id) + ' · ' +
        (d.from_feed ? 'running ' + d.view.label : d.view.label)));
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

    /*
     * The spoken line carries the same split. Saying "eleven minutes late,
     * scheduled 15:27" over a 15:32 arrival is the screen-reader version of the
     * contradiction above, so a feed-sourced row scopes the state to the bus.
     */
    row.appendChild(el('p', 'sr-only',
      fmt.clock(d.due_at) + ', ' + W.untilText(d.seconds_until) +
      (d.view && !d.suppressed && d.predicted_at !== null
        ? (d.from_feed
          ? ', scheduled ' + fmt.clockSpoken(d.scheduled_at) +
            '. Bus ' + (d.vehicle.label || d.vehicle.vehicle_id) +
            ' is running ' + d.view.label + ' overall'
          : ', ' + d.view.spoken + ', scheduled ' + fmt.clockSpoken(d.scheduled_at))
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
    /* Exported so a test can assert what one row actually renders. The
       badge-versus-time contradiction lived here, not in upcoming(). */
    departureRow: departureRow,
    nextAtStop: nextAtStop,
    stopMeta: stopMeta,
    render: render
  };
})(window);
