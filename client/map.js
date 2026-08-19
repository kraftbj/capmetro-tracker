/*
 * map.js — the "where is she right now" panel.
 *
 * No basemap ships here and none is coming: a tile source is a network
 * dependency and this board has to open from a file:// URL with no server. The
 * answer was not to fake cartography but to notice that the payload already
 * carries the only cartography this panel needs. Stops on these routes sit
 * roughly 200m apart, so the ordered chain of every stop — timepoints AND the
 * minor stops between them — traces the streets the bus actually drives
 * closely enough to recognize the shape of the route. The route draws itself.
 *
 * That turns this from a schematic OF a route into a real map of one, and the
 * rules that follow from the promotion are the ones worth guarding:
 *
 * 1. THE PROJECTION MUST BE ASPECT-CORRECT. At Austin's latitude a degree of
 *    longitude is cos(30.3 deg) = 0.863 of a degree of latitude. Scaling both
 *    axes by the same number stretches every route 16% east-west, which is the
 *    difference between "that dogleg is 7th Street" and "that is a diagram".
 *    One scale for both axes, longitude multiplied by cos(mid latitude).
 *
 * 2. NORTH IS UP AND THE SCALE IS DRAWN. A position with no bearing and no
 *    distance is not an answer to "where is she"; it is a picture of one. The
 *    rose and the bar are furniture, not decoration.
 *
 * 3. THE CHIPS ARE THE CONTENT, THE MAP IS CONTEXT. Chips are placed first and
 *    stop labels are culled around them, never the other way round. A reader
 *    opens this panel looking for a bus, not for a street name.
 *
 * Chips carry the same shape + signed number + colour as the rows, so the
 * grayscale rule holds here too.
 */
