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
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS)

/*
 * The schedule documents the stops view needs.
 *
 * A stop card cannot fall back to the bundled route fixture: it needs a whole
 * service day of scheduled departures at one stop, and only this endpoint has
 * that. Route 4 is served by the turnaround trim, because the turnaround is the
 * case the view exists for; route 800 by the ordinary mid-route trim, so a
 * non-turnaround card is on screen next to it.
 */
const DEPARTURES = {
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
  const dep = wireFormat(readJson(path.join(SYNTHETIC, DEPARTURES[837])))
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
  const pair = readJson(path.join(SYNTHETIC, DEPARTURES[837]))._expected.pairs.find(
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

/*
 * EVERY LOOKUP KEYED BY SOMETHING OFF THE WIRE GOES THROUGH HERE.
 *
 * Route ids and path prefixes arrive from a '#plan=' fragment, and the suite has
 * a test that deliberately puts `constructor` in one. `DEPARTURES['constructor']`
 * is the Object function: truthy, so the 404 branch never fired, and then
 * path.join() was handed a function and threw inside the request handler. An
 * uncaught throw there takes the process down, so a single hostile-input test
 * killed the fixture server and every test scheduled after it failed for a
 * reason with nothing to do with what it was testing. A suite that dies mid-run
 * is worse than one that fails, because the cause is invisible.
 */
const lookup = (table, key) =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined

function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (url.pathname === '/__reset') {
    flakyServed.clear()
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }
  const parts = url.pathname.split('/').filter(Boolean)
  const scenario = lookup(SCENARIOS, parts[0]) ? parts.shift() : 'fresh'
  const rest = parts.join('/') || 'index.html'

  if (rest.startsWith('api/departures/')) {
    const id = path.basename(rest, '.json')
    /*
     * A schedule that loads once and then cannot be re-fetched, dated for a
     * service day that is not the bundled fixture's.
     *
     * This models the failure exactly: a dropped route request makes the client
     * fall back to the frozen 20260819 fixture, and if that date is read as
     * "today" every cached schedule looks expired. Evicting one before its
     * replacement lands then loses a whole service day to a connection that has
     * already proved it cannot fetch anything.
     */
    if (isFlakyRoute(id)) {
      if (flakyServed.get(id)) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end('{"error":"gone"}')
        return
      }
      flakyServed.set(id, true)
      const doc = wireFormat(readJson(path.join(SYNTHETIC, DEPARTURES[4])))
      doc.route_id = id
      doc.service_date = '20260818'
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(JSON.stringify(doc))
      return
    }
    if (id === YESTERDAY_ROUTE) {
      const doc = wireFormat(readJson(path.join(SYNTHETIC, DEPARTURES[4])))
      doc.route_id = YESTERDAY_ROUTE
      doc.service_date = '20260818'
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(JSON.stringify(doc))
      return
    }
    const file = lookup(DEPARTURES, id)
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end('{"error":"no schedule for that route"}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(JSON.stringify(wireFormat(readJson(path.join(SYNTHETIC, file)))))
    return
  }

  if (rest.startsWith('api/route/')) {
    if (path.basename(rest, '.json') === '837') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(JSON.stringify(turnaroundRoute()))
      return
    }
    const { status, body } = lookup(SCENARIOS, scenario)()
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(body)
    return
  }

  const file = path.join(CLIENT, rest)
  if (!file.startsWith(CLIENT) || !existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }

  res.writeHead(200, { 'Content-Type': lookup(TYPES, path.extname(file)) ?? 'application/octet-stream' })
  res.end(readFileSync(file))
}

const server = createServer((req, res) => {
  /*
   * The belt to the braces above. The guarded lookups close the hole that was
   * actually found; this makes the next one a 500 on one request instead of a
   * dead server and a screenful of unrelated failures.
   */
  try {
    handle(req, res)
  } catch (err) {
    process.stderr.write(`fixture server: ${req.url} -> ${err && err.message}\n`)
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end('{"error":"fixture server refused that request"}')
  }
})

server.listen(PORT, () => {
  process.stdout.write(`e2e fixtures server on http://localhost:${PORT}/\n`)
})
