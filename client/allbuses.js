/*
 * allbuses.js — the fleet view. The route boards answer "is her bus late";
 * this one answers "is anything unusual happening right now", across all 392
 * vehicles CapMetro is reporting.
 *
 * Two facts drove the layout:
 *
 *   1. 143 of the 392 vehicles in the 2026-08-19 capture carry nobody. The route boards push them
 *      to a muted footer because a rider waiting on route 4 does not care.
 *      Here they are the point: a bus rolling past a stop with its head sign
 *      dark is the single most confusing thing a fleet view can show, so the
 *      deadheads get their own named section that says, in words, that you
 *      cannot board one.
 *
 *   2. 392 rows sorted any which way is a phone book, and nobody reads a
 *      phone book to find out whether the system is on fire. So the screen
 *      opens with a count strip and then falls in order of urgency: the buses
 *      in trouble, the buses carrying nobody, and only then the by-route
 *      index — itself ordered worst news first, not by route number.
 *
 * Every lateness reading comes from adherence.view(). This file never reads
 * adherence.seconds, never formats a deviation and never decides what is late;
 * doing any of those would be a second lateness vocabulary, and the first
 * symptom of one is a bus reading "+29m" here and "very late" on its route
 * board. Bunching is deliberately NOT computed here for the same reason — a
 * distance threshold invented on the client would sit next to server-owned
 * states looking equally authoritative while being neither defined nor tested.
 */
