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
 * Run standalone with: node tests/e2e/server.mjs
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLIENT = path.join(ROOT, 'client')
const GOLDEN = path.join(ROOT, 'tests/fixtures/golden/route-4-20260819.json')
const SYNTHETIC = path.join(ROOT, 'tests/fixtures/synthetic')

const PORT = Number(process.env.CAPMETRO_E2E_PORT || 4173)

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
}

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
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(body)
    return
  }

  /*
   * The departures document. As with api/route/ above, the requested route id is
   * ignored and one committed schedule stands in for whichever route the board
   * asks about — the scenario, not the id, decides what comes back. There is one
   * committed schedule fixture; a per-route map goes here when a test needs two
   * routes to differ.
   *
   * Under `yesterday` the only thing that changes is service_date, set one day
   * before the date the golden live payload publishes. That is exactly the state
   * a phone is in when it was left on the counter overnight: a schedule from the
   * previous service day, and a live feed that has since rolled over.
   */
  if (rest.startsWith('api/departures/')) {
    /* `missing` means the API is down, and it has to mean that for BOTH
     * endpoints — a scenario where the live payload 500s while the schedule
     * answers 200 is not a state the box can be in, and a test written against
     * it proves nothing about the real one. */
    if (scenario === 'missing') {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end('{"error":"upstream"}')
      return
    }
    const doc = wireFormat(readJson(path.join(SYNTHETIC, 'departures-800.json')))
    if (scenario === 'yesterday') doc.service_date = DAY_BEFORE_GOLDEN
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(JSON.stringify(doc))
    return
  }

  const file = path.join(CLIENT, rest)
  if (!file.startsWith(CLIENT) || !existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }

  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})

server.listen(PORT, () => {
  process.stdout.write(`e2e fixtures server on http://localhost:${PORT}/\n`)
})
