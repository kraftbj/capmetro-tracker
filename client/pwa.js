/*
 * pwa.js — registers the service worker, and nothing else.
 *
 * Separate from app.js for two reasons. The first is the CSP: index.html is
 * allowed exactly ONE inline script, admitted by sha256 hash, and that one is
 * the <base> bootstrap. A second inline snippet would need a second hash in
 * both vhosts and would make the "one inline script" invariant in
 * tests/node/deploy-vhost-headers.test.mjs a lie. The second is that
 * registration must not be able to break the board: nothing here throws, and
 * app.js never learns whether it ran.
 *
 * `sw.js` is registered as a RELATIVE URL on purpose. The <base> bootstrap has
 * already pointed the document at the directory the board is served from, so
 * this resolves to `/sw.js` in production and `/fresh/sw.js` under
 * tests/e2e/server.mjs, and the worker's scope follows it. An absolute `/sw.js`
 * would register at the origin root and claim every other board served from the
 * same host, which is what the e2e fixture server is.
 *
 * The registration is deferred to `load` so it never competes with the first
 * paint or with the route fetch. A phone at a bus stop wants the board on
 * screen; the offline copy can be built a second later.
 */
(function (global) {
  'use strict';

  /*
   * Guarded rather than assumed. Three of these are real:
   *
   *   file://       has no service workers at all -- an opaque origin is not a
   *                 secure context -- and opening from disk is a hard
   *                 requirement of this client, not a convenience.
   *   no navigator  the node sandbox in tests/node/helpers/client.mjs evaluates
   *                 every script in index.html against a minimal window. This
   *                 file has to be a no-op there rather than a ReferenceError
   *                 that takes the whole sandbox down with it.
   *   no support    an old browser. The board works without this; it just does
   *                 not open with the network off.
   */
  var nav = global.navigator;
  var loc = global.location;
  if (!nav || !nav.serviceWorker) return;
  if (!loc || loc.protocol === 'file:') return;
  if (typeof global.addEventListener !== 'function') return;

  function register() {
    try {
      /*
       * Failure is silent, and silent is correct. A worker that will not
       * register costs the reader nothing they can see: every fetch still goes
       * to the network, which is where all of them go anyway. Reporting it on
       * the board would be telling somebody waiting for a bus about a caching
       * layer.
       */
      nav.serviceWorker.register('sw.js').catch(function () {});
    } catch (e) { /* SecurityError on an origin that forbids workers. */ }
  }

  if (global.document && global.document.readyState === 'complete') register();
  else global.addEventListener('load', register);
})(window);
