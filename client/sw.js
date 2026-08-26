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
 * the browser does exactly what the page asked for. Do not "optimise" that into
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
  return url.pathname.indexOf('/api/') !== -1;
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

function store(request, res) {
  var copy = res.clone();
  /* Deliberately not awaited into the response path: a full quota must not turn
     a successful fetch into a failed one. */
  caches.open(CACHE).then(function (cache) {
    return cache.put(request, copy);
  }).catch(function () {});
  return res;
}

self.addEventListener('install', function (event) {
  /*
   * Every entry, or none. addAll rejects the whole install if any file 404s,
   * which is what should happen: a shell missing one script is a board that
   * opens offline and renders nothing, and a failed install leaves the previous
   * worker (or no worker) in place, which is strictly better.
   *
   * `reload` on each request so an install cannot pick a stale copy out of the
   * HTTP cache and precache the previous release.
   */
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL.map(function (u) {
        return new Request(u, { cache: 'reload' });
      }));
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
        if (cacheable(res)) store(NAV_FALLBACK, res);
        return res;
      }).catch(function () {
        return caches.match(request).then(function (hit) {
          return hit || caches.match(NAV_FALLBACK);
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
      caches.match(request).then(function (hit) {
        return hit || fetch(request).then(function (res) {
          return cacheable(res) ? store(request, res) : res;
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(request).then(function (res) {
      return cacheable(res) ? store(request, res) : res;
    }).catch(function () {
      return caches.match(request).then(function (hit) {
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
