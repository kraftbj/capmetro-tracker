/*
 * ladder.js — task D3. The string-line, answering "is the route healthy".
 *
 * Two decisions from the design review are load-bearing here:
 *
 * 1. DEFAULT ROWS ARE TIMEPOINTS, NOT STOPS. Route 7 has 66 stops in one
 *    direction and 8 timepoints. All stops at 412px gives 6px labels and an
 *    11px pitch — measured, unusable. Minor stops live behind an accordion.
 *
 * 2. BUS DOTS ARE INTERPOLATED ALONG THE LINE, NEVER SNAPPED TO A TIMEPOINT
 *    ROW. When the first render snapped them, 5 of 6 live buses disappeared
 *    because they sat at non-timepoint stops. A string-line is continuous;
 *    only the labels are sparse.
 *
 * Axis meaning, since the payload carries no per-timepoint schedule times:
 *    y = position along the route (timepoint order, interpolated by
 *        stop_sequence)
 *    x = signed schedule deviation, early to the left, late to the right,
 *        clamped at ±10 min.
 * A healthy route is a column of dots hugging the spine.
 *
 * The SVG is aria-hidden. The vehicle rows carry every fact it draws.
 */
(function (global) {
  'use strict';

  var fmt = global.CMB.fmt;
  var adhLib = global.CMB.adherence;
  var S = global.CMB.states;
  var el = S.el;

  var NS = 'http://www.w3.org/2000/svg';
  var CLAMP_S = 600;          /* ±10 min is the full width of the deviation axis */
  var PITCH = 44;             /* timepoint row pitch — also the touch-target floor */
  var MINOR_PITCH = 30;
  var PAD_TOP = 26;
  var PAD_BOTTOM = 18;
  var LABEL_W = 138;
  var expanded = Object.create(null);   /* "dir:segIndex" -> true */

  function svgEl(name, attrs) {
    var n = document.createElementNS(NS, name);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function timepointsFor(data, dir) {
    return (data.timepoints || [])
      .filter(function (t) { return t.direction_id === dir; })
      .sort(function (a, b) { return a.stop_sequence - b.stop_sequence; });
  }

  /*
   * Lay the visible rows out top to bottom and record, for every visible stop,
   * the (stop_sequence, y) pair that interpolation anchors on. Expanding a
   * segment adds real anchors, so dots stay put relative to the stops around
   * them instead of sliding.
   */
  function layout(tps, dir) {
    var rows = [];
    var anchors = [];
    var y = PAD_TOP;
    tps.forEach(function (tp, i) {
      var cy = y + PITCH / 2;
      rows.push({ kind: 'tp', tp: tp, y: cy, top: y, h: PITCH, index: i });
      anchors.push({ seq: tp.stop_sequence, y: cy });
      y += PITCH;
      var minors = tp.minor_stops || [];
      var isLast = i === tps.length - 1;
      if (!isLast && minors.length) {
        var open = !!expanded[dir + ':' + i];
        rows.push({ kind: 'seg', index: i, tp: tp, next: tps[i + 1], count: minors.length, open: open, y: cy });
        if (open) {
          minors.forEach(function (ms) {
            var my = y + MINOR_PITCH / 2;
            rows.push({ kind: 'minor', stop: ms, y: my, top: y, h: MINOR_PITCH });
            anchors.push({ seq: ms.stop_sequence, y: my });
            y += MINOR_PITCH;
          });
        }
      }
    });
    anchors.sort(function (a, b) { return a.seq - b.seq; });
    return { rows: rows, anchors: anchors, height: y + PAD_BOTTOM };
  }

  /* Interpolate a vehicle's y from its current stop_sequence. */
  function yForSequence(anchors, seq) {
    if (!anchors.length || seq === null || seq === undefined) return null;
    if (seq <= anchors[0].seq) return anchors[0].y;
    var last = anchors[anchors.length - 1];
    if (seq >= last.seq) return last.y;
    for (var i = 0; i < anchors.length - 1; i++) {
      var a = anchors[i], b = anchors[i + 1];
      if (seq >= a.seq && seq <= b.seq) {
        var span = b.seq - a.seq;
        var frac = span === 0 ? 0 : (seq - a.seq) / span;
        return a.y + frac * (b.y - a.y);
      }
    }
    return last.y;
  }

  /* Draw the contract's glyph as a real shape, so grayscale still reads. */
  function dotShape(glyphName, cx, cy, r, cls) {
    switch (glyphName) {
      case 'up-triangle':
        return svgEl('polygon', {
          points: [cx, cy - r, cx + r, cy + r * 0.8, cx - r, cy + r * 0.8].join(' '), class: cls
        });
      case 'left-triangle':
        return svgEl('polygon', {
          points: [cx - r, cy, cx + r * 0.8, cy - r, cx + r * 0.8, cy + r].join(' '), class: cls
        });
      case 'square':
        return svgEl('rect', {
          x: cx - r * 0.85, y: cy - r * 0.85, width: r * 1.7, height: r * 1.7, class: cls
        });
      case 'ring':
        return svgEl('circle', { cx: cx, cy: cy, r: r * 0.85, class: cls + ' dot--hollow' });
      case 'question':
        return svgEl('circle', { cx: cx, cy: cy, r: r * 0.95, class: cls + ' dot--hollow' });
      default:
        return svgEl('circle', { cx: cx, cy: cy, r: r, class: cls });
    }
  }

  function glyphNameFor(view, vehicle) {
    if (view.state === 'unknown') return 'question';
    if (view.state === 'deadhead') return 'ring';
    return (vehicle.adherence && vehicle.adherence.glyph) || 'circle';
  }

  /* One direction's ladder: labels + accordions in HTML, geometry in SVG. */
  function buildTrack(data, dir, width, opts) {
    var tps = timepointsFor(data, dir);
    var dirName = ((data.route.directions || []).filter(function (d) { return d.id === dir; })[0] || {}).headsign
      || ('direction ' + dir);
    var host = el('div', 'track');

    var head = el('p', 'track__head');
    head.appendChild(el('span', 'track__dir', fmt.directionTag(dirName, dir)));
    head.appendChild(el('span', 'track__name', dirName));
    host.appendChild(head);

    if (!tps.length) {
      host.appendChild(S.notice('empty',
        'No timepoints published for ' + dirName + '.',
        'The ladder needs the route\'s timepoint list and this feed did not carry one for ' +
        'this direction. Every bus running ' + dirName + ' is still listed in Vehicles above.'));
      return { node: host, drawn: 0 };
    }

    var lay = layout(tps, dir);
    var body = el('div', 'track__body');
    body.style.height = lay.height + 'px';

    var trackLeft = LABEL_W;
    var trackW = Math.max(120, width - LABEL_W - 8);
    var centre = trackLeft + trackW / 2;
    var half = trackW / 2 - 26;

    var svg = svgEl('svg', {
      class: 'track__svg', width: width, height: lay.height,
      viewBox: '0 0 ' + width + ' ' + lay.height, 'aria-hidden': 'true', focusable: 'false'
    });

    /*
     * Deviation axis. When adherence is suppressed the gridlines stay (they
     * are structure) but the minute labels go: a scale implies a reading, and
     * there is no reading to be had.
     */
    [[-CLAMP_S, fmt.MINUS + '10'], [-CLAMP_S / 2, fmt.MINUS + '5'], [CLAMP_S / 2, '+5'], [CLAMP_S, '+10']]
      .forEach(function (t) {
        var x = centre + (t[0] / CLAMP_S) * half;
        svg.appendChild(svgEl('line', {
          x1: x, y1: PAD_TOP - 12, x2: x, y2: lay.height - PAD_BOTTOM + 4, class: 'axis-tick'
        }));
        if (opts.suppressed) return;
        var lab = svgEl('text', { x: x, y: PAD_TOP - 16, class: 'axis-lab' });
        lab.textContent = t[1];
        svg.appendChild(lab);
      });

    var spineTop = lay.rows[0].y;
    var spineBottom = lay.rows[lay.rows.length - 1].y;
    svg.appendChild(svgEl('line', {
      x1: centre, y1: PAD_TOP - 12, x2: centre, y2: lay.height - PAD_BOTTOM + 4,
      class: 'axis-zero' + (opts.suppressed ? ' is-suppressed' : '')
    }));
    var zlab = svgEl('text', { x: centre, y: PAD_TOP - 16, class: 'axis-lab axis-lab--zero' });
    zlab.textContent = opts.suppressed ? 'SCHEDULE' : 'ON TIME';
    svg.appendChild(zlab);

    /* the route line itself, plus a node per stop */
    svg.appendChild(svgEl('line', {
      x1: centre, y1: spineTop, x2: centre, y2: spineBottom,
      class: 'spine' + (opts.suppressed ? ' is-suppressed' : '')
    }));

    lay.rows.forEach(function (r) {
      if (r.kind === 'tp') {
        var served = !r.tp.service_status || r.tp.service_status.served !== false;
        svg.appendChild(svgEl('circle', {
          cx: centre, cy: r.y, r: 4.5, class: 'node' + (served ? '' : ' node--closed')
        }));
        svg.appendChild(svgEl('line', {
          x1: LABEL_W - 6, y1: r.y, x2: centre - 8, y2: r.y, class: 'node-rule'
        }));
      } else if (r.kind === 'minor') {
        svg.appendChild(svgEl('circle', { cx: centre, cy: r.y, r: 2.4, class: 'node node--minor' }));
      }
    });

    /* ---- buses ------------------------------------------------------- */
    var buses = (data.vehicles || []).filter(function (v) {
      return v.in_service && v.trip && v.trip.direction_id === dir &&
        v.progress && v.progress.current_stop_sequence !== null &&
        v.progress.current_stop_sequence !== undefined;
    });
    var placed = 0;
    /* Keep labels from stacking on top of each other: dots stay where the data
     * puts them, only the text is nudged, and never by more than a row. */
    var labelRows = [];
    function labelY(y) {
      var candidate = y;
      for (var guard = 0; guard < 12; guard++) {
        var clash = labelRows.some(function (u) { return Math.abs(u - candidate) < 13; });
        if (!clash) break;
        candidate += 13;
      }
      labelRows.push(candidate);
      return candidate;
    }

    buses.sort(function (a, b) {
      return a.progress.current_stop_sequence - b.progress.current_stop_sequence;
    }).forEach(function (v) {
      var view = adhLib.view(v, data.staleness);
      var y = yForSequence(lay.anchors, v.progress.current_stop_sequence);
      if (y === null) return;
      var dev = view.seconds === null ? 0 : Math.max(-CLAMP_S, Math.min(CLAMP_S, view.seconds));
      var x = centre + (dev / CLAMP_S) * half;
      var g = svgEl('g', { class: 'bus bus--' + view.state });
      /* a stem back to the spine makes the deviation itself readable */
      g.appendChild(svgEl('line', { x1: centre, y1: y, x2: x, y2: y, class: 'bus__stem' }));
      g.appendChild(dotShape(glyphNameFor(view, v), x, y, 7, 'dot'));
      if (view.state === 'unknown') {
        var q = svgEl('text', { x: x, y: y + 3.4, class: 'dot__q' });
        q.textContent = '?';
        g.appendChild(q);
      }
      var right = x < centre + half * 0.45;
      var ly = labelY(y);
      var t = svgEl('text', {
        x: right ? x + 11 : x - 11, y: ly + 3.6,
        class: 'bus__label' + (right ? '' : ' bus__label--left')
      });
      t.textContent = '#' + (v.label || v.vehicle_id) + ' ' + view.value;
      if (Math.abs(ly - y) > 1) {
        g.appendChild(svgEl('line', {
          x1: right ? x + 7 : x - 7, y1: y, x2: right ? x + 10 : x - 10, y2: ly,
          class: 'bus__tie'
        }));
      }
      g.appendChild(t);
      svg.appendChild(g);
      placed++;
    });

    body.appendChild(svg);

    /* ---- labels + accordions (real HTML, real buttons) ---------------- */
    var labels = el('div', 'track__labels');
    lay.rows.forEach(function (r) {
      if (r.kind === 'tp') {
        var lbl = el('div', 'tplabel');
        lbl.style.top = (r.y - PITCH / 2) + 'px';
        lbl.style.height = PITCH + 'px';
        var name = el('span', 'tplabel__name', r.tp.stop_name);
        name.title = r.tp.stop_name_full || r.tp.stop_name;
        var closed = r.tp.service_status && r.tp.service_status.served === false;
        if (closed) {
          name.classList.add('is-closed');
          lbl.appendChild(name);
          var why = el('span', 'tplabel__why', '✕ ' +
            (r.tp.service_status.detail || r.tp.service_status.source || 'not served'));
          lbl.appendChild(why);
        } else {
          lbl.appendChild(name);
        }
        labels.appendChild(lbl);
      } else if (r.kind === 'minor') {
        var m = el('div', 'tplabel tplabel--minor');
        m.style.top = (r.y - MINOR_PITCH / 2) + 'px';
        m.style.height = MINOR_PITCH + 'px';
        var mn = el('span', 'tplabel__name', r.stop.stop_name);
        if (r.stop.service_status && r.stop.service_status.served === false) mn.classList.add('is-closed');
        m.appendChild(mn);
        labels.appendChild(m);
      } else if (r.kind === 'seg') {
        var btn = el('button', 'segbtn');
        btn.type = 'button';
        btn.style.top = r.y + 'px';
        btn.style.left = (LABEL_W - 4) + 'px';
        btn.setAttribute('aria-expanded', r.open ? 'true' : 'false');
        btn.setAttribute('aria-label',
          (r.open ? 'Hide the ' : 'Show the ') + r.count + ' stops between ' +
          r.tp.stop_name + ' and ' + r.next.stop_name);
        btn.appendChild(el('span', 'segbtn__sign', r.open ? '−' : '+'));
        btn.appendChild(el('span', 'segbtn__n', String(r.count)));
        (function (index) {
          btn.addEventListener('click', function () {
            var key = dir + ':' + index;
            expanded[key] = !expanded[key];
            opts.onToggle(key);
          });
        })(r.index);
        labels.appendChild(btn);
      }
    });
    body.appendChild(labels);
    host.appendChild(body);

    /* caption: never leave the absence of dots unexplained */
    var cap = el('p', 'track__cap');
    if (opts.suppressed) {
      cap.textContent = 'Lateness suppressed — dots sit on the spine and are hollow until the feed catches up.';
      cap.className += ' is-warn';
    } else if (!buses.length) {
      cap.textContent = 'No buses in service ' + dirName + ' right now. The line is the schedule, drawn from ' +
        tps.length + ' timepoints.';
    } else {
      cap.textContent = 'Left of the line is early, right is late, ±10 min full scale. ' +
        placed + ' of ' + buses.length + ' buses placed by interpolated stop sequence.';
    }
    host.appendChild(cap);

    return { node: host, drawn: placed, buses: buses.length, tps: tps.length };
  }

  function alertsDisclosure(alerts) {
    if (!alerts || !alerts.length) return null;
    var wrap = el('div', 'alerts');
    var btn = el('button', 'alerts__toggle');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    var body = el('ul', 'alerts__list');
    body.hidden = true;
    body.id = 'alerts-list';
    btn.setAttribute('aria-controls', 'alerts-list');
    btn.appendChild(el('span', 'alerts__glyph', '!'));
    btn.appendChild(el('span', null, fmt.plural(alerts.length, 'service alert', 'service alerts') + ' on this route'));
    btn.appendChild(el('span', 'alerts__caret', '▾'));
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      body.hidden = open;
    });
    alerts.forEach(function (a) {
      var li = el('li', 'alert alert--' + (a.severity || 'low'));
      li.appendChild(el('span', 'alert__effect', (a.effect || '').replace(/_/g, ' ').toLowerCase()));
      li.appendChild(el('span', 'alert__head', a.header));
      li.appendChild(el('span', 'alert__desc', a.description));
      body.appendChild(li);
    });
    wrap.appendChild(btn);
    wrap.appendChild(body);
    return wrap;
  }

  /*
   * render(host, data, opts)
   *   opts.direction 0 | 1 | 'both'
   *   opts.status    'ok' | 'loading' | 'error'
   *   opts.onToggle  called when an accordion changes; the app re-renders
   */
  function render(host, data, opts) {
    S.clear(host);
    var head = el('div', 'band__head');
    head.appendChild(el('h2', 'band__title', 'Ladder'));
    var sub = el('p', 'band__sub');
    head.appendChild(sub);
    host.appendChild(head);

    if (opts.status === 'loading') {
      sub.textContent = 'Drawing timepoints…';
      host.appendChild(S.skeletonBlock(180));
      return;
    }
    if (opts.status === 'error') {
      sub.textContent = 'Not drawn';
      host.appendChild(S.notice('error', 'Ladder hidden while the feed is unreachable.',
        'Vehicle rows above still show the last data received.'));
      return;
    }

    var suppressed = !!(data.staleness && data.staleness.suppress_adherence);
    var width = Math.max(300, host.clientWidth || 384);
    var dirs = opts.direction === 'both' ? [0, 1] : [opts.direction];

    sub.textContent = 'Timepoints only · tap + to open the stops between two timepoints';

    /*
     * Two passes on purpose. Side by side on a wide screen, each track is only
     * half the band wide, and the SVG has to be drawn to the width the track
     * actually got — not the width of the band. So: put the empty containers
     * in the document, measure them, then draw.
     */
    var wrap = el('div', 'tracks' + (dirs.length > 1 ? ' tracks--both' : ''));
    var slots = dirs.map(function (d) {
      var n = el('div', 'track');
      wrap.appendChild(n);
      return { dir: d, node: n };
    });
    host.appendChild(wrap);

    var totals = { drawn: 0, buses: 0, tps: 0 };
    slots.forEach(function (slot) {
      var w = Math.max(280, slot.node.clientWidth || width);
      var t = buildTrack(data, slot.dir, w, { suppressed: suppressed, onToggle: opts.onToggle });
      totals.drawn += t.drawn || 0;
      totals.buses += t.buses || 0;
      totals.tps += t.tps || 0;
      while (t.node.firstChild) slot.node.appendChild(t.node.firstChild);
    });

    /* The SVG is opaque to screen readers; this is its text equivalent. */
    var sr = el('p', 'sr-only');
    sr.textContent = 'Ladder diagram, described in text: ' + totals.tps + ' timepoints and ' +
      totals.drawn + ' buses positioned by stop sequence. Each bus, its lateness and its next ' +
      'stop are listed in the Vehicles panel above, which carries the same facts.';
    host.appendChild(sr);

    var al = alertsDisclosure(data.alerts);
    if (al) host.appendChild(al);
  }

  global.CMB.ladder = {
    render: render,
    yForSequence: yForSequence,
    layout: layout,
    timepointsFor: timepointsFor,
    PITCH: PITCH,
    _expanded: expanded
  };
})(window);
