/*
 * sw.js — the service worker. It exists so the board OPENS when the phone has
 * no signal, and for no other reason.
 *
 * Read the next paragraph before changing anything in this file.
 *
 * THE API IS NEVER CACHED, NOT EVEN LOOKED AT. `/api/*` is regenerated every
 * 60 seconds and both vhosts serve it `no-cache`; CLAUDE.md is explicit that a
 * cache in front of it shows stale positions while looking current, which is
 * the one failure this whole project is built to avoid. Requests under an
 * `api/` segment fall straight through to the network with no respondWith(), so
 * the browser does exactly what the page asked for. Do not "optimize" that into
 * a stale-while-revalidate. A bus that is not where the board says it is, is
 * worse than a board that will not load.
 *
 * Everything else -- the document, the scripts, the stylesheet, the fonts, the
 * bundled fixture -- is NETWORK-FIRST, with the cache used only when the
 * network fails. That ordering is the deploy story: deploy/update.sh rsyncs new
 * client files and nothing restarts, so a cache-first worker would keep serving
 * the previous release until its version string changed and somebody remembered
 * to change it. Network-first means a deploy is picked up on the next load,
 * exactly as it is without a worker, and the cache is a floor rather than a
 * ceiling. The fonts are the one exception: they are content-addressed by name,
 * immutable for a year in both vhosts, and worth 70 KB of not-refetching.
 *
 * Offline, the board opens on the bundled golden fixture and says "Sample data"
 * on its own -- that banner already exists and is what an offline reader should
 * see. This worker does not add an offline screen, because the app has an
 * honest one already.
 *
 * Scope: registered from client/pwa.js as a relative URL, so it lands at the
 * directory the board is served from -- `/` in production and `/fresh/` under
 * tests/e2e/server.mjs. Every URL below is relative to THIS FILE for the same
 * reason. Nothing here may hardcode a leading slash.
 */
'use strict';

/*
 * Bump when the SHELL list changes. It does not need bumping for a code change:
 * network-first means new code is fetched on the next load regardless, and the
 * cached copy is overwritten by that same fetch. The version exists so a
 * REMOVED file stops being served from an old cache, which is the one thing
 * network-first cannot fix by itself.
 */
var VERSION = 'v1';
var CACHE = 'dillo-bus-board-' + VERSION;

/*
 * Every file the board needs to render with no network.
 *
 * Hand-written, and pinned by tests/node/client-sw.test.mjs, which derives the
 * same list from index.html and from the @import/url() chain inside the CSS,
 * and fails if the two disagree. A derived list cannot live here: this file has
 * no build step and is shipped verbatim. A hand list that nothing checks would
 * silently lose a script -- the board would then open offline with one
 * namespace missing and render nothing, which looks exactly like a bug in the
 * code rather than a hole in this array.
 *
 * `./` and `index.html` are both here because both are real URLs for the same
 * document: nginx serves the directory index, and the e2e server and every
 * file:// link name the file.
 */
var SHELL = [
  './',
  'index.html',
  'data/route-4-20260819.js',
  'data/departures-4-20260819.js',
  'format.js',
  'adherence.js',
  'states.js',
  'rows.js',
  'ladder.js',
  'map.js',
  'near.js',
  'allbuses.js',
  'watch.js',
  'stopboard.js',
  'chain.js',
  'trip.js',
  'urls.js',
  'pwa.js',
  'app.js',
  'styles.css',
  'tokens.css',
  'fonts/plex.css',
  'fonts/ibm-plex-sans.woff2',
  'fonts/ibm-plex-mono-500.woff2',
  'fonts/ibm-plex-mono-600.woff2',
  'fonts/ibm-plex-mono-700.woff2',
  'manifest.webmanifest',
  'favicon.svg',
  'favicon.ico',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png'
];

/* The document to fall back to for a navigation nothing else answers. `/route/4/eb`
   is not a file anywhere; the vhosts answer it with index.html and so does this. */
var NAV_FALLBACK = new URL('./', self.location.href).href;