(function (global) {
  'use strict';

  var fmt = global.CMB.fmt;
  var adh = global.CMB.adherence;
  var S = global.CMB.states;
  var el = S.el;

  var STATUS_WORD = {
    IN_TRANSIT_TO: 'in transit to',
    STOPPED_AT: 'stopped at',
    INCOMING_AT: 'approaching'
  };

  /* Worst first, and the same order adherence.js sorts by. */
  var STATE_ORDER = ['very_late', 'late', 'early', 'unknown', 'ontime', 'deadhead'];

  /*
   * What earns a place above the fold: the payload's own worst word, and the
   * state that admits the board cannot say. "late" does not — a third of the
   * fleet is a few minutes late at any moment and a list of 33 buses that are
   * merely behind is the phone book again.
   */
  var ATTENTION = { very_late: true, unknown: true };

  /*
   * Deadhead sub-groups. A missing speed is its own group rather than being
   * folded into "stopped": the feed not saying is not the same as the bus not
   * moving, and a board that quietly rounds one to the other is the reason
   * nobody trusts the other one.
   */
  var MOVEMENT = [
    { key: 'moving', title: 'On the move', note: 'empty, in traffic' },
    { key: 'stopped', title: 'Stopped', note: 'parked or idling' },
    { key: 'unknown', title: 'Speed not reported', note: 'position known, motion is not' }
  ];

  var MOVEMENT_WORD = {
    moving: 'moving', stopped: 'stopped', unknown: 'speed not reported'
  };

  function movement(v) {
    var speed = v.position ? v.position.speed_mps : null;
    if (speed === null || speed === undefined) return 'unknown';
    return speed > 0 ? 'moving' : 'stopped';
  }

  function entriesFor(data) {
    var staleness = data.staleness;
    return (data.vehicles || []).map(function (v) {
      return { v: v, view: adh.view(v, staleness) };
    });
  }

  /* Worst news first, then the earliest trip, which is how rows.js orders. */
  function bySeverity(a, b) {
    if (a.view.severity !== b.view.severity) return a.view.severity - b.view.severity;
    var ta = (a.v.trip && a.v.trip.start_epoch) || 0;
    var tb = (b.v.trip && b.v.trip.start_epoch) || 0;
    return ta - tb;
  }

  /* Route ids are numeric strings today ("7", "550", "801") but nothing in the
   * contract promises that, so fall back to a string compare. */
  function byRouteLabel(a, b) {
    var na = parseInt(a, 10);
    var nb = parseInt(b, 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
  }

  function vehicleName(v) {
    return String(v.label || v.vehicle_id);
  }

  /*
   * The split the whole screen hangs on. `in_service && trip` is the same test
   * rows.js uses: a vehicle the feed calls in service but hands no trip is not
   * something a rider can board either, so it lands with the deadheads rather
   * than in a route group it has no route for.
   */
  function partition(data) {
    var carrying = [];
    var deadhead = [];
    entriesFor(data).forEach(function (e) {
      if (e.v.in_service && e.v.trip) carrying.push(e);
      else deadhead.push(e);
    });
    return { carrying: carrying, deadhead: deadhead };
  }

  function groupByRoute(entries) {
    var index = Object.create(null);
    var order = [];
    entries.forEach(function (e) {
      var id = e.v.route_id || '';
      if (!index[id]) {
        index[id] = {
          id: id,
          name: e.v.route_short_name || e.v.route_id || 'route not reported',
          entries: []
        };
        order.push(id);
      }
      index[id].entries.push(e);
    });
    return order.map(function (id) {
      var g = index[id];
      g.entries.sort(bySeverity);
      g.severity = g.entries[0].view.severity;
      g.worstCount = g.entries.filter(function (e) {
        return e.view.severity === g.severity;
      }).length;
      g.tally = tallyStates(g.entries);
      return g;
    });
  }

  function tallyStates(entries) {
    var counts = Object.create(null);
    entries.forEach(function (e) {
      counts[e.view.state] = (counts[e.view.state] || 0) + 1;
    });
    return STATE_ORDER.filter(function (s) { return counts[s]; })
      .map(function (s) {
        return { state: s, n: counts[s], label: adh.STATE_LABEL[s] || s };
      });
  }

  /*
   * Counts are derived from the vehicles array rather than read from
   * data.counts. The two agree on every payload generated so far, but the
   * numbers printed at the top of a screen must be counts OF THE THINGS DRAWN
   * BELOW them — a header that says 249 over a list of 248 is a bug report
   * nobody can act on, and the contract does not promise `counts` is present.
   */
  function summarize(data) {
    var parts = partition(data);
    var routes = Object.create(null);
    var attention = 0;
    var veryLate = 0;
    parts.carrying.forEach(function (e) {
      if (e.v.route_id) routes[e.v.route_id] = true;
      if (ATTENTION[e.view.state]) attention++;
      if (e.view.state === 'very_late') veryLate++;
    });
    return {
      total: parts.carrying.length + parts.deadhead.length,
      carrying: parts.carrying.length,
      deadhead: parts.deadhead.length,
      routes: Object.keys(routes).length,
      attention: attention,
      veryLate: veryLate,
      suppressed: !!(data.staleness && data.staleness.suppress_adherence)
    };
  }

  /* ---- pieces ------------------------------------------------------- */

  function sectionHead(title, note) {
    var h = el('h3', 'subband__head');
    h.appendChild(el('span', null, title));
    if (note) h.appendChild(el('span', 'subband__note', note));
    return h;
  }

  function stat(n, key, alarm) {
    var box = el('div', 'fleetstat' + (alarm ? ' fleetstat--alarm' : ''));
    box.appendChild(el('span', 'fleetstat__n fig', String(n)));
    box.appendChild(el('span', 'fleetstat__k', key));
    return box;
  }

  /*
   * The strip is the answer to "is anything unusual happening" and it has to
   * survive a grayscale screenshot, so every cell states its own noun. The
   * very-late cell is drawn even when it reads 0 — "0 very late" is the good
   * news, and a cell that vanishes when things are fine teaches the reader
   * nothing about what its absence means.
   */
  function strip(sum) {
    var s = el('div', 'fleetstrip');
    s.appendChild(stat(sum.carrying, 'carrying riders'));
    s.appendChild(stat(sum.deadhead, 'not in service'));
    s.appendChild(stat(sum.routes, sum.routes === 1 ? 'route running' : 'routes running'));
    if (!sum.suppressed) {
      s.appendChild(stat(sum.veryLate, 'very late', sum.veryLate > 0));
    }
    return s;
  }

  /*
   * One bus, one or two lines. Deliberately not the route board's expandable
   * card: there are up to 392 of these, and the expansion already exists — it
   * is the route board, one tap away on the group header.
   */
  function busRow(e, data, showRoute) {
    var v = e.v;
    var view = e.view;
    var row = el('article', 'abrow abrow--' + view.state);

    var badge = el('span', 'abrow__badge');
    badge.appendChild(adh.badge(view, { small: true }));
    /* The badge is aria-hidden; this is where the state becomes text, which is
     * the same trade rows.js makes. */
    badge.appendChild(el('span', 'abrow__state', view.label));
    row.appendChild(badge);

    var meta = el('span', 'abrow__meta');
    var l1 = el('span', 'abrow__l1');
    l1.appendChild(el('b', 'abrow__id', '#' + vehicleName(v)));
    if (showRoute && v.route_id) {
      l1.appendChild(el('span', 'sep', ' · '));
      l1.appendChild(el('span', 'abrow__route', 'route ' + (v.route_short_name || v.route_id)));
    }
    l1.appendChild(el('span', 'sep', ' · '));
    if (v.trip) {
      l1.appendChild(el('span', 'fig', fmt.serviceClock(v.trip.start_time)));
      l1.appendChild(el('span', null, ' ' + (v.trip.headsign || 'destination not reported')));
    } else {
      l1.appendChild(el('span', null, 'no trip assigned'));
    }
    meta.appendChild(l1);

    var l2 = el('span', 'abrow__l2');
    var against = v.adherence && v.adherence.against;
    if (view.suppressed && v.in_service) {
      /* No lateness value, and none of the numbers it is derived from. */
      l2.appendChild(el('span', 'dim', 'position '));
      l2.appendChild(el('span', 'fig', fmt.clock(v.position_at)));
      l2.appendChild(el('span', 'sep', ' · '));
      l2.appendChild(el('span', 'warnink', 'timing unavailable'));
    } else if (against) {
      l2.appendChild(el('span', 'dim', 'next '));
      l2.appendChild(el('span', 'abrow__stop', against.stop_name || 'stop ' + against.stop_id));
      l2.appendChild(el('span', 'sep', ' · '));
      l2.appendChild(el('span', 'dim', 'pred '));
      l2.appendChild(el('span', 'fig', fmt.clock(against.predicted_at)));
    } else if (v.in_service) {
      l2.appendChild(el('span', 'warnink', view.reasonLabel || 'no prediction available'));
      if (v.progress && v.progress.current_stop_id) {
        l2.appendChild(el('span', 'sep', ' · '));
        l2.appendChild(el('span', 'dim',
          (STATUS_WORD[v.progress.current_status] || 'near') + ' stop '));
        l2.appendChild(el('span', 'fig', String(v.progress.current_stop_id)));
      }
    } else {
      l2.appendChild(el('span', 'dim', 'last seen '));
      l2.appendChild(el('span', 'fig', fmt.clock(v.position_at)));
      l2.appendChild(el('span', 'sep', ' · '));
      l2.appendChild(el('span', null, 'not carrying passengers'));
    }
    meta.appendChild(l2);
    row.appendChild(meta);
    return row;
  }

  function rowList(entries, data, showRoute) {
    var list = el('div', 'abrows');
    entries.forEach(function (e) { list.appendChild(busRow(e, data, showRoute)); });
    return list;
  }

  /* ---- the trouble band ---------------------------------------------- */

  function attentionBand(carrying, data, suppressed) {
    var band = el('section', 'abband abband--attention');

    if (suppressed) {
      band.appendChild(sectionHead('Needs a look', 'lateness hidden'));
      band.appendChild(S.notice('empty', 'The board cannot say which buses are late.',
        'The feed is too far behind to judge lateness, so no bus can be ranked by it. ' +
        'Positions below are the last ones received.'));
      return band;
    }

    var flagged = carrying.filter(function (e) { return ATTENTION[e.view.state]; });
    flagged.sort(bySeverity);

    var counts = tallyStates(flagged);
    var note = counts.map(function (c) { return c.n + ' ' + c.label; }).join(' · ');
    band.appendChild(sectionHead('Needs a look', note || 'nothing flagged'));

    if (!flagged.length) {
      band.appendChild(S.notice('empty', 'No bus is running very late.',
        fmt.plural(carrying.length, 'bus is', 'buses are') + ' carrying riders right now, ' +
        'and every one of them is reporting early, on time or late — none has crossed ' +
        'into very late, and none is missing a prediction.'));
      return band;
    }

    band.appendChild(el('p', 'abnote',
      'These buses are also listed under their route below.'));
    band.appendChild(rowList(flagged, data, true));
    return band;
  }

  /* ---- the deadhead band ---------------------------------------------- */

  /*
   * A chip grid rather than 143 rows. A deadhead has no trip, no head sign and
   * no lateness — its whole record is an id, a clock and whether the wheels are
   * turning — so a row built for a trip would be seven eighths empty. What the
   * reader needs is the count, the plain-language reason, and the ability to
   * find one specific bus by number.
   */
  function deadheadChips(entries) {
    var list = el('ul', 'abchips');
    entries.slice().sort(function (a, b) {
      return byRouteLabel(vehicleName(a.v), vehicleName(b.v));
    }).forEach(function (e) {
      var v = e.v;
      var item = el('li', 'abchip abchip--' + movement(v));
      item.setAttribute('aria-label', 'Bus ' + vehicleName(v) +
        ', not carrying passengers, ' + MOVEMENT_WORD[movement(v)] +
        ', last reported ' + fmt.clockSpoken(v.position_at) + '.');
      item.appendChild(el('span', 'abchip__id', '#' + vehicleName(v)));
      item.appendChild(el('span', 'abchip__t fig', fmt.clock(v.position_at)));
      list.appendChild(item);
    });
    return list;
  }

  function deadheadBand(deadhead) {
    var band = el('section', 'abband abband--deadhead');
    band.appendChild(sectionHead('Not carrying passengers',
      fmt.plural(deadhead.length, 'bus', 'buses')));

    if (!deadhead.length) {
      band.appendChild(S.notice('empty', 'Every bus reporting in is in service.',
        'No vehicle is deadheading right now — nothing on the road without a trip.'));
      return band;
    }

    /* The whole reason this section exists, said before the numbers. */
    band.appendChild(el('p', 'abnote',
      'These buses are on the road but out of service — driving to or from a garage, ' +
      'or repositioning between assignments. You cannot board one, and none of them ' +
      'appears on a route board. A bus passing your stop may well be one of these.'));

    /*
     * Moving and parked are different problems. A parked deadhead is a bus in
     * a yard and nobody's concern; a moving one is the bus that just blew past
     * a stop with people on it. Splitting them is the only classification this
     * panel makes, and it is a direct read of speed_mps, not an inference.
     */
    MOVEMENT.forEach(function (m) {
      var group = deadhead.filter(function (e) { return movement(e.v) === m.key; });
      if (!group.length) return;
      band.appendChild(sectionHead(m.title,
        fmt.plural(group.length, 'bus', 'buses') + ' · ' + m.note));
      band.appendChild(deadheadChips(group));
    });
    return band;
  }

  /* ---- the by-route index --------------------------------------------- */

  function tallyEl(tally) {
    var wrap = el('span', 'abtally');
    tally.forEach(function (t) {
      var item = el('span', 'abtally__item abtally__item--' + t.state);
      var glyph = el('span', 'abtally__glyph', glyphForState(t.state));
      glyph.setAttribute('aria-hidden', 'true');
      item.appendChild(glyph);
      item.appendChild(el('span', 'abtally__n fig', String(t.n)));
      wrap.appendChild(item);
    });
    /* The glyphs are shape, not text. This is the same facts in words, for a
     * screen reader and for anyone who cannot tell ■ from ▲ at 11px. */
    wrap.appendChild(el('span', 'sr-only', tally.map(function (t) {
      return t.n + ' ' + t.label;
    }).join(', ') + '.'));
    return wrap;
  }

  /*
   * The glyph for a state, asked of adherence.js rather than mapped again
   * here. A second copy of that table is how one panel ends up drawing ▲ for
   * a state another panel draws ■ for, which is ISSUE-002 with shapes.
   */
  function glyphForState(state) {
    return adh.view({ adherence: { state: state, seconds: null, reason: null } }, null).glyph;
  }

  function routeGroup(group, data, onSelectRoute) {
    var box = el('section', 'abroute');

    /* A header that cannot be tapped is not drawn as a tap target. */
    var head;
    if (onSelectRoute && group.id) {
      head = el('button', 'abroute__head');
      head.type = 'button';
      head.setAttribute('aria-label', 'Open the route ' + group.name + ' board — ' +
        fmt.plural(group.entries.length, 'bus', 'buses') + ', ' +
        group.tally.map(function (t) { return t.n + ' ' + t.label; }).join(', ') + '.');
      head.addEventListener('click', function () { onSelectRoute(group.id); });
    } else {
      head = el('div', 'abroute__head abroute__head--flat');
    }
    head.appendChild(el('span', 'abroute__id', group.name));
    head.appendChild(el('span', 'abroute__n', fmt.plural(group.entries.length, 'bus', 'buses')));
    head.appendChild(tallyEl(group.tally));
    if (onSelectRoute && group.id) {
      var caret = el('span', 'abroute__caret', '›');
      caret.setAttribute('aria-hidden', 'true');
      head.appendChild(caret);
    }
    box.appendChild(head);
    box.appendChild(rowList(group.entries, data, false));
    return box;
  }

  function routeBand(carrying, data, opts, suppressed) {
    var band = el('section', 'abband abband--routes');
    var groups = groupByRoute(carrying);

    /*
     * Worst news first, not route number. A reader scanning this band is
     * looking for the route that is in trouble; sorting 48 groups by number
     * buries it behind 300-series flyers that are all on time. With lateness
     * suppressed there is no worst news to sort by, so it falls back to route
     * number, which is at least a predictable order to hunt in.
     */
    if (suppressed) {
      groups.sort(function (a, b) { return byRouteLabel(a.name, b.name); });
    } else {
      groups.sort(function (a, b) {
        if (a.severity !== b.severity) return a.severity - b.severity;
        if (a.worstCount !== b.worstCount) return b.worstCount - a.worstCount;
        if (a.entries.length !== b.entries.length) return b.entries.length - a.entries.length;
        return byRouteLabel(a.name, b.name);
      });
    }

    band.appendChild(sectionHead('Every route running',
      fmt.plural(groups.length, 'route', 'routes') +
      (suppressed ? ' · by route number' : ' · worst first')));

    if (!groups.length) {
      band.appendChild(S.notice('empty', 'No route has a bus on it.',
        'Every vehicle reporting in is out of service. Nothing is carrying riders.'));
      return band;
    }

    var list = el('div', 'abroutes');
    groups.forEach(function (g) {
      list.appendChild(routeGroup(g, data, opts.onSelectRoute));
    });
    band.appendChild(list);
    return band;
  }

  /* ---- entry point ----------------------------------------------------- */

  /*
   * render(host, data, opts)
   *   opts.status          'ok' | 'loading' | 'error'
   *   opts.errorDetail     string, appended to the error notice
   *   opts.lastGood        epoch seconds of the last payload that loaded
   *   opts.onRetry         fn(), wired to the retry button
   *   opts.onSelectRoute   fn(routeId), fired when a route header is tapped.
   *                        Omit it and the headers render as plain labels
   *                        rather than dead buttons.
   */
  function render(host, data, opts) {
    opts = opts || {};
    data = data || {};
    S.clear(host);

    var head = el('div', 'band__head');
    head.appendChild(el('h2', 'band__title', 'All buses'));
    var sub = el('p', 'band__sub');
    head.appendChild(sub);
    host.appendChild(head);

    if (opts.status === 'loading') {
      sub.textContent = 'Counting the fleet…';
      host.appendChild(S.skeletonRows(6));
      return;
    }

    if (opts.status === 'error') {
      sub.textContent = 'Feed unreachable';
      host.appendChild(S.notice('error', 'Can\'t reach the feed.',
        opts.lastGood
          ? 'Showing nothing rather than a fleet count from ' + fmt.clock(opts.lastGood) +
            ', which would be wrong by now.'
          : 'Nothing has loaded yet, so there is no fleet to count. ' +
            (opts.errorDetail || ''),
        S.retryButton('Retry', opts.onRetry)));
      return;
    }

    var sum = summarize(data);

    if (!sum.total) {
      sub.textContent = 'No vehicles reported';
      host.appendChild(S.notice('empty', 'CapMetro is reporting no buses at all.',
        'Not one vehicle appears in the feed' +
        (data.generated_at ? ' as of ' + fmt.clock(data.generated_at) : '') +
        '. Overnight this is normal. During service hours it means the vehicle feed ' +
        'is empty, which is a CapMetro problem rather than a problem with this board.'));
      return;
    }

    var bits = [fmt.plural(sum.total, 'bus', 'buses') + ' reporting'];
    bits.push(sum.carrying + ' carrying riders');
    bits.push(sum.deadhead + ' not in service');
    if (data.generated_at) bits.push('as of ' + fmt.clock(data.generated_at));
    sub.textContent = bits.join(' · ');

    var parts = partition(data);
    host.appendChild(strip(sum));
    host.appendChild(attentionBand(parts.carrying, data, sum.suppressed));
    host.appendChild(deadheadBand(parts.deadhead));
    host.appendChild(routeBand(parts.carrying, data, opts, sum.suppressed));
  }

  global.CMB.allbuses = {
    render: render,
    summarize: summarize,
    partition: partition,
    groupByRoute: groupByRoute
  };
})(window);
