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
      /*
       * The next stop is adherence.against, not progress.current_stop_id: the
       * anchor is section 2's own "first stop at or after where the bus is",
       * and it already carries a shortened name and a predicted time. Reading
       * the raw progress id instead would mean a second stop-name lookup and a
       * second definition of "next", which is how two panels start disagreeing.
       *
       * It is null whenever the board refuses to score the bus -- stale feed,
       * canceled trip, no progress -- and a null here prints nothing rather
       * than a guess.
       */
      var against = v.adherence && v.adherence.against;
      var pattern = v.pattern || null;
      return {
        id: String(v.vehicle_id),
        label: v.label || String(v.vehicle_id),
        direction_id: v.trip ? v.trip.direction_id : null,
        headsign: v.trip ? v.trip.headsign : null,
        start_epoch: v.trip ? v.trip.start_epoch : null,
        in_service: !!v.in_service,
        adherence_state: v.adherence ? v.adherence.state : 'unknown',
        next_stop_name: against ? against.stop_name : null,
        /* Normalized to null, never undefined: a missing time is the same
           answer as no anchor, and the row prints nothing for either. */
        next_stop_at: (against && against.predicted_at !== undefined)
          ? against.predicted_at : null,
        /* STOPPED_AT means the bus is sitting at that stop right now, which is
           a different sentence from "heading there". */
        is_stopped: !!(v.progress && v.progress.current_status === 'STOPPED_AT'),
        is_special: !!(pattern && pattern.is_special),
        skips: (pattern && pattern.skips) || []
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
  function stopRow(row, now) {
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
      if (row.source === 'estimate') {
        /* The divider says where a stretch turns estimated, but a screen
           reader meets each row on its own, so the word travels with the
           row too. */
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

      /*
       * A special run is the one thing on this list that changes whether a
       * rider should board at all: route 4's Austin High pattern skips
       * Campbell/5th, and route 550's skips three stations. Naming the skipped
       * stops is the whole value -- "special run" alone tells nobody anything.
       */
      if (b.is_special) {
        var flag = el('span', 'trip__bus-special');
        flag.appendChild(el('b', 'trip__bus-specialtag', 'SPECIAL RUN'));
        flag.appendChild(el('span', 'trip__bus-skips', b.skips.length
          ? 'skips ' + b.skips.map(function (s) { return s.stop_name; }).join(', ')
          : 'runs a different pattern from the usual one'));
        btn.appendChild(flag);
      }

      if (b.next_stop_name) {
        btn.appendChild(el('span', 'trip__bus-next',
          (b.is_stopped ? 'at ' : 'next ') + b.next_stop_name +
          (b.next_stop_at ? ' · ' + fmt.clock(b.next_stop_at) : '')));
      }

      btn.setAttribute('aria-label', 'Bus ' + b.label +
        (b.in_service ? ', ' + (b.headsign || 'in service') : ', not in service, cannot be followed') +
        (b.is_special ? ', special run' + (b.skips.length ? ', skips ' +
          b.skips.map(function (s) { return s.stop_name; }).join(', ') : '') : '') +
        (b.next_stop_name
          ? ', ' + (b.is_stopped ? 'stopped at ' : 'next stop ') + b.next_stop_name +
            (b.next_stop_at ? ' at ' + fmt.clockSpoken(b.next_stop_at) : '')
          : ''));
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

    /*
     * A bus that has left the feed keeps its answer on screen, dimmed, with a
     * last-seen time. The list is being read at the moment the bus disappears —
     * a trip ending, a vehicle going out of service, one dropped poll all look
     * the same from here — and taking the answer away leaves no trace of what
     * it said. Dimmed-and-labelled says what is known and what is no longer.
     *
     * This is resolved before the picker is built, not inside the `!vehicle`
     * empty-state below, so the Bus picker row names the vanished bus too —
     * otherwise the picker would read "choose" while the dimmed list under it
     * names a bus, one screen saying two different things.
     */
    var vehicle = vehicleById(route, model.vehicleId);
    var stale = null;
    if (!vehicle && model.lastSeen && model.lastSeen.vehicle &&
        String(model.lastSeen.vehicle.vehicle_id) === String(model.vehicleId)) {
      vehicle = model.lastSeen.vehicle;
      stale = model.lastSeen.at;
      if (host.classList) host.classList.add('trip--gone');
      else host.className += ' trip--gone';
    }

    var picker = el('div', 'trip__picker');
    picker.appendChild(pickerRow('Route',
      route && route.route ? (route.route.short_name || route.route.id) : null,
      opts.onPickRoute));

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

    if (stale !== null) {
      host.appendChild(S.notice('stale', 'This bus is no longer in the feed',
        'Last seen at ' + fmt.clock(stale) + '. The stops below are what it said then, ' +
        'not what is happening now. Pick another bus to start again.'));
    }

    var view = adhLib.view(vehicle, route && route.staleness);
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
      /*
       * Two states, one missing document, and they must not look the same.
       *
       * A schedule that has not arrived yet is a shimmer worth watching: it
       * resolves in a moment. A schedule the board is WITHHOLDING -- held, from
       * a service day that has ended, with the replacement not yet fetched --
       * can sit there for as long as the server keeps serving the old one, and a
       * skeleton that never resolves is a promise the board cannot keep.
       *
       * The skeleton rows also carry aria-hidden, so on their own they say
       * nothing at all to a screen reader: the panel simply stops after the bus
       * name. This is the screen built entirely around scheduled times, so it is
       * the last place that should decline to explain itself.
       *
       * The board and the editor show a notice here too, but both still headline
       * it "Loading…" — they read the same null and cannot tell these states
       * apart, because only this one is passed the flags. Worth doing there as
       * well; not done in the same breath as this.
       */
      if (opts && opts.depWithheld) {
        host.appendChild(S.notice('empty', 'Today’s schedule has not arrived yet',
          'The one being held is from a service day that has ended, so the times in it ' +
          'are not today’s. It is asked for again every minute.'));
      } else if (opts && opts.depFailed) {
        /*
         * The third state, and the same argument as the second. A schedule that
         * failed to load is not arriving in a moment either — the request is
         * retried once a minute and may keep failing — so the shimmer is just as
         * false here, and just as silent to a screen reader.
         */
        host.appendChild(S.notice('empty', 'This route’s schedule did not load',
          'Without it there are no scheduled times to list. It is asked for again ' +
          'every minute.'));
      } else {
        host.appendChild(S.skeletonRows(6));
      }
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
    var plan = fmt.arrivalPlan(ahead, vehicle, route && route.staleness);

    var count = el('p', 'trip__count', plan.reason && !ahead.anchored
      ? fmt.plural(plan.rows.length, 'scheduled stop', 'scheduled stops') + ' on this trip'
      : fmt.plural(plan.rows.length, 'stop', 'stops') + ' ahead');
    host.appendChild(count);

    if (plan.reason) { host.appendChild(reasonNotice(plan.reason, vehicle)); }

    /*
     * A divider at EVERY source change, in both directions. Feed coverage
     * has an interior gap on 9 of 249 buses — feed, then estimate, then feed
     * again — so a rule drawn only at the first feed-to-estimate transition
     * would sit under a later, unmarked return to CapMetro's own numbers and
     * mislabel them as estimated. Each marker claims something true only
     * about the rows that follow it up to the next marker, not about the
     * rest of the trip.
     */
    var list = el('ol', 'tripstops');
    plan.rows.forEach(function (row, i) {
      if (i > 0 && row.source && row.source !== plan.rows[i - 1].source) {
        var marker = row.source === 'estimate'
          ? 'Estimated stops begin here'
          : 'CapMetro’s times begin again here';
        list.appendChild(el('li', 'tripstops__divider', marker));
      }
      var li = stopRow(row, now);
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