/** Under an `api/` segment, at any depth, is the live feed. */
function isApi(url) {
  /*
   * Decoded before testing. `/api%2Froute/4.json` reaches here with the escape intact, so a
   * raw substring test does not see the segment and the request would be handled -- and
   * cached -- as an ordinary asset. Nothing the client builds looks like that, and this
   * origin answers 404 for it today, so it is a guard rather than a live hole; but the rule
   * this function exists to enforce is the one rule the project treats as absolute, and it
   * should not rest on how a path happens to be spelled.
   *
   * Over-broad on purpose, and it fails safe: a path that merely contains `/api/` after
   * decoding is left to the network, which is the conservative direction.
   */
  var path = url.pathname;
  try { path = decodeURIComponent(path); } catch (e) { /* malformed escape: test as-is */ }
  return path.indexOf('/api/') !== -1;
}

function isFont(url) {
  return /\.woff2?$/.test(url.pathname);
}

/**
 * A response worth keeping. `basic` excludes opaque cross-origin responses,
 * which cache as a 0-status body that later reads as a successful empty file.
 */
function cacheable(res) {
  return !!res && res.ok && res.type === 'basic';
}

/**
 * The app document, as opposed to any other file this origin serves.
 *
 * A navigation is not necessarily a navigation TO THE BOARD. A top-level link
 * from anywhere to https://bus.dillo.dev/favicon.svg is a navigate-mode request
 * that this origin answers 200, and adopting it as the shell replaces the
 * offline board with an SVG on that device until the next successful ONLINE
 * navigation -- which is exactly when the cache is not needed. Checked by
 * content type rather than against the app verbs because the verb list is
 * already written in four places and a fifth copy here would be one more thing
 * to forget: the vhosts serve the document as text/html and every other file as
 * something else, so the type IS the question being asked.
 */
function isDocument(res) {
  var type = res && res.headers ? res.headers.get('Content-Type') : null;
  return !!type && String(type).toLowerCase().indexOf('text/html') === 0;
}

/**
 * Look in THIS worker's cache, not across all of them.
 *
 * `caches.match()` is CacheStorage's, and it iterates every cache on the origin
 * in CREATION order and returns the first hit -- so the OLDEST surviving cache
 * wins. activate deletes the older ones, but that delete sits in a Promise.all
 * whose rejection is not caught and does not stop activation: one transient
 * storage error and `dillo-bus-board-v1` outlives the bump to v2. Every offline
 * read on that device then comes out of v1 for good, because activate only
 * fires on a version change and never retries. Unobservable from the device and
 * from the server both.
 */
function fromCache(request) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request);
  });
}

/**
 * Write a copy into the cache.
 *
 * `event.waitUntil` keeps the worker alive until the put lands, WITHOUT putting
 * it in the response path -- those are two different things and the code needs
 * both. Awaiting it into the response would let a full quota turn a successful
 * fetch into a failed one; not extending the lifetime at all meant the browser
 * could terminate the worker as soon as respondWith settled and silently drop
 * the write. The most valuable one, the navigation shell, is issued last on a
 * page load, which is exactly when termination pressure is highest.
 */
function store(event, request, res) {
  var copy = res.clone();
  var wrote = caches.open(CACHE).then(function (cache) {
    return cache.put(request, copy);
  }).catch(function () {});
  if (event && typeof event.waitUntil === 'function') event.waitUntil(wrote);
  return res;
}

