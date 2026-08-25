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
    view: 'board',       /* board | all | saved | saved-edit */
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
    openBuses: {}        /* vehicle_id -> true, for the all-buses detail panels */
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

  function loadAll() {
    if (state.allStatus === 'loading') return;
    state.allStatus = 'loading';
    render();
    getJson(API_ALL)
      .then(function (d) {
        state.all = d;
        state.allStatus = 'ok';
        render();
      })
      .catch(function (err) {
        state.allStatus = state.all ? 'ok' : 'error';
        state.errorDetail = 'Could not load every-bus data (' + err.message + ').';
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
