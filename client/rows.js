/*
 * rows.js — THE primary panel. It answers the only question that matters at
 * 7:50am: is her bus late.
 *
 * Rows are the one card-like object on the board (the card *is* the tap
 * target). Everything else is a band.
 *
 * The rows are also the accessible equivalent of the ladder (task D6): the
 * SVG carries no fact that is not written here in text.
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

  function vehiclesFor(data, dirFilter) {
    var inService = [];
    var outOfService = [];
    (data.vehicles || []).forEach(function (v) {
      if (v.in_service && v.trip) inService.push(v);
      else outOfService.push(v);
    });
    var shown = inService.filter(function (v) {
      return dirFilter === 'both' || v.trip.direction_id === dirFilter;
    });
    shown.sort(function (a, b) {
      var sa = adh.view(a, data.staleness).severity;
      var sb = adh.view(b, data.staleness).severity;
      if (sa !== sb) return sa - sb;
      return (a.trip.start_epoch || 0) - (b.trip.start_epoch || 0);
    });
    outOfService.sort(function (a, b) {
      return String(a.vehicle_id).localeCompare(String(b.vehicle_id));
    });
    return { shown: shown, inService: inService, outOfService: outOfService };
  }

  /* One line of "label value" inside the expanded detail. */
  function fact(label, value) {
    var row = el('div', 'fact');
    row.appendChild(el('dt', 'fact__k', label));
    row.appendChild(el('dd', 'fact__v', value));
    return row;
  }

  /*
   * Block continuation copy. §4 of the contract: a `low` confidence
   * continuation is never presented as fact.
   */
  function dirTag(data, id) {
    var d = ((data && data.route && data.route.directions) || [])
      .filter(function (x) { return x.id === id; })[0];
    return fmt.directionTag(d && d.headsign, id);
  }

  function continuationText(block, data) {
    if (!block) return null;
    if (!block.next_trip) {
      return { chip: 'last trip of block', text: 'Last trip of block ' + block.block_id + '.', hedged: false };
    }
    var n = block.next_trip;
    var when = fmt.serviceClock(n.start_time);
    var tag = dirTag(data, n.direction_id);
    var where = n.start_stop_name ? ' from ' + n.start_stop_name : '';
    var verb = n.is_direction_flip ? 'becomes' : 'then runs';
    if (block.confidence === 'high') {
      return {
        chip: verb + ' ' + when + ' ' + tag,
        text: verb.charAt(0).toUpperCase() + verb.slice(1) + ' the ' + when + ' ' + tag + where + '.',
        hedged: false
      };
    }
    return {
      chip: 'likely ' + verb + ' ' + when + ' ' + tag,
      text: 'Likely ' + verb + ' the ' + when + ' ' + tag + where +
        ' — the feed does not confirm this continuation.',
      hedged: true
    };
  }

  function spokenLabel(v, view, data) {
    var bits = ['Bus ' + (v.label || v.vehicle_id)];
    bits.push(view.spoken);
    if (v.trip) {
      bits.push(fmt.serviceClock(v.trip.start_time).replace(/a$/, ' AM').replace(/p$/, ' PM') +
        ' trip, ' + v.trip.headsign);
    }
    var against = v.adherence && v.adherence.against;
    if (view.suppressed) {
      bits.push('lateness hidden, feed is ' + fmt.age(data.staleness.oldest_feed_age_s));
    } else if (against) {
      bits.push('measured at ' + against.stop_name + ', scheduled ' +
        fmt.clockSpoken(against.scheduled_at) + ', predicted ' + fmt.clockSpoken(against.predicted_at));
    } else if (v.progress && v.progress.current_stop_id) {
      bits.push((STATUS_WORD[v.progress.current_status] || 'near') + ' stop ' + v.progress.current_stop_id);
    }
    if (v.pattern && v.pattern.is_special) bits.push('special trip pattern');
    var cont = continuationText(v.block, data);
    if (cont) bits.push(cont.text);
    if (!v.in_service) bits.push('deadhead, no trip assigned');
    return bits.map(function (b) { return String(b).replace(/\.$/, ''); }).join('. ') + '.';
  }

  /* Remembering the last state each bus was in is what makes the change flash
   * mean something. Motion fires on a real transition, never on first paint. */
  var lastState = Object.create(null);

  function buildRow(v, data, idx) {
    var view = adh.view(v, data.staleness);
    var wrap = el('article', 'vrow vrow--' + view.state);
    var prev = lastState[v.vehicle_id];
    if (prev !== undefined && prev !== view.state) wrap.classList.add('is-changed');
    lastState[v.vehicle_id] = view.state;
    var detailId = 'vdetail-' + v.vehicle_id + '-' + idx;

    var main = el('button', 'vrow__main');
    main.type = 'button';
    main.setAttribute('aria-expanded', 'false');
    main.setAttribute('aria-controls', detailId);
    main.setAttribute('aria-label', spokenLabel(v, view, data));

    var badgeCell = el('span', 'vrow__badge');
    badgeCell.appendChild(adh.badge(view));
    badgeCell.appendChild(el('span', 'vrow__state', view.label));
    main.appendChild(badgeCell);

    var meta = el('span', 'vrow__meta');
    var l1 = el('span', 'vrow__l1');
    l1.appendChild(el('b', 'vrow__id', '#' + (v.label || v.vehicle_id)));
    l1.appendChild(el('span', 'sep', ' · '));
    if (v.trip) {
      l1.appendChild(el('span', 'fig', fmt.serviceClock(v.trip.start_time)));
      l1.appendChild(el('span', null, ' ' + v.trip.headsign));
    } else {
      l1.appendChild(el('span', null, 'no trip assigned'));
    }
    meta.appendChild(l1);

    var l2 = el('span', 'vrow__l2');
    var against = v.adherence && v.adherence.against;
    if (view.suppressed && v.in_service) {
      /* No lateness value, and none of the numbers it is derived from. */
      l2.appendChild(el('span', 'dim', 'position '));
      l2.appendChild(el('span', 'fig', fmt.clock(v.position_at)));
      l2.appendChild(el('span', 'sep', ' · '));
      l2.appendChild(el('span', 'warnink', 'timing unavailable'));
    } else if (against) {
      l2.appendChild(el('span', 'dim', 'next '));
      l2.appendChild(el('span', 'vrow__stop', against.stop_name));
      meta.appendChild(l2);
      l2 = el('span', 'vrow__l3');
      l2.appendChild(el('span', 'dim', 'pred '));
      l2.appendChild(el('span', 'fig', fmt.clock(against.predicted_at)));
      l2.appendChild(el('span', 'sep', ' · '));
      l2.appendChild(el('span', 'dim', 'sch '));
      l2.appendChild(el('span', 'fig', fmt.clock(against.scheduled_at)));
    } else if (v.in_service) {
      l2.appendChild(el('span', 'warnink', view.reasonLabel || 'no prediction available'));
      if (v.progress && v.progress.current_stop_id) {
        l2.appendChild(el('span', 'sep', ' · '));
        l2.appendChild(el('span', 'dim', (STATUS_WORD[v.progress.current_status] || 'near') + ' stop '));
        l2.appendChild(el('span', 'fig', v.progress.current_stop_id));
      }
    } else {
      l2.appendChild(el('span', 'dim', 'last seen '));
      l2.appendChild(el('span', 'fig', fmt.clock(v.position_at)));
      l2.appendChild(el('span', 'sep', ' · '));
      l2.appendChild(el('span', null, 'not carrying passengers'));
    }
    meta.appendChild(l2);

    var chips = el('span', 'vrow__chips');
    if (v.pattern && v.pattern.is_special) {
      var sp = el('span', 'chip chip--special');
      sp.appendChild(el('span', 'chip__glyph', '◆'));
      sp.appendChild(el('span', null, 'special pattern'));
      chips.appendChild(sp);
    }
    var cont = continuationText(v.block, data);
    if (cont && v.block.next_trip) {
      var cc = el('span', 'chip chip--block' + (cont.hedged ? ' chip--hedged' : ''));
      cc.appendChild(el('span', null, cont.chip));
      chips.appendChild(cc);
    }
    if (chips.childNodes.length) meta.appendChild(chips);
    main.appendChild(meta);

    var caret = el('span', 'vrow__caret', '▾');
    caret.setAttribute('aria-hidden', 'true');
    main.appendChild(caret);
    wrap.appendChild(main);

    /* ---- expanded detail --------------------------------------------- */
    var detail = el('dl', 'vrow__detail');
    detail.id = detailId;
    detail.hidden = true;

    if (v.in_service && !view.suppressed && view.seconds !== null) {
      detail.appendChild(fact('Deviation', fmt.exactLateness(view.seconds)));
    } else if (view.reasonLabel) {
      detail.appendChild(fact('Why no number', view.reasonLabel));
    }
    if (against) {
      detail.appendChild(fact('Measured against',
        against.stop_name + ' (stop ' + against.stop_id + ', seq ' + against.stop_sequence + ')'));
    }
    if (v.progress) {
      detail.appendChild(fact('Progress',
        (STATUS_WORD[v.progress.current_status] || 'position ') + ' stop ' +
        (v.progress.current_stop_id || '—') +
        (v.progress.current_stop_sequence === null ? ', sequence not reported'
          : ', sequence ' + v.progress.current_stop_sequence)));
    }
    if (v.trip) {
      detail.appendChild(fact('Trip', v.trip.trip_id + ' · ' + v.trip.schedule_relationship.toLowerCase()));
    }
    if (cont) {
      detail.appendChild(fact('Block ' + v.block.block_id, cont.text));
    }
    if (v.pattern && (v.pattern.adds.length || v.pattern.skips.length)) {
      if (v.pattern.adds.length) {
        detail.appendChild(fact('Adds', v.pattern.adds.map(function (s) { return s.stop_name; }).join(', ')));
      }
      if (v.pattern.skips.length) {
        detail.appendChild(fact('Skips', v.pattern.skips.map(function (s) { return s.stop_name; }).join(', ')));
      }
    }
    detail.appendChild(fact('Position',
      fmt.clock(v.position_at) + ' · ' +
      v.position.lat.toFixed(5) + ', ' + v.position.lon.toFixed(5)));
    wrap.appendChild(detail);

    main.addEventListener('click', function () {
      var open = main.getAttribute('aria-expanded') === 'true';
      main.setAttribute('aria-expanded', open ? 'false' : 'true');
      detail.hidden = open;
      wrap.classList.toggle('is-open', !open);
    });

    return wrap;
  }

  /*
   * Empty is a feature. The headline alone ("no buses") is the failure mode we
   * are designing against, so the detail line always states what happens next
   * — or says plainly that the feed did not carry it.
   */
  function emptyNotice(data, dirFilter, counts) {
    var routeName = data.route ? (data.route.short_name || data.route.id) : 'this route';
    var head, detail;

    if (counts.inService.length && dirFilter !== 'both') {
      var other = dirFilter === 0 ? 1 : 0;
      var otherName = (data.route.directions.filter(function (d) { return d.id === other; })[0] || {}).headsign || 'the other direction';
      head = 'No buses running ' + directionName(data, dirFilter) + ' right now.';
      detail = fmt.plural(counts.inService.length, 'bus is', 'buses are') +
        ' running on route ' + routeName + ' — all of them ' + otherName + '. Switch direction to see them.';
      return S.notice('empty', head, detail);
    }

    head = 'No buses on route ' + routeName + ' right now.';
    var next = data.route && data.route.next_departure;
    if (next && next.scheduled_at) {
      detail = 'Next departure ' + fmt.clock(next.scheduled_at) +
        (next.stop_name ? ' from ' + next.stop_name : '') + '.';
    } else {
      detail = 'The feed does not carry the next scheduled departure yet, so the board ' +
        'cannot say when one is due. Buses appear here within a minute of CapMetro ' +
        'reporting them. Data as of ' + fmt.clock(data.generated_at) + '.';
    }
    return S.notice('empty', head, detail);
  }

  function directionName(data, dirFilter) {
    if (dirFilter === 'both') return 'either direction';
    var d = (data.route.directions || []).filter(function (x) { return x.id === dirFilter; })[0];
    return d ? d.headsign : 'direction ' + dirFilter;
  }

  /*
   * render(host, data, opts)
   *   opts.direction  0 | 1 | 'both'
   *   opts.status     'ok' | 'loading' | 'error'
   */
  function render(host, data, opts) {
    S.clear(host);
    var head = el('div', 'band__head');
    head.appendChild(el('h2', 'band__title', 'Vehicles'));
    var sub = el('p', 'band__sub');
    head.appendChild(sub);
    host.appendChild(head);

    if (opts.status === 'loading') {
      sub.textContent = 'Loading live positions…';
      host.appendChild(S.skeletonRows(4));
      return;
    }

    if (opts.status === 'error') {
      sub.textContent = 'Feed unreachable';
      host.appendChild(S.notice('error',
        'Can\'t reach the feed.',
        opts.lastGood
          ? 'Showing data from ' + fmt.clock(opts.lastGood) + '. It will not update until the feed returns.'
          : 'Nothing has loaded yet, so there is nothing to show. ' + (opts.errorDetail || ''),
        S.retryButton('Retry', opts.onRetry)));
      return;
    }

    var counts = vehiclesFor(data, opts.direction);
    var parts = [];
    parts.push(fmt.plural(counts.inService.length, 'bus', 'buses') + ' in service');
    if (opts.direction !== 'both') {
      parts.push(counts.shown.length + ' ' + fmt.directionTag(directionName(data, opts.direction), opts.direction));
    }
    if (counts.outOfService.length) {
      parts.push(counts.outOfService.length + ' not in service');
    }
    sub.textContent = parts.join(' · ');

    if (!counts.shown.length) {
      host.appendChild(emptyNotice(data, opts.direction, counts));
    } else {
      var list = el('div', 'vrows');
      counts.shown.forEach(function (v, i) { list.appendChild(buildRow(v, data, i)); });
      host.appendChild(list);
    }

    if (counts.outOfService.length) {
      var oosHead = el('p', 'subband__head');
      oosHead.appendChild(el('span', null, 'Not in service'));
      oosHead.appendChild(el('span', 'subband__note',
        'no trip assigned · not on the ladder'));
      host.appendChild(oosHead);
      var oos = el('div', 'vrows vrows--muted');
      counts.outOfService.forEach(function (v, i) {
        oos.appendChild(buildRow(v, data, 'd' + i));
      });
      host.appendChild(oos);
    }
  }

  global.CMB.rows = { render: render, vehiclesFor: vehiclesFor, continuationText: continuationText };
})(window);
