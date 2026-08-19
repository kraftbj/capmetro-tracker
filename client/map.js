/*
 * map.js — the "where exactly" panel, and the least differentiated one, which
 * is why it sits last. No basemap ships yet (a tile source is a network
 * dependency and the board must open from disk), so this is a schematic:
 * real coordinates, real relative geometry, no cartography. It is labelled as
 * such rather than pretending to be a map.
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
  var H = 210;

  function svgEl(name, attrs) {
    var n = document.createElementNS(NS, name);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  /* Equirectangular with a cos(lat) correction — fine over one bus route. */
  function projector(points, w, h, pad) {
    var lats = points.map(function (p) { return p.lat; });
    var lons = points.map(function (p) { return p.lon; });
    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    var minLon = Math.min.apply(null, lons), maxLon = Math.max.apply(null, lons);
    var midLat = (minLat + maxLat) / 2;
    var k = Math.cos(midLat * Math.PI / 180);
    var spanX = Math.max((maxLon - minLon) * k, 1e-6);
    var spanY = Math.max(maxLat - minLat, 1e-6);
    var scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    var offX = (w - spanX * scale) / 2;
    var offY = (h - spanY * scale) / 2;
    return function (lat, lon) {
      return {
        x: offX + (lon - minLon) * k * scale,
        y: h - (offY + (lat - minLat) * scale)
      };
    };
  }

  /* Same tag the rows and the ladder use, so one bus reads the same in all three. */
  function dirTagFor(data, id) {
    return fmt.directionTagFor(data, id);
  }

  function render(host, data, opts) {
    S.clear(host);
    var head = el('div', 'band__head');
    head.appendChild(el('h2', 'band__title', 'Map'));
    var sub = el('p', 'band__sub', 'Schematic · no basemap yet');
    head.appendChild(sub);
    host.appendChild(head);

    if (opts.status === 'loading') {
      host.appendChild(S.skeletonBlock(H));
      return;
    }
    if (opts.status === 'error') {
      host.appendChild(S.notice('error', 'Map omitted while the feed is unreachable.',
        'Positions would be guesses, and a guessed position on a map reads as a fact.'));
      return;
    }

    var dir = opts.direction;
    var showDirection = dir === 'both';
    var stops = (data.timepoints || []).filter(function (t) {
      return dir === 'both' || t.direction_id === dir;
    });
    var buses = (data.vehicles || []).filter(function (v) {
      if (!v.position) return false;
      if (!v.in_service || !v.trip) return true;            /* deadheads always shown */
      return dir === 'both' || v.trip.direction_id === dir;
    });

    var pts = stops.map(function (s) { return { lat: s.lat, lon: s.lon }; })
      .concat(buses.map(function (v) { return { lat: v.position.lat, lon: v.position.lon }; }));

    if (!pts.length) {
      host.appendChild(S.notice('empty', 'Nothing to plot yet.',
        'No timepoints and no vehicles for this direction, so the map would be an empty grid. ' +
        'Data as of ' + fmt.clock(data.generated_at) + '.'));
      return;
    }

    var w = Math.max(300, host.clientWidth || 384);
    var project = projector(pts, w, H, 26);
    var suppressed = !!(data.staleness && data.staleness.suppress_adherence);

    var svg = svgEl('svg', {
      class: 'map__svg' + (suppressed ? ' is-suppressed' : ''),
      width: w, height: H, viewBox: '0 0 ' + w + ' ' + H,
      'aria-hidden': 'true', focusable: 'false'
    });
    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: H, class: 'map__bg' }));

    /* route line, drawn first so it is there even when no bus is */
    [0, 1].forEach(function (d) {
      var line = (data.timepoints || []).filter(function (t) {
        return t.direction_id === d && (dir === 'both' || dir === d);
      }).sort(function (a, b) { return a.stop_sequence - b.stop_sequence; });
      if (line.length < 2) return;
      var pathPts = [];
      line.forEach(function (t) {
        var p = project(t.lat, t.lon);
        pathPts.push(p.x + ',' + p.y);
        (t.minor_stops || []).forEach(function (m) {
          var q = project(m.lat, m.lon);
          pathPts.push(q.x + ',' + q.y);
        });
      });
      svg.appendChild(svgEl('polyline', { points: pathPts.join(' '), class: 'map__route' }));
    });

    stops.forEach(function (t) {
      var p = project(t.lat, t.lon);
      svg.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 3, class: 'map__stop' }));
    });

    /*
     * Buses bunch up geographically — that is the whole point of a bunching
     * board — so chips must be pushed off each other or they read as one
     * illegible smear. The pin stays on the real position; only the chip moves.
     */
    var placed = [];
    function freeSlot(x, y, wpx) {
      var hpx = 16;
      var offsets = [0, -19, 19, -38, 38, -57, 57, -76, 76];
      for (var i = 0; i < offsets.length; i++) {
        var ty = Math.max(2, Math.min(H - hpx - 2, y + offsets[i]));
        var clash = placed.some(function (r) {
          return !(x + wpx < r.x - 2 || x > r.x + r.w + 2 || ty + hpx < r.y - 2 || ty > r.y + hpx + 2);
        });
        if (!clash) { placed.push({ x: x, y: ty, w: wpx }); return ty; }
      }
      placed.push({ x: x, y: y, w: wpx });
      return y;
    }

    buses.forEach(function (v) {
      var view = adhLib.view(v, data.staleness);
      var p = project(v.position.lat, v.position.lon);
      var g = svgEl('g', { class: 'map__chip map__chip--' + view.state });
      /*
       * The direction tag earns its width in BOTH mode: without it a chip says which bus
       * and how late, but not which way it is heading, which is the one thing the map is
       * positioned to answer. Omitted in a single-direction view, where every chip on
       * screen already shares the same heading and the tag would be pure repetition.
       */
      var dtag = (v.trip && showDirection) ? ' ' + dirTagFor(data, v.trip.direction_id) : '';
      var text = view.glyph + ' ' + (v.label || v.vehicle_id) + ' ' + view.value + dtag;
      var wpx = 8 + text.length * 6.1;
      var x = Math.max(2, Math.min(w - wpx - 2, p.x - wpx / 2));
      var y = freeSlot(x, Math.max(2, Math.min(H - 20, p.y - 20)), wpx);
      g.appendChild(svgEl('line', { x1: p.x, y1: p.y, x2: x + wpx / 2, y2: y + 16, class: 'map__leader' }));
      g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 3.2, class: 'map__pin' }));
      g.appendChild(svgEl('rect', { x: x, y: y, width: wpx, height: 16, rx: 4, class: 'map__chipbg' }));
      var t = svgEl('text', { x: x + wpx / 2, y: y + 11.6, class: 'map__chiptext' });
      t.textContent = text;
      g.appendChild(t);
      svg.appendChild(g);
    });

    host.appendChild(svg);

    var cap = el('p', 'track__cap');
    if (suppressed) {
      cap.className += ' is-warn';
      cap.textContent = 'Positions only. Lateness is suppressed, so chips carry no number.';
    } else {
      cap.textContent = 'Relative positions from the feed, drawn to scale against the route\'s ' +
        'own bounding box. A real basemap is still to come; nothing here is a street map.';
    }
    host.appendChild(cap);

    var sr = el('p', 'sr-only');
    sr.textContent = 'Schematic map showing ' + buses.length + ' vehicles. The same positions, ' +
      'lateness and next stops are listed in the Vehicles panel above.';
    host.appendChild(sr);
  }

  global.CMB.map = { render: render };
})(window);
