/**
 * fmt.directionsInOrder / directionIds / directionsForRows / directionTagFor.
 *
 * These four decide, for every panel, which directions exist and what each one is called.
 * They shipped with no test at all, and two bugs came straight out of that gap:
 *
 *   - The ladder hard-coded [0, 1]. Routes 466 and 642 publish one direction, so BOTH mode
 *     drew a phantom second ladder reading "No timepoints published for direction 1".
 *   - Moving the rows onto the published list then dropped any bus whose direction the
 *     route does not publish. Trimming route 4's list to one direction made two of its six
 *     rows vanish while the header above went on counting them.
 *
 * The second bug is why there are two lists rather than one. The ladder needs the PUBLISHED
 * directions, because a direction with no timepoints has no ladder to draw. The rows need
 * every direction any VEHICLE reports, because a bus with no group to land in disappears.
 * Collapsing them back into one function reintroduces one bug or the other, so each is
 * pinned here separately.
 */
import { describe, expect, it } from 'vitest'
import { gateClient, loadClient } from './helpers/client.mjs'

const client = loadClient(['format.js'])
const t = gateClient(client, 'fmt', it)

describe('the published list, which is what the ladder draws', () => {
  t('returns route.directions sorted ascending by id', (fmt) => {
    const data = { route: { directions: [{ id: 1, headsign: 'B' }, { id: 0, headsign: 'A' }] } }
    expect(fmt.directionIds(data)).toEqual([0, 1])
  })

  t('does not mutate the payload it was handed', (fmt) => {
    const data = { route: { directions: [{ id: 1, headsign: 'B' }, { id: 0, headsign: 'A' }] } }
    fmt.directionsInOrder(data)
    expect(data.route.directions.map((d) => d.id)).toEqual([1, 0])
  })

  t('names exactly the directions the route publishes, not one more', (fmt) => {
    /* The phantom-ladder bug in one assertion: route 466 publishes direction 0 only. */
    const data = {
      route: { directions: [{ id: 0, headsign: '466 Northbound' }] },
      vehicles: [{ trip: { direction_id: 0 } }],
    }
    expect(fmt.directionIds(data)).toEqual([0])
  })

  t('derives the directions from the vehicles when route.directions is missing', (fmt) => {
    const data = {
      vehicles: [
        { trip: { direction_id: 1, headsign: 'X EB' } },
        { trip: { direction_id: 0, headsign: 'Y WB' } },
      ],
    }
    expect(fmt.directionsInOrder(data)).toEqual([
      { id: 0, headsign: 'Y WB' },
      { id: 1, headsign: 'X EB' },
    ])
  })

  t('returns NUMBERS from the fallback, because the panels compare with ===', (fmt) => {
    /*
     * Load-bearing. ladder.js filters `v.trip.direction_id === dir` and Object.keys yields
     * strings, so a string id here would silently match nothing and draw an empty ladder.
     */
    const ids = fmt.directionIds({ vehicles: [{ trip: { direction_id: 1 } }] })
    expect(typeof ids[0]).toBe('number')
  })

  t('skips a vehicle with no trip, and a null or undefined direction_id', (fmt) => {
    const data = { vehicles: [{}, { trip: {} }, { trip: { direction_id: null } }] }
    expect(fmt.directionsInOrder(data)).toEqual([])
  })

  t('returns an empty list rather than throwing on a null payload', (fmt) => {
    expect(fmt.directionsInOrder(null)).toEqual([])
    expect(fmt.directionIds(undefined)).toEqual([])
  })
})

describe('the rows list, which must never lose a bus', () => {
  t('adds a direction the vehicles report and the route does not publish', (fmt) => {
    /*
     * The confirmed regression. Route 4 publishes both directions; trim it to one and the
     * bus running the other still has to land somewhere.
     */
    const data = {
      route: { directions: [{ id: 0, headsign: '4 Mopac WB' }] },
      vehicles: [{ trip: { direction_id: 0 } }, { trip: { direction_id: 1, headsign: '4 Shady EB' } }],
    }
    expect(fmt.directionsForRows(data).map((d) => d.id)).toEqual([0, 1])
    expect(fmt.directionsForRows(data)[1].headsign).toBe('4 Shady EB')
  })

  t('is the same list as the ladder when the payload is complete', (fmt) => {
    /* The union must not perturb the normal case, or the two panels stop lining up. */
    const data = {
      route: { directions: [{ id: 0, headsign: 'A WB' }, { id: 1, headsign: 'B EB' }] },
      vehicles: [{ trip: { direction_id: 0 } }, { trip: { direction_id: 1 } }],
    }
    expect(fmt.directionsForRows(data)).toEqual(fmt.directionsInOrder(data))
  })

  t('keeps the published headsign when a vehicle reports the same direction', (fmt) => {
    const data = {
      route: { directions: [{ id: 0, headsign: '4 Mopac WB' }] },
      vehicles: [{ trip: { direction_id: 0, headsign: 'something else' } }],
    }
    expect(fmt.directionsForRows(data)).toEqual([{ id: 0, headsign: '4 Mopac WB' }])
  })

  t('stays sorted by id when the extra direction sorts before the published one', (fmt) => {
    const data = {
      route: { directions: [{ id: 1, headsign: 'B EB' }] },
      vehicles: [{ trip: { direction_id: 0, headsign: 'A WB' } }],
    }
    expect(fmt.directionsForRows(data).map((d) => d.id)).toEqual([0, 1])
  })
})

describe('the tag, which must read the same in all three panels', () => {
  t('takes the compass word out of the headsign', (fmt) => {
    const data = { route: { directions: [{ id: 0, headsign: '4 Mopac WB' }, { id: 1, headsign: '4 Shady EB' }] } }
    expect(fmt.directionTagFor(data, 0)).toBe('WB')
    expect(fmt.directionTagFor(data, 1)).toBe('EB')
  })

  t('falls back to A and B when the headsign carries no compass word', (fmt) => {
    const data = { route: { directions: [{ id: 0, headsign: 'Downtown' }, { id: 1, headsign: 'Airport' }] } }
    expect(fmt.directionTagFor(data, 0)).toBe('A')
    expect(fmt.directionTagFor(data, 1)).toBe('B')
  })

  t('tags a direction the route does not publish, because the rows still group it', (fmt) => {
    const data = {
      route: { directions: [{ id: 0, headsign: '4 Mopac WB' }] },
      vehicles: [{ trip: { direction_id: 1, headsign: '4 Shady EB' } }],
    }
    expect(fmt.directionTagFor(data, 1)).toBe('EB')
  })
})
