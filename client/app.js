/*
 * app.js — bootstrap, data loading, header, view switching, and the panel order
 * that was decided and is not open: header, VEHICLE ROWS, LADDER, MAP.
 *
 * Three views share one shell:
 *   board  — one route, the original and the default
 *   all    — every bus in the system, deadheads included
 *   saved  — trips this browser has saved, resolved locally
 *
 * Data sources, in order of preference:
 *   1. a real HTTP fetch of api/*.json, when the board is served
 *   2. the bundled golden fixture in data/, when it is opened from disk
 * Opening client/index.html straight from the filesystem has to work, because
 * that is how this gets tested with no server running.
 */
(function (global) {
  'use strict';

  var fmt = global.CMB.fmt;
  var S = global.CMB.states;
  var el = S.el;

  var SUPPORTED_SCHEMA = 1;

  /*
   * Every fetch hangs off a base derived from the current path, because the
   * pretty URLs put the page at a depth the api/ files are not at. A relative
   * "api/route/4.json" read from /trip/1234 asks for /trip/api/route/4.json.
   *
   * Derived rather than the fixed string "/api/": tests/e2e/server.mjs serves
   * the whole client under a scenario prefix, so an absolute base would 404
   * every browser test in this repo. From disk there is no base at all -- a
   * leading slash on file:// walks to the root of the filesystem -- so the
   * relative form is kept, which is also the only form file:// URLs use.
   */
  var API_PREFIX = global.location.protocol === 'file:'
    ? '' : global.CMB.urls.baseFor(global.location.pathname);
  var API_BASE = API_PREFIX + 'api/route/';
  var API_ROUTES = API_PREFIX + 'api/routes.json';
  var API_ALL = API_PREFIX + 'api/all.json';
  var API_DEPARTURES = API_PREFIX + 'api/departures/';
  var REFRESH_MS = 60000;

  /*
   * What to say when localStorage refuses a write — Safari private browsing, an
   * exhausted quota, storage switched off. The board must never announce a save
   * that did not happen: the trip would simply be gone next time, with nothing on
   * screen having suggested anything went wrong.
   */
  var SAVE_REFUSED = {
    head: 'Nothing was saved.',
    detail: 'This browser would not let the board save the trip — private ' +
      'browsing or storage turned off. Nothing was kept.'
  };

  /*
   * A refused delete needs its own words. "Nothing was saved" would be actively
   * misleading: the trip is not gone, it is still on this device and will be back
   * on the next load, which is the opposite of what the reader just asked for.
   */
  var REMOVE_REFUSED = {
    head: 'The trip is still saved on this device.',
    detail: 'This browser would not let the board delete it — storage is full or ' +
      'switched off. It will be back the next time this page is opened.'
  };

  /*
   * The six routes this household actually rides, pinned to the top of the picker.
   * They are a shortcut, NOT the list: the picker offers every route the catalog
   * publishes. Hard-coding six while the build generated seventy-one meant the
   * board was wrong the moment either kid took a different bus, and it is the one
   * thing the owner asked for by name — "don't hard code one".
   */
  var FAVOURITES = ['4', '7', '337', '350', '800', '837'];

  /*
   * Used only until api/routes.json arrives, and when the board is opened from
   * disk where there is no catalog to fetch. Names are never invented here; a
   * route is its number until something authoritative says otherwise.
   */
  function fallbackCatalog() {
    return FAVOURITES.map(function (id) {
      return { id: id, short_name: id, long_name: '', directions: [], has_service_today: null };
    });
  }

  function catalog() {
    return state.routes && state.routes.length ? state.routes : fallbackCatalog();
  }

  function cleanName(s) { return String(s || '').replace(/^\d+-/, ''); }

  function catalogEntry(id) {
    return catalog().filter(function (r) { return r.id === id; })[0] || null;
  }

  function routeName(id) {
    var r = catalogEntry(id);
    if (r && r.long_name) return cleanName(r.long_name);
    var d = state.data;
    if (d && d.route && d.route.id === id) return cleanName(d.route.long_name);
    return '';
  }

  var state = {
    view: 'board',       /* board | all | trip | saved | saved-edit */
    routeId: null,
    direction: 'both',   /* 0 | 1 | 'both' */
    data: null,
    status: 'loading',   /* loading | ok | error | schema | first-run */
    errorDetail: null,
    lastGoodAt: null,
    scenario: null,
    usingFixture: false,
    /*
     * The location fix. In memory only, and deliberately not in localStorage
     * alongside the route and direction: a saved route is a preference, a saved
     * position is a record of where somebody was.
     */
    geo: null,
    pickerOpen: false,
    pickerFilter: '',
    routes: null,        /* the catalog, once api/routes.json lands */
    all: null,           /* api/all.json, fetched only while the all view is open */
    allStatus: 'idle',   /* idle | loading | ok | error */
    /*
     * Seven maps keyed by a route id, and `?route=` puts any string in that key.
     * A bare `{}` inherits Object.prototype, so a route id of `constructor` or
     * `toString` reads back a function rather than undefined: the fetch guard
     * sees a cached document that is not one, and never asks for the real thing.
     * Object.create(null) has no prototype to reach. Same bug as W.rowsFor, same
     * reason it is fixed at the map rather than at each reader.
     */
    /*
     * Held, which is not the same as believed. Read this directly and you get a
     * schedule the board may already know belongs to a service day that has
     * ended: call usableDepartures(routeId) to render from one. The trip view
     * read it directly for a while and printed yesterday's times under today's
     * heading, which is what this note is here to stop happening again.
     */
    departures: Object.create(null),   /* route id -> api/departures/{id}.json */
    /*
     * The REQUEST for a document, never the document itself. Absent is a value
     * and the load-bearing one: it is what permits the next request, and it is
     * what the sweep produces when it clears a failure or gives up on a hang.
     */
    depStatus: Object.create(null),    /* route id -> absent | loading | ok | stale | error */
    depGen: Object.create(null),       /* route id -> which request the answer must belong to */
    depStuck: Object.create(null),     /* route id -> sweeps a 'loading' has survived */
    depAbort: Object.create(null),     /* route id -> the in-flight request's AbortController */
    routeData: Object.create(null),    /* route id -> api/route/{id}.json, off the open board */
    routeStatus: Object.create(null),  /* route id -> loading | ok | error */
    editor: { route_id: null, direction_id: null, stop_id: null },
    stopId: null,        /* the stop the Next buses band is answering for */
    stopPicking: false,
    openBuses: Object.create(null),  /* vehicle_id -> true, for the all-buses panels */
    tripBusId: null,     /* the vehicle the trip view is following, this session only */
    tripPicking: null,   /* null | 'bus' — is the bus list open */
    tripLastSeen: null,  /* {vehicle, at} — the followed bus's last appearance */
    /*
     * A direction token from the URL, held until the route document arrives.
     * "eb" means direction 0 on the 4 and nothing at all on the 7, so it cannot
     * be resolved until the headsigns are known.
     */
    pendingDir: null,
    /* A bus id from /trip/1234 whose route is not yet known. */
    pendingBus: null,
    storageError: null   /* {head, detail} when localStorage refused the last write */
  };

  var dom = {};

  /* ---- persistence: "opens to last route" ----------------------------- */
  function store(k, v) { try { localStorage.setItem('cmb.' + k, v); } catch (e) { /* private mode */ } }
  function recall(k) { try { return localStorage.getItem('cmb.' + k); } catch (e) { return null; } }

  function query() {
    var q = {};
    (global.location.search || '').replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var bits = kv.split('=');
      q[decodeURIComponent(bits[0])] = decodeURIComponent(bits.slice(1).join('=') || '');
    });
    return q;
  }

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---- loading -------------------------------------------------------- */
  /*
   * The bundled fixtures are two more maps keyed by a route id off the URL, and
   * `?route=` puts any string in that key. They are declared in client/data/*.js
   * as plain object literals, so a bare lookup reaches Object.prototype -- the
   * same defect W.rowsFor was guarded for, one map over, and reachable by anyone
   * who can send a link. Both were live:
   *
   *   ?route=__proto__    embedded() returned Object.prototype, deepCopy made
   *                       `{}` of it, and a payload with no numeric `schema`
   *                       took the schema branch. The board rendered nothing but
   *                       "This app needs updating" -- a screen that is not just
   *                       broken but WRONG about why, which sends the reader off
   *                       to fix a copy of the app that was never the problem.
   *   ?route=constructor  embeddedDepartures() returned the Object function, and
   *                       JSON.stringify of a function is undefined, so deepCopy
   *                       threw "undefined" is not valid JSON. It throws inside
   *                       loadDepartures's own .catch, where nothing catches it
   *                       again, so depStatus stayed 'loading' for the life of
   *                       the tab and that route could never load a schedule.
   *
   * Guarded at each lookup rather than at the two data files, because those are
   * generated (client/data/regenerate.js) and a guard here also covers a fixture
   * written by hand or by an older generator.
   */
  function fixture(map, routeId) {
    if (!map || !Object.prototype.hasOwnProperty.call(map, routeId)) return null;
    var f = map[routeId];
    return f ? deepCopy(f) : null;
  }

  function embedded(routeId) {
    return fixture(global.CMB_FIXTURES, routeId);
  }

  /*
   * The departures document from disk. Same reason as embedded(): a file://
   * board has nothing to fetch, and without a schedule the trip view has no
   * scheduled column and therefore no answer at all.
   */
  function embeddedDepartures(routeId) {
    return fixture(global.CMB_FIXTURES_DEPARTURES, routeId);
  }

  /*
   * One fetch. Every endpoint is a static JSON file on the same origin, so there
   * is nothing to configure and nothing to authenticate. A file:// board has no
   * origin to fetch from and rejects immediately rather than waiting for a
   * network error, because from disk the fixture IS the answer, not a fallback
   * after a timeout.
   */
  /*
   * A 200 is not by itself an answer.
   *
   * Every one of these endpoints is a static JSON file, and the things that sit
   * in front of it — a proxy, a CDN, a captive portal, a half-written file — can
   * all answer 200 with a body that parses to something that is not a document.
   * Stored under a success status, a falsy body then reads as "nothing cached"
   * to one guard and as "loaded" to another, and each endpoint fails a different
   * ugly way: the schedule spun a request loop, the fleet document told the
   * reader CapMetro was reporting no buses at all, and a route document sat at
   * 'ok' holding null where the once-a-minute retry only ever clears 'error'.
   *
   * Arrays are refused too. `typeof [] === 'object'`, and an array reaches the
   * schema check instead, which puts "This app needs updating … written for
   * format undefined" on screen — a board that is wrong about why it is broken.
   */
  function isDocument(d) {
    return !!d && typeof d === 'object' && Object.prototype.toString.call(d) !== '[object Array]';
  }

  function getJson(path, signal) {
    if (global.location.protocol === 'file:' || typeof fetch !== 'function') {
      return Promise.reject(new Error('file://'));
    }
    var opts = { cache: 'no-cache' };
    if (signal) opts.signal = signal;
    return fetch(path, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /*
   * An AbortController where the browser has one, and null where it does not.
   *
   * Giving up on a hung request in bookkeeping alone leaves the request itself
   * outstanding. A browser allows about six connections per origin, so a server
   * that accepts and never answers fills that pool with dead requests and the
   * once-a-minute poll ends up queued behind them -- the opposite of what giving
   * up is for. Feature-detected rather than assumed: the board runs on whatever
   * phone the reader has, and where there is no AbortController the board loses
   * the release of the socket and nothing else -- the give-up, the retry and the
   * fetch itself all behave exactly as they do with one.
   */
  function abortable() {
    return typeof AbortController === 'function' ? new AbortController() : null;
  }

  function fetchRoute(routeId) {
    return getJson(API_BASE + encodeURIComponent(routeId) + '.json');
  }

  /*
   * The catalog, fetched once. A failure here is not an error state: the picker
   * falls back to the six favourites, which is exactly what it offered before
   * this endpoint existed. Losing the other sixty-five routes is a smaller
   * failure than refusing to show a board.
   */
  function loadCatalog() {
    getJson(API_ROUTES)
      .then(function (d) {
        if (d && d.routes && d.routes.length) {
          state.routes = d.routes;
          render();
        }
      })
      .catch(function () { /* fallbackCatalog() covers it */ });
  }

  function loadAll(then) {
    if (state.allStatus === 'loading') return;
    state.allStatus = 'loading';
    render();
    getJson(API_ALL)
      .then(function (d) {
        /*
         * See isDocument. Here the board does not merely fail — it renders
         * "CapMetro is reporting no buses at all … a CapMetro problem rather
         * than a problem with this board", which is a confident false statement
         * about service that names somebody else as the cause. The real
         * can't-reach-the-feed state, with its Retry, never appeared.
         */
        if (!isDocument(d)) throw new Error('not a fleet document');
        state.all = d;
        state.allStatus = 'ok';
        if (then) then(d);
        render();
      })
      .catch(function (err) {
        state.allStatus = state.all ? 'ok' : 'error';
        state.errorDetail = 'Could not load every-bus data (' + err.message + ').';
        /*
         * The callback runs on failure too. resolveBusRoute is the only caller
         * that passes one, and it is resolving a bare /trip/1234 -- the link
         * shape this whole feature exists for. Calling back only on success left
         * it with pendingBus set forever: the refresh retries loadAll only while
         * the all view is open, and boot has already switched to the trip view
         * by then, so a bus link opened during one bad fetch stayed stuck with
         * no way out but a reload.
         */
        if (then) then(null);
        render();
      });
  }

  /*
   * The live payload for a route that is NOT the one on screen.
   *
   * A saved trip is almost never on the board you happen to be looking at — the
   * whole point is watching the 800 while the 4 is open. Reading the live vehicle
   * out of `state.data` only worked when the two happened to be the same route,
   * so every saved trip on any other route reported "no bus is reporting on this
   * trip yet" no matter how many buses were out. Cached per route and refreshed
   * on the same interval as the board.
   */
  function loadRouteData(routeId) {
    if (!routeId) return;
    if (routeId === state.routeId) return;   /* state.data already has it */
    /*
     * Every status except 'idle' is a stop, not a pause.
     *
     * This used to short-circuit on 'loading' alone. paintSaved calls it once
     * per saved trip on every paint, and the fetch calls render() when it
     * resolves -- so a route that had finished loading sat at 'ok', passed the
     * guard, fetched again, painted again, and went round. Measured at 364
     * requests in six seconds against one route file, from a board sitting on
     * the saved tab doing nothing.
     *
     * The timer is what reopens the question: refreshTick sets 'idle' back on
     * every saved trip once a minute and then asks. That is the same shape
     * depStatus already had, where 'stale' and 'error' are cleared by the sweep
     * rather than by whoever happens to repaint next -- and it is the rule
     * written twice elsewhere in this file, that a render which starts a fetch
     * is a render that can trigger another render.
     */
    var st = state.routeStatus[routeId];
    if (st && st !== 'idle') return;
    state.routeStatus[routeId] = 'loading';
    fetchRoute(routeId)
      .then(function (d) {
        /*
         * See isDocument. This one is unreachable by the retry that was built
         * for exactly its symptom: the sweep clears 'error', a falsy body lands
         * on 'ok', and the bus detail then reads "Just left · loading the
         * route…" for the life of the tab with nothing loading. Throwing puts it
         * on the error path the retry can actually see.
         */
        if (!isDocument(d)) throw new Error('not a route document');
        state.routeData[routeId] = d;
        state.routeStatus[routeId] = 'ok';
        render();
      })
      .catch(function () {
        state.routeStatus[routeId] = 'error';
        render();
      });
  }

  /* The live payload for a route, wherever it happens to be cached. */
  function liveRoute(routeId) {
    if (routeId === state.routeId) return state.data;
    return state.routeData[routeId] || null;
  }

  /*
   * The service date the LIVE payloads say it is now, or null when nothing live
   * has been seen. Null means "do not judge anything expired".
   *
   * Never derived here from a device clock. The server already resolved
   * service-day midnight once, correctly across both DST transitions, and
   * re-deriving it in a browser is two chances a year to be an hour wrong on the
   * document that says when a kid's bus leaves.
   *
   * And never from the bundled fixture. That file is a frozen capture, not a
   * statement about today: reading its date as the current one would let a single
   * failed request — route 4 is the default and the only bundled route — declare
   * every cached schedule expired and throw it away, on a connection that had
   * just proved it could not fetch a replacement.
   */
  function currentServiceDate(s) {
    s = s || state;
    var dates = [];
    if (!s.usingFixture && s.data && s.data.service_day) dates.push(s.data.service_day.date);
    if (s.all && s.all.service_day) dates.push(s.all.service_day.date);
    var routeData = s.routeData || {};
    Object.keys(routeData).forEach(function (id) {
      var r = routeData[id];
      if (r && r.service_day) dates.push(r.service_day.date);
    });
    /*
     * Held to the same shape scheduleExpired holds a document's date to. A date
     * that is not YYYYMMDD cannot be compared with `<` against one that is, and
     * this operand fails in the unsafe direction: whatever sorts highest becomes
     * "today", and one malformed value there makes every well-formed document
     * look current, which is the bug the eviction exists to remove. Not
     * reachable from the generator, which formats 'Ymd' and nothing else --
     * asserted here because the other operand already is, and an asymmetry is
     * how the next person concludes one of them does not matter.
     */
    dates = dates.filter(function (d) { return /^[0-9]{8}$/.test(String(d)); }).sort();
    /*
     * The LATEST date any live source reports, not the first one found.
     *
     * The sources do not refresh on the same schedule: `state.all` is only
     * fetched while the every-bus view is open and then sits there, so it can be
     * hours behind the route payload. Taking the first hit let a source that had
     * stopped updating define what "today" is — and because a date that is too
     * old makes nothing look expired, the failure lands exactly on the bug this
     * eviction exists to remove.
     *
     * Max is safe in the direction that matters: every candidate was generated
     * server-side, so none can be ahead of the real service day, and a stale one
     * can no longer drag the answer backwards.
     */
    return dates.length ? dates[dates.length - 1] : null;
  }

  /*
   * A departures document describes one service day. This one describes an
   * EARLIER one.
   *
   * Older, not merely different. `!==` also condemns a document from the future,
   * and the two are not the same news: around the service-day roll, `state.data`
   * can still be from before it while a schedule fetched a moment later is from
   * after, and calling the fresher of the two expired re-fetches it once a minute
   * until the live payload catches up. Any skew in that direction has the shape.
   *
   * Service dates are `YYYYMMDD` strings, so comparing them as strings compares
   * them as dates. That holds only because of the format, which is why it is
   * written down here rather than left to be noticed.
   */
  function scheduleExpired(doc, today) {
    if (today === undefined) today = currentServiceDate();
    if (!today || !doc) return false;
    /*
     * A date we cannot read counts as expired: kept, but never answered from.
     *
     * The comparison used to be `doc.service_date < today` alone, which leaves
     * the answer to JS relational coercion and gets a different failure
     * direction depending on which way the document is malformed. `null` and
     * `''` and `'2026-08-22'` all came back expired, which is the safe
     * direction; `undefined` and `'garbage'` came back CURRENT, because any
     * relational comparison with undefined is false and 'g' sorts above '2'.
     * So an absent date was believed forever and never re-requested.
     *
     * The schema requires eight digits and the suite enforces it, so a document
     * reaching this state means the generator has already broken its contract.
     * That is exactly when the board should not be improvising.
     */
    if (!/^[0-9]{8}$/.test(String(doc.service_date))) return true;
    return String(doc.service_date) < today;
  }

  /*
   * The departures document for a route, or null when the board must not answer
   * from it.
   *
   * EVERY render path goes through here, and that is the whole point. The board
   * deliberately KEEPS an out-of-date schedule — deleting it is how a failed
   * refetch loses a whole service day — but it must never ANSWER from one.
   * Keeping and believing are two different decisions, and this is where the
   * second one is made.
   *
   * The first version of this fix made only the first decision. It marked the
   * document `stale`, wrote a comment claiming it was "kept, not believed", and
   * then handed it to the readers unchanged, because no reader ever looked at
   * that status. A phone at breakfast still read yesterday's departure times
   * under today's heading — the exact bug the eviction was written to remove,
   * surviving in the branch where the replacement has not arrived yet.
   *
   * Derived from the document rather than from `depStatus` on purpose: a status
   * is a second copy of a fact and can fall out of step with it. The document
   * carries its own service date, so ask the document.
   */
  function usableDepartures(routeId) {
    var doc = state.departures[routeId];
    return doc && !scheduleExpired(doc) ? doc : null;
  }

  /*
   * One departures document per route, kept for the SERVICE DAY it describes —
   * not, as it was, for the life of the tab.
   *
   * It is a whole service day of scheduled stop times, about 17 KB gzipped for
   * route 800, so it is worth fetching once and worth not fetching until a saved
   * trip or the editor actually needs it. But a phone left on the counter
   * overnight and picked up at seven still held yesterday's document: a saved
   * trip reading "the last one today has gone", or times belonging to the wrong
   * service day entirely, on the exact surface someone consults at breakfast and
   * has no reason to doubt. The route payload refreshes every 60 seconds and
   * carries the current service date, so it is what says when this document has
   * expired.
   */
  function loadDepartures(routeId) {
    if (!routeId) return;
    /*
     * A document for the current service day is done; there is nothing to do.
     *
     * One that is NOT is left exactly where it is and re-requested. Deleting it
     * first is only safe when the fetch cannot fail — and this one demonstrably
     * can, taking a correct schedule with it and leaving "Schedule not loaded"
     * where a minute earlier there was a whole service day. The replacement is
     * swapped in below, once it has actually arrived.
     */
    var cached = state.departures[routeId];
    if (cached && !scheduleExpired(cached)) return;
    /*
     * 'error' is a stop, not a pause, and so is 'stale'. Without that a failed
     * fetch set the status, called render, and render asked again - a
     * fetch-and-repaint loop that hammered the server and rebuilt the DOM every
     * frame. The 60s refresh clears both so a transient failure, and a server
     * still serving yesterday, each recover without spinning.
     */
    var status = state.depStatus[routeId];
    if (status === 'loading' || status === 'error' || status === 'stale') return;
    state.depStatus[routeId] = 'loading';
    /*
     * Which request this is. The sweep gives up on a fetch that never settles
     * (see refreshTick) and lets the next tick ask again, which means two
     * requests for one route can be outstanding at once. Without this stamp the
     * abandoned one still writes when it finally lands, and an older document
     * overwrites a newer one.
     */
    var gen = (state.depGen[routeId] || 0) + 1;
    state.depGen[routeId] = gen;
    var ctl = abortable();
    state.depAbort[routeId] = ctl;
    getJson(API_DEPARTURES + encodeURIComponent(routeId) + '.json', ctl && ctl.signal)
      .then(function (d) {
        /*
         * Before the delete below, and it has to stay that way. An abandoned
         * answer that got this far would otherwise delete the controller of the
         * request that REPLACED it, and nothing in the suite would notice --
         * the leak is a socket, not a wrong number on a screen.
         */
        if (state.depGen[routeId] !== gen) return;
        delete state.depAbort[routeId];
        /*
         * See isDocument. Here the falsy body spun a request loop: stored under
         * 'ok', read as "nothing cached" by the guard above, re-asked on the
         * next paint. After the generation check, so an abandoned request cannot
         * take the live one's route into 'error' on its way out.
         */
        if (!isDocument(d)) throw new Error('not a departures document');
        /* The swap. Whatever was here is replaced only now, by something that
         * arrived. */
        state.departures[routeId] = d;
        /*
         * A document for an earlier day is KEPT — deleting it is how a failed
         * refetch loses a whole service day — and marked so it is asked for again
         * on the timer rather than spun on. Kept is not the same as believed:
         * usableDepartures() is what stops any reader answering from it.
         */
        state.depStatus[routeId] = scheduleExpired(d) ? 'stale' : 'ok';
        render();
      })
      .catch(function () {
        /*
         * From disk the fixture IS the answer, not a fallback after a timeout.
         * Over HTTP a failure is a failure: substituting the bundle there would
         * make route 4 alone recover silently from a real 404/500 while the
         * other 70 routes correctly error, and a schedule bundled months ago
         * must never be presented as today's.
         */
        if (state.depGen[routeId] !== gen) return;   /* answer to a question we stopped asking */
        delete state.depAbort[routeId];
        var disk = global.location.protocol === 'file:' ? embeddedDepartures(routeId) : null;
        if (disk) {
          state.departures[routeId] = disk;
          state.depStatus[routeId] = 'ok';
        } else {
          state.depStatus[routeId] = 'error';
        }
        render();
      });
  }

  function load(routeId) {
    var scenario = state.scenario;

    if (scenario && scenario.firstRun) {
      state.status = 'first-run';
      render();
      return;
    }
    if (scenario && scenario.hold) {
      state.status = 'loading';
      render();
      return;                      /* deliberately never resolves */
    }
    if (scenario && scenario.fail) {
      state.status = 'error';
      state.errorDetail = scenario.fail;
      render();
      return;
    }

    state.status = state.data ? state.status : 'loading';
    render();

    fetchRoute(routeId)
      /*
       * The board's OWN route document, and the one place the shape check was
       * missing. load() and loadRouteData() call the same fetchRoute against the
       * same endpoint; the guard went on one of them. loadRouteData returns
       * early for the open route, so the document on screen — the very first
       * fetch any reader makes — went exclusively through the unguarded path.
       *
       * Deliberately in THIS .then rather than the one below, so that it lands
       * on the fixture fallback in the catch that follows. A body of `[]` or a
       * captive portal's `"sorry"` is not data, and the board already knows what
       * to do when it has no data: show the bundled sample under its banner, or
       * say it cannot reach the feed. Guarding after the fallback instead would
       * make a 200 of garbage WORSE than a 502 — the schema screen, which tells
       * the reader to go and update an app that was never the problem.
       */
      .then(function (d) {
        if (!isDocument(d)) throw new Error('not a route document');
        state.usingFixture = false;
        return d;
      })
      .catch(function (err) {
        var f = embedded(routeId);
        if (!f) throw err;
        state.usingFixture = true;
        return f;
      })
      .then(function (d) {
        /*
         * Seed the followed bus from the payload BEFORE a scenario mutates it.
         * ?state=trip-gone strips every vehicle from every document the harness
         * produces, so without this there is no poll in which the bus was ever
         * present, and the dimmed last-seen state has no URL that can show it.
         * This is the sequence a real disappearance takes -- present in one poll,
         * absent in the next -- compressed into one load.
         */
        if (scenario && scenario.apply && state.tripBusId) {
          for (var i = 0; i < (d.vehicles || []).length; i++) {
            if (String(d.vehicles[i].vehicle_id) === String(state.tripBusId)) {
              state.tripLastSeen = { vehicle: deepCopy(d.vehicles[i]), at: d.generated_at };
              break;
            }
          }
        }
        if (scenario && scenario.apply) d = scenario.apply(d);
        if (typeof d.schema !== 'number' || d.schema > SUPPORTED_SCHEMA) {
          state.status = 'schema';
          state.data = d;
          render();
          return;
        }
        state.data = d;
        state.lastGoodAt = d.generated_at;
        state.status = 'ok';
        /* Now the headsigns exist, so "eb" can become a direction_id. Done here
           rather than in boot so it lands before the first meaningful paint. */
        resolveDirection();
        /*
         * Re-check the schedule against the payload that just arrived.
         *
         * currentServiceDate() reads state.data, so an expiry check run before
         * this point is judged against the PREVIOUS service date. The refresh
         * tick did exactly that: on the first tick after a phone woke, the sweep
         * compared today's schedule question against yesterday's answer, found
         * nothing expired, and the board went on showing yesterday's times for a
         * further full minute. The roll is known here; act on it here.
         */
        loadDepartures(routeId);
        render();
      })
      .catch(function (err) {
        state.status = state.data ? 'ok' : 'error';
        state.errorDetail = 'No data file for route ' + routeId + ' yet (' + err.message + ').';
        if (state.status === 'ok') announce('Refresh failed; showing the last data received.');
        render();
      });
  }

  function announce(msg) {
    if (dom.live) dom.live.textContent = msg;
  }

  /* ---- header --------------------------------------------------------- */
  function directionLabel(id) {
    if (!state.data || !state.data.route) return id === 0 ? 'A' : 'B';
    var d = (state.data.route.directions || []).filter(function (x) { return x.id === id; })[0];
    return d ? fmt.directionTag(d.headsign, id) : (id === 0 ? 'A' : 'B');
  }

  function buildHeader() {
    var head = el('header', 'topbar');

    var brandRow = el('div', 'topbar__row topbar__row--brand');
    var brand = el('p', 'brand');
    brand.appendChild(el('span', 'brand__mark', '▲'));
    brand.appendChild(el('span', 'brand__name', 'Dillo Bus Board'));
    brandRow.appendChild(brand);
    dom.stamp = el('p', 'stamp');
    brandRow.appendChild(dom.stamp);
    head.appendChild(brandRow);

    var ctrlRow = el('div', 'topbar__row');

    var chip = el('button', 'routechip');
    chip.type = 'button';
    chip.setAttribute('aria-haspopup', 'true');
    chip.setAttribute('aria-expanded', 'false');
    chip.addEventListener('click', function () {
      state.pickerOpen = !state.pickerOpen;
      render();
    });
    dom.routechip = chip;
    ctrlRow.appendChild(chip);

    var group = el('div', 'dirtoggle');
    dom.dirgroup = group;
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Direction');
    dom.dirbuttons = [];
    [0, 1, 'both'].forEach(function (d) {
      var b = el('button', 'dirtoggle__btn');
      b.type = 'button';
      b.dataset.dir = String(d);
      b.addEventListener('click', function () {
        state.direction = d;
        store('direction', String(d));
        render();
        announce('Showing ' + (d === 'both' ? 'both directions' : directionLabel(d)));
      });
      group.appendChild(b);
      dom.dirbuttons.push(b);
    });
    ctrlRow.appendChild(group);
    head.appendChild(ctrlRow);

    /*
     * The view switcher. The route board is the product; the other two are the
     * secondary screens the owner asked for, and they sit behind a tab rather
     * than beside the route so that opening the app still lands on one route's
     * buses without a choice to make.
     */
    var views = el('nav', 'viewtabs');
    views.setAttribute('aria-label', 'View');
    dom.viewbuttons = [];
    [
      { id: 'board', label: 'Route' },
      { id: 'all', label: 'All buses' },
      { id: 'trip', label: 'Trip' },
      { id: 'saved', label: 'Saved' }
    ].forEach(function (v) {
      var b = el('button', 'viewtabs__btn');
      b.type = 'button';
      b.dataset.view = v.id;
      b.textContent = v.label;
      b.addEventListener('click', function () { selectView(v.id); });
      views.appendChild(b);
      dom.viewbuttons.push(b);
    });
    head.appendChild(views);

    dom.picker = el('div', 'picker');
    dom.picker.hidden = true;
    head.appendChild(dom.picker);

    return head;
  }

  /*
   * The storage notice describes ONE write — a save or a delete that the browser
   * refused — and stops being true the moment the list under it changes for any
   * other reason.
   *
   * Nothing cleared it at first except the next save that happened to succeed,
   * so a single refusal left the notice sitting above the list for the rest of
   * the session. Clearing it only when the editor opened was better and still
   * not enough: removing a trip and switching tabs both leave the notice
   * describing something the reader did several actions ago, as though it
   * described what is on screen now.
   */
  function clearSaveNotice() { state.storageError = null; }

  function selectView(id) {
    if (id !== state.view) clearSaveNotice();
    state.view = id;
    state.pickerOpen = false;
    store('view', id);
    if (id === 'all' && !state.all) loadAll();
    if (id === 'trip') { loadDepartures(state.routeId); }
    if (id === 'saved') {
      /* A saved trip cannot be resolved without its route's schedule. Fetch every
       * route a saved trip names, not just the one on screen. */
      global.CMB.watch.list().forEach(function (w) {
        loadDepartures(w.route_id);
        loadRouteData(w.route_id);
      });
    }
    render();
  }

  function paintHeader() {
    var d = state.status === 'first-run' ? null : state.data;
    var routeName = d && d.route
      ? (d.route.short_name || d.route.id) + ' · ' + (d.route.long_name || '').replace(/^\d+-/, '')
      : 'Route ' + (state.routeId || '—');
    S.clear(dom.routechip);
    dom.routechip.appendChild(el('span', 'routechip__id',
      d && d.route ? d.route.short_name : (state.status === 'first-run' ? '—' : (state.routeId || '—'))));
    dom.routechip.appendChild(el('span', 'routechip__name',
      d && d.route ? (d.route.long_name || '').replace(/^\d+-/, '') : 'choose a route'));
    dom.routechip.appendChild(el('span', 'routechip__caret', '▾'));
    dom.routechip.setAttribute('aria-label', 'Route ' + routeName + '. Change route.');
    dom.routechip.setAttribute('aria-expanded', state.pickerOpen ? 'true' : 'false');

    dom.viewbuttons.forEach(function (b) {
      var on = b.dataset.view === (state.view === 'saved-edit' ? 'saved' : state.view);
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    });

    /*
     * The route chip means something on any route-scoped view — the board and
     * the trip view both answer questions about one route. The direction toggle
     * belongs to the board alone: the trip view is already scoped to one bus,
     * and a filter that changes nothing on screen reads as the app being broken.
     */
    var routeScoped = state.view === 'board' || state.view === 'trip';
    dom.routechip.hidden = !routeScoped;
    dom.dirgroup.hidden = state.view !== 'board';
    if (!routeScoped) { dom.picker.hidden = true; }

    dom.dirbuttons.forEach(function (b) {
      var raw = b.dataset.dir;
      var val = raw === 'both' ? 'both' : parseInt(raw, 10);
      var label = val === 'both' ? 'BOTH' : directionLabel(val);
      b.textContent = label;
      var on = String(state.direction) === raw;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('is-on', on);
      if (val !== 'both' && d && d.route) {
        var hs = (d.route.directions || []).filter(function (x) { return x.id === val; })[0];
        b.setAttribute('aria-label', hs ? hs.headsign : 'Direction ' + val);
      } else if (val === 'both') {
        b.setAttribute('aria-label', 'Both directions');
      }
    });

    S.clear(dom.stamp);
    if (d && state.status === 'ok') {
      dom.stamp.appendChild(el('span', 'stamp__time', 'feed ' + fmt.clockWithSeconds(d.generated_at)));
      var lvl = d.staleness ? d.staleness.level : 'fresh';
      if (lvl !== 'fresh') {
        var chip = el('span', 'stamp__chip stamp__chip--' + lvl, fmt.age(d.staleness.oldest_feed_age_s));
        dom.stamp.appendChild(chip);
      }
    } else if (state.status === 'error') {
      dom.stamp.appendChild(el('span', 'stamp__chip stamp__chip--dead', 'offline'));
    } else if (state.status === 'first-run') {
      dom.stamp.appendChild(el('span', 'stamp__time', 'nothing loaded yet'));
    } else {
      dom.stamp.appendChild(el('span', 'stamp__time', 'loading…'));
    }

    dom.picker.hidden = !state.pickerOpen;
    if (state.pickerOpen) paintPicker();
  }

  /* Route number first, then the name, both case-insensitive. Someone reaching
   * for the 337 types "337"; someone who only knows where it goes types "lamar". */
  function matchesFilter(r, q) {
    if (!q) return true;
    var hay = ((r.short_name || r.id) + ' ' + (r.long_name || '')).toLowerCase();
    return hay.indexOf(q.toLowerCase()) !== -1;
  }

  function routeButton(r) {
    var b = el('button', 'routegrid__item');
    b.type = 'button';
    if (r.id === state.routeId) b.classList.add('is-on');
    b.appendChild(el('span', 'routegrid__id', r.short_name || r.id));
    var nm = cleanName(r.long_name) || routeName(r.id);
    if (nm) b.appendChild(el('span', 'routegrid__name', nm));
    /*
     * has_service_today is null on the fallback catalog, which means "unknown",
     * not "no". Only say a route is not running when something authoritative
     * said so, or a working route reads as dead on a board opened from disk.
     */
    if (r.has_service_today === false) {
      b.appendChild(el('span', 'routegrid__note', 'no service today'));
      b.classList.add('is-off');
    } else if (r.vehicles) {
      b.appendChild(el('span', 'routegrid__note',
        r.vehicles.in_service ? fmt.plural(r.vehicles.in_service, 'bus', 'buses') + ' out'
          : 'none out right now'));
    }
    b.addEventListener('click', function () {
      state.pickerOpen = false;
      state.pickerFilter = '';
      selectRoute(r.id);
    });
    return b;
  }

  function paintPicker() {
    S.clear(dom.picker);
    var all = catalog();

    var search = el('input', 'picker__search');
    search.type = 'search';
    search.placeholder = 'Route number or name';
    search.setAttribute('aria-label', 'Filter routes');
    search.value = state.pickerFilter;
    search.addEventListener('input', function () {
      state.pickerFilter = search.value;
      paintPicker();
      /* Repainting in place would drop focus mid-keystroke. */
      var again = dom.picker.querySelector('.picker__search');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });
    dom.picker.appendChild(search);

    var q = state.pickerFilter;
    var shown = all.filter(function (r) { return matchesFilter(r, q); });

    if (!q) {
      var favs = shown.filter(function (r) { return FAVOURITES.indexOf(r.id) !== -1; });
      if (favs.length) {
        dom.picker.appendChild(el('p', 'picker__head', 'Routes we ride'));
        var favGrid = el('div', 'routegrid');
        favs.forEach(function (r) { favGrid.appendChild(routeButton(r)); });
        dom.picker.appendChild(favGrid);
      }
      shown = shown.filter(function (r) { return FAVOURITES.indexOf(r.id) === -1; });
    }

    dom.picker.appendChild(el('p', 'picker__head',
      q ? fmt.plural(shown.length, 'match', 'matches') : 'Every route'));

    if (!shown.length) {
      dom.picker.appendChild(S.notice('empty', 'No route matches “' + q + '”.',
        'Try the number, or a street the route runs on.'));
      return;
    }
    var grid = el('div', 'routegrid');
    shown.forEach(function (r) { grid.appendChild(routeButton(r)); });
    dom.picker.appendChild(grid);

    if (!state.routes) {
      dom.picker.appendChild(el('p', 'hint',
        'Showing the routes this board was built around. The full list loads with ' +
        'the route catalog, which needs the board to be served rather than opened ' +
        'from a file.'));
    }
  }

  /* ---- the address bar ------------------------------------------------ */

  /*
   * The direction token for what is on screen — "eb", "both", or the bare
   * direction_id when this route's headsigns carry no compass letter.
   *
   * It has to come from the live document rather than from a table, because the
   * letters are a property of the route: direction 0 is EB on the 4 and NB on
   * the 7. fmt.directionTagFor is the one place that mapping lives.
   */
  function directionToken() {
    if (state.view !== 'board') return null;
    /*
     * A token still waiting on its route document is the direction the reader
     * ASKED for, and it outranks whatever is on screen meanwhile. Without this,
     * the first render writes the fallback direction into the address bar and
     * erases the request -- /route/7/nb settles at /route/7/both, and reloading
     * that turns the erasure into an explicit choice the feed recovering cannot
     * undo. Only visible when the document is slow or never comes, which is
     * exactly when a shared link matters most.
     */
    if (global.CMB.urls.isDirectionToken(state.pendingDir)) {
      return String(state.pendingDir).toLowerCase();
    }
    if (state.direction === 'both') return 'both';
    var tag = state.data ? fmt.directionTagFor(state.data, state.direction) : null;
    if (tag && /^(EB|WB|NB|SB)$/.test(tag)) return tag.toLowerCase();
    return String(state.direction);
  }

  /*
   * Turn a URL's direction token into a direction_id, once the route document
   * makes that possible. Called again after each load because boot cannot do it
   * -- at boot there is no document and therefore no headsigns.
   */
  function resolveDirection() {
    var token = state.pendingDir;
    if (!token) return;
    if (token === 'both') { state.direction = 'both'; state.pendingDir = null; return; }
    if (token === '0' || token === '1') {
      state.direction = parseInt(token, 10);
      state.pendingDir = null;
      return;
    }
    if (!state.data) return;              /* try again when the document lands */
    var dirs = fmt.directionsForRows(state.data);
    for (var i = 0; i < dirs.length; i++) {
      if (String(fmt.directionTagFor(state.data, dirs[i].id)).toLowerCase() === token) {
        state.direction = dirs[i].id;
        break;
      }
    }
    /* Cleared either way: a route that does not run the direction someone asked
       for keeps the saved one rather than retrying on every refresh. */
    state.pendingDir = null;
  }

  /*
   * /trip/1234 names a bus and not its route, which is what makes it a URL you
   * can read to somebody over the phone. The fleet document is the only thing
   * that maps one to the other, so this is the single entry path that fetches
   * it up front -- /trip/7/1234 says the route and skips all of this.
   */
  function resolveBusRoute(busId) {
    loadAll(function (all) {
      /*
       * The fleet document can take seconds, and the reader does not wait. If
       * they picked a bus, changed route, or left the view while it was in
       * flight, this answer is about a question they have stopped asking --
       * applying it wipes what they just did. state.pendingBus is what says the
       * question still stands; selectRoute and the bus picker both clear it.
       *
       * This became reachable when the failure path started calling back: a
       * fleet request that fails five seconds in would otherwise clear the bus
       * the reader chose in the meantime and drop the board to its empty state.
       */
      if (state.pendingBus !== String(busId)) return;
      var vehicles = (all && all.vehicles) || [];
      for (var i = 0; i < vehicles.length; i++) {
        if (String(vehicles[i].vehicle_id) === String(busId) && vehicles[i].route_id) {
          state.pendingBus = null;
          /* selectRoute deliberately clears the followed bus -- a bus does not
             survive a route change -- so the id is set AFTER it, not before. */
          selectRoute(String(vehicles[i].route_id));
          state.tripBusId = String(busId);
          state.view = 'trip';
          /* Deliberately not store()d. Following a link must not rewrite the
             view this browser opens to; boot says the same about the bus. */
          return;
        }
      }
      /*
       * Either the fleet document did not load, or the bus is not in it -- out
       * of service, or an id that never existed. Both end the same way: clear
       * the pending id and let the trip view's own empty state say so, because
       * inventing a route would be worse than admitting the bus is not there.
       */
      state.pendingBus = null;
      state.tripBusId = null;
    });
  }

  /*
   * Write what is on screen back to the address bar, so the link is shareable.
   *
   * replaceState, never pushState: Back leaves the site exactly as it did
   * before this existed. Walking a tab history would be a different feature and
   * a new failure mode.
   *
   * Silent from disk. file:// has no meaningful path, and the History API
   * refuses on an opaque origin -- the query form is the only shareable form
   * there, and it is already in the address bar.
   */
  /*
   * The part of the incoming query worth carrying forward.
   *
   * view, route, dir and bus are now said by the path, and parse() lets a query
   * override a path field by field -- so retaining them writes a URL that
   * contradicts itself. Open a legacy /?view=trip&route=4&bus=2641, tap "All
   * buses", and the bar would read /buses?view=trip&route=4&bus=2641: share that
   * and the recipient lands on the trip view, not the buses list you were
   * looking at. The address bar has to describe the screen, most of all for the
   * people still holding old links.
   *
   * Everything else is kept verbatim. ?state= in particular is how any
   * interaction state is reached, and it has no path spelling.
   */
  var PATH_OWNED = { view: 1, route: 1, dir: 1, bus: 1 };

  function keptSearch() {
    var raw = String(global.location.search || '').replace(/^\?/, '');
    if (!raw) return '';
    var kept = [];
    raw.split('&').forEach(function (kv) {
      if (!kv) return;
      var key = decodeURIComponent(kv.split('=')[0]);
      if (!Object.prototype.hasOwnProperty.call(PATH_OWNED, key)) kept.push(kv);
    });
    return kept.length ? '?' + kept.join('&') : '';
  }

  function syncUrl() {
    if (global.location.protocol === 'file:') return;
    if (!global.history || !global.history.replaceState) return;
    var path = global.CMB.urls.format(
      state.view, state.routeId, directionToken(), state.tripBusId);
    try {
      global.history.replaceState(null, '', API_PREFIX + path + keptSearch());
    } catch (e) { /* opaque origin, or a browser that refuses; the view is fine */ }
  }

  function selectRoute(id) {
    state.routeId = id;
    state.data = null;
    state.errorDetail = null;
    /* A followed bus cannot survive a route change: it belongs to the route
     * being left. Leaving these set would let the trip view resurrect the
     * previous route's vehicle under the new route's (missing) data. */
    state.tripBusId = null;
    state.tripLastSeen = null;
    /* Whatever bare /trip/{bus} was being resolved is about the route being
       left, so its answer must not land here. */
    state.pendingBus = null;
    /* Each route remembers its own stop, so switching back is one tap and not
     * a fresh hunt through sixty-six of them. */
    state.stopId = recall('stop.' + id);
    state.stopPicking = false;
    store('route', id);
    load(id);
    loadDepartures(id);
  }

  /*
   * One minute's worth of refreshing, as a named function rather than a closure
   * inside setInterval, so a test can run exactly what the timer runs.
   *
   * It used to be anonymous, which meant the only way to cover it was to
   * re-implement its body in the test — and a test that re-implements the code it
   * covers proves the test, not the code.
   */
  function refreshTick() {
    if (state.status !== 'loading') load(state.routeId);
    if (state.view === 'all') loadAll();
    /*
     * One retry per minute for a schedule that failed to load or that describes
     * an earlier service day, and only here, where a retry cannot become a render
     * loop.
     *
     * Every route the board can currently answer for, not just the open one: a
     * saved trip on another route holds its own departures document, and that is
     * the one being read at breakfast after the phone sat on the counter all
     * night. Clearing its status without asking again would leave it evicted but
     * not replaced until something happened to repaint that route.
     */
    Object.keys(state.depStatus).forEach(function (rid) {
      var st = state.depStatus[rid];
      /*
       * Any status but 'loading' means that request finished, so its strikes go
       * with it. Clearing them only on the error/stale branch left a strike
       * stranded on a route whose fetch had SUCCEEDED after straddling a tick --
       * and the next request on that route then met the give-up rule one sweep
       * early, on precisely the connection that had already shown it was slow.
       */
      if (st !== 'loading') delete state.depStuck[rid];
      if (st === 'error' || st === 'stale') { delete state.depStatus[rid]; return; }
      /*
       * 'loading' was the one status nothing ever cleared, and withholding an
       * expired document is what turned that into a dead surface.
       *
       * getJson is a plain fetch with no timeout, so a request outstanding when
       * a device suspends may never settle: neither handler runs, the status
       * stays 'loading', and loadDepartures returns early on it forever. Before
       * this change that left the board reading the schedule it still held --
       * wrong after a roll, but present. Now usableDepartures withholds that
       * document, so Next buses and every saved trip show an empty state for the
       * life of the tab, and the network coming back does not help.
       *
       * Given up on after surviving two sweeps rather than one, so an ordinary
       * fetch that happens to straddle a tick is not abandoned and refetched
       * every minute. Bumping the generation is what makes giving up safe: if
       * the first request does eventually land, its answer is dropped rather
       * than written over whatever arrived meanwhile.
       */
      if (st === 'loading') {
        state.depStuck[rid] = (state.depStuck[rid] || 0) + 1;
        if (state.depStuck[rid] >= 2) {
          state.depGen[rid] = (state.depGen[rid] || 0) + 1;
          /* Let go of the socket too, not just of the answer. */
          if (state.depAbort[rid]) { try { state.depAbort[rid].abort(); } catch (e) { /* already gone */ } }
          delete state.depAbort[rid];
          delete state.depStatus[rid];
          delete state.depStuck[rid];
        }
      }
    });
    var routes = global.CMB.watch.list().map(function (w) { return w.route_id; });
    if (state.routeId) routes.push(state.routeId);
    if (state.editor.route_id) routes.push(state.editor.route_id);
    routes.filter(function (id, i) { return id && routes.indexOf(id) === i; })
      .forEach(loadDepartures);
    /*
     * One retry a minute for a route document that failed, whichever view was
     * asking for it.
     *
     * loadRouteData declines every status but 'idle', which is what stopped it
     * spinning a fetch per repaint -- but the only thing writing 'idle' back was
     * the saved-view block below, so on the every-bus view a single dropped
     * request was permanent. The bus detail reads "Just left · loading the
     * route…" from then on, which is not merely missing: nothing is loading, and
     * nothing ever will be. Before the guard a transient failure healed itself
     * on the next repaint, so this is the half of that trade that has to be
     * given back -- once a minute, from the timer, where a retry cannot become a
     * render loop.
     */
    Object.keys(state.routeStatus).forEach(function (rid) {
      if (state.routeStatus[rid] !== 'error') return;
      delete state.routeStatus[rid];
      /*
       * Clearing the status is not the retry, it only permits one. Nothing on
       * the every-bus view calls loadRouteData during a repaint -- it is wired
       * to opening a bus detail and nothing else -- so a cleared status alone
       * left the panel exactly as stuck as before, until the reader happened to
       * collapse and reopen the row. Ask here, the way the saved block does.
       */
      loadRouteData(rid);
    });
    if (state.view === 'saved') {
      /* A frozen saved trip is worse than none: it reads as a live prediction.
       * Saved trips re-ask even on success, because what they show is a live
       * prediction rather than the route's shape. */
      global.CMB.watch.list().forEach(function (w) {
        /*
         * Not over a request that is still running. Writing 'idle' unconditionally
         * stomped a 'loading' the sweep above had just started, so an errored
         * watched route was fetched twice in one tick, and a merely SLOW one
         * picked up an extra concurrent request every minute for as long as the
         * server stayed slow. loadRouteData carries no generation stamp, so those
         * two answers can also land out of order.
         */
        if (state.routeStatus[w.route_id] === 'loading') return;
        state.routeStatus[w.route_id] = 'idle';
        loadRouteData(w.route_id);
      });
    }
  }

  /* ---- render --------------------------------------------------------- */
  var rafPending = false;
  /*
   * Ask the browser where we are. The prompt is only ever raised from here, in
   * response to a tap, and the fix is used and dropped — it is never sent
   * anywhere, and there is nowhere for it to be sent to: the board has no
   * endpoint that accepts one.
   */
  function locate() {
    var can = global.CMB.near.canAsk(global);
    if (can !== 'ok') {
      /* 'unsupported' (no API) and 'insecure' (not a secure context) are
         different facts and the panel says so differently. */
      state.geo = { status: can };
      render();
      return;
    }
    state.geo = { status: 'locating' };
    render();
    global.navigator.geolocation.getCurrentPosition(function (pos) {
      state.geo = {
        status: 'ok',
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        /*
         * When the OS ACQUIRED the fix, not when the callback ran. Browsers
         * routinely serve a cached reading that is already minutes old -- that
         * is what GEO_OPTS.maximumAge asks for -- so stamping delivery time
         * would start the staleness clock at zero on a fix that is already
         * stale. Falls back to now where a browser omits the timestamp.
         */
        at: pos.timestamp || Date.now()
      };
      render();
    }, function (err) {
      state.geo = { status: 'error', error: err };
      render();
    }, global.CMB.near.GEO_OPTS);
  }

  function render() {
    /* The address bar tracks what is on screen, so whatever a reader is looking
       at is the thing they copy out of it. */
    syncUrl();
    if (rafPending) return;
    rafPending = true;
    global.requestAnimationFrame(function () {
      rafPending = false;
      paint();
    });
  }

  function paint() {
    paintHeader();
    var d = state.data;

    /* whole-app refusals first */
    S.clear(dom.main);

    if (state.scenarioNote) dom.main.appendChild(state.scenarioNote);

    if (state.status === 'schema') {
      dom.main.appendChild(S.schemaTooNew(d ? d.schema : '?', SUPPORTED_SCHEMA));
      return;
    }
    if (state.status === 'first-run') {
      dom.main.appendChild(S.firstRun(catalog().filter(function (r) {
        return FAVOURITES.indexOf(r.id) !== -1;
      }).map(function (r) { return { id: r.id, name: cleanName(r.long_name) }; }), function (id) {
        state.status = 'loading';
        state.scenario = null;
        selectRoute(id);
      }));
      return;
    }

    if (d && state.status === 'ok') {
      var banner = S.stalenessBanner(d.staleness, d.feeds, function () { load(state.routeId); });
      if (banner) dom.main.appendChild(banner);
      if (state.usingFixture) {
        var fx = el('div', 'banner banner--info');
        fx.setAttribute('role', 'status');
        fx.appendChild(el('strong', 'banner__head', 'Sample data.'));
        fx.appendChild(el('span', 'banner__detail',
          'No live feed reachable — this is the committed ' + d.service_day.date +
          ' fixture, not what is happening now.'));
        dom.main.appendChild(fx);
      }
    }

    if (state.view === 'all') { paintAll(); return; }
    if (state.view === 'saved') { paintSaved(); return; }
    if (state.view === 'saved-edit') { paintSavedEdit(); return; }
    if (state.view === 'trip') { paintTrip(); return; }

    var opts = {
      direction: state.direction,
      status: state.status === 'ok' ? 'ok' : state.status === 'loading' ? 'loading' : 'error',
      lastGood: state.lastGoodAt,
      errorDetail: state.errorDetail,
      onRetry: function () { load(state.routeId); },
      onToggle: function () { render(); },
      geo: state.geo,
      window: global,
      onLocate: locate,
      onClear: function () { state.geo = null; render(); }
    };

    /*
     * The near-me answer renders in the banner slot above the rows, not as a
     * fourth panel: rows, ladder, map is settled, and this is a stated answer
     * in the same place the staleness banners appear. It is offered only once
     * there is a payload to answer from.
     */
    if (d && state.status === 'ok') {
      var nearHost = el('div', 'nearhost');
      global.CMB.near.render(nearHost, d, opts);
      dom.main.appendChild(nearHost);
      opts.highlightVehicleIds = global.CMB.near.highlightedVehicleIds(d, opts);
    }

    /* order is fixed: rows, then ladder, then map */
    var rowsBand = el('section', 'band band--rows');
    rowsBand.setAttribute('aria-label', 'Vehicles');
    global.CMB.rows.render(rowsBand, d || {}, opts);
    dom.main.appendChild(rowsBand);

    var ladderBand = el('section', 'band band--ladder');
    ladderBand.setAttribute('aria-label', 'Ladder');
    dom.main.appendChild(ladderBand);
    global.CMB.ladder.render(ladderBand, d || {}, opts);

    var mapBand = el('section', 'band band--map');
    mapBand.setAttribute('aria-label', 'Map');
    dom.main.appendChild(mapBand);
    global.CMB.map.render(mapBand, d || {}, opts);

    /*
     * Last, because it answers a narrower question than the rest of the board:
     * the other panels are "what is this route doing", this one is "I am at
     * this stop". Anyone who wants it will scroll to it once and then it
     * remembers their stop.
     *
     * The schedule is fetched by selectRoute and boot, NOT here. A render that
     * starts a fetch is a render that can trigger another render, and the loop
     * that produced destroyed the alerts disclosure mid-click.
     */
    var stopBand = el('section', 'band band--nextbus');
    stopBand.setAttribute('aria-label', 'Next buses at a stop');
    dom.main.appendChild(stopBand);
    global.CMB.stopboard.render(
      stopBand,
      usableDepartures(state.routeId),
      d,
      nowEpoch(),
      {
        stopId: state.stopId,
        picking: state.stopPicking,
        onPick: function (id) {
          state.stopId = id;
          state.stopPicking = false;
          store('stop.' + state.routeId, id);
          render();
        },
        onChange: function () { state.stopPicking = true; render(); }
      }
    );

    dom.main.appendChild(footer(d));
  }

  /* ---- the other two views --------------------------------------------- */

  function paintAll() {
    var band = el('section', 'band band--all');
    band.setAttribute('aria-label', 'Every bus');
    dom.main.appendChild(band);

    if (state.all && state.all.staleness) {
      var banner = S.stalenessBanner(state.all.staleness, state.all.feeds, loadAll);
      if (banner) dom.main.insertBefore(banner, band);
    }

    global.CMB.allbuses.render(band, state.all || {}, {
      status: state.allStatus === 'ok' ? 'ok'
        : state.allStatus === 'error' ? 'error' : 'loading',
      errorDetail: state.errorDetail,
      onRetry: loadAll,
      onSelectRoute: function (routeId) {
        selectView('board');
        selectRoute(routeId);
      },
      /*
       * api/all.json carries no stops, so the one thing a bus detail cannot
       * answer from it is "what stop did it just leave". The route file has
       * that and is already generated, so it is fetched when a reader opens a
       * bus rather than for all 392 up front.
       */
      onWantRoute: loadRouteData,
      routeFor: function (routeId) { return liveRoute(routeId); },
      open: state.openBuses,
      onToggleBus: function (vehicleId) {
        if (state.openBuses[vehicleId]) { delete state.openBuses[vehicleId]; }
        else {
          state.openBuses[vehicleId] = true;
          var v = ((state.all && state.all.vehicles) || []).filter(function (x) {
            return x.vehicle_id === vehicleId;
          })[0];
          if (v && v.route_id) loadRouteData(v.route_id);
        }
        render();
      }
    });
    dom.main.appendChild(footer(state.all));
  }

  /*
   * The trip view. It needs both documents: the live one for the bus and the
   * schedule for the stops. loadDepartures is idempotent and is called from
   * selectView, not from here — a render that starts a fetch is a render that
   * can trigger another render.
   */
  function paintTrip() {
    var band = el('section', 'band band--trip');
    dom.main.appendChild(band);

    /*
     * Refresh the last-seen record whenever the followed bus is actually in
     * this payload, before render decides whether it is gone. Without this,
     * the very poll that drops the bus would have nothing to fall back to.
     */
    var live = null;
    ((state.data && state.data.vehicles) || []).forEach(function (v) {
      if (String(v.vehicle_id) === String(state.tripBusId)) live = v;
    });
    if (live && state.data) {
      state.tripLastSeen = { vehicle: deepCopy(live), at: state.data.generated_at };
    }

    global.CMB.trip.render(band, {
      route: state.data,
      dep: usableDepartures(state.routeId),
      vehicleId: state.tripBusId,
      now: (state.data && state.data.generated_at) || null,
      lastSeen: state.tripLastSeen
    }, {
      /*
       * Whether the null above means "not fetched yet" or "held, and refused".
       * The two look identical from inside trip.js and read very differently to
       * someone waiting for a departure time.
       */
      depWithheld: !!state.departures[state.routeId] && !usableDepartures(state.routeId),
      /*
       * And the third: asked for, and it did not work out. Only a request that
       * is genuinely about to resolve gets the shimmer.
       *
       * Two shapes, because a failure is not always an 'error'. A request that
       * is refused gets one. A request against a server that accepts and never
       * answers gets abandoned instead, and the status cycles 'loading' ->
       * cleared -> 'loading' without ever passing through 'error' — so the
       * board looked like it was still waiting, forever, on the one screen made
       * entirely of scheduled times. A generation past its first, with nothing
       * ever received, means an earlier request for this route already failed or
       * was abandoned — either way not a first attempt still in progress.
       */
      depFailed: state.depStatus[state.routeId] === 'error' ||
        (!state.departures[state.routeId] && (state.depGen[state.routeId] || 0) > 1),
      picking: state.tripPicking,
      onPickRoute: function () { state.pickerOpen = !state.pickerOpen; render(); },
      onPickBus: function () {
        state.tripPicking = state.tripPicking === 'bus' ? null : 'bus';
        render();
      },
      onChooseBus: function (id) {
        state.tripBusId = id;
        state.tripPicking = null;
        state.tripLastSeen = null;   /* a new bus starts with no history */
        /* A deliberate choice outranks a bare /trip/{bus} still resolving. */
        state.pendingBus = null;
        render();
      }
    });
  }

  function paintSaved() {
    var band = el('section', 'band band--saved');
    band.setAttribute('aria-label', 'Saved trips');
    dom.main.appendChild(band);

    var now = nowEpoch();
    var models = global.CMB.watch.list().map(function (w) {
      /* Fetching here rather than only in selectView covers a watch saved while
       * the view is already open. loadDepartures is idempotent. */
      loadDepartures(w.route_id);
      loadRouteData(w.route_id);
      return global.CMB.watch.resolve(
        w,
        usableDepartures(w.route_id),
        liveRoute(w.route_id),
        now
      );
    });

    global.CMB.watch.render(band, global.CMB.watch.sortModels(models), {
      onAdd: function () {
        state.editor = { route_id: null, direction_id: null, stop_id: null };
        clearSaveNotice();
        state.view = 'saved-edit';
        render();
      },
      /*
       * A delete reports the same way a save does. Without this the Remove
       * button was simply dead on a store that refused the write: the card
       * stayed, because every render rebuilds the list from the store rather
       * than from what remove() hands back, and nothing said why.
       *
       * A removal that WORKED clears the notice for the same reason any other
       * change to the list does: it described one earlier write, and the list
       * under it has moved on.
       */
      onChange: function (res, w) {
        if (res && res.removed === false) {
          state.storageError = REMOVE_REFUSED;
          announce(REMOVE_REFUSED.detail);
        } else {
          /*
           * Said out loud, not only cleared.
           *
           * The live region is not repainted by render() — it lives outside
           * dom.main — so whatever was last announced stands until something
           * replaces it. A refusal followed by a delete that worked therefore
           * left a screen reader holding "the board would not let it be
           * deleted… it will be back the next time this page is opened" about a
           * trip that had just been deleted: the visible notice was cleared and
           * the spoken one was not, so the two channels disagreed and the
           * spoken one was the wrong one. onSave has always announced both
           * outcomes; this is the same courtesy.
           */
          announce(w ? 'Removed ' + global.CMB.watch.describe(w) : 'Removed.');
          clearSaveNotice();
        }
        render();
      }
    });

    /*
     * A refused write is reported where the reader is looking for the trip.
     *
     * After watch.render, not before: it opens with S.clear(host), so a notice
     * appended earlier is built and then thrown away — which is exactly what
     * happened the first time this was written, and the reason the e2e test
     * asserts the notice is on screen rather than that the code appends one.
     *
     * The announcement alone is not enough. It goes to a sr-only live region, so
     * on its own it leaves a sighted reader looking at a list that silently does
     * not contain what they just saved.
     */
    if (state.storageError) {
      band.appendChild(S.notice('error', state.storageError.head, state.storageError.detail));
    }
    dom.main.appendChild(footer(state.data));
  }

  function paintSavedEdit() {
    var band = el('section', 'band band--saved');
    band.setAttribute('aria-label', 'Save a trip');
    dom.main.appendChild(band);

    /* The editor asks again for a schedule usableDepartures() has withheld, or it
     * would sit on an empty step list until the timer came round — and before
     * that withholding existed it would have offered times from a service day
     * that had already ended, and let one be saved. */
    if (state.editor.route_id) loadDepartures(state.editor.route_id);
    global.CMB.watch.renderEditor(band, {
      routes: catalog(),
      route_id: state.editor.route_id,
      direction_id: state.editor.direction_id,
      stop_id: state.editor.stop_id,
      departures: state.editor.route_id ? usableDepartures(state.editor.route_id) : null
    }, {
      onPickRoute: function (id) {
        state.editor = { route_id: id, direction_id: null, stop_id: null };
        loadDepartures(id);
        render();
      },
      onPickDirection: function (id) {
        state.editor.direction_id = id;
        state.editor.stop_id = null;
        render();
      },
      onPickStop: function (id) {
        state.editor.stop_id = id;
        render();
      },
      onSave: function (w) {
        /*
         * add() reports whether the store actually took it. It used to return
         * the list either way, so a refused write announced "Saved" and the trip
         * was gone on the next load with nothing having said so.
         */
        var res = global.CMB.watch.add(w);
        state.storageError = res.saved ? null : SAVE_REFUSED;
        state.view = 'saved';
        announce(res.saved ? 'Saved ' + global.CMB.watch.describe(w) : SAVE_REFUSED.detail);
        render();
      }
    });

    var back = el('button', 'btn');
    back.type = 'button';
    back.textContent = 'Cancel';
    back.addEventListener('click', function () { state.view = 'saved'; render(); });
    band.appendChild(back);
  }

  /*
   * The board's clock. It follows the feed rather than the device, so a phone with
   * a wrong clock reads the same board as a right one, and the seconds-until on a
   * saved trip stays consistent with the lateness the feed reported.
   */
  function nowEpoch() {
    var d = state.data || state.all;
    if (!d) {
      var ids = Object.keys(state.routeData);
      if (ids.length) d = state.routeData[ids[0]];
    }
    if (d && typeof d.generated_at === 'number') return d.generated_at;
    return Math.floor(Date.now() / 1000);
  }

  function footer(d) {
    var foot = el('footer', 'foot');
    foot.appendChild(el('span', null,
      d && d.service_day
        ? 'Service day ' + d.service_day.date + (d.service_day.is_exception_day ? ' (exception day)' : '') +
          ' \u00b7 GTFS ' + (d.feeds ? d.feeds.gtfs_feed_version : '\u2014')
        : 'No service day loaded'));
    foot.appendChild(el('span', null, 'All times America/Chicago.'));
    return foot;
  }

  /* ---- boot ----------------------------------------------------------- */
  function boot() {
    var u = global.CMB.urls.parse(global.location.pathname, global.location.search);
    var q = u.query;
    dom.root = document.getElementById('app');
    dom.root.appendChild(buildHeader());
    dom.main = el('main', 'main');
    dom.main.id = 'board';
    dom.root.appendChild(dom.main);
    dom.live = el('p', 'sr-only');
    dom.live.setAttribute('role', 'status');
    dom.live.setAttribute('aria-live', 'polite');
    dom.root.appendChild(dom.live);

    /* hasOwnProperty, not truthiness: ?state=constructor would otherwise pass
       and Object.apply(d) would replace the payload with {}. */
    if (q.state && Object.prototype.hasOwnProperty.call(S.STATE_SCENARIOS, q.state)) {
      state.scenario = S.STATE_SCENARIOS[q.state];
      var note = el('p', 'scenario');
      note.textContent = 'STATE PREVIEW · ' + state.scenario.note;
      state.scenarioNote = note;
    }

    /*
     * The URL is read through one grammar rather than field by field, so a path
     * and a query say the same things and the query still wins where both do.
     * See client/urls.js for why the query form is permanent.
     */
    var dirParam = u.direction !== null ? u.direction : recall('direction');
    if (dirParam === '0' || dirParam === '1') state.direction = parseInt(dirParam, 10);
    else if (dirParam === 'both') state.direction = 'both';
    else if (dirParam) state.pendingDir = dirParam;   /* a letter; needs the route */

    var routeId = u.route_id || recall('route') || '4';
    state.routeId = routeId;
    state.stopId = q.stop || recall('stop.' + routeId);
    load(routeId);
    /*
     * Boot does not go through selectRoute, so it has to ask for the schedule
     * itself. Moving this out of paint() to stop a render loop left the first
     * page load with no schedule at all, and the Next buses band sat on
     * "Loading this route's schedule..." forever.
     */
    loadDepartures(routeId);
    loadCatalog();


    /*
     * The bus is a URL parameter but NOT a stored preference, and that asymmetry
     * with `view` and `route` is deliberate. A vehicle id means a different trip
     * an hour later, so recalling one would show the wrong bus with nothing on
     * screen saying it had changed.
     */
    if (u.bus_id) {
      state.tripBusId = String(u.bus_id);
      /* A bare /trip/1234 names no route, so the fleet document has to say
         which one it is before anything can be drawn. */
      if (!u.route_id) {
        state.pendingBus = String(u.bus_id);
        resolveBusRoute(u.bus_id);
      }
    }

    /*
     * The view is selected AFTER the bus is resolved, not before. selectView
     * calls loadAll for the all-buses view, and loadAll returns early while a
     * request is in flight -- without attaching the callback -- so ?view=all
     * plus a bare bus id used to discard the resolver and leave the link
     * unresolved for the session.
     */
    var view = u.view || recall('view');
    if (view === 'all' || view === 'trip' || view === 'saved') selectView(view);

    /* Live refresh only makes sense when something can actually change. */
    if (global.location.protocol !== 'file:' && !state.scenario) {
      setInterval(refreshTick, REFRESH_MS);
    }

    var resizeTimer = null;
    global.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 150);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (state.pickerOpen) { state.pickerOpen = false; render(); return; }
      if (state.view === 'saved-edit') { state.view = 'saved'; render(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.CMB.app = {
    state: state,
    load: load,
    selectView: selectView,
    matchesFilter: matchesFilter,
    /*
     * Both take their inputs explicitly so the suite can assert the rule without
     * a running board: currentServiceDate(s) reads the state it is handed, and
     * scheduleExpired(doc, today) is a pure comparison. The board calls them with
     * no arguments and gets the live state.
     */
    currentServiceDate: currentServiceDate,
    scheduleExpired: scheduleExpired,
    usableDepartures: usableDepartures,
    refreshTick: refreshTick,
    /* Exported for the suite alone: the generation guard is only observable by
     * letting an abandoned request answer, which needs a fetch under test
     * control. Nothing in the client calls it through here. */
    loadDepartures: loadDepartures,
    FAVOURITES: FAVOURITES,
    SUPPORTED_SCHEMA: SUPPORTED_SCHEMA
  };
})(window);
