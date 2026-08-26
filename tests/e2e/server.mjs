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
 *   /yesterday/ a fresh live payload with a departures document from the
 *             service day before it — the phone left on the counter overnight
 *
 * `api/departures/{id}.json` is served under every prefix from the chain fixture,
 * because the saved-trip and transfer-chain editors are built entirely from that
 * document and neither can be driven without it.
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
  /*
   * The live payload is the fresh one; only the departures document below
   * differs, and only in its service date. That is the whole point: the client
   * decides a schedule has expired by comparing the two, so the scenario has to
   * hold everything else still.
   */
  yesterday: () => ({ status: 200, body: JSON.stringify(readJson(GOLDEN)) }),
  /*
   * The chain scenarios. The live payload is the ordinary fresh or dead one —
   * what they change is the SCHEDULE, which comes from the committed chain
   * fixture instead of the per-route defaults below.
   *
   * The prefix says which fixture set the board is holding. Both sets carry
   * routes 800 and 4: the chain pair is a filtered set built around one 07:52:09
   * departure and the route 4 buses it can reach, chosen because those two
   * routes share NO stop ids; the defaults are a whole golden service day for
   * route 4 and the synthetic schedule the expiry tests are written against.
   *
   * Measured rather than assumed, because the first version of this comment
   * claimed the two could not substitute for each other and that is not true
   * today: point every chain test at /fresh/ and all 24 still pass, because
   * departures-800 happens to carry the same trip id and the golden route 4
   * document is a superset containing the same Pleasant Valley stops. So this is
   * a defensive split, not a load-bearing one — it pins the tests to the data
   * the feature was designed against, so that editing either fixture cannot
   * quietly change what the other one's tests mean. What actually pins the chain
   * fixture's CONTENT is tests/node/client-chain.test.mjs, which reads it
   * directly.
   */
  chain: () => ({ status: 200, body: JSON.stringify(readJson(GOLDEN)) }),
  chaindead: () => ({ status: 200, body: JSON.stringify(wireFormat(readJson(path.join(SYNTHETIC, 'route-4-dead-cron.json')))) }),
}

/* Which scenarios take their schedules from the chain fixture. */
const CHAIN_SCENARIOS = { chain: true, chaindead: true }

/*
 * The service date the golden route payload publishes, and the day before it.
 * Read rather than written down twice, so replacing the golden file cannot
 * leave the scenario quietly asserting against a date nothing serves.
 */
const GOLDEN_SERVICE_DATE = readJson(GOLDEN).service_day.date

/* As a DATE, not as an integer. 20260901 - 1 is 20260900, which is not a day,
 * and the scenario would then be testing a string comparison against a value the
 * generator can never emit. */
function dayBefore(yyyymmdd) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) - 1))
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}
const DAY_BEFORE_GOLDEN = dayBefore(GOLDEN_SERVICE_DATE)

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

/*
 * The service-day departure boards from the committed chain fixture. It carries
 * routes 800 and 4 — the pair that shares no stop ids — which is what the chain
 * editor has to be exercised against rather than a stub.
 */
function chainDeparturesFor(routeId) {
  const doc = wireFormat(readJson(path.join(SYNTHETIC, 'chain-800-to-4.json')))
  return Object.prototype.hasOwnProperty.call(doc.departures, routeId)
    ? doc.departures[routeId]
    : null
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const parts = url.pathname.split('/').filter(Boolean)
  /* hasOwnProperty, not a bare lookup: `/valueOf/index.html` would otherwise
   * resolve to a function, be called as a scenario, and take the whole fixture
   * server down mid-run — the same class of bug the client fixes for `?stop=`. */
  const named = Object.prototype.hasOwnProperty.call(SCENARIOS, parts[0])
  const scenario = named ? parts.shift() : 'fresh'
  const rest = parts.join('/') || 'index.html'

  if (rest.startsWith('api/route/')) {
    const { status, body } = SCENARIOS[scenario]()
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(body)
    return
  }

  /*
   * The departures documents, by route id. Unlike api/route/ above, the id is
   * NOT ignored: route 4 gets the committed golden schedule that the live golden
   * payload belongs to, and 800 gets the synthetic one the schedule-expiry tests
   * were written against. Every other id 404s through the static handler below,
   * which is what exercises the trip view's departures-error state.
   *
   * A departures document carries a whole service day of scheduled stop times
   * and nothing from a realtime feed, so the SCENARIOS mutations above do not
   * apply to it. Two scenarios still reach it, and both are about the document
   * as a whole rather than its contents:
   *
   *   yesterday  service_date set one day before the date the golden live
   *              payload publishes -- the state a phone is in when it was left
   *              on the counter overnight, holding a schedule from the previous
   *              service day against a feed that has since rolled over.
   *   missing    the API is down, and it has to mean that for BOTH endpoints. A
   *              scenario where the live payload 500s while the schedule answers
   *              200 is not a state the box can be in, and a test written
   *              against it proves nothing about the real one.
   *
   * The chain scenarios swap the whole map for the chain fixture's pair, which
   * is why they exist: both fixture sets carry routes 800 and 4, and neither can
   * stand in for the other.
   */
  const DEPARTURES = CHAIN_SCENARIOS[scenario]
    ? { 4: () => chainDeparturesFor('4'), 800: () => chainDeparturesFor('800') }
    : {
      4: () => readJson(GOLDEN_DEP),
      800: () => wireFormat(readJson(path.join(SYNTHETIC, 'departures-800.json'))),
    }
  const depMatch = rest.match(/^api\/departures\/([^/]+)\.json$/)
  if (depMatch && Object.prototype.hasOwnProperty.call(DEPARTURES, depMatch[1])) {
    if (scenario === 'missing') {
      res.writeHead(500, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
      res.end('{"error":"upstream"}')
      return
    }
    const doc = DEPARTURES[depMatch[1]]()
    if (scenario === 'yesterday') doc.service_date = DAY_BEFORE_GOLDEN
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(JSON.stringify(doc))
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
