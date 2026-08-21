/*
 * app.js — bootstrap, data loading, header, view switching, and the panel order
 * that was decided and is not open: header, VEHICLE ROWS, LADDER, MAP.
 *
 * Three views share one shell:
 *   board  — one route, the original and the default
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
  var API_BASE = 'api/route/';
  var API_ROUTES = 'api/routes.json';
  var API_ALL = 'api/all.json';
  var API_DEPARTURES = 'api/departures/';
  var REFRESH_MS = 60000;

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
    view: 'board',       /* board | all | saved | saved-edit | chain-edit */
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
    departures: {},      /* route id -> api/departures/{id}.json */
    depStatus: {},       /* route id -> loading | ok | error | stale */
    routeData: {},       /* route id -> api/route/{id}.json, for saved trips off the open board */
    routeStatus: {},     /* route id -> loading | ok | error */
    /*
     * route id -> the device clock when that payload arrived. Not the payload's
     * own generated_at: this measures how long THIS browser has been holding the
     * document, which is the one thing the document itself cannot say. See
     * agedStaleness().
     */
    routeFetchedAt: {},
    editor: { route_id: null, direction_id: null, stop_id: null },
    stopId: null,        /* the stop the Next buses band is answering for */
    stopPicking: false,
    openBuses: {},       /* vehicle_id -> true, for the all-buses detail panels */
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
  function embedded(routeId) {
    var f = global.CMB_FIXTURES && global.CMB_FIXTURES[routeId];
    return f ? deepCopy(f) : null;
  }

  /*
   * One fetch. Every endpoint is a static JSON file on the same origin, so there
   * is nothing to configure and nothing to authenticate. A file:// board has no
   * origin to fetch from and rejects immediately rather than waiting for a
   * network error, because from disk the fixture IS the answer, not a fallback
   * after a timeout.
   */
  function getJson(path) {
    if (global.location.protocol === 'file:' || typeof fetch !== 'function') {
      return Promise.reject(new Error('file://'));
    }
    return fetch(path, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
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

  function loadAll() {
    if (state.allStatus === 'loading') return;
    state.allStatus = 'loading';
    renderLive();
    getJson(API_ALL)
      .then(function (d) {
        state.all = d;
        state.allStatus = 'ok';
        renderLive();
      })
      .catch(function (err) {
        state.allStatus = state.all ? 'ok' : 'error';
        state.errorDetail = 'Could not load every-bus data (' + err.message + ').';
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
     * ONLY 'idle' proceeds. This guard is load-bearing, not an optimization: this
     * function is called from paint(), and both its handlers call render(). Any
     * status that falls through starts a fetch, which repaints, which asks again —
     * an unthrottled request loop against the origin for as long as the view is
     * open.
     *
     * Enumerating the statuses that stop ('loading', 'ok') rather than the one that
     * proceeds is what made the first version of this wrong: 'error' matched
     * neither, so a route that could not be fetched looped hardest of all. Two ways
     * in, both real. On a `file://` board — a stated project requirement — fetch
     * rejects immediately, so it is a tight spin rather than a network round trip.
     * And a GTFS republish, about three times a year, can renumber or drop a route
     * that a saved chain still names, making its payload a permanent 404.
     *
     * The refresh interval below sets the status back to 'idle' before calling
     * here, which is what makes a re-fetch happen once a minute instead of never,
     * and is also how a transient failure recovers. That handshake is the whole
     * refresh mechanism; changing either half without the other either freezes the
     * data or restores the loop.
     *
     * Same shape as loadDepartures() below and as the guard in PR 2, deliberately:
     * three loaders with the same failure mode should not have three different
     * answers to it.
     */
    var status = state.routeStatus[routeId];
    if (status && status !== 'idle') return;
    state.routeStatus[routeId] = 'loading';
    fetchRoute(routeId)
      .then(function (d) {
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

  /* The live payload for a route, wherever it happens to be cached. */
  function liveRoute(routeId) {
    if (routeId === state.routeId) return state.data;
    return state.routeData[routeId] || null;
  }

  /*
   * One departures document per route, kept for the session. It is a whole
   * service day of scheduled stop times — about 17 KB gzipped for route 800 —
   * so it is worth fetching once and worth not fetching until a saved trip or
   * the editor actually needs it.
   */
  function loadDepartures(routeId) {
    if (!routeId) return;
    if (state.departures[routeId]) return;
    /*
     * ONLY 'idle' proceeds, the same rule and for the same reason as
     * loadRouteData() above. Enumerating the statuses that stop is what made both
     * of the earlier loops in this file: 'error' matched neither of them the first
     * time, and 'stale' would have matched neither of them this time.
     *
     * A status is a stop, not a pause. Without one, a fetch sets the status, calls
     * render, and render asks again — a fetch-and-repaint loop that hammers the
     * origin and rebuilds the DOM every frame. The 60s refresh clears the status,
     * which is what makes a transient failure recover instead of sticking.
     */
    var depStatus = state.depStatus[routeId];
    if (depStatus && depStatus !== 'idle') return;
    state.depStatus[routeId] = 'loading';
    getJson(API_DEPARTURES + encodeURIComponent(routeId) + '.json')
      .then(function (d) {
        state.departures[routeId] = d;
        state.depStatus[routeId] = 'ok';
        render();
      })
      .catch(function () {
        state.depStatus[routeId] = 'error';
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
    renderLive();

    fetchRoute(routeId)
      .then(function (d) { state.usingFixture = false; return d; })
      .catch(function (err) {
        var f = embedded(routeId);
        if (!f) throw err;
        state.usingFixture = true;
        return f;
      })
      .then(function (d) {
        if (scenario && scenario.apply) d = scenario.apply(d);
        if (typeof d.schema !== 'number' || d.schema > SUPPORTED_SCHEMA) {
          state.status = 'schema';
          state.data = d;
          renderLive();
          return;
        }
        state.data = d;
        state.lastGoodAt = d.generated_at;
        state.status = 'ok';
        state.routeFetchedAt[routeId] = heldClock();
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
      { id: 'all', label: 'All buses' },
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
   * Every route id the Saved view needs, from both stores, as a set. A saved trip
   * names one route; a chain names two or three, and none of them is necessarily
   * the route on screen.
   */
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
   */
  function loadSavedRoutes() {
    evictStaleDepartures();
    Object.keys(savedRouteIds()).forEach(function (id) {
      loadDepartures(id);
      loadRouteData(id);
    });
  }

  /*
   * Drop any cached schedule that belongs to a different service day than the one
   * the board is currently on.
   *
   * These documents are cached for the whole session because they only change when
   * the service date does — but a board left open across 3 a.m. crosses that line,
   * and then one route's schedule counts from yesterday's midnight while the next
   * one fetched counts from today's. A chain subtracting across the two reported a
   * day of slack. chain.js refuses to grade a mismatch; this is what makes the
   * refusal temporary rather than permanent.
   */
  function evictStaleDepartures() {
    var today = state.data && state.data.service_day && state.data.service_day.date;
    if (!today) return;
    Object.keys(state.departures).forEach(function (id) {
      var doc = state.departures[id];
      /*
       * STRICTLY older, not merely different.
       *
       * These are `YYYYMMDD` strings, which sort chronologically as text because
       * every field is fixed-width and most-significant-first — no parsing, and no
       * timezone to get wrong. That matters because the two dates disagree in both
       * directions and only one of them means the cached schedule is out of date:
       *
       *   doc older than the board — the 3 a.m. rollover. The schedule really is
       *     yesterday's and must go.
       *   doc NEWER than the board — the board is the stale one. After a republish
       *     it falls back to the embedded fixture, which is pinned at 20260819
       *     forever, while departures return today. Evicting on "different" threw
       *     away a perfectly good schedule, refetched the identical document, and
       *     evicted it again: measured at 214 requests in three seconds, permanent
       *     for as long as the fallback was in use.
       */
      if (!doc || !doc.service_date || doc.service_date >= today) return;
      delete state.departures[id];
      /*
       * 'stale' rather than deleting the status, because the status IS
       * loadDepartures' single-flight guard and deleting it says "never fetched".
       * Eviction would then refetch inside the paint that evicted, the refetch
       * would repaint, and the repaint would evict — the same loop from the other
       * side. Marked instead, and left for the refresh tick to clear, which is the
       * one place in this file where a retry cannot become a render loop.
       *
       * And never over 'loading': a request already in flight will land with a
       * document and set its own status, and clobbering the guard underneath it
       * lets a second request start that can arrive first.
       */
      if (state.depStatus[id] !== 'loading') state.depStatus[id] = 'stale';
    });
  }

  /* No origin to fetch from, so api/* is not merely slow — it is absent. */
  function fromDisk() {
    return global.location.protocol === 'file:' || typeof fetch !== 'function';
  }

  function selectView(id) {
    state.view = id;
    state.pickerOpen = false;
    store('view', id);
    if (id === 'all' && !state.all) loadAll();
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
     * The route chip and the direction toggle only mean something on the route
     * board. Leaving them live on the other two views would offer a control that
     * changes nothing on screen, which reads as the app being broken.
     */
    var onBoard = state.view === 'board';
    dom.routechip.hidden = !onBoard;
    dom.dirgroup.hidden = !onBoard;
    if (!onBoard) { dom.picker.hidden = true; }

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

  function selectRoute(id) {
    state.routeId = id;
    state.data = null;
    state.errorDetail = null;
    /* Each route remembers its own stop, so switching back is one tap and not
     * a fresh hunt through sixty-six of them. */
    state.stopId = recall('stop.' + id);
    state.stopPicking = false;
    store('route', id);
    load(id);
    loadDepartures(id);
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
      state.departures[state.routeId] || null,
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
    savedStalenessBanners(now).forEach(function (b) { dom.main.appendChild(b); });

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
      return global.CMB.chain.resolve(c, state.departures, live, now);
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
        state.departures[w.route_id] || null,
        liveRoute(w.route_id),
        now
      );
    });

    global.CMB.watch.render(band, global.CMB.watch.sortModels(models), {
      onAdd: function () {
        state.editor = { route_id: null, direction_id: null, stop_id: null };
        state.view = 'saved-edit';
        render();
      },
      onChange: render
    });
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

  function savedStalenessBanners() {
    var live = liveRouteMap();
    var out = [];
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
        var why = disk
          ? 'This board is open from a file, so there is no live feed to read. ' +
            'Saved chains need the board as it is served.'
          : state.routeStatus[id] === 'error'
            ? 'Its data could not be loaded, so nothing here reflects where its buses are.'
            : 'Its data has not loaded yet, so nothing here reflects where its buses are.';
        var miss = el('div', 'savedbanner');
        miss.appendChild(el('p', 'savedbanner__route', 'Route ' + id));
        miss.appendChild(S.notice(
          disk ? 'empty' : state.routeStatus[id] === 'error' ? 'warn' : 'empty',
          disk ? 'No live data from a file.' : 'No live data for route ' + id + '.',
          why,
          disk ? null : S.retryButton('Try again', function () { refreshRoute(id); })
        ));
        out.push(miss);
        return;
      }
      if (!d.staleness || d.staleness.level === 'fresh') return;
      var banner = S.stalenessBanner(d.staleness, d.feeds, function () {
        refreshRoute(id);
      });
      if (!banner) return;
      /*
       * Composed, not mutated. Reaching into the banner to rewrite its headline
       * would couple this to states.js's internal class names and would silently
       * do nothing anywhere querySelector is not available — which is exactly the
       * kind of quietly-skipped labeling this view cannot afford.
       */
      var box = el('div', 'savedbanner');
      box.appendChild(el('p', 'savedbanner__route', 'Route ' + id));
      box.appendChild(banner);
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
    if (state.routeId && state.data) map[state.routeId] = age(state.data, state.routeId);
    return map;
  }

  function paintChainEdit() {
    var band = el('section', 'band band--saved');
    band.setAttribute('aria-label', 'Save a transfer chain');
    dom.main.appendChild(band);

    var ed = state.chainEditor;
    global.CMB.chain.renderEditor(band, {
      routes: catalog(),
      legs: ed.legs,
      day_type: ed.day_type,
      start: ed.start,
      onward: ed.onward,
      saveFailed: ed.saveFailed,
      departures: state.departures,
      /* A step waiting on a schedule has to be able to tell "not yet" from "not
         ever", and from a file it is always the second. */
      dep_status: state.depStatus,
      from_disk: fromDisk(),
      connections: global.CMB.chain.connectionsFor(
        ed.legs, state.departures, ed.onward.route_id, ed.onward.direction_id)
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

    global.CMB.watch.renderEditor(band, {
      routes: catalog(),
      route_id: state.editor.route_id,
      direction_id: state.editor.direction_id,
      stop_id: state.editor.stop_id,
      departures: state.editor.route_id ? (state.departures[state.editor.route_id] || null) : null
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
        global.CMB.watch.add(w);
        state.view = 'saved';
        announce('Saved ' + global.CMB.watch.describe(w));
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
    var q = query();
    dom.root = document.getElementById('app');
    dom.root.appendChild(buildHeader());
    dom.main = el('main', 'main');
    dom.main.id = 'board';
    dom.root.appendChild(dom.main);
    dom.live = el('p', 'sr-only');
    dom.live.setAttribute('role', 'status');
    dom.live.setAttribute('aria-live', 'polite');
    dom.root.appendChild(dom.live);

    if (q.state && S.STATE_SCENARIOS[q.state]) {
      state.scenario = S.STATE_SCENARIOS[q.state];
      var note = el('p', 'scenario');
      note.textContent = 'STATE PREVIEW · ' + state.scenario.note;
      state.scenarioNote = note;
    }

    var dirParam = q.dir !== undefined ? q.dir : recall('direction');
    if (dirParam === '0' || dirParam === '1') state.direction = parseInt(dirParam, 10);
    else if (dirParam === 'both') state.direction = 'both';

    var routeId = q.route || recall('route') || '4';
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

    var view = q.view || recall('view');
    if (view === 'all' || view === 'saved') selectView(view);

    /* Live refresh only makes sense when something can actually change. */
    if (global.location.protocol !== 'file:' && !state.scenario) {
      setInterval(function () {
        /*
         * An open editor stops the REPAINT and nothing else — see renderLive().
         *
         * Every refresh ends in a render, and a render rebuilds the band from
         * scratch, which on a six-step editor throws away focus, scroll position
         * and any half-made tap, once a minute, silently. Returning here stopped
         * that, and stopped the clock with it: nothing was fetched while anybody
         * stood in the editor, so leaving it after ten minutes showed a Saved view
         * counting down from a payload ten minutes old. The refreshes run; the
         * paint they would have caused is deferred until the editor closes.
         */
        if (state.status !== 'loading') load(state.routeId);
        if (state.view === 'all') loadAll();
        /* One retry per minute for a schedule that failed to load or was evicted
         * as belonging to another service day, and only here, where a retry cannot
         * become a render loop. */
        retrySchedule(state.routeId);
        /*
         * The routes an open editor is part-way through picking. They are not the
         * board's route and not yet in either store, so without this a schedule
         * that failed once left the editor on "Loading…" until the tab was closed.
         */
        editorRouteIds().forEach(retrySchedule);

        if (state.view === 'saved' || editing()) {
          /* A frozen saved trip is worse than none: it reads as a live prediction,
           * and a frozen chain reports a connection that stopped being true. Every
           * route either store names is re-fetched, not just the watched ones.
           *
           * Including while an editor is open, which is reached FROM this view and
           * returns to it. Skipping it there meant the cards behind the editor were
           * as old as the visit, which is the whole failure above in miniature. */
          Object.keys(savedRouteIds()).forEach(function (id) {
            refreshRoute(id);
            /*
             * And one retry per minute for a schedule that failed. The retry above
             * covers only the route on the board; a chain's other two routes are by
             * definition not that one, so without this a chain whose second leg's
             * schedule failed once stayed unresolvable until a reload. Safe here for
             * the same reason: the interval is not a render.
             */
            retrySchedule(id);
          });
        }
      }, REFRESH_MS);
    }

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
    FAVOURITES: FAVOURITES,
    SUPPORTED_SCHEMA: SUPPORTED_SCHEMA
  };
})(window);
