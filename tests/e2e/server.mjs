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
  /*
   * And the same arrangement for the stops view, whose route 4 schedule is the
   * turnaround trim rather than the golden service day.
   *
   * Named for the fixture rather than for the view, because `stops` is an app
   * path verb now and a scenario may not be one — the client reads the first
   * such segment as the start of the app path, so a prefix called `stops` would
   * resolve every asset against the wrong base. The guard below enforces it.
   */
  turnaround: () => ({ status: 200, body: JSON.stringify(readJson(GOLDEN)) }),
  turnarounddead: () => ({ status: 200, body: JSON.stringify(wireFormat(readJson(path.join(SYNTHETIC, 'route-4-dead-cron.json')))) }),
}

/* Which scenarios take their schedules from which committed set. */
const CHAIN_SCENARIOS = { chain: true, chaindead: true }
const STOPS_SCENARIOS = { turnaround: true, turnarounddead: true }

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

/*
 * The schedule documents the stops view needs.
 *
 * A stop card cannot fall back to the bundled route fixture: it needs a whole
 * service day of scheduled departures at one stop, and only this endpoint has
 * that. Route 4 is served by the turnaround trim, because the turnaround is the
 * case the view exists for; route 800 by the ordinary mid-route trim, so a
 * non-turnaround card is on screen next to it.
 *
 * Behind the `stops` prefix rather than by default, for the reason the chain
 * scenarios give: route 4 already answers with a whole golden service day that
 * the trip view is asserted against, and the turnaround trim cannot stand in for
 * it. Route 837 is only in this set, so it needs no prefix and is served
 * everywhere.
 */
const STOPS_DEPARTURES = {
  4: 'departures-4-turnaround.json',
  800: 'departures-800.json',
  837: 'departures-837-turnaround-canceled.json',
}

/*
 * A schedule for a service day that is not the one the route payload reports.
 * The client must keep asking for it on the timer rather than trusting it for
 * the session — and must not ask for it on every repaint while doing so, which
 * is how the fetch-and-render loop this suite guards against would come back.
 */
const YESTERDAY_ROUTE = '7'

/*
 * A route whose schedule loads exactly once; every request after that is a 500.
 *
 * ONE COUNTER PER ROUTE ID, and any id starting `flaky` is one of these, so each
 * test picks its own and no two share anything. It used to be a single flag
 * reset through GET /__reset, which two tests running in parallel could reset out
 * from under each other: the second page then got the 500 meant for the first,
 * and a test about a cached schedule failed for having no schedule at all. Test
 * infrastructure that fails for reasons of its own is the thing hardest to
 * debug, because the failure names the wrong culprit.
 */
const isFlakyRoute = (id) => /^flaky/.test(id)
const flakyServed = new Map()

/*
 * EVERY LOOKUP KEYED BY SOMETHING OFF THE WIRE GOES THROUGH HERE.
 *
 * Route ids and path prefixes arrive from a link, and the suite has tests that
 * deliberately put `constructor` in one. `TABLE['constructor']` is the Object
 * function: truthy, so a 404 branch never fires, and then path.join() is handed
 * a function and throws inside the request handler. An uncaught throw there
 * takes the process down, so a single hostile-input test killed the fixture
 * server and every test scheduled after it failed for a reason with nothing to
 * do with what it was testing. A suite that dies mid-run is worse than one that
 * fails, because the cause is invisible.
 */
const lookup = (table, key) =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined

/*
 * A live route payload for route 837 whose vehicle is genuinely on the inbound
 * leg of a northbound departure from Republic Square.
 *
 * Without this every `api/route/*` request answers with the golden route 4 file,
 * whose vehicles are on 10:xx route 4 trips, so no plan departure ever resolves a
 * live bus and the turnaround's whole point — naming the bus coming the other way
 * — went untested end to end. Built from the departures fixture rather than
 * committed, so the two cannot drift.
 *
 * `confidence: 'low'` because that is what every real 837 block in the
 * 2026-08-19 capture carries, and it is what the hedge is for.
 */
