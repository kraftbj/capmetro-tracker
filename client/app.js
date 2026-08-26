/*
 * app.js — bootstrap, data loading, header, view switching, and the panel order
 * that was decided and is not open: header, VEHICLE ROWS, LADDER, MAP.
 *
 * Four views share one shell:
 *   board  — one route, the original and the default
 *   stops  — the places this phone waits at, from a link or from storage
 *   all    — every bus in the system, deadheads included
 *   saved  — trips and transfer chains this browser has saved, resolved locally
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
   * And the stops view has its own again, because it saves a different thing.
   * "Nothing was saved" is right for a trip; a stops link is a set of places,
   * and the link itself still works whatever the store did — which is the one
   * piece of good news worth giving somebody whose browser refuses to remember.
   */
  var STORAGE_REFUSED = 'This browser would not let the board save anything — ' +
    'private browsing or storage turned off. Nothing was kept. The link still works.';

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
    view: 'board',       /* board | stops | all | trip | saved | saved-edit | chain-edit */
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
     * Eight maps keyed by a route id, and `?route=` or a stops link can put ANY
     * string in that key.
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
    /*
     * route id -> the device clock when that payload arrived. Not the payload's
     * own generated_at: this measures how long THIS browser has been holding the
     * document, which is the one thing the document itself cannot say. See
     * agedStaleness().
     */
    routeFetchedAt: Object.create(null),
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
    storageError: null,  /* {head, detail} when localStorage refused the last write */
    /*
     * The stops view. `entries` is what is on screen, whatever its source;
     * `saved` says whether those entries are the ones in localStorage, which is
     * what decides between offering to keep them and offering to forget them.
     * `offer` is the set a link is proposing and is null once it is answered
     * either way, so the banner does not come back on every repaint.
     *
     * `declined` is the set of stops the reader has already said no to, not a
     * boolean about this page load — see adoptPlan().
     */
    plan: { entries: null, saved: false, offer: null, fromQuery: false, fromLink: false,
      declined: null, storageFailed: false },
    /*
     * The chain editor builds forwards: `legs` are the ones already fixed, `start`
     * is the part-made first leg and `onward` the part-made next one. It is a
     * separate bag from `editor` because a chain and a saved trip are saved to
     * different stores and abandoning one must not half-fill the other.
     */
    chainEditor: { legs: [], day_type: null, start: {}, onward: {} }
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
  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function isDocument(d) {
    return !!d && typeof d === 'object' && !isArray(d);
  }

  /*
   * One fetch. Every endpoint is a static JSON file on the same origin, so there
   * is nothing to configure and nothing to authenticate. A file:// board has no
   * origin to fetch from and rejects immediately rather than waiting for a
   * network error, because from disk the fixture IS the answer, not a fallback
   * after a timeout.
   */
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
    renderLive();
    getJson(API_ALL)
      .then(function (d) {
        /*
         * See isDocument. Here the board does not merely fail — it renders
         * "CapMetro is reporting no buses at all … a CapMetro problem rather
         * than a problem with this board", which is a confident false statement
         * about service that names somebody else as the cause. The real
         * can't-reach-the-feed state, with its Retry, never appeared.
         */
        /*
         * And it has to carry vehicles. isDocument is a transport check — "did
         * something JSON-shaped come back" — and `{}` passes it while satisfying
         * no schema at all. On the other two documents that is harmless; here it
         * reproduces the accusation above word for word, because the empty-fleet
         * copy keys off the vehicle list being empty rather than absent.
         */
        if (!isDocument(d) || !isArray(d.vehicles)) throw new Error('not a fleet document');
        state.all = d;
        state.allStatus = 'ok';
        if (then) then(d);
        renderLive();
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
        renderLive();
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
     * This guard is load-bearing rather than an optimization: the function is
     * called from paint(), and both its handlers call render(), so any status
     * that falls through starts a fetch, which repaints, which asks again. It
     * has been that bug twice, from opposite directions. Enumerating the
     * statuses that STOP left 'error' matching none of them, so a route that
     * could not be fetched looped hardest of all — 178 requests in three
     * seconds. Later, short-circuiting on 'loading' alone left a route that had
     * finished at 'ok', which passed and fetched again: 364 requests in six
     * seconds from a board sitting on the saved tab doing nothing.
     *
     * Both ways in are real. On a `file://` board — a stated project requirement
     * — fetch rejects immediately, so it is a tight spin rather than a network
     * round trip. And a GTFS republish, about three times a year, can renumber
     * or drop a route a saved chain still names, making its payload a permanent
     * 404.
     *
     * The refresh tick sets 'idle' back before asking again, which is what makes
     * a re-fetch happen once a minute instead of never, and is how a transient
     * failure recovers. That handshake is the whole refresh mechanism: change
     * either half without the other and you get frozen data or the loop back.
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
        state.routeFetchedAt[routeId] = heldClock();
        renderLive();
      })
      .catch(function () {
        state.routeStatus[routeId] = 'error';
        renderLive();
      });
  }

  /*
   * The live payload for a route, wherever it happens to be cached — and only
   * when it IS live.
   *
   * The bundled fixture is a frozen capture that declares its own staleness as
   * `fresh` with adherence usable, because it was fresh on the day it was taken.
   * So a board that has fallen back to it was handing months-old lateness to the
   * graders as a current measurement: a saved trip printed "Bus 2216 · on time
   * to the second" directly under the banner saying no live feed was reachable.
   * GTFS trip ids are stable within a feed version, so the join succeeds and the
   * contradiction never surfaces by itself.
   *
   * currentServiceDate() has always excluded the fixture on the same argument —
   * a frozen capture must not define what today is — and this is the other half
   * of it. Withholding costs nothing anybody wanted: with no live feed there is
   * no lateness to grade with, and saying so is a state both cards already have
   * words for.
   */
  function liveRoute(routeId) {
    if (routeId === state.routeId) return state.usingFixture ? null : state.data;
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
  /*
   * The same rule as usableDepartures, for the readers that take the whole map
   * rather than one route.
   *
   * chain.js resolves a journey across two or three routes at once, so it is
   * handed the map instead of a document — and passing the raw map handed it
   * schedules the board had already decided it must not answer from. That is the
   * bug the accessor exists to prevent, arriving through the one reader whose
   * shape did not fit the accessor. The trip view had it too, for the same
   * reason: a surface built after the rule, taking a route the rule did not
   * cover.
   */
  function usableDeparturesMap() {
    var out = Object.create(null);
    Object.keys(state.departures).forEach(function (id) {
      var doc = usableDepartures(id);
      if (doc) out[id] = doc;
    });
    return out;
  }

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
   * trip, a stop card or the editor actually needs it. But a phone left on the
   * counter
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
         * next paint.
         *
         * Below the generation check for tidiness rather than for safety — the
         * .catch opens with the same check, so an abandoned request is turned
         * away there wherever this throw happens.
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

  /* ---- the stops plan -------------------------------------------------- */

  /*
   * Preload, which is half of what a stops link is for.
   *
   * Every route the plan names needs two documents before a card can say
   * anything: the service day's schedule and the live vehicles. Fetching them
   * when the link opens rather than when the tab is tapped is the difference
   * between a board that is already answering and one that spends two seconds
   * saying "loading" at somebody already late for a bus. Both loaders are
   * idempotent, so calling this on boot, on tab change and on every refresh is
   * free.
   */
  function loadPlanRoutes() {
    var entries = state.plan.entries;
    if (!entries || !entries.length) return;
    global.CMB.plan.routesIn(entries).forEach(function (id) {
      loadDepartures(id);
      loadRouteData(id);
    });
  }

  /*
   * What the location bar is proposing, if anything.
   *
   * A '?plan=' query is accepted and then moved into the fragment, because the
   * fragment is the half of a URL browsers never send to the server. That does
   * not un-send the request that just arrived — the entries are in the access log
   * already and the banner says so — but it stops the leak repeating on every
   * reload and on every re-share of whatever is in the address bar.
   */
  function planFromLocation() {
    var found = global.CMB.plan.fromLocation(global.location);
    if (!found) return null;
    if (found.fromQuery) rewriteQueryToFragment(found.raw);
    return found;
  }

  /*
   * Put the fragment back in step with what is on screen, after an edit.
   *
   * Only when the plan came FROM a link. Removing a stop used to leave the old
   * fragment in the address bar, so a reload restored the stop that had just
   * been removed and re-offered a set the reader had already edited. Kept stops
   * live in localStorage and need no fragment at all.
   */
  function syncFragment() {
    if (!state.plan.fromLink) return;
    if (!global.history || typeof global.history.replaceState !== 'function') return;
    var entries = state.plan.entries || [];
    try {
      global.history.replaceState(null, '', entries.length
        ? global.CMB.plan.linkFor(entries, global.location.href)
        : global.location.pathname + global.location.search);
      if (!entries.length) state.plan.fromLink = false;
    } catch (e) {
      /* Some browsers refuse replaceState on a file:// URL. The screen is still
       * right; only the address bar is behind. */
    }
  }

  function rewriteQueryToFragment(raw) {
    if (!global.history || typeof global.history.replaceState !== 'function') return;
    var search = (global.location.search || '').replace(/^\?/, '')
      .split('&')
      .filter(function (kv) { return kv && kv.split('=')[0] !== 'plan'; })
      .join('&');
    try {
      global.history.replaceState(null, '',
        global.location.pathname + (search ? '?' + search : '') + '#plan=' + raw);
    } catch (e) {
      /* Some browsers refuse replaceState on a file:// URL. The plan still
       * renders; only the tidy-up is lost. */
    }
  }

  /*
   * Decide what the stops view is looking at, from the link and from storage.
   *
   * A link always wins the screen — someone who just opened one is asking to see
   * it — but it only wins the STORE when they say so. A link that matches what is
   * already kept is not an offer at all, which is the ordinary case of opening a
   * bookmark twice.
   */
  function adoptPlan() {
    var saved = global.CMB.plan.stored();
    var link = planFromLocation();

    state.plan.fromLink = !!link;

    if (link) {
      state.plan.entries = link.entries;
      state.plan.fromQuery = link.fromQuery;
      state.plan.saved = !!(saved && global.CMB.plan.sameSet(saved, link.entries));
      /*
       * `offer` is the unanswered question, and `fromLink` is where the load came
       * from. They were one flag, and that made the second visit to a bookmarked
       * link land on the route board: once "Keep on this phone" had been tapped
       * there was no offer to make, so nothing switched the view and the link
       * looked like it had done nothing.
       */
      /*
       * A decline is about a SET OF STOPS, not about a page load, so it is
       * remembered as one. adoptPlan() rebuilds `offer` from scratch, and
       * anything that sends the reader through it again — going to another
       * fragment and pressing Back is the ordinary way — put the offer they had
       * just dismissed back on screen. Asking twice is how a board teaches
       * somebody to stop reading it.
       */
      state.plan.offer = state.plan.saved ||
        (state.plan.declined && global.CMB.plan.sameSet(state.plan.declined, link.entries))
        ? null : link.entries;
    } else if (saved) {
      state.plan.entries = saved;
      state.plan.saved = true;
      state.plan.offer = null;
      state.plan.fromQuery = false;
    } else {
      state.plan.entries = null;
      state.plan.saved = false;
      state.plan.offer = null;
      state.plan.fromQuery = false;
    }
    loadPlanRoutes();
  }

  /*
   * What storage holds that is not already on screen.
   *
   * Everything the offer and onKeep need to know about the stops this phone
   * already keeps, in one place, because reading localStorage twice in a click
   * handler and once in a paint is how the two get out of step.
   */
  function keptOther() {
    var kept = global.CMB.plan.stored() || [];
    if (!state.plan.entries || !state.plan.entries.length) return kept;
    var here = Object.create(null);
    state.plan.entries.forEach(function (e) { here[global.CMB.plan.keyFor(e)] = true; });
    return kept.filter(function (e) { return !here[global.CMB.plan.keyFor(e)]; });
  }

  /*
   * Let a schedule that failed to fetch be asked for once more.
   *
   * The document itself changes about three times a year, so this is not a poll:
   * it is the only way back from a fetch that failed while the phone was in a
   * tunnel, on a view that would otherwise stay blank until the tab is closed.
   */
  function retryDepartures(routeId) {
    var status = state.depStatus[routeId];
    if (status === 'error' || status === 'stale') {
      state.depStatus[routeId] = 'idle';
      return;
    }
    /*
     * The service day rolled over under a document that fetched cleanly. Only the
     * timer may clear an 'ok' status, because paint() calls loadDepartures and a
     * status that paint could clear is a fetch-and-render loop.
     *
     * And never while a fetch is in flight, which is the same rule refreshRoute()
     * applies to the route payload and for the same reason. A slow connection
     * holding a request open past sixty seconds is exactly when this fires, and
     * clearing the status there fired a second request alongside the first, then
     * a third — with nothing tracking any of them, so the older response could
     * land last and install the document the newer one had already replaced.
     */
    if (state.depStatus[routeId] === 'loading') return;
    if (scheduleExpired(state.departures[routeId])) state.depStatus[routeId] = 'idle';
  }

  /*
   * One route's live payload and schedule, refreshed on the timer.
   *
   * The status is only forced back to idle when a fetch is NOT in flight.
   * Clearing it unconditionally meant a request still outstanding after 60
   * seconds — a phone on a bad connection, which is exactly when this matters —
   * got a second one fired alongside it, and then a third, each one still
   * counted as "loading" by nothing at all.
   */
  function refreshRoute(routeId) {
    if (state.routeStatus[routeId] !== 'loading') state.routeStatus[routeId] = 'idle';
    retryDepartures(routeId);
    loadDepartures(routeId);
    loadRouteData(routeId);
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
    renderLive();

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
          /* render(), not renderLive(): a schema the app does not understand is a
             whole-app refusal, and deferring it would leave somebody working in an
             editor the app has just decided it must stop drawing. */
          render();
          return;
        }
        state.data = d;
        state.lastGoodAt = d.generated_at;
        state.status = 'ok';
        state.routeFetchedAt[routeId] = heldClock();
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
        renderLive();
      })
      .catch(function (err) {
        state.status = state.data ? 'ok' : 'error';
        state.errorDetail = 'No data file for route ' + routeId + ' yet (' + err.message + ').';
        if (state.status === 'ok') announce('Refresh failed; showing the last data received.');
        renderLive();
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
      { id: 'stops', label: 'Stops' },
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

  /*
   * The routes an open editor names or is part-way through naming: the legs
   * already fixed, the first leg being built, and the onward route being chosen.
   * Empty unless an editor is open.
   */
  function editorRouteIds() {
    if (!editing()) return [];
    var ids = [];
    var push = function (id) { if (id && ids.indexOf(id) === -1) ids.push(id); };
    var chainEd = state.chainEditor || {};
    (chainEd.legs || []).forEach(function (leg) { push(leg.route_id); });
    push((chainEd.start || {}).route_id);
    push((chainEd.onward || {}).route_id);
    push((state.editor || {}).route_id);
    return ids;
  }

  /*
   * Every route id the Saved view needs, from both stores, as a set. A saved trip
   * names one route; a chain names two or three, and none of them is necessarily
   * the route on screen.
   */
  function savedRouteIds() {
    var wanted = {};
    global.CMB.watch.list().forEach(function (w) { wanted[w.route_id] = true; });
    global.CMB.chain.list().forEach(function (c) {
      global.CMB.chain.routesIn(c).forEach(function (id) { wanted[id] = true; });
    });
    return wanted;
  }

  /*
   * Fetch both documents every saved thing needs — the schedule to find the trip,
   * the live payload to find the bus.
   *
   * Safe to call on every paint, but only because both loaders refuse to start a
   * second fetch for any status other than 'idle'. That is a property of THEM, not
   * of this function: each one's handlers call render(), so a loader that retried
   * after a failure would turn this call into a request loop. It has been exactly
   * that bug twice. Do not add a third loader here without checking its guard.
   *
   * A schedule from a service day that has ended used to be DELETED here, and
   * that is now handled a layer down and the other way round: the document is
   * kept and usableDepartures() refuses to answer from it, because deleting is
   * only safe if the refetch cannot fail, and it can. chain.js sees the same
   * null either way and still declines to grade a chain it cannot resolve.
   */
  function loadSavedRoutes() {
    Object.keys(savedRouteIds()).forEach(function (id) {
      loadDepartures(id);
      loadRouteData(id);
    });
  }

  /* No origin to fetch from, so api/* is not merely slow — it is absent. */
  function fromDisk() {
    return global.location.protocol === 'file:' || typeof fetch !== 'function';
  }

  function selectView(id) {
    if (id !== state.view) clearSaveNotice();
    state.view = id;
    state.pickerOpen = false;
    store('view', id);
    if (id === 'all' && !state.all) loadAll();
    if (id === 'stops') loadPlanRoutes();
    if (id === 'trip') { loadDepartures(state.routeId); }
    /* Every route either store names, not just the one on screen: a saved trip
     * names one, a chain names two or three. */
    if (id === 'saved') loadSavedRoutes();
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
      var on = b.dataset.view === (state.view === 'saved-edit' || state.view === 'chain-edit'
        ? 'saved' : state.view);
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
      /*
       * The fragment is carried, not dropped. The path says which VIEW is on
       * screen and the fragment says which STOPS a link is proposing, and they
       * are written by different functions on different occasions — so a sync
       * that rebuilt the URL from the path alone erased the plan on the next
       * repaint, and a reload came back to an empty board.
       *
       * They are separate on purpose rather than by accident: a path is sent to
       * the server and turns up in a Referer, and what the plan describes is
       * where a child stands and at what time. That is the one part of this URL
       * that must never leave the browser.
       */
      global.history.replaceState(null, '',
        API_PREFIX + path + keptSearch() + (global.location.hash || ''));
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
    /*
     * And the routes the stops view is showing. They are in neither store — a
     * plan a reader has not kept is held only in this tab — so nothing else
     * sweeps them, and a schedule that was current when it arrived and stopped
     * being so while the tab stayed open would never be asked for again. Only
     * the timer may do this: paint() calls loadDepartures, so anything a repaint
     * could clear is a fetch-and-render loop.
     */
    if (state.plan.entries && state.plan.entries.length) {
      global.CMB.plan.routesIn(state.plan.entries).forEach(function (id) {
        routes.push(id);
      });
    }
    /*
     * And their live payloads, not only their schedules.
     *
     * A stops card names the bus bringing your trip in — "Bus 2867 brings it in
     * on the 3:04p WB, due here in 4 minutes" — and a frozen payload leaves that
     * bus four minutes away for as long as the tab stays open. The schedules
     * above answer WHEN; these answer WHICH BUS, and the second is the half that
     * goes stale in a way a reader cannot see.
     *
     * Only the route on the board is refreshed by load(), and a plan names up to
     * six. refreshRoute is the same handshake the saved trips use, and it
     * declines over a request still in flight.
     */
    if (state.view === 'stops' && state.plan.entries && state.plan.entries.length) {
      global.CMB.plan.routesIn(state.plan.entries).forEach(refreshRoute);
    }
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
    /*
     * The routes an open editor is part-way through picking. They are not the
     * board's route and are not yet in either store, so without this a schedule
     * that failed once left the editor on "Loading…" until the tab was closed.
     */
    /*
     * Asked for outright, not through retrySchedule.
     *
     * retrySchedule acts only on 'error' and 'stale', and the sweep at the top of
     * this same tick has already deleted both — so calling it from here was dead
     * code describing a mechanism that could not run. loadDepartures is what
     * actually covers the case: a schedule that is present, still marked 'ok',
     * and WITHHELD — the service-day roll, or a document whose date cannot be
     * read — is neither 'error' nor 'stale', and it is what an open editor
     * cannot recover from on its own, because renderLive() suppresses the
     * repaint and the paint-time re-ask never runs to notice. The tick is the
     * one thing that keeps working behind an open editor.
     */
    editorRouteIds().forEach(loadDepartures);

    /*
     * Every route either store names — a saved trip names one, a chain names two
     * or three — and none of them is necessarily the route on screen.
     *
     * Including while an editor is open, which is reached FROM this view and
     * returns to it. Skipping it there left the cards behind the editor as old
     * as the visit, which is the same failure the renderLive() note above
     * describes, in miniature.
     *
     * A frozen saved trip is worse than none: it reads as a live prediction, and
     * a frozen chain reports a connection that stopped being true. These re-ask
     * even on success, because what they show is a live prediction rather than
     * the route's shape — refreshRoute is the handshake, and it declines over a
     * request that is still running. Writing 'idle' unconditionally stomped a
     * 'loading' the sweep above had just started, so an errored route was
     * fetched twice in one tick and a merely slow one picked up an extra
     * concurrent request every minute; loadRouteData carries no generation
     * stamp, so those two answers can also land out of order.
     */
    if (state.view === 'saved' || editing()) {
      Object.keys(savedRouteIds()).forEach(function (id) {
        refreshRoute(id);
        /* And the schedule, for the same reason and by the same route: the sweep
         * above has already cleared any 'error' or 'stale', so this asks rather
         * than retries. loadDepartures declines a document it may still use. */
        loadDepartures(id);
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

  /* A step-based editor owns the whole screen while it is open. */
  function editing() {
    return state.view === 'chain-edit' || state.view === 'saved-edit';
  }

  /*
   * A repaint that ARRIVING DATA asked for, rather than one the reader did.
   *
   * render() rebuilds the band from scratch, which on a six-step editor throws away
   * focus, scroll position and any half-made tap. So a live payload landing behind
   * an open editor is stored and not drawn — and nothing is lost by that, because
   * nothing an editor shows comes from a live payload. It is built entirely from
   * the service-day schedule and the route catalog, and those two keep the ordinary
   * render() precisely because the editor IS waiting on them.
   *
   * Suppressing the repaint rather than the refresh is the whole point. The first
   * version of this returned early from the entire interval, which stopped the
   * clock along with the repaint: ten minutes in the editor and the Saved view
   * behind it still said "in 11 minutes" about a bus due in one, because nowEpoch()
   * reads generated_at out of a payload that was no longer being fetched. Leaving
   * an editor calls render() on its way out, so the deferred paint costs nothing.
   */
  function renderLive() {
    if (editing()) return;
    render();
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
      /*
       * Not on the Saved view. That view draws its own staleness banners, one per
       * distinct warning across the routes it depends on, and the board's route is
       * either among them — in which case this is the same sentence a second time —
       * or it is not on the screen at all, in which case an unlabelled banner about
       * a route none of the cards belong to is worse than none.
       */
      var banner = state.view === 'saved'
        ? null
        : S.stalenessBanner(d.staleness, d.feeds, function () { load(state.routeId); });
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

    if (state.view === 'stops') { paintStops(); return; }
    if (state.view === 'all') { paintAll(); return; }
    if (state.view === 'saved') { paintSaved(); return; }
    if (state.view === 'saved-edit') { paintSavedEdit(); return; }
    if (state.view === 'trip') { paintTrip(); return; }
    if (state.view === 'chain-edit') { paintChainEdit(); return; }

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

  /* ---- the three views that are not the route board --------------------- */

  /*
   * Why a route's schedule is missing, in the only place that knows.
   *
   * The stops view is the one screen that cannot fall back to the bundled
   * fixture: the fixture is a route payload, and a stop card needs the whole
   * service day of scheduled departures, which only exists as a fetched
   * document. From a file:// URL that is a permanent condition and saying "not
   * loaded yet" would be a lie with a spinner attached.
   */
  function scheduleDetail(routeId) {
    if (global.location.protocol === 'file:') {
      return 'A stop card needs the day’s schedule, which is fetched rather than ' +
        'bundled — so this view needs the board to be served, not opened from a file.';
    }
    if (state.depStatus[routeId] === 'error') {
      return 'The schedule for route ' + routeId + ' could not be fetched. The next ' +
        'refresh will try again.';
    }
    return null;
  }

  function paintStops() {
    var band = el('section', 'band band--stops');
    band.setAttribute('aria-label', 'Stops');
    dom.main.appendChild(band);

    var entries = state.plan.entries || [];
    var now = nowEpoch();
    var models = entries.map(function (e) {
      /* Resolving here rather than only in selectView covers a link opened while
       * the view is already showing. Both loaders are idempotent. */
      loadDepartures(e.route_id);
      loadRouteData(e.route_id);
      return global.CMB.plan.resolve(
        e,
        state.departures[e.route_id] || null,
        liveRoute(e.route_id),
        now,
        {
          schedule_detail: scheduleDetail(e.route_id),
          /*
           * Whatever scheduleExpired() decides has to reach the COPY, not only
           * the fetch logic. A document from a previous service day has every
           * one of today's times behind it, so nothing is upcoming and the card
           * said "The last one today has gone. Back tomorrow." — a claim about
           * today's service, made from a document that does not describe today,
           * at breakfast, on a board somebody left open overnight.
           */
          schedule_expired: scheduleExpired(state.departures[e.route_id])
        }
      );
    });

    global.CMB.plan.render(band, global.CMB.plan.sortModels(models), {
      offer: state.plan.offer,
      cameFromQuery: state.plan.fromQuery,
      saved: state.plan.saved,
      link: entries.length
        ? global.CMB.plan.linkFor(entries, global.location.href)
        : null,
      storageFailed: state.plan.storageFailed,
      /* What is already on the phone, so the offer can say so rather than
       * quietly deciding what happens to it. */
      keptCount: keptOther().length,
      onKeep: function () {
        /*
         * ADD, never replace.
         *
         * save() overwrites, which is right when the reader is editing the set in
         * front of them and wrong when a second link arrives. Somebody keeping one
         * child's stops who opened the other child's link and tapped the obvious
         * button lost the first set, with nothing on screen having mentioned it
         * and no way back but the original link. plan.merge() puts the existing
         * ones first so a cap can only ever bite what is arriving.
         */
        var merged = global.CMB.plan.merge(keptOther(), state.plan.entries);
        /*
         * The write is allowed to fail, so its answer decides what is said. This
         * used to dismiss the offer and announce success on a save that never
         * happened — the stops were gone on the next load with nothing on screen
         * having suggested anything went wrong. The offer stays up on a refusal,
         * because the link in the address bar is still the way back.
         */
        if (!global.CMB.plan.save(merged.entries)) {
          state.plan.storageFailed = true;
          announce(STORAGE_REFUSED);
          render();
          return;
        }
        state.plan.storageFailed = false;
        state.plan.entries = merged.entries;
        state.plan.saved = true;
        state.plan.offer = null;
        state.plan.declined = null;
        syncFragment();
        announce('Kept ' + fmt.plural(merged.entries.length, 'stop', 'stops') +
          ' on this phone.' + (merged.dropped
            ? ' ' + fmt.plural(merged.dropped, 'stop', 'stops') +
              ' could not be added: this phone keeps at most ' +
              global.CMB.plan.MAX_ENTRIES + ' stops on at most ' +
              global.CMB.plan.MAX_ROUTES + ' routes.'
            : ''));
        render();
      },
      onDismiss: function () {
        state.plan.declined = state.plan.offer;
        state.plan.offer = null;
        render();
      },
      onForget: function () {
        /*
         * A delete is a write and can be refused the same way a save can, and the
         * two must be equally honest. This announced that the stops were no
         * longer kept, cleared the flag that says they are, and left them sitting
         * in storage — so they came back on the next load, having been declared
         * gone. The save path was already fixed for exactly this; these are its
         * siblings and were missed.
         */
        if (!global.CMB.plan.clear()) {
          state.plan.storageFailed = true;
          announce(STORAGE_REFUSED);
          render();
          return;
        }
        state.plan.storageFailed = false;
        state.plan.saved = false;
        /* The link, if there is one, is still on screen: forgetting is about the
         * store, not about what is being looked at. */
        if (!global.CMB.plan.fromLocation(global.location)) state.plan.entries = null;
        announce('These stops are no longer kept on this phone.');
        render();
      },
      onRemove: function (key) {
        var left = (state.plan.entries || []).filter(function (e) {
          return global.CMB.plan.keyFor(e) !== key;
        });
        /*
         * Same rule as onForget, and the state is not touched until the write has
         * agreed. Taking the stop off screen first and then discarding a refusal
         * put it back on the next load, which reads as the board undoing an edit
         * on its own.
         */
        if (state.plan.saved && !global.CMB.plan.save(left)) {
          state.plan.storageFailed = true;
          announce(STORAGE_REFUSED);
          render();
          return;
        }
        state.plan.entries = left;
        if (state.plan.offer) state.plan.offer = state.plan.entries;
        syncFragment();
        render();
      }
    });
    dom.main.appendChild(footer(state.data));
  }

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
    /* Fetching here rather than only in selectView covers anything saved while the
     * view is already open. */
    loadSavedRoutes();
    var now = nowEpoch();

    /*
     * A staleness banner for every route this view depends on, not just the one on
     * the board.
     *
     * This is the view where it matters most and the only one that had none. Its
     * routes are BY DEFINITION not the route being watched, so nobody is looking at
     * their board to notice the feed died — and a chain leg on a dead route is
     * graded against frozen positions while the card reads "not reporting yet, that
     * is normal until it starts its run". The contract makes staleness a rendered
     * state, and rendering it for four routes while silently trusting a fifth is
     * the same failure the whole staleness machinery exists to prevent.
     */
    savedStalenessBanners().forEach(function (b) { dom.main.appendChild(b); });

    /*
     * Chains sit above saved trips. A chain is the higher-stakes item on this
     * screen — a missed connection strands someone, a late bus merely annoys them
     * — and the ordering inside each band is already worst-news-first, so putting
     * the band that can carry a missed connection second would bury it.
     */
    var chainBand = el('section', 'band band--chains');
    chainBand.setAttribute('aria-label', 'Transfer chains');
    dom.main.appendChild(chainBand);

    var live = liveRouteMap();
    var chains = global.CMB.chain.list().map(function (c) {
      return global.CMB.chain.resolve(c, usableDeparturesMap(), live, now);
    });
    global.CMB.chain.render(chainBand, global.CMB.chain.sortModels(chains), {
      /* A chain that cannot resolve from disk is not waiting on anything. The
         banner above already says so; the cards have to agree with it. */
      fromDisk: fromDisk(),
      onAdd: function () {
        state.chainEditor = { legs: [], day_type: null, start: {}, onward: {} };
        state.view = 'chain-edit';
        render();
      },
      onChange: render
    });

    var band = el('section', 'band band--saved');
    band.setAttribute('aria-label', 'Saved trips');
    dom.main.appendChild(band);

    var models = global.CMB.watch.list().map(function (w) {
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

  /*
   * Every live route payload this browser currently holds, keyed by route id.
   * Chain resolution spans routes, so it takes a map rather than one payload; the
   * route on screen lives in state.data and the rest in state.routeData, and this
   * is the one place that difference is reconciled.
   */
  /*
   * One banner per route whose feed is not fresh, labeled with the route number.
   *
   * Labeled because on this view an unlabeled "Data 14 minutes old" is unusable:
   * there are three or four routes on screen and the reader cannot tell which of
   * them the warning is about, or therefore which card to stop trusting. The route
   * board never had that problem — it only ever shows one route.
   */
  /*
   * Permit one more fetch for a route, without disturbing one in flight.
   *
   * Resetting to 'idle' unconditionally defeats loadRouteData's own single-flight
   * guard: the reset lands while a request is open, the next paint starts a second,
   * and the older response can arrive last and revert a verdict to stale data. Same
   * helper and same condition as PR 2, so the two do not drift.
   */
  function refreshRoute(routeId) {
    if (state.routeStatus[routeId] === 'loading') return;
    state.routeStatus[routeId] = 'idle';
    loadRouteData(routeId);
  }

  /*
   * Permit one more fetch of a schedule that stopped: a failed request, or a
   * document evicted for belonging to another service day. Same handshake and same
   * in-flight condition as refreshRoute, so the two do not drift.
   *
   * Only ever called from the refresh interval and from a button somebody pressed.
   * Calling it from a paint would restore the loop it exists to end.
   */
  function retrySchedule(routeId) {
    if (!routeId) return;
    var status = state.depStatus[routeId];
    if (status !== 'error' && status !== 'stale') return;
    state.depStatus[routeId] = 'idle';
    loadDepartures(routeId);
  }

  /*
   * "Route 4" / "Routes 4, 800 and 837". The list is what makes a shared banner
   * as specific as the per-route ones it replaces: it still names every card to
   * stop trusting, in one place instead of four.
   */
  function routeLabel(ids) {
    if (ids.length === 1) return 'Route ' + ids[0];
    return 'Routes ' + ids.slice(0, -1).join(', ') + ' and ' + ids[ids.length - 1];
  }

  /*
   * Two banners saying the same sentence about the same feed are not two warnings,
   * they are one warning shouted four times, and the fourth is read as carefully as
   * the first. Every saved route is generated by one cron run from one pair of
   * feeds, so in the ordinary degraded case every route's staleness is the SAME
   * object, word for word — which is how the Saved view came to stack four
   * identical banners above the cards they were warning about.
   *
   * So routes are bucketed by what their banner would actually SAY, and each
   * distinct sentence is drawn once, labelled with every route it covers. Nothing
   * is dropped: two routes only share a banner when their text is identical, and a
   * route the board has failed to refresh on its own (agedStaleness raises its
   * level, and its reason names it) falls into its own bucket and keeps its own.
   */
  function savedStalenessBanners() {
    var live = liveRouteMap();
    var order = [];
    var buckets = Object.create(null);

    var into = function (key, id, make) {
      if (!Object.prototype.hasOwnProperty.call(buckets, key)) {
        buckets[key] = { ids: [], make: make };
        order.push(key);
      }
      buckets[key].ids.push(id);
    };

    /*
     * Driven by the routes this view NEEDS, not by the payloads it happens to hold.
     *
     * A route whose payload never arrived — a 404 after a republish renumbered it,
     * a dead network — has no entry in liveRouteMap() and so drew no banner at all,
     * while resolveLeg graded it against the timetable with full confidence. That
     * is the case most in need of one: a leg the board knows nothing about rendered
     * identically to a leg running exactly on schedule.
     */
    Object.keys(savedRouteIds()).sort().forEach(function (id) {
      var d = live[id];
      if (!d) {
        /*
         * From disk this is not a failure and Try again cannot help: there is no
         * origin, so api/* is absent rather than slow. Saying "could not be loaded"
         * there would send the reader hunting for a problem with their network.
         */
        var disk = fromDisk();
        var kind = disk ? 'disk' : state.routeStatus[id] === 'error' ? 'error' : 'loading';
        into('missing:' + kind, id, function (ids) {
          var many = ids.length > 1;
          var whose = many ? 'Their' : 'Its';
          var theirs = many ? 'their' : 'its';
          var why = disk
            ? 'This board is open from a file, so there is no live feed to read. ' +
              'Saved chains need the board as it is served.'
            : whose + ' data ' +
              (kind === 'error' ? 'could not be loaded' : 'has not loaded yet') +
              ', so nothing here reflects where ' + theirs + ' buses are.';
          return S.notice(
            disk ? 'empty' : kind === 'error' ? 'warn' : 'empty',
            disk
              ? 'No live data from a file.'
              : 'No live data for ' + (many ? 'routes ' : 'route ') + ids.join(', ') + '.',
            why,
            disk ? null : S.retryButton('Try again', function () {
              ids.forEach(refreshRoute);
            })
          );
        });
        return;
      }
      if (!d.staleness || d.staleness.level === 'fresh') return;
      var st = d.staleness;
      /*
       * The signature is every input stalenessBanner() reads, so two routes share a
       * bucket exactly when the banner it builds for them is the same text. Keying
       * on the level alone would merge a route stale because the whole feed stopped
       * with one stale only because THIS browser cannot reach it, and those say
       * different things and need different retries.
       */
      var key = ['stale', st.level, st.oldest_feed_age_s, st.schedule_age_days,
        st.reason, d.feeds && d.feeds.positions_at].join('\u0000');
      into(key, id, function (ids) {
        return S.stalenessBanner(st, d.feeds, function () { ids.forEach(refreshRoute); });
      });
    });

    var out = [];
    order.forEach(function (key) {
      var bucket = buckets[key];
      var body = bucket.make(bucket.ids);
      if (!body) return;
      /*
       * Composed, not mutated. Reaching into the banner to rewrite its headline
       * would couple this to states.js's internal class names and would silently
       * do nothing anywhere querySelector is not available — which is exactly the
       * kind of quietly-skipped labeling this view cannot afford.
       */
      var box = el('div', 'savedbanner');
      box.appendChild(el('p', 'savedbanner__route', routeLabel(bucket.ids)));
      box.appendChild(body);
      out.push(box);
    });
    return out;
  }

  /*
   * The device clock, in whole seconds, and used for exactly one thing: measuring
   * how long this browser has held a document.
   *
   * Everything a reader SEES is timed against the feed's own generated_at, so a
   * phone two minutes fast cannot shave two minutes off an arrival. That rule is
   * about comparing our clock with the agency's, and it does not apply here: this
   * subtracts two readings of the same local clock and never compares either with
   * anything in a payload. A device clock is the only instrument that can answer
   * "how long ago did this arrive", and a skewed one still measures elapsed time.
   */
  function heldClock() {
    return Math.floor(Date.now() / 1000);
  }

  /* The contract's staleness ladder, worst last, so a level is never downgraded. */
  var STALE_RANK = { fresh: 0, aging: 1, stale: 2, dead: 3 };

  /*
   * A payload's staleness as it is NOW, rather than as the server stamped it.
   *
   * `staleness` describes the feed at the moment the file was generated, and the
   * contract is right that `suppress_adherence` is authoritative — about the
   * document as delivered. It cannot speak for the minutes since. A route the
   * board fetched once and has failed to refresh ever since keeps saying `fresh`
   * for as long as the tab is open, so it drew no banner and its chain leg was
   * graded with full confidence against positions frozen an hour ago. That is
   * precisely the "the cron stopped an hour ago" case, and it was the one case the
   * new banner could not see: it watched for a payload that reports staleness, and
   * for a route with no payload at all, and this is neither.
   *
   * So the feed age is the age the server measured PLUS the time we have been
   * holding the answer, and the contract's own thresholds (section 1) are applied
   * to that sum. This is not second-guessing the server; it is finishing the
   * server's sentence with the only term the server could not know. The level is
   * never lowered, only raised.
   */
  function agedStaleness(d, id) {
    var st = d && d.staleness;
    if (!st) return st;
    var fetchedAt = state.routeFetchedAt[id];
    var held = typeof fetchedAt === 'number' ? Math.max(0, heldClock() - fetchedAt) : 0;
    if (!held) return st;

    var age = (typeof st.oldest_feed_age_s === 'number' ? st.oldest_feed_age_s : 0) + held;
    var level = age > 3600 ? 'dead' : age > 600 ? 'stale' : age > 120 ? 'aging' : 'fresh';
    if ((STALE_RANK[level] || 0) <= (STALE_RANK[st.level] || 0)) return st;

    var reason = 'The board has not been able to refresh route ' + id + ' for ' +
      fmt.age(held) + '.';
    return {
      level: level,
      oldest_feed_age_s: age,
      schedule_age_days: st.schedule_age_days,
      /* The same flag the contract makes authoritative, set for the same reason:
         past ten minutes of feed age no lateness may be rendered. */
      suppress_adherence: st.suppress_adherence || age > 600,
      reason: st.reason ? st.reason + ' ' + reason : reason
    };
  }

  /*
   * Every live route payload this browser currently holds, keyed by route id, each
   * one aged by how long it has been held. Chain resolution spans routes, so it
   * takes a map rather than one payload; the route on screen lives in state.data
   * and the rest in state.routeData, and this is the one place that difference —
   * and the aging — is reconciled, so the banners and the verdicts cannot disagree
   * about which routes are still worth believing.
   */
  function liveRouteMap() {
    var map = {};
    var age = function (d, id) {
      if (!d) return d;
      var st = agedStaleness(d, id);
      if (st === d.staleness) return d;
      /* A copy, because the cached document must keep saying what it was sent
         saying; only this view's reading of it changes. */
      var copy = {};
      Object.keys(d).forEach(function (k) { copy[k] = d[k]; });
      copy.staleness = st;
      return copy;
    };
    Object.keys(state.routeData).forEach(function (id) {
      map[id] = age(state.routeData[id], id);
    });
    /*
     * Through liveRoute, so the rule about the bundled fixture is written once.
     * This used to reach for state.data itself, which meant the exclusion had to
     * be remembered in two places — and the copy the chain card reads was the
     * one no test covered.
     */
    var open = state.routeId ? liveRoute(state.routeId) : null;
    if (open) map[state.routeId] = age(open, state.routeId);
    return map;
  }

  function paintChainEdit() {
    var band = el('section', 'band band--saved');
    band.setAttribute('aria-label', 'Save a transfer chain');
    dom.main.appendChild(band);

    /*
     * The same paint-time re-ask the saved-trip editor makes, for the same
     * reason: this editor asks again for a schedule usableDepartures() has
     * withheld, or it sits on an empty step list until something else happens to
     * fetch one.
     *
     * Nothing else covers it. The refresh tick's schedule sweep knows the routes
     * in the two STORES and the route on the board; a chain being built names
     * routes that are in neither yet. And retrySchedule declines any status but
     * 'error' or 'stale', so a schedule that is present, current-looking and
     * withheld — the service-day roll, or a document whose date cannot be read —
     * leaves the editor on "Loading the schedule for route N…" with no retry
     * button for the life of the view.
     *
     * Safe from looping for the same reason the other editor's is: loadDepartures
     * returns early on a document it may use, and on loading/error/stale.
     */
    editorRouteIds().forEach(loadDepartures);

    var ed = state.chainEditor;
    global.CMB.chain.renderEditor(band, {
      routes: catalog(),
      legs: ed.legs,
      day_type: ed.day_type,
      start: ed.start,
      onward: ed.onward,
      saveFailed: ed.saveFailed,
      departures: usableDeparturesMap(),
      /* A step waiting on a schedule has to be able to tell "not yet" from "not
         ever", and from a file it is always the second. */
      dep_status: state.depStatus,
      from_disk: fromDisk(),
      connections: global.CMB.chain.connectionsFor(
        ed.legs, usableDeparturesMap(), ed.onward.route_id, ed.onward.direction_id)
    }, {
      onRetrySchedule: function (id) {
        retrySchedule(id);
        render();
      },
      onPickStartRoute: function (id) {
        ed.start = { route_id: id };
        loadDepartures(id);
        render();
      },
      onPickStartDirection: function (id) {
        ed.start.direction_id = id;
        ed.start.stop_id = null;
        render();
      },
      onPickStartStop: function (id) {
        ed.start.stop_id = id;
        render();
      },
      onPickStartDeparture: function (leg, dayType) {
        ed.legs = [leg];
        ed.day_type = dayType;
        ed.start = {};
        ed.onward = {};
        render();
      },
      onPickOnwardRoute: function (id) {
        ed.onward = { route_id: id };
        loadDepartures(id);
        render();
      },
      onPickOnwardDirection: function (id) {
        ed.onward.direction_id = id;
        render();
      },
      onPickConnection: function (leg) {
        ed.legs = ed.legs.concat([leg]);
        ed.onward = {};
        render();
      },
      onSave: function (chain) {
        /*
         * Only claim it was saved if it was. A browser that refuses to write —
         * private mode, quota, storage disabled — used to get the confirmation and
         * a navigation away from six steps of work, landing on "No transfer chains
         * yet". Stay in the editor and say what happened instead.
         */
        if (!global.CMB.chain.add(chain)) {
          ed.saveFailed = true;
          announce('This browser would not save the chain. Nothing has been stored.');
          render();
          return;
        }
        ed.saveFailed = false;
        state.view = 'saved';
        loadSavedRoutes();
        announce('Saved ' + global.CMB.chain.describe(chain));
        render();
      }
    });

    var back = el('button', 'btn');
    back.type = 'button';
    back.textContent = 'Cancel';
    back.addEventListener('click', function () { state.view = 'saved'; render(); });
    band.appendChild(back);
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

  /*
   * One turn of the refresh timer.
   *
   * A named function rather than the interval's own body, because the rules it
   * enforces — a schedule is re-asked for once a minute and only here, where a
   * retry cannot become a render loop — are the ones most easily lost, and the
   * end-to-end suite has no way to observe them if the only way to take a turn
   * is to wait sixty seconds for one. It is exported for that, and calling it is
   * the same thing the timer does, not a shortcut around it.
   */

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

    /*
     * BEFORE ANY FETCH, AND THAT ORDERING IS THE POINT.
     *
     * A '?plan=' link is scrubbed into the fragment in here, and any request
     * issued while the query string is still in the address bar can carry it
     * onward in a Referer header — a legible description of a child's daily
     * routine, arriving at whatever the request was addressed to. The vhost and
     * the meta tag in index.html both say no-referrer; ordering is the part this
     * file controls, and it costs nothing to put the scrub first.
     *
     * So nothing below this line may move above it. load(), loadDepartures() and
     * loadCatalog() all reach getJson, and moving adoptPlan() after any of them
     * reopens the leak while changing nothing on screen. That is exactly why it
     * has a test of its own rather than only a comment — stops.spec.mjs watches
     * the address bar at the moment the first request leaves.
     */
    adoptPlan();

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
    if (view === 'all' || view === 'trip' || view === 'saved' || view === 'stops') selectView(view);
    /*
     * A link beats a remembered view. Someone who has just opened a stops link is
     * asking for the stops, whatever tab they happened to leave the board on, and
     * whether or not those stops are already kept on this phone.
     */
    if (state.plan.fromLink) selectView('stops');

    /* Live refresh only makes sense when something can actually change. */
    if (global.location.protocol !== 'file:' && !state.scenario) {
      /*
       * An open editor stops the REPAINT and nothing else — see renderLive().
       *
       * Every refresh ends in a render, and a render rebuilds the band from
       * scratch, which on a six-step editor throws away focus, scroll position
       * and any half-made tap, once a minute, silently. Skipping the tick
       * stopped that and stopped the clock with it: nothing was fetched while
       * anybody stood in the editor, so leaving it after ten minutes showed a
       * Saved view counting down from a payload ten minutes old. The refreshes
       * run; the paint they would have caused is deferred until the editor
       * closes.
       */
      setInterval(refreshTick, REFRESH_MS);
    }

    /*
     * Pasting a stops link into a tab that is already open only changes the
     * fragment, so nothing reloads and nothing would happen without this — and
     * that is the commonest way a link actually gets used: the board is open, the
     * link arrives in a message, it goes in the address bar.
     *
     * What decides the view is whether the hash CARRIES A PLAN, not whether the
     * plan changed. Comparing against what was on screen and returning early made
     * pasting an already-kept link do nothing at all, which is the same "the link
     * looks inert" symptom the boot path was just fixed for, surviving on the
     * other entry point.
     *
     * The comparison still earns its keep for one thing: an identical plan skips
     * adoptPlan(), which rebuilds `offer` from scratch and would otherwise
     * resurrect an offer the reader had already declined.
     */
    global.addEventListener('hashchange', function () {
      var found = global.CMB.plan.fromLocation(global.location);
      /*
       * A fragment that carries no plan is not about this view, so nothing here
       * reacts to it.
       *
       * It used to rebuild the plan from scratch whenever the board had been
       * opened from a link, which emptied the screen: an in-page anchor, or a
       * Back onto the URL as it was before the link, took a set of stops the
       * reader was looking at and replaced it with "No stops on this phone yet".
       * The stops are still the right answer — they were a moment ago, and a
       * fragment naming something else says nothing to the contrary. Kept ones
       * are in storage and unaffected either way.
       */
      if (!found) return;
      if (state.plan.entries && global.CMB.plan.sameSet(state.plan.entries, found.entries)) {
        state.plan.fromLink = true;
      } else {
        adoptPlan();
      }
      selectView('stops');
    });

    var resizeTimer = null;
    global.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 150);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (state.pickerOpen) { state.pickerOpen = false; render(); return; }
      if (state.view === 'saved-edit' || state.view === 'chain-edit') {
        state.view = 'saved';
        render();
      }
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
    /*
     * The one the timer runs, and therefore the one the suite must drive. There
     * used to be a second tick alongside it, left by a merge — setInterval ran
     * this one while the stops tests drove the other, so those tests were
     * exercising a function the board never called and could not have seen a
     * regression in the one it did.
     */
    refreshTick: refreshTick,
    /* Exported for the suite alone: the generation guard is only observable by
     * letting an abandoned request answer, which needs a fetch under test
     * control. Nothing in the client calls it through here. */
    loadDepartures: loadDepartures,
    FAVOURITES: FAVOURITES,
    SUPPORTED_SCHEMA: SUPPORTED_SCHEMA
  };
})(window);
