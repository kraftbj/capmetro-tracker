/*
 * ladder.js — task D3. The string-line, answering "is the route healthy".
 *
 * Three decisions from the design review are load-bearing here:
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
 * 3. THE X AXIS IS CLOCK TIME, NOT SIGNED DEVIATION. A deviation axis puts
 *    every bus in one column and can therefore never show bunching or a
 *    headway gap, which is the thing a dispatch board exists to show. With a
 *    real time axis the scheduled trips are grey diagonals and every live bus
 *    sits on the NOW line; the horizontal distance from a bus to its own
 *    diagonal IS its lateness, drawn rather than stated.
 *
 * Axis meaning:
 *    y = position along the route (timepoint order, interpolated by
 *        stop_sequence)
 *    x = clock time, spanning schedule.window.from to schedule.window.until.
 * The window bounds are read from the payload on every render. §3.2 of the
 * contract restates them precisely so they stay a server decision; widening
 * the window must never need a client change.
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
  var PITCH = 44;             /* timepoint row pitch — also the touch-target floor */
  var MINOR_PITCH = 30;
  var PAD_TOP = 26;
  var PAD_BOTTOM = 18;
  var LABEL_W = 138;
  var GUTTER_R = 8;           /* breathing room at the right edge of the plot */
  var TICK_MIN_PX = 56;       /* below this two clock labels touch at 9px */
  var TICK_STEPS = [300, 600, 900, 1800, 3600];
  var expanded = Object.create(null);   /* "dir:segIndex" -> true */
  var clipSeq = 0;            /* clipPath ids must be unique across both tracks */

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
   * ---- the time axis ------------------------------------------------------
   * Everything below reads the window off the payload. There is no 900 or 2700
   * in this file on purpose: §3.2 restates both bounds so a later widening is a
   * build change and nothing else.
   */

  /* The payload's window, or null when this feed carries no schedule block. */
  function scheduleWindow(data) {
    var w = data && data.schedule && data.schedule.window;
    if (!w) return null;
    if (typeof w.from !== 'number' || typeof w.until !== 'number') return null;
    if (!(w.until > w.from)) return null;
    return { from: w.from, until: w.until };
  }

  /*
   * The schedule entry for one direction. The contract guarantees one entry per
   * route.directions entry rather than omitting a direction with nothing in it,
   * so a miss here means a one-direction route asked for its other direction.
   */
  function scheduleDirection(data, dir) {
    var dirs = (data && data.schedule && data.schedule.directions) || [];
    for (var i = 0; i < dirs.length; i++) {
      if (dirs[i].direction_id === dir) return dirs[i];
    }
    return null;
  }

  /* Maps an epoch second onto the plot. Linear, and clamped nowhere: callers clip. */
  function timeScale(win, left, right) {
    var span = win.until - win.from;
    var w = right - left;
    return {
      from: win.from,
      until: win.until,
      left: left,
      right: right,
      x: function (t) { return left + ((t - win.from) / span) * w; }
    };
  }

  /*
   * Clock gridlines on a round step, chosen so two labels never touch. Epoch
   * multiples of the step land on round local minutes because every US offset
   * is a whole number of hours.
   */
  function axisTicks(from, until, plotW) {
    var span = until - from;
    var step = TICK_STEPS[TICK_STEPS.length - 1];
    for (var i = 0; i < TICK_STEPS.length; i++) {
      if ((TICK_STEPS[i] / span) * plotW >= TICK_MIN_PX) { step = TICK_STEPS[i]; break; }
    }
    var out = [];
    for (var t = Math.ceil(from / step) * step; t <= until; t += step) out.push(t);
    return out;
  }

  /*
   * One scheduled trip as points. `offsets[i]` is null when the trip does not
   * serve timepoint i — that vertex is simply omitted, so the diagonal runs
   * straight past the timepoint instead of opening a gap the schedule does not
   * claim. A row that keeps fewer than two points is not a line and is dropped
   * by the caller.
   */
  function tripPoints(trip, tpY, scale) {
    var start = trip[1];
    var offsets = trip[2] || [];
    var pts = [];
    for (var i = 0; i < offsets.length; i++) {
      var off = offsets[i];
      if (off === null || off === undefined) continue;
      if (tpY[i] === undefined || tpY[i] === null) continue;
      pts.push({ t: start + off, x: scale.x(start + off), y: tpY[i] });
    }
    return pts;
  }

  /*
   * Where a trip's diagonal crosses a given row height. This is the anchor the
   * bus stem draws back to, which is what turns lateness into a visible length.
   * Null when the bus sits outside the part of the route this trip's schedule
   * covers, because there is then no honest place to put the other end.
   */
  function xAtY(points, y) {
    if (!points || points.length === 0) return null;
    if (points.length === 1) return points[0].y === y ? points[0].x : null;
    for (var i = 0; i < points.length - 1; i++) {
      var a = points[i], b = points[i + 1];
      var lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
      if (y >= lo && y <= hi) {
        var span = b.y - a.y;
        if (span === 0) return a.x;
        return a.x + ((y - a.y) / span) * (b.x - a.x);
      }
    }
    return null;
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

    var win = scheduleWindow(data);
    if (!win) {
      host.appendChild(S.notice('empty',
        'No schedule window in this file.',
        'The ladder plots clock time along the bottom and needs the schedule block the ' +
        'contract requires. Every bus running ' + dirName + ' is still listed in Vehicles above.'));
      return { node: host, drawn: 0, buses: 0, tps: tps.length };
    }

    var lay = layout(tps, dir);
    var body = el('div', 'track__body');
    body.style.height = lay.height + 'px';

    var plotLeft = LABEL_W;
    var plotRight = Math.max(plotLeft + 120, width - GUTTER_R);
    var plotW = plotRight - plotLeft;
    var scale = timeScale(win, plotLeft, plotRight);
    var nowAt = typeof data.generated_at === 'number' ? data.generated_at : null;

    var svg = svgEl('svg', {
      class: 'track__svg', width: width, height: lay.height,
      viewBox: '0 0 ' + width + ' ' + lay.height, 'aria-hidden': 'true', focusable: 'false'
    });

    /*
     * Diagonals run the whole length of a trip, which is routinely longer than
     * the window, so the plot is clipped rather than the geometry clamped —
     * clamping a vertex would bend the line and misstate the slope, and slope
     * is speed.
     */
    var clipId = 'ladderclip-' + (++clipSeq);
    var clip = svgEl('clipPath', { id: clipId });
    clip.appendChild(svgEl('rect', {
      x: plotLeft, y: 0, width: plotW, height: lay.height
    }));
    svg.appendChild(clip);

    /*
     * Clock gridlines. When adherence is suppressed these stay, labels and all:
     * what the old deviation axis had to drop was a ±minute scale, because a
     * scale implies a reading and there was no reading to be had. A clock label
     * is a fact about the clock and implies nothing about any bus.
     */
    axisTicks(win.from, win.until, plotW).forEach(function (t) {
      var x = scale.x(t);
      svg.appendChild(svgEl('line', {
        x1: x, y1: PAD_TOP - 12, x2: x, y2: lay.height - PAD_BOTTOM + 4, class: 'axis-tick'
      }));
      var anchor = x < plotLeft + 20 ? 'start' : (x > plotRight - 20 ? 'end' : 'middle');
      var lab = svgEl('text', { x: x, y: PAD_TOP - 16, class: 'axis-lab', 'text-anchor': anchor });
      lab.textContent = fmt.clock(t);
      svg.appendChild(lab);
    });

    /* the route itself: one rule per stop, running the width of the plot */
    lay.rows.forEach(function (r) {
      if (r.kind !== 'tp' && r.kind !== 'minor') return;
      svg.appendChild(svgEl('line', {
        x1: LABEL_W - 6, y1: r.y, x2: plotRight, y2: r.y, class: 'node-rule'
      }));
    });

    /* ---- scheduled trips: the grey diagonals -------------------------- */
    var sched = scheduleDirection(data, dir);
    var tpY = [];
    lay.rows.forEach(function (r) { if (r.kind === 'tp') tpY[r.index] = r.y; });

    var diagonals = 0;
    var byTrip = Object.create(null);
    var schedG = svgEl('g', { 'clip-path': 'url(#' + clipId + ')' });
    ((sched && sched.trips) || []).forEach(function (trip) {
      var pts = tripPoints(trip, tpY, scale);
      byTrip[trip[0]] = pts;
      if (pts.length < 2) return;
      schedG.appendChild(svgEl('polyline', {
        points: pts.map(function (p) { return p.x + ',' + p.y; }).join(' '),
        class: 'sched',
        style: 'fill:none;stroke:var(--dia-' + (opts.suppressed ? 'spine-dim' : 'spine') +
          ');stroke-width:1.5;stroke-linejoin:round'
      }));
      diagonals++;
    });
    svg.appendChild(schedG);

    lay.rows.forEach(function (r) {
      if (r.kind === 'tp') {
        var served = !r.tp.service_status || r.tp.service_status.served !== false;
        svg.appendChild(svgEl('circle', {
          cx: plotLeft, cy: r.y, r: 4.5, class: 'node' + (served ? '' : ' node--closed')
        }));
      } else if (r.kind === 'minor') {
        svg.appendChild(svgEl('circle', { cx: plotLeft, cy: r.y, r: 2.4, class: 'node node--minor' }));
      }
    });

    /* ---- NOW ---------------------------------------------------------- */
    var nowX = null;
    if (nowAt !== null) {
      nowX = Math.max(plotLeft, Math.min(plotRight, scale.x(nowAt)));
      svg.appendChild(svgEl('line', {
        x1: nowX, y1: PAD_TOP - 12, x2: nowX, y2: lay.height - PAD_BOTTOM + 4,
        class: 'axis-zero' + (opts.suppressed ? ' is-suppressed' : '')
      }));
      /*
       * NOW is labelled at the foot rather than the head of the axis: the line
       * lands wherever generated_at falls, which is usually a few pixels from a
       * clock label, and two labels fighting for the same 30px is worse than
       * one extra glance downward.
       */
      var nlab = svgEl('text', {
        x: nowX, y: lay.height - 4, class: 'axis-lab axis-lab--zero',
        'text-anchor': nowX > plotRight - 24 ? 'end' : (nowX < plotLeft + 24 ? 'start' : 'middle')
      });
      nlab.textContent = 'NOW ' + fmt.clock(nowAt);
      svg.appendChild(nlab);
    }

    /* ---- buses -------------------------------------------------------- */
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
      if (nowX === null) return;
      var view = adhLib.view(v, data.staleness);
      var y = yForSequence(lay.anchors, v.progress.current_stop_sequence);
      if (y === null) return;
      var x = nowX;
      var g = svgEl('g', { class: 'bus bus--' + view.state });

      /*
       * The stem runs from the bus to its own diagonal at the same row height,
       * so its length IS the lateness. Two cases get no stem:
       *
       * - Suppressed. A drawn gap between "scheduled" and "here" is a lateness
       *   reading whether or not a number is printed beside it.
       * - A trip that has not started yet. A bus parked at its terminal waiting
       *   for a 10:30 departure sits twenty minutes left of its own diagonal,
       *   and that distance is layover, not lateness. The diagonal still starts
       *   to the right of the dot, which says "this one leaves later" without
       *   claiming the bus is early.
       */
      var started = nowAt !== null && typeof v.trip.start_epoch === 'number' &&
        nowAt >= v.trip.start_epoch;
      if (!opts.suppressed && started) {
        var own = byTrip[v.trip.trip_id];
        var sx = own ? xAtY(own, y) : null;
        if (sx !== null && sx !== undefined) {
          var clamped = Math.max(plotLeft, Math.min(plotRight, sx));
          g.appendChild(svgEl('line', { x1: clamped, y1: y, x2: x, y2: y, class: 'bus__stem' }));
        }
      }

      g.appendChild(dotShape(glyphNameFor(view, v), x, y, 7, 'dot'));
      if (view.state === 'unknown') {
        var q = svgEl('text', { x: x, y: y + 3.4, class: 'dot__q' });
        q.textContent = '?';
        g.appendChild(q);
      }
      var text = '#' + (v.label || v.vehicle_id) + ' ' + view.value;
      /* 11px figures measure about 6.4px a character; keep the run inside the plot. */
      var right = x + 11 + text.length * 6.4 <= plotRight;
      var ly = labelY(y);
      var t = svgEl('text', {
        x: right ? x + 11 : x - 11, y: ly + 3.6,
        class: 'bus__label' + (right ? '' : ' bus__label--left')
      });
      t.textContent = text;
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

    /* caption: never leave the absence of dots, or of diagonals, unexplained */
    var span = fmt.clock(win.from) + ' to ' + fmt.clock(win.until);
    var inWindow = ((sched && sched.trips) || []).length;
    var cap = el('p', 'track__cap');
    if (opts.suppressed) {
      cap.textContent = 'Lateness suppressed — buses sit on the NOW line and are hollow until the ' +
        'feed catches up. The axis still runs ' + span + '.';
      cap.className += ' is-warn';
    } else {
      /*
       * "Scheduled" and "drawable" are not the same count. A direction with one
       * timepoint has trips in the window and no diagonal to draw, and saying
       * "nothing scheduled" there would be false.
       */
      var schedLine;
      if (diagonals) {
        schedLine = 'Time runs left to right, ' + span + '. The grey diagonals are the ' +
          fmt.plural(diagonals, 'scheduled trip', 'scheduled trips') +
          '; how far a bus sits from its own diagonal is how late it is.';
      } else if (inWindow) {
        schedLine = 'Time runs left to right, ' + span + '. ' +
          fmt.plural(inWindow, 'trip is', 'trips are') + ' scheduled in that hour, but ' +
          dirName + ' publishes only ' + fmt.plural(tps.length, 'timepoint', 'timepoints') +
          ', so there is no diagonal to draw.';
      } else {
        schedLine = 'Time runs left to right, ' + span + '. Nothing is scheduled ' + dirName +
          ' in that hour.';
      }
      cap.textContent = schedLine + ' ' + (buses.length
        ? placed + ' of ' + fmt.plural(buses.length, 'bus', 'buses') + ' placed by interpolated stop sequence.'
        : 'No buses in service ' + dirName + ' right now.');
    }
    host.appendChild(cap);

    return { node: host, drawn: placed, buses: buses.length, tps: tps.length, diagonals: diagonals };
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

    sub.textContent = 'Clock time across, route down · tap + to open the stops between two timepoints';

    /*
     * Two passes on purpose. Side by side on a wide screen, each track is only
     * half the band wide, and the SVG has to be drawn to the width the track
     * actually got — not the width of the band. So: put the empty containers
     * in the document, measure them, then draw.
     *
     * BOTH stays two stacked ladders, each with its own axis. Mirroring them
     * around one shared axis was measured at 412px and rejected: on route 7 it
     * collapses 17 rows into a 15-row union at ~27px pitch, under the touch
     * target, and it makes the two directions' diagonals cross.
     */
    var wrap = el('div', 'tracks' + (dirs.length > 1 ? ' tracks--both' : ''));
    var slots = dirs.map(function (d) {
      var n = el('div', 'track');
      wrap.appendChild(n);
      return { dir: d, node: n };
    });
    host.appendChild(wrap);

    var totals = { drawn: 0, buses: 0, tps: 0, diagonals: 0 };
    slots.forEach(function (slot) {
      var w = Math.max(280, slot.node.clientWidth || width);
      var t = buildTrack(data, slot.dir, w, { suppressed: suppressed, onToggle: opts.onToggle });
      totals.drawn += t.drawn || 0;
      totals.buses += t.buses || 0;
      totals.tps += t.tps || 0;
      totals.diagonals += t.diagonals || 0;
      while (t.node.firstChild) slot.node.appendChild(t.node.firstChild);
    });

    /* The SVG is opaque to screen readers; this is its text equivalent. */
    var sr = el('p', 'sr-only');
    sr.textContent = 'String-line diagram, described in text: clock time runs left to right and the ' +
      'route runs top to bottom, over ' + totals.tps + ' timepoints, ' + totals.diagonals +
      ' scheduled trips and ' + totals.drawn + ' buses positioned by stop sequence. Each bus, its ' +
      'lateness and its next stop are listed in the Vehicles panel above, which carries the same facts.';
    host.appendChild(sr);

    var al = alertsDisclosure(data.alerts);
    if (al) host.appendChild(al);
  }

  global.CMB.ladder = {
    render: render,
    yForSequence: yForSequence,
    layout: layout,
    timepointsFor: timepointsFor,
    scheduleWindow: scheduleWindow,
    scheduleDirection: scheduleDirection,
    timeScale: timeScale,
    axisTicks: axisTicks,
    tripPoints: tripPoints,
    xAtY: xAtY,
    PITCH: PITCH,
    LABEL_W: LABEL_W,
    _expanded: expanded
  };
})(window);
