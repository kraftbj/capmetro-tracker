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
    departures: {},      /* route id -> api/departures/{id}.json */
    depStatus: {},       /* route id -> loading | ok | error */
    routeData: {},       /* route id -> api/route/{id}.json, for saved trips off the open board */
    routeStatus: {},     /* route id -> loading | ok | error */
    editor: { route_id: null, direction_id: null, stop_id: null },
    stopId: null,        /* the stop the Next buses band is answering for */
    stopPicking: false,
    openBuses: {},       /* vehicle_id -> true, for the all-buses detail panels */
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
    pendingBus: null
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
   * The departures document from disk. Same reason as embedded(): a file://
   * board has nothing to fetch, and without a schedule the trip view has no
   * scheduled column and therefore no answer at all.
   */
  function embeddedDepartures(routeId) {
    var f = global.CMB_FIXTURES_DEPARTURES && global.CMB_FIXTURES_DEPARTURES[routeId];
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

  function loadAll(then) {
    if (state.allStatus === 'loading') return;
    state.allStatus = 'loading';
    render();
    getJson(API_ALL)
      .then(function (d) {
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
    if (state.routeStatus[routeId] === 'loading') return;
    state.routeStatus[routeId] = 'loading';
    fetchRoute(routeId)
      .then(function (d) {
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
   * One departures document per route, kept for the session. It is a whole
   * service day of scheduled stop times — about 17 KB gzipped for route 800 —
   * so it is worth fetching once and worth not fetching until a saved trip or
   * the editor actually needs it.
   */
  function loadDepartures(routeId) {
    if (!routeId) return;
    if (state.departures[routeId]) return;
    /*
     * 'error' is a stop, not a pause. Without it a failed fetch set the status,
     * called render, and render asked again - a fetch-and-repaint loop that
     * hammered the server and rebuilt the DOM every frame. The 60s refresh
     * clears the status so a transient failure still recovers.
     */
    if (state.depStatus[routeId] === 'loading' || state.depStatus[routeId] === 'error') return;
    state.depStatus[routeId] = 'loading';
    getJson(API_DEPARTURES + encodeURIComponent(routeId) + '.json')
      .then(function (d) {
        state.departures[routeId] = d;
        state.depStatus[routeId] = 'ok';
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
      .then(function (d) { state.usingFixture = false; return d; })
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

  function selectView(id) {
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
      dep: state.departures[state.routeId] || null,
      vehicleId: state.tripBusId,
      now: (state.data && state.data.generated_at) || null,
      lastSeen: state.tripLastSeen
    }, {
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
      setInterval(function () {
        if (state.status !== 'loading') load(state.routeId);
        if (state.view === 'all') loadAll();
        /* One retry per minute for a schedule that failed to load, and only
         * here, where a retry cannot become a render loop. */
        if (state.depStatus[state.routeId] === 'error') {
          delete state.depStatus[state.routeId];
          loadDepartures(state.routeId);
        }
        if (state.view === 'saved') {
          /* A frozen saved trip is worse than none: it reads as a live prediction. */
          global.CMB.watch.list().forEach(function (w) {
            state.routeStatus[w.route_id] = 'idle';
            loadRouteData(w.route_id);
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
    FAVOURITES: FAVOURITES,
    SUPPORTED_SCHEMA: SUPPORTED_SCHEMA
  };
})(window);