(function (global) {
  'use strict';

  var fmt = global.CMB.fmt;
  var adhLib = global.CMB.adherence;
  var S = global.CMB.states;
  var el = S.el;

  var NS = 'http://www.w3.org/2000/svg';

  var PAD = 22;               /* frame inset — also the room the rose and the bar sit in */
  var H_MIN = 160;
  var H_MAX = 320;            /* a phone panel taller than this pushes the caption off screen */
  var CHIP_H = 16;
  var LABEL_H = 11;
  var M_PER_DEG_LAT = 111320; /* WGS84, near enough over one city */

  /*
   * Zero-span is not hypothetical: a one-stop shuttle, or every vehicle parked
   * at the same yard, gives identical coordinates and a scale of span/pixels
   * divides by zero. A tenth of a microdegree is about 1cm — below it, the
   * points really are the same place and the honest drawing is one dot.
   */
  var MIN_SPAN = 1e-7;

  /* Bar lengths a rider already thinks in. Austin measures itself in miles. */
  var SCALE_STEPS = [
    { m: 61, label: '200 ft' },
    { m: 152, label: '500 ft' },
    { m: 402, label: '0.25 mi' },
    { m: 805, label: '0.5 mi' },
    { m: 1609, label: '1 mi' },
    { m: 3219, label: '2 mi' },
    { m: 8047, label: '5 mi' },
    { m: 16093, label: '10 mi' }
  ];

  function svgEl(name, attrs) {
    var n = document.createElementNS(NS, name);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  /*
   * A fix is only usable if both halves are real numbers. 0/0 is the Gulf of
   * Guinea, not Austin: the feed uses it for "no position recorded", and
   * plotting it would drag the whole frame 3,000km south and shrink the route
   * to a speck. A stop with no fix is dropped, never placed at the origin.
   */
  function hasFix(p) {
    return !!p && typeof p.lat === 'number' && typeof p.lon === 'number' &&
      isFinite(p.lat) && isFinite(p.lon) && !(p.lat === 0 && p.lon === 0);
  }

  /*
   * Every stop of one direction in the order the bus drives them. The minor
   * stops are what make this a map rather than a set of chords: route 4 has 6
   * timepoints and 48 stops, and it is the 42 in between that bend the line
   * around the streets. stop_sequence is the authority on order — minor stops
   * are nested under the timepoint they follow, so a flat sort by sequence is
   * the only thing that survives a route whose nesting is uneven.
   */
  function stopChain(data, dir) {
    var out = [];
    (data.timepoints || []).forEach(function (t) {
      if (t.direction_id !== dir) return;
      if (hasFix(t)) {
        out.push({ lat: t.lat, lon: t.lon, seq: t.stop_sequence, name: t.stop_name, major: true });
      }
      (t.minor_stops || []).forEach(function (m) {
        if (hasFix(m)) {
          out.push({ lat: m.lat, lon: m.lon, seq: m.stop_sequence, name: m.stop_name, major: false });
        }
      });
    });
    out.sort(function (a, b) { return a.seq - b.seq; });
    return out;
  }

  /* The route's extent, with longitude already in latitude-degree units. */
  function bounds(points) {
    var b = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
    points.forEach(function (p) {
      if (p.lat < b.minLat) b.minLat = p.lat;
      if (p.lat > b.maxLat) b.maxLat = p.lat;
      if (p.lon < b.minLon) b.minLon = p.lon;
      if (p.lon > b.maxLon) b.maxLon = p.lon;
    });
    b.k = Math.cos(((b.minLat + b.maxLat) / 2) * Math.PI / 180);
    b.spanX = (b.maxLon - b.minLon) * b.k;
    b.spanY = b.maxLat - b.minLat;
    return b;
  }

  /*
   * Equirectangular, one scale for both axes, longitude corrected by
   * cos(latitude). Over a single bus route the error against a proper
   * projection is under a meter; over the whole city it would still be under a
   * block. What it buys is that a pixel means the same distance whichever way
   * you measure it, which is what makes the scale bar legal.
   */
  function projector(b, w, h) {
    /* Infinity, not a clamped span: an axis with no extent must not win the min. */
    var sx = b.spanX > MIN_SPAN ? (w - PAD * 2) / b.spanX : Infinity;
    var sy = b.spanY > MIN_SPAN ? (h - PAD * 2) / b.spanY : Infinity;
    var scale = Math.min(sx, sy);
    if (!isFinite(scale)) scale = 0;      /* every point is one point; center it */
    var offX = (w - b.spanX * scale) / 2;
    var offY = (h - b.spanY * scale) / 2;
    var project = function (lat, lon) {
      return {
        x: offX + (lon - b.minLon) * b.k * scale,
        y: h - (offY + (lat - b.minLat) * scale)   /* north up: latitude grows upward */
      };
    };
    project.pxPerMeter = scale / M_PER_DEG_LAT;    /* one number, because one scale */
    return project;
  }

  /* Panel height from the route's own shape, so a north-south route is not squashed. */
  function heightFor(b, w) {
    if (b.spanY <= MIN_SPAN) return H_MIN;
    if (b.spanX <= MIN_SPAN) return H_MAX;
    return Math.max(H_MIN, Math.min(H_MAX, (w - PAD * 2) * (b.spanY / b.spanX) + PAD * 2));
  }

  /*
   * The two directions run the same streets, so drawn on the same centerline
   * one hides the other entirely and the map claims the route is one-way. They
   * are shifted a lane apart instead — which is what they physically are — and
   * only when both are on screen, so a single-direction view still shows the
   * true centerline. A dashed stroke on the inbound path carries the same
   * distinction without color, for the grayscale rule and for the case where
   * the two paths use different streets and never sit side by side.
   */
  function offsetPath(pts, dist) {
    if (!dist || pts.length < 2) return pts;
    return pts.map(function (p, i) {
      var a = pts[Math.max(0, i - 1)];
      var b = pts[Math.min(pts.length - 1, i + 1)];
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (!len) return p;                          /* two stops at one coordinate */
      return { x: p.x + (-dy / len) * dist, y: p.y + (dx / len) * dist };
    });
  }

  function overlaps(a, b, slack) {
    var s = slack || 0;
    return !(a.x + a.w < b.x - s || a.x > b.x + b.w + s ||
             a.y + a.h < b.y - s || a.y > b.y + b.h + s);
  }

  /* Same tag the rows and the ladder use, so one bus reads the same in all three. */
  function dirTagFor(data, id) {
    return fmt.directionTagFor(data, id);
  }

  /* North arrow. It never rotates — north is up by construction — but a reader
   * cannot know that from the drawing alone, so the panel states it. */
  function compassRose(w) {
    var g = svgEl('g', { class: 'map__rose' });
    var x = w - 13;
    g.appendChild(svgEl('line', { x1: x, y1: 27, x2: x, y2: 14, class: 'map__rose-needle' }));
    g.appendChild(svgEl('polygon', {
      points: [x, 9, x + 4, 17, x - 4, 17].join(' '), class: 'map__rose-head'
    }));
    var t = svgEl('text', { x: x, y: 38, class: 'map__rose-text' });
    t.textContent = 'N';
    g.appendChild(t);
    return { node: g, rect: { x: x - 8, y: 6, w: 16, h: 34 } };
  }

  /*
   * A bar, not a "1:24000" ratio: the reader is judging whether a bus is four
   * blocks away or four miles, and a bar answers that by eye. Longest step
   * that still leaves two thirds of the panel for the route.
   */
  function scaleBar(pxPerMeter, w, h) {
    if (!(pxPerMeter > 0)) return null;
    var limit = w * 0.32;
    var pick = null;
    SCALE_STEPS.forEach(function (s) {
      if (s.m * pxPerMeter <= limit) pick = s;
    });
    if (!pick) pick = SCALE_STEPS[0];
    var len = pick.m * pxPerMeter;
    if (len < 12) return null;                     /* a bar too short to read is a lie */
    var g = svgEl('g', { class: 'map__scale' });
    var x0 = PAD - 8, y = h - 12;
    g.appendChild(svgEl('line', { x1: x0, y1: y, x2: x0 + len, y2: y, class: 'map__scale-bar' }));
    g.appendChild(svgEl('line', { x1: x0, y1: y - 3, x2: x0, y2: y + 3, class: 'map__scale-bar' }));
    g.appendChild(svgEl('line', {
      x1: x0 + len, y1: y - 3, x2: x0 + len, y2: y + 3, class: 'map__scale-bar'
    }));
    var t = svgEl('text', { x: x0, y: y - 6, class: 'map__scale-text' });
    t.textContent = pick.label;
    g.appendChild(t);
    return { node: g, rect: { x: x0 - 2, y: y - 18, w: len + 4, h: 24 } };
  }

  function render(host, data, opts) {
    S.clear(host);
    var head = el('div', 'band__head');
    head.appendChild(el('h2', 'band__title', 'Map'));
    head.appendChild(el('p', 'band__sub', 'Route geography · north up'));
    host.appendChild(head);

    if (opts.status === 'loading') {
      host.appendChild(S.skeletonBlock(H_MIN));
      return;
    }
    if (opts.status === 'error') {
      host.appendChild(S.notice('error', 'Map omitted while the feed is unreachable.',
        'Positions would be guesses, and a guessed position on a map reads as a fact.'));
      return;
    }

    var dir = opts.direction;
    var showDirection = dir === 'both';
    var dirs = [0, 1].filter(function (d) { return dir === 'both' || dir === d; });
    var chains = dirs.map(function (d) { return { dir: d, stops: stopChain(data, d) }; });

    var buses = (data.vehicles || []).filter(function (v) {
      if (!hasFix(v.position)) return false;
      if (!v.in_service || !v.trip) return true;            /* deadheads always shown */
      return dir === 'both' || v.trip.direction_id === dir;
    });

    /*
     * The frame is bounded by the buses as well as the route. A bus that has
     * wandered off the line is exactly the one the reader is hunting for, and
     * clamping it to the edge would put it somewhere it is not.
     */
    var pts = [];
    chains.forEach(function (c) { pts = pts.concat(c.stops); });
    buses.forEach(function (v) { pts.push({ lat: v.position.lat, lon: v.position.lon }); });

    if (!pts.length) {
      host.appendChild(S.notice('empty', 'Nothing to plot yet.',
        'No stop has a published position for this direction and no vehicle is reporting one, ' +
        'so the map would be an empty frame. Data as of ' + fmt.clock(data.generated_at) + '.'));
      return;
    }

    var w = Math.max(300, host.clientWidth || 384);
    var box = bounds(pts);
    var h = heightFor(box, w);
    var project = projector(box, w, h);
    var suppressed = !!(data.staleness && data.staleness.suppress_adherence);

    var svg = svgEl('svg', {
      class: 'map__svg' + (suppressed ? ' is-suppressed' : ''),
      width: w, height: h, viewBox: '0 0 ' + w + ' ' + h,
      'aria-hidden': 'true', focusable: 'false'
    });
    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, class: 'map__bg' }));

    /*
     * Everything on this panel competes for the same few hundred pixels, so the
     * order things claim space in IS the priority order: furniture, then the two
     * ends of the route, then the chips, then the remaining stop names. `placed`
     * is that claim list.
     */
    var rose = compassRose(w);
    var bar = scaleBar(project.pxPerMeter, w, h);
    var placed = [rose.rect];
    if (bar) placed.push(bar.rect);

    var labels = [];
    var named = Object.create(null);     /* one label per stop name; see placeLabel */
    /*
     * A label goes to whichever side of its dot is free, and if neither side is,
     * it is dropped outright rather than shrunk or nudged into the gap — a nudged
     * label points at the wrong dot, which is worse than no label at all.
     */
    function placeLabel(s) {
      /*
       * Once per name. The turnaround stop belongs to both directions and is one
       * place on the ground, so labeling it twice — which it happily is, one to
       * each side of the same dot, since two rectangles that do not touch do not
       * collide — says there are two of them.
       */
      if (!s || !s.name || named[s.name]) return;
      var p = project(s.lat, s.lon);
      var wpx = s.name.length * 5.1 + 2;
      var sides = [
        { x: p.x + 6, box: p.x + 6, left: false },
        { x: p.x - 6, box: p.x - 6 - wpx, left: true }
      ];
      for (var i = 0; i < sides.length; i++) {
        var box = { x: sides[i].box, y: p.y - LABEL_H / 2, w: wpx, h: LABEL_H };
        if (box.x < 2 || box.x + wpx > w - 2) continue;
        if (placed.some(function (r) { return overlaps(box, r, 1); })) continue;
        placed.push(box);
        named[s.name] = true;
        var t = svgEl('text', {
          x: sides[i].x, y: p.y + 3.2,
          class: 'map__label' + (sides[i].left ? ' map__label--left' : '')
        });
        t.textContent = s.name;
        labels.push(t);
        return;
      }
    }

    /*
     * The two ends of each direction are named before the chips claim anything.
     * A map whose ends are unnamed cannot be located at all — it is a squiggle —
     * and the cost is that at most four chips get nudged 19px down their own
     * column. A chip yields position here, never existence.
     */
    chains.forEach(function (c) {
      var majors = c.stops.filter(function (s) { return s.major; });
      placeLabel(majors[0]);
      if (majors.length > 1) placeLabel(majors[majors.length - 1]);
    });

    /*
     * Buses bunch up geographically — that is the whole point of a bunching
     * board — so chips must be pushed off each other or they read as one
     * illegible smear. The pin stays on the real position; only the chip moves,
     * and the leader keeps the two tied together.
     *
     * The search runs the full height of the panel before it gives up, then
     * shoulders sideways. A fixed ±76px ladder was not enough: route 7 is a
     * north-south line, which the projection draws as a narrow column, and its
     * 13 buses all wanted the same 90px of it. Chips ran out of slots and landed
     * on top of each other, which is the one failure this panel cannot have.
     */
    var ladder = [0];
    for (var li = 1; li * 19 <= h; li++) { ladder.push(-li * 19); ladder.push(li * 19); }
    var COLUMNS = [0, 0.62, -0.62];        /* straight up from the pin, then aside */

    function freeSlot(x, y, wpx) {
      /* Nearest slot first in both axes: a leader that crosses the panel is
       * traceable but the chip has stopped saying where the bus is. */
      for (var i = 0; i < ladder.length; i++) {
        var ty = Math.max(2, Math.min(h - CHIP_H - 2, y + ladder[i]));
        for (var c = 0; c < COLUMNS.length; c++) {
          var cx = Math.max(2, Math.min(w - wpx - 2, x + COLUMNS[c] * wpx));
          var box = { x: cx, y: ty, w: wpx, h: CHIP_H };
          if (!placed.some(function (r) { return overlaps(box, r, 2); })) {
            placed.push(box);
            return box;
          }
        }
      }
      var last = { x: x, y: y, w: wpx, h: CHIP_H };
      placed.push(last);
      return last;
    }

    var chips = buses.map(function (v) {
      var view = adhLib.view(v, data.staleness);
      var p = project(v.position.lat, v.position.lon);
      /*
       * The direction tag earns its width in BOTH mode: without it a chip says which bus
       * and how late, but not which way it is heading, which is the one thing the map is
       * positioned to answer. Omitted in a single-direction view, where every chip on
       * screen already shares the same heading and the tag would be pure repetition.
       */
      var dtag = (v.trip && showDirection) ? ' ' + dirTagFor(data, v.trip.direction_id) : '';
      var text = view.glyph + ' ' + (v.label || v.vehicle_id) + ' ' + view.value + dtag;
      var wpx = 8 + text.length * 6.1;
      var slot = freeSlot(Math.max(2, Math.min(w - wpx - 2, p.x - wpx / 2)),
        Math.max(2, Math.min(h - 20, p.y - 20)), wpx);
      return { view: view, p: p, text: text, x: slot.x, y: slot.y, w: wpx };
    });

    /* route paths first, so they are there even when no bus is */
    var drawable = chains.filter(function (c) { return c.stops.length > 1; });
    var lane = drawable.length > 1 ? 1.6 : 0;   /* nothing to separate from, no shift */
    drawable.forEach(function (c, i) {
      var line = offsetPath(c.stops.map(function (s) { return project(s.lat, s.lon); }),
        i === 0 ? -lane : lane);
      svg.appendChild(svgEl('polyline', {
        points: line.map(function (q) { return q.x + ',' + q.y; }).join(' '),
        class: 'map__route map__route--' + (c.dir === 0 ? 'out' : 'back')
      }));
    });

    /*
     * Minor stops are drawn small and first. They are not there to be read one
     * by one — they are there because a line through 48 points is a street and
     * a line through 6 is a triangle.
     */
    chains.forEach(function (c) {
      c.stops.forEach(function (s) {
        if (s.major) return;
        var p = project(s.lat, s.lon);
        svg.appendChild(svgEl('circle', {
          cx: p.x, cy: p.y, r: 1.6, class: 'map__stop map__stop--minor'
        }));
      });
    });
    chains.forEach(function (c) {
      c.stops.forEach(function (s) {
        if (!s.major) return;
        var p = project(s.lat, s.lon);
        svg.appendChild(svgEl('circle', {
          cx: p.x, cy: p.y, r: 3, class: 'map__stop map__stop--major'
        }));
      });
    });

    /*
     * Timepoints only, and not even all of those. Route 7 carries 66 stops in one
     * direction; labeling them at 412px was measured at 6px type. The ends are
     * already down; these are whatever still fits around the chips, and on the
     * busiest routes that is nothing, which is the right answer.
     */
    chains.forEach(function (c) {
      c.stops.forEach(function (s) { if (s.major) placeLabel(s); });
    });
    labels.forEach(function (t) { svg.appendChild(t); });

    svg.appendChild(rose.node);
    if (bar) svg.appendChild(bar.node);

    /* Chips last: on a panel this dense, z-order is the difference between
     * "the buses are on the map" and "the map is on the buses". */
    chips.forEach(function (c) {
      var g = svgEl('g', { class: 'map__chip map__chip--' + c.view.state });
      g.appendChild(svgEl('line', {
        x1: c.p.x, y1: c.p.y, x2: c.x + c.w / 2, y2: c.y + CHIP_H, class: 'map__leader'
      }));
      g.appendChild(svgEl('circle', { cx: c.p.x, cy: c.p.y, r: 3.2, class: 'map__pin' }));
      g.appendChild(svgEl('rect', {
        x: c.x, y: c.y, width: c.w, height: CHIP_H, rx: 4, class: 'map__chipbg'
      }));
      var t = svgEl('text', { x: c.x + c.w / 2, y: c.y + 11.6, class: 'map__chiptext' });
      t.textContent = c.text;
      g.appendChild(t);
      svg.appendChild(g);
    });

    host.appendChild(svg);

    /*
     * The caption's whole job is to stop the panel overclaiming. It is a true
     * map of one route's geography and nothing else on the screen is real
     * ground, so it says both halves.
     */
    var geo = 'Every stop at its true position, north up, to the scale shown. There is no ' +
      'basemap under it — no streets, no river, no city — so this is a map of the route, ' +
      'not a map of Austin.';
    var cap = el('p', 'track__cap');
    if (suppressed) {
      cap.className += ' is-warn';
      cap.textContent = 'Positions only: lateness is suppressed, so chips carry no number. ' + geo;
    } else if (!buses.length) {
      cap.textContent = 'No vehicle is reporting a position, so the route is drawn empty. ' + geo;
    } else {
      cap.textContent = geo;
    }
    host.appendChild(cap);

    var sr = el('p', 'sr-only');
    sr.textContent = 'Map of the route\'s own stops, north up, showing ' + buses.length +
      ' vehicles. The same positions, lateness and next stops are listed in the Vehicles ' +
      'panel above.';
    host.appendChild(sr);
  }

  global.CMB.map = { render: render };
})(window);