function turnaroundRoute() {
  const dep = wireFormat(readJson(path.join(SYNTHETIC, STOPS_DEPARTURES[837])))
  const stop = dep._expected?.turnaround_stop_id ?? '2112'
  const tripAt = (seconds, dir) => {
    const row = dep.departures[stop].find(
      ([s, i]) => s === seconds && dep.trips[i].direction_id === dir,
    )
    return dep.trips[row[1]]
  }
  const golden = readJson(GOLDEN)
  /* A departure that is still ahead of the golden file's clock and is running,
   * so the card actually has a live bus to name. */
  const nowSeconds = golden.generated_at - dep.service_day_start_epoch
  const pair = readJson(path.join(SYNTHETIC, STOPS_DEPARTURES[837]))._expected.pairs.find(
    (x) =>
      x.inbound_arrival_s !== null &&
      x.outbound_departure_s > nowSeconds &&
      !tripAt(x.outbound_departure_s, 1).canceled,
  )
  const outbound = tripAt(pair.outbound_departure_s, 1)
  const inbound = tripAt(pair.inbound_arrival_s, 0)

  return {
    ...golden,
    route: { ...golden.route, id: '837', short_name: '837', long_name: 'Expo Center' },
    vehicles: [
      {
        vehicle_id: '8021',
        label: '8021',
        route_id: '837',
        route_short_name: '837',
        in_service: true,
        position: { lat: 30.2685, lon: -97.7462, bearing: 180, speed: 8 },
        position_at: golden.generated_at,
        trip: {
          trip_id: inbound.id,
          start_time: inbound.start_time,
          start_epoch: dep.service_day_start_epoch,
          direction_id: inbound.direction_id,
          headsign: inbound.headsign,
          schedule_relationship: 'SCHEDULED',
        },
        progress: { current_stop_sequence: 18, current_stop_id: '6502', current_status: 'IN_TRANSIT_TO' },
        pattern: { is_baseline: true, is_special: false, trips_in_pattern: 40, adds: [], skips: [] },
        block: {
          block_id: inbound.block_id,
          confidence: 'low',
          spans_routes: false,
          route_ids: ['837'],
          is_last_trip: false,
          next_trip: {
            trip_id: outbound.id,
            route_id: '837',
            route_short_name: '837',
            direction_id: 1,
            start_time: outbound.start_time,
            start_epoch: dep.service_day_start_epoch + pair.outbound_departure_s,
            start_stop_id: stop,
            start_stop_name: '5th/Guadalupe',
            is_direction_flip: true,
          },
        },
        adherence: { state: 'late', seconds: 210, glyph: 'up-triangle', reason: null, against: null },
      },
    ],
  }
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS)

/*
 * A scenario may not be named after an app path. The client finds the directory
 * it is served from by scanning for the first `route`/`buses`/`trip`/`saved`
 * segment, so a scenario called one of those would be read as the start of the
 * app path and every asset would resolve against the wrong base -- a blank board
 * with nothing in the console. Cheap to prevent, invisible to debug.
 */
const APP_VERBS = ['route', 'buses', 'trip', 'saved', 'stops']
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
  /* Through lookup(), never a bare index: `/valueOf/index.html` would otherwise
   * resolve to a function, be called as a scenario, and take the whole fixture
   * server down mid-run — the same class of bug the client fixes for `?stop=`. */
  const scenario = lookup(SCENARIOS, parts[0]) ? parts.shift() : 'fresh'
  const rest = parts.join('/') || 'index.html'

  if (rest.startsWith('api/departures/')) {
    const id = path.basename(rest, '.json')
    /*
     * A schedule that loads once and then cannot be re-fetched, dated for a
     * service day that is not the bundled fixture's. Models the failure exactly:
     * a dropped route request makes the client fall back to the frozen capture,
     * and if that date were read as "today" every cached schedule would look
     * expired. Evicting one before its replacement lands then loses a whole
     * service day to a connection that has already proved it cannot fetch.
     */
    if (isFlakyRoute(id)) {
      if (flakyServed.get(id)) {
        res.writeHead(500, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
        res.end('{"error":"gone"}')
        return
      }
      flakyServed.set(id, true)
      const doc = wireFormat(readJson(path.join(SYNTHETIC, STOPS_DEPARTURES[4])))
      doc.route_id = id
      doc.service_date = '20260818'
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(JSON.stringify(doc))
      return
    }
    if (id === YESTERDAY_ROUTE) {
      const doc = wireFormat(readJson(path.join(SYNTHETIC, STOPS_DEPARTURES[4])))
      doc.route_id = YESTERDAY_ROUTE
      doc.service_date = '20260818'
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(JSON.stringify(doc))
      return
    }
    /* Route 837 exists only in the stops set, so it needs no prefix. */
    if (id === '837' || STOPS_SCENARIOS[scenario]) {
      const file = lookup(STOPS_DEPARTURES, id)
      if (file) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
        res.end(JSON.stringify(wireFormat(readJson(path.join(SYNTHETIC, file)))))
        return
      }
    }
  }

  if (rest.startsWith('api/route/')) {
    /* The one live payload with a bus genuinely on the inbound leg of a
     * northbound departure, which is what the turnaround card names. */
    if (path.basename(rest, '.json') === '837') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(JSON.stringify(turnaroundRoute()))
      return
    }
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
  const file = /^(route|buses|trip|saved|stops)(\/|$)/.test(rest)
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
