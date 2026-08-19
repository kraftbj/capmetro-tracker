/** Fixture loading. Every test input is a committed file; nothing hits the network. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './optional.mjs'

export const FEEDS = path.join(ROOT, 'tests/fixtures/feeds-20260819')
export const GOLDEN = path.join(ROOT, 'tests/fixtures/golden')
export const SYNTHETIC = path.join(ROOT, 'tests/fixtures/synthetic')

export const readText = (p) => readFileSync(p, 'utf8')
export const readJson = (p) => JSON.parse(readText(p))

export const feed = (name) => readJson(path.join(FEEDS, name))
export const synthetic = (name) => readJson(path.join(SYNTHETIC, name))
export const goldenRoute4 = () => readJson(path.join(GOLDEN, 'route-4-20260819.json'))

/** Fixtures carry _comment/_expected/_now. Strip before schema-shaped assertions. */
export function stripTestMetadata(doc) {
  if (Array.isArray(doc)) return doc.map(stripTestMetadata)
  if (doc && typeof doc === 'object') {
    return Object.fromEntries(
      Object.entries(doc)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, stripTestMetadata(v)]),
    )
  }
  return doc
}

/** Vehicle entries from a GTFS-RT vehiclepositions envelope. */
export const vehicles = (envelope) => envelope.entity.map((e) => e.vehicle)
/** tripUpdate entries from a GTFS-RT tripupdates envelope. */
export const tripUpdates = (envelope) => envelope.entity.map((e) => e.tripUpdate)
