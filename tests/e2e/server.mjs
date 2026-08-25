/**
 * Static server for the end-to-end suite. Fixtures only; nothing reaches the network.
 *
 * The client fetches `api/route/{id}.json` relative to its own URL, so each
 * scenario gets its own path prefix and the same client files are served under
 * all of them:
 *
 *   /fresh/   the committed golden route 4 output
 *   /dead/    the same file 47 minutes after the cron died
 *   /torn/    a response truncated mid-write
 *   /missing/ a 500 from the API, with the client files still served
 *   /future/  a payload written for schema 2
 *
 * Run standalone with: node tests/e2e/server.mjs
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = path.join(ROOT, 'client')
const GOLDEN = path.join(ROOT, 'tests/fixtures/golden/route-4-20260819.json')
const GOLDEN_DEP = path.join(ROOT, 'tests/fixtures/golden/departures-4-20260819.json')
const SYNTHETIC = path.join(ROOT, 'tests/fixtures/synthetic')

const PORT = Number(process.env.CAPMETRO_E2E_PORT || 4173)

/*
 * The security headers this server sends are the ones the real vhost sends,
 * read out of deploy/nginx-capmetro.conf rather than retyped.
 *
 * Without this the suite could not see the class of bug that matters most here.
 * The board's <base> bootstrap is an inline script; production serves
 * `script-src 'self'` with a hash for exactly that snippet, and a server sending
 * no CSP at all admits any snippet whatsoever. So every URL test passed while
 * the deployed board would have rendered nothing at any deep path. Parsing the
 * live config means editing the snippet without updating the hash turns the
 * browser tests red here instead of blanking the board on the box.
 */
const VHOST = readFileSync(path.join(ROOT, 'deploy/nginx-capmetro.conf'), 'utf8')
const CSP = (VHOST.match(/add_header Content-Security-Policy "([^"]+)"/) || [])[1]
if (!CSP) throw new Error('no Content-Security-Policy found in deploy/nginx-capmetro.conf')

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

/** Strip the _comment/_expected/_now keys the fixtures carry for the test suite. */
function wireFormat(doc) {
  if (Array.isArray(doc)) return doc.map(wireFormat)
  if (doc && typeof doc === 'object') {
    return Object.fromEntries(
      Object.entries(doc).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, wireFormat(v)]),
    )
  }
  return doc
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

const SCENARIOS = {
  fresh: () => ({ status: 200, body: JSON.stringify(readJson(GOLDEN)) }),
  dead: () => ({ status: 200, body: JSON.stringify(wireFormat(readJson(path.join(SYNTHETIC, 'route-4-dead-cron.json')))) }),
  torn: () => ({ status: 200, body: readFileSync(path.join(SYNTHETIC, 'torn-route-4.json'), 'utf8') }),
  missing: () => ({ status: 500, body: '{"error":"upstream"}' }),
  future: () => ({ status: 200, body: JSON.stringify({ ...readJson(GOLDEN), schema: 2 }) }),
  empty: () => ({ status: 200, body: JSON.stringify({ ...readJson(GOLDEN), vehicles: [] }) }),
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS)

/*
 * A scenario may not be named after an app path. The client finds the directory
 * it is served from by scanning for the first `route`/`buses`/`trip`/`saved`
 * segment, so a scenario called one of those would be read as the start of the
 * app path and every asset would resolve against the wrong base -- a blank board
 * with nothing in the console. Cheap to prevent, invisible to debug.
 */
const APP_VERBS = ['route', 'buses', 'trip', 'saved']
for (const name of SCENARIO_NAMES) {
  if (APP_VERBS.includes(name)) {
    throw new Error(`scenario "${name}" collides with an app path verb; rename it`)
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const parts = url.pathname.split('/').filter(Boolean)
  const scenario = SCENARIOS[parts[0]] ? parts.shift() : 'fresh'
  const rest = parts.join('/') || 'index.html'

  if (rest.startsWith('api/route/')) {
    const { status, body } = SCENARIOS[scenario]()
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(body)
    return
  }

  /*
   * Route 4 only: the departures document carries a whole service day of
   * scheduled stop times, nothing from a realtime feed, so no SCENARIOS
   * mutation applies to it. Every other route id falls through to the static
   * handler below and 404s, which is what exercises the trip view's
   * departures-error state — the fixture set has no departures document for
   * any other route.
   */
  if (rest === 'api/departures/4.json') {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(readFileSync(GOLDEN_DEP))
    return
  }

  /*
   * The same fallback deploy/nginx-capmetro.conf gives the four app verbs, so
   * the pretty URLs are testable here rather than only in production. Scoped to
   * those verbs for the same reason: a blanket fallback answers 200 with the
   * board's HTML for every missing asset, and a broken script tag would then
   * look like it loaded.
   */
  const file = /^(route|buses|trip|saved)(\/|$)/.test(rest)
    ? path.join(CLIENT, 'index.html')
    : path.join(CLIENT, rest)

  if (!file.startsWith(CLIENT) || !existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }

  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})

server.listen(PORT, () => {
  process.stdout.write(`e2e fixtures server on http://localhost:${PORT}/\n`)
})
