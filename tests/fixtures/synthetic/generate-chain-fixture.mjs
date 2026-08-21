/**
 * Builds `chain-800-to-4.json` by trimming two real generated departure boards.
 *
 * Committed alongside the fixture for the same reason `golden/generate-reference.py`
 * is: when CapMetro republishes and the trim has to be rebuilt, the next person
 * needs the rule that produced it, not an opaque 40 KB of JSON.
 *
 * The pair is not arbitrary. Routes 800 and 4 share ZERO stop ids, and they are the
 * "800 to the 4" of the original request, so this fixture is the one that proves a
 * transfer cannot be found by intersecting stop ids. They meet at Pleasant Valley
 * where the MetroRapid platform and the local kerb are tens of metres apart under
 * different ids.
 *
 * Run against a generated webroot:
 *   node tests/fixtures/synthetic/generate-chain-fixture.mjs .local/test-webroot
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const webroot = process.argv[2] ?? '.local/test-webroot'
const read = (id) =>
  JSON.parse(readFileSync(path.join(webroot, 'api', 'departures', `${id}.json`), 'utf8'))

/**
 * Keep a subset of a departures document's trips and renumber every reference.
 *
 * `departures[stop]` rows carry a trip INDEX, so dropping trips without
 * renumbering would leave every surviving row pointing at the wrong headsign —
 * the exact class of silent breakage the fixture exists to catch.
 */
function trim(doc, keepTrip) {
  const keptIndexes = []
  doc.trips.forEach((t, i) => {
    if (keepTrip(t, i)) keptIndexes.push(i)
  })
  const remap = new Map(keptIndexes.map((old, next) => [old, next]))
  const trips = keptIndexes.map((i) => doc.trips[i])

  const departures = {}
  for (const [stopId, rows] of Object.entries(doc.departures)) {
    const kept = rows
      .filter((r) => remap.has(r[1]))
      .map((r) => [r[0], remap.get(r[1])])
    if (kept.length) departures[stopId] = kept
  }
  /* A stop with nothing left leaving it is not a stop on this trim. */
  const stops = doc.stops.filter((s) => departures[s.stop_id])
  return { ...doc, stops, trips, departures }
}

/* The 07:52:09 southbound from Simond SB is the contract's own worked example.
   Two neighbors either side keep the trip indices off zero. */
const WATCHED_TRIP = '3010894_22201'
const dep800 = read('800')
const watchedIndex = dep800.trips.findIndex((t) => t.id === WATCHED_TRIP)
if (watchedIndex < 0) throw new Error(`trip ${WATCHED_TRIP} is not in this route 800 board`)

const trimmed800 = trim(dep800, (t, i) => Math.abs(i - watchedIndex) <= 2)

/* Route 4 needs enough of the morning that the onward buses the 800 can actually
   reach are present in both directions. */
const dep4 = read('4')
const inMorning = (t) => {
  const [h, m] = t.start_time.split(':').map(Number)
  const s = h * 3600 + m * 60
  return s >= 7.75 * 3600 && s <= 9 * 3600
}
const trimmed4 = trim(dep4, inMorning)

const out = {
  _comment:
    'Transfer chains: the 07:52:09 route 800 SB from Simond SB (6293) and the route 4 ' +
    'buses it can reach. Routes 800 and 4 share NO stop ids — they meet at Pleasant ' +
    'Valley where the MetroRapid platform (1369/1349) and the local kerb (938/3337) are ' +
    'tens of metres apart — so a transfer found by intersecting stop ids finds nothing ' +
    'here. That is the case this fixture exists for.',
  _now: dep800.service_day_start_epoch + 7 * 3600 + 30 * 60,
  _expected: {
    watched_trip: WATCHED_TRIP,
    watched_stop_id: '6293',
    watched_time: '07:52:09',
    shared_stop_ids: 0,
    note: 'connections() must still return transfers, all of them across a walk.',
  },
  departures: { 800: trimmed800, 4: trimmed4 },
}

writeFileSync(path.join(HERE, 'chain-800-to-4.json'), JSON.stringify(out, null, 1) + '\n')
console.log(
  `800: ${trimmed800.trips.length} trips / ${trimmed800.stops.length} stop rows; ` +
    `4: ${trimmed4.trips.length} trips / ${trimmed4.stops.length} stop rows`
)
