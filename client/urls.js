/*
 * urls.js — what the address bar says, and what it means.
 *
 * The board is a static file set behind nginx. There is no router and no server
 * that knows about views, so a shareable URL has to survive two facts:
 *
 *   1. The page can be opened from a file:// URL, where paths are meaningless
 *      and the History API is off limits. That is a hard requirement of this
 *      project, not a convenience, so ?query= remains a first-class form and is
 *      the ONLY form used from disk.
 *   2. Over HTTP the client fetches `api/route/4.json` RELATIVE to the page. At
 *      /trip/1234 that resolves to /trip/api/route/4.json, which does not
 *      exist. Every fetch therefore goes through a base derived from the
 *      current path rather than a hardcoded "/api/" -- the e2e fixture server
 *      serves the whole client under a scenario prefix, and an absolute base
 *      would break it.
 *
 * The grammar:
 *
 *   /                    board, last route
 *   /route/4             board, route 4, saved direction
 *   /route/4/eb          board, route 4, eastbound
 *   /buses               all buses
 *   /trip                trip view, no bus picked
 *   /trip/1234           trip view, bus 1234 -- caller resolves the route
 *   /trip/7/1234         trip view, route 7, bus 1234
 *   /saved               saved trips
 *
 * `/saved` carries no watch data and never will. Saved trips live in
 * localStorage; putting one in a URL would publish somebody's routine to
 * whoever they sent the link to.
 */
(function (global) {
  'use strict';

  /* The verbs that begin an app path. Anything before the first one is the
     directory the board is served from. */
  var VERBS = { route: 1, buses: 1, trip: 1, saved: 1 };

  /* Direction tokens. The letters are per-route -- the 4 runs EB/WB and the 7
     runs NB/SB -- so a token cannot be mapped to a direction_id until that
     route's document has loaded. 0 and 1 are accepted for the routes whose
     headsigns carry no compass letter at all. */
  var DIRECTIONS = { eb: 1, wb: 1, nb: 1, sb: 1, both: 1, '0': 1, '1': 1 };

  function segments(pathname) {
    return String(pathname || '/').split('/').filter(function (s) { return s.length; });
  }

  /*
   * Split a pathname into the directory the board is served from and the app
   * path within it. `/fresh/trip/1234` is the e2e server's shape and must come
   * back as base `/fresh/` with segments [trip, 1234]; `/trip/1234` in
   * production comes back as base `/` with the same segments.
   *
   * With no verb present the base is the directory of whatever was requested,
   * so `/fresh/index.html` and `/fresh/` both yield `/fresh/`. A segment is
   * treated as a filename when it contains a dot.
   */
  function split(pathname) {
    var parts = segments(pathname);
    var at = -1;
    for (var i = 0; i < parts.length; i++) {
      if (Object.prototype.hasOwnProperty.call(VERBS, parts[i])) { at = i; break; }
    }
    if (at < 0) {
      var last = parts.length ? parts[parts.length - 1] : '';
      var dir = last.indexOf('.') >= 0 ? parts.slice(0, -1) : parts;
      return { base: '/' + (dir.length ? dir.join('/') + '/' : ''), segments: [] };
    }
    return {
      base: '/' + (at ? parts.slice(0, at).join('/') + '/' : ''),
      segments: parts.slice(at)
    };
  }

  /** The prefix every api/ fetch hangs off, with a trailing slash. */
  function baseFor(pathname) {
    return split(pathname).base;
  }

  function parseQuery(search) {
    var q = {};
    String(search || '').replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var bits = kv.split('=');
      q[decodeURIComponent(bits[0])] = decodeURIComponent(bits.slice(1).join('=') || '');
    });
    return q;
  }

  /*
   * What a URL asks for. Every field is null when the URL does not say.
   *
   * The path is read first and the query then overrides it, field by field.
   * That order keeps every link that already exists working unchanged -- those
   * carry no path -- and lets a path be combined with the ?state= harness,
   * which is the only way to look at an interaction state on a pretty URL.
   */
  function parse(pathname, search) {
    var s = split(pathname);
    var segs = s.segments;
    var out = {
      base: s.base,
      view: null,
      route_id: null,
      direction: null,
      bus_id: null,
      query: parseQuery(search)
    };

    if (segs.length) {
      var verb = segs[0];
      if (verb === 'buses') {
        out.view = 'all';
      } else if (verb === 'saved') {
        out.view = 'saved';
      } else if (verb === 'route') {
        out.view = 'board';
        if (segs[1]) out.route_id = segs[1];
        var token = segs[2] ? String(segs[2]).toLowerCase() : null;
        if (token && Object.prototype.hasOwnProperty.call(DIRECTIONS, token)) {
          out.direction = token;
        }
      } else if (verb === 'trip') {
        out.view = 'trip';
        /* Three segments name the route; two leave it for the caller to resolve
           from the fleet document, which is the cost of a URL you can read out
           loud over the phone. */
        if (segs.length >= 3) { out.route_id = segs[1]; out.bus_id = segs[2]; }
        else if (segs.length === 2) { out.bus_id = segs[1]; }
      }
    }

    var q = out.query;
    if (q.view) out.view = q.view;
    if (q.route) out.route_id = q.route;
    if (q.dir !== undefined && q.dir !== '') out.direction = String(q.dir).toLowerCase();
    if (q.bus) out.bus_id = q.bus;

    return out;
  }

  /*
   * The path for what is on screen, relative to the base — "route/4/eb",
   * "trip/7/2641", "buses", "saved", or "" for the board's default.
   *
   * `direction` is already a token here rather than a direction_id, because
   * only the caller knows this route's headsigns well enough to say whether
   * direction 0 is EB or NB.
   */
  function format(view, routeId, direction, busId) {
    if (view === 'all') return 'buses';
    if (view === 'saved' || view === 'saved-edit') return 'saved';
    if (view === 'trip') {
      if (busId && routeId) return 'trip/' + routeId + '/' + busId;
      if (busId) return 'trip/' + busId;
      return 'trip';
    }
    if (routeId && direction !== null && direction !== undefined && direction !== '') {
      return 'route/' + routeId + '/' + direction;
    }
    if (routeId) return 'route/' + routeId;
    return '';
  }

  /** Is this token one the grammar accepts for a direction? */
  function isDirectionToken(token) {
    return !!token && Object.prototype.hasOwnProperty.call(DIRECTIONS, String(token).toLowerCase());
  }

  global.CMB = global.CMB || {};
  global.CMB.urls = {
    parse: parse,
    format: format,
    baseFor: baseFor,
    isDirectionToken: isDirectionToken
  };
})(window);