self.addEventListener('install', function (event) {
  /*
   * Every entry, or none. addAll rejects the whole install if any file 404s,
   * which is what should happen: a shell missing one script is a board that
   * opens offline and renders nothing, and a failed install leaves the previous
   * worker (or no worker) in place, which is strictly better.
   *
   * The HTTP cache is used rather than bypassed, and that is a deliberate
   * reversal. `cache: 'reload'` here made the install re-download every byte
   * the page had fetched seconds earlier -- 34 unconditional requests, ~290 KB,
   * starting on `load` while app.js was issuing its first feed request. On the
   * phone this worker exists for, that is most of a minute of saturated link
   * spent fetching what the browser already had.
   *
   * It is safe because of what the vhosts send, not by luck: the document is
   * `no-cache` and the scripts, stylesheets and manifest are
   * `max-age=0, must-revalidate`, so the browser must revalidate every one of
   * them before reuse and a precache cannot come from the previous release.
   * Fonts are `immutable`, which is the one set worth taking from cache
   * outright. That dependency is pinned by
   * tests/node/deploy-vhost-headers.test.mjs -- give the scripts a long
   * max-age and it fails there, because it would silently make this install
   * capable of freezing an old release as the offline copy.
   *
   * The icons are `max-age=86400`, so a precache can hold one up to a day old.
   * They are regenerated roughly never and network-first replaces them on the
   * next load, so that is the whole cost.
   */
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () {
      /* No update prompt: the strategies below are network-first, so a waiting
         worker would only delay the offline floor being correct. */
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        /* Only this app's caches. An origin can host more than one. */
        if (k !== CACHE && k.indexOf('dillo-bus-board-') === 0) return caches.delete(k);
        return null;
      }));
    }).catch(function () {
      /* An eviction that fails must not also cost us the claim. `.then(claim)` chained
         after an uncaught Promise.all meant one rejected delete skipped clients.claim()
         entirely, leaving every open page uncontrolled until its next navigation -- so a
         reader who had the board open got no offline floor at all, for a reason that has
         nothing to do with them. fromCache() already anticipates this same rejection for
         the surviving-cache half; this is the other half. */
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  /* The live feed. See the header: not cached, not read, not touched. */
  if (isApi(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function (res) {
        /*
         * Stored under the fallback URL rather than under the path that was
         * asked for. Every app path is served the same document, so caching
         * `/route/4/eb`, `/trip/1234` and `/buses` separately would be three
         * copies of one file and none of them the one a cold `/` needs.
         */
        /* `!res.redirected` is the third clause and it is not decoration. For a navigate
           request the Fetch spec leaves tainting `basic`, so a chain ending somewhere else
           is still basic, ok and text/html -- it passes both other guards. And a cached
           response carrying redirected===true, handed back to a navigation, is turned into
           a network error by the browser: the offline board would then fail to OPEN rather
           than fall back, which is worse than the poisoning it looks like. */
        if (cacheable(res) && !res.redirected && isDocument(res)) {
          store(event, NAV_FALLBACK, res);
        }
        return res;
      }).catch(function () {
        /* NAV_FALLBACK FIRST, and the order is the whole point. Navigations are only ever
           STORED under NAV_FALLBACK, while SHELL carries both `./` and `index.html` as real
           URLs for the same document -- and `index.html` is written only by install's
           addAll, which re-runs only when this file's own bytes change. Reading the request
           first therefore answered a cold `/index.html` from the copy taken at install and
           never refreshed since: measured at release 1 while `./` and app.js were at
           release 5. Same document, many releases apart, offline. */
        return fromCache(NAV_FALLBACK).then(function (hit) {
          return hit || fromCache(request);
        }).then(function (hit) {
          /*
           * Nothing cached and no network: say so in words. This is reachable
           * only before the first successful install, so it is a sentence
           * rather than a screen.
           */
          return hit || new Response(
            '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
            '<body style="background:#0b0d12;color:#e5e7eb;font:16px system-ui;padding:24px">' +
            '<p>The board is offline and has nothing saved yet. Open it once with a connection.</p>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        });
      })
    );
    return;
  }

  if (isFont(url)) {
    event.respondWith(
      fromCache(request).then(function (hit) {
        return hit || fetch(request).then(function (res) {
          return cacheable(res) ? store(event, request, res) : res;
        });
      }).catch(function () {
        /* The one branch in this file that could reject. Every other path catches and
           degrades; this one handed a rejected promise to respondWith, so a font that was
           not cached and could not be fetched failed the request outright instead of
           becoming an ordinary network error. Bounded -- it is a typeface, not the board --
           but it made this branch behave unlike its three siblings for no stated reason. */
        return Response.error();
      })
    );
    return;
  }

  event.respondWith(
    fetch(request).then(function (res) {
      return cacheable(res) ? store(event, request, res) : res;
    }).catch(function () {
      return fromCache(request).then(function (hit) {
        /*
         * A miss has to be an error rather than an empty 200. An empty
         * stylesheet or script would render an unstyled or broken board and
         * look like a code bug; a failed request is what the page already knows
         * how to be honest about.
         */
        return hit || Response.error();
      });
    })
  );
});
