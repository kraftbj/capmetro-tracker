/**
 * map.js as a map rather than a schematic.
 *
 * The panel used to plot timepoints only, on a frame that made no promise about
 * distance or direction. It now draws every stop the payload carries, in
 * stop_sequence order, on an aspect-correct projection with north up and a scale
 * bar — which is the difference between "which bus is further along" and "where is
 * she right now".
 *
 * Four of these tests exist because the geometry can be wrong while still looking
 * plausible, and a plausible-looking wrong map is the worst thing this panel could
 * ship: an unscaled longitude stretches every route 16% east-west, a path that
 * ignores stop_sequence draws a star instead of a street, a zero-span bounding box
 * divides by zero, and a stop with no fix lands on Null Island and drags the whole
 * frame with it. None of those throw. All of them lie.
 */
import { describe, expect, it } from 'vitest'
import { all, renderClient, textDeep } from './helpers/client.mjs'
import { goldenRoute4 } from './helpers/fixtures.mjs'

const client = renderClient(['format.js', 'adherence.js', 'states.js', 'map.js'])

const t = (name, fn) =>
  it(name, (ctx) => {
    if (!client.cmb) ctx.skip(client.reason)
    if (!client.cmb.map) ctx.skip('client scripts loaded but window.CMB.map is not defined')
    return fn(client.cmb, client.document)
  })

const draw = (cmb, document, data, direction = 'both') => {
  const host = document.createElement('section')
  cmb.map.render(host, data, { direction, status: 'ok' })
  return host
}

/** The stop chain the panel should draw: every stop of one direction, in sequence. */
const expectedChain = (data, dir) =>
  data.timepoints
    .filter((tp) => tp.direction_id === dir)
    .flatMap((tp) => [
      { lat: tp.lat, lon: tp.lon, seq: tp.stop_sequence, name: tp.stop_name },
      ...(tp.minor_stops || []).map((m) => ({
        lat: m.lat,
        lon: m.lon,
        seq: m.stop_sequence,
        name: m.stop_name,
      })),
    ])
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && !(s.lat === 0 && s.lon === 0))
    .sort((a, b) => a.seq - b.seq)

/** Points of the polyline drawn for one direction, as {x, y}. */
const pathPoints = (host, cls) => {
  const line = all(host, cls)[0]
  if (!line) return []
  return line.attributes.points
    .split(' ')
    .filter(Boolean)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number)
      return { x, y }
    })
}

/*
 * The panel's projection recovered from what it drew: two stops far apart in each
 * axis pin down x = a·lon + b and y = c·lat + d exactly, because the projection is
 * affine by construction. Everything else is then checked against it, so the tests
 * never have to restate the map's own arithmetic.
 */
const fitProjection = (stops, points) => {
  const far = (key) => {
    let best = 0
    for (let i = 1; i < stops.length; i++) {
      if (Math.abs(stops[i][key] - stops[0][key]) > Math.abs(stops[best][key] - stops[0][key])) best = i
    }
    return best
  }
  const i = far('lon')
  const j = far('lat')
  const a = (points[i].x - points[0].x) / (stops[i].lon - stops[0].lon)
  const c = (points[j].y - points[0].y) / (stops[j].lat - stops[0].lat)
  return {
    pxPerDegLon: a,
    pxPerDegLat: c,
    x: (lon) => points[0].x + a * (lon - stops[0].lon),
    y: (lat) => points[0].y + c * (lat - stops[0].lat),
  }
}

/** Every attribute value in a subtree, so a NaN cannot hide in one of them. */
const attrValues = (node) => [
  ...Object.values(node.attributes || {}),
  ...(node.children || []).flatMap(attrValues),
]

describe('the projection is a projection, not a stretch', () => {
  t('shortens a degree of longitude by cos(latitude), the way the ground does', (cmb, document) => {
    /*
     * Austin sits at 30.3°N, where a degree of longitude is 0.863 of a degree of
     * latitude. Scale both by the same number and route 4 comes out 16% too wide:
     * the 7th Street run reads as a straighter, longer road than it is, and every
     * distance judged off the picture is wrong in one axis only — the failure that
     * is hardest to notice and hardest to unlearn.
     */
    const data = goldenRoute4()
    const stops = expectedChain(data, 0)
    const fit = fitProjection(stops, pathPoints(draw(cmb, document, data, 0), 'map__route--out'))
    const lats = stops.map((s) => s.lat)
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2
    const ratio = Math.abs(fit.pxPerDegLon) / Math.abs(fit.pxPerDegLat)
    expect(ratio).toBeCloseTo(Math.cos((midLat * Math.PI) / 180), 3)
  })

  t('puts north at the top, so a bearing read off the panel is a real bearing', (cmb, document) => {
    const data = goldenRoute4()
    const stops = expectedChain(data, 0)
    const points = pathPoints(draw(cmb, document, data, 0), 'map__route--out')
    const north = stops.reduce((a, s, i) => (s.lat > stops[a].lat ? i : a), 0)
    const south = stops.reduce((a, s, i) => (s.lat < stops[a].lat ? i : a), 0)
    expect(points[north].y).toBeLessThan(points[south].y)
  })

  t('keeps one pixel worth the same distance in both axes', (cmb, document) => {
    /* An isotropic scale is what makes the scale bar mean anything off-axis. */
    const data = goldenRoute4()
    const stops = expectedChain(data, 0)
    const points = pathPoints(draw(cmb, document, data, 0), 'map__route--out')
    const fit = fitProjection(stops, points)
    const k = Math.abs(fit.pxPerDegLon) / Math.abs(fit.pxPerDegLat)
    const ratios = []
    for (let i = 1; i < stops.length; i++) {
      const dLon = (stops[i].lon - stops[i - 1].lon) * k
      const dLat = stops[i].lat - stops[i - 1].lat
      const ground = Math.hypot(dLon, dLat)
      const px = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
      if (ground > 1e-5) ratios.push(px / ground)
    }
    expect(ratios.length).toBeGreaterThan(5)
    expect(Math.max(...ratios) / Math.min(...ratios)).toBeLessThan(1.005)
  })
})

describe('the route path is the basemap', () => {
  t('walks every stop, minor ones included, in stop_sequence order', (cmb, document) => {
    /*
     * The old panel joined 6 timepoints and called it a route; the 42 stops between
     * them are what bend the line around the streets. Order matters as much as
     * count: minor stops are nested under the timepoint they follow, so anything
     * that trusts the nesting instead of the sequence draws the line back on itself
     * the moment a route publishes them unevenly.
     */
    const data = goldenRoute4()
    const stops = expectedChain(data, 0)
    const points = pathPoints(draw(cmb, document, data, 0), 'map__route--out')
    expect(stops.length).toBeGreaterThan(data.timepoints.length)
    expect(points).toHaveLength(stops.length)

    const fit = fitProjection(stops, points)
    stops.forEach((s, i) => {
      expect(points[i].x).toBeCloseTo(fit.x(s.lon), 2)
      expect(points[i].y).toBeCloseTo(fit.y(s.lat), 2)
    })
  })

  t('draws each direction as its own line, so an overlap is still two lines', (cmb, document) => {
    const host = draw(cmb, document, goldenRoute4())
    expect(all(host, 'map__route--out')).toHaveLength(1)
    expect(all(host, 'map__route--back')).toHaveLength(1)
  })

  t('marks timepoints apart from the minor stops between them', (cmb, document) => {
    const data = goldenRoute4()
    const host = draw(cmb, document, data, 0)
    const majors = all(host, 'map__stop--major')
    const minors = all(host, 'map__stop--minor')
    expect(majors).toHaveLength(data.timepoints.filter((tp) => tp.direction_id === 0).length)
    expect(minors.length).toBeGreaterThan(majors.length)
    expect(Number(minors[0].attributes.r)).toBeLessThan(Number(majors[0].attributes.r))
  })

  t('labels timepoints only, and never all of them at 412px', (cmb, document) => {
    const data = goldenRoute4()
    const host = draw(cmb, document, data)
    const labels = all(host, 'map__label').map((n) => n.textContent)
    const names = data.timepoints.map((tp) => tp.stop_name)
    expect(labels.length).toBeGreaterThan(0)
    labels.forEach((s) => expect(names).toContain(s))
    /* Campbell/5th is the turnaround: one place, two directions, one label. */
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('a reader can turn the picture into a distance and a direction', () => {
  t('draws a compass rose that says which way is north', (cmb, document) => {
    const host = draw(cmb, document, goldenRoute4())
    const rose = all(host, 'map__rose')
    expect(rose).toHaveLength(1)
    expect(textDeep(rose[0])).toBe('N')
  })

  t('draws a scale bar labelled in units a rider already thinks in', (cmb, document) => {
    const host = draw(cmb, document, goldenRoute4())
    const bar = all(host, 'map__scale')
    expect(bar).toHaveLength(1)
    expect(textDeep(bar[0])).toMatch(/^[\d.]+ (mi|ft)$/)
    expect(all(host, 'map__scale-bar').length).toBeGreaterThan(0)
  })

  t('captions what a reader cannot work out from the picture', (cmb, document) => {
    /*
     * The caption is a legend now, not a disclaimer. That there are no streets
     * under the drawing needs no words; which dots are timepoints does.
     */
    const text = textDeep(draw(cmb, document, goldenRoute4()))
    expect(text).toMatch(/larger dots are timepoints/i)
    expect(text).not.toMatch(/no basemap|no streets|no river|not a map of Austin/i)
  })
})

describe('degenerate payloads render something legible instead of nothing', () => {
  const noNaN = (host) => {
    attrValues(host).forEach((v) => {
      expect(String(v)).not.toMatch(/NaN|Infinity/)
    })
  }

  t('survives a zero-span bounding box, where the scale divides by zero', (cmb, document) => {
    /*
     * Every stop and every bus at one coordinate is what a yard looks like before
     * pull-out. span is 0, so w/span is Infinity and every coordinate becomes NaN —
     * an SVG full of NaN draws nothing at all and reports no error.
     */
    const data = goldenRoute4()
    data.timepoints.forEach((tp) => {
      tp.lat = 30.2672
      tp.lon = -97.7431
      ;(tp.minor_stops || []).forEach((m) => {
        m.lat = 30.2672
        m.lon = -97.7431
      })
    })
    data.vehicles.forEach((v) => {
      v.position.lat = 30.2672
      v.position.lon = -97.7431
    })
    const host = draw(cmb, document, data)
    noNaN(host)
    expect(all(host, 'map__svg')).toHaveLength(1)
    expect(all(host, 'map__stop--major').length).toBeGreaterThan(0)
    expect(all(host, 'map__chiptext').length).toBe(data.vehicles.length)
  })

  t('skips a stop with no fix rather than plotting it off the coast of Africa', (cmb, document) => {
    const data = goldenRoute4()
    const first = data.timepoints.find((tp) => tp.direction_id === 0)
    first.minor_stops[0].lat = null
    first.minor_stops[0].lon = null
    first.minor_stops[1].lat = 0
    first.minor_stops[1].lon = 0

    const stops = expectedChain(data, 0)
    const points = pathPoints(draw(cmb, document, data, 0), 'map__route--out')
    expect(points).toHaveLength(stops.length)

    const fit = fitProjection(stops, points)
    /* Null Island is 3,000km south: had either stop been kept, this frame would
     * have collapsed the whole route into a couple of pixels. */
    expect(Math.abs(fit.pxPerDegLat)).toBeGreaterThan(1000)
    points.forEach((p) => expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true))
  })

  t('renders a one-stop route as one stop, not as an exception', (cmb, document) => {
    const data = goldenRoute4()
    data.timepoints = [{ ...data.timepoints[0], minor_stops: [] }]
    data.vehicles = []
    const host = draw(cmb, document, data)
    noNaN(host)
    expect(all(host, 'map__stop--major')).toHaveLength(1)
    expect(all(host, 'map__route--out')).toHaveLength(0)
    expect(textDeep(host)).toMatch(/no vehicle is reporting/i)
  })

  t('draws the route with no vehicles on it, and says that is what happened', (cmb, document) => {
    const data = goldenRoute4()
    data.vehicles = []
    const host = draw(cmb, document, data)
    expect(all(host, 'map__route--out')).toHaveLength(1)
    expect(all(host, 'map__chiptext')).toHaveLength(0)
    expect(textDeep(host)).toMatch(/No vehicle is reporting a position/i)
  })

  t('states the absence when nothing has a position at all', (cmb, document) => {
    const data = goldenRoute4()
    data.timepoints = []
    data.vehicles = []
    const host = draw(cmb, document, data)
    expect(all(host, 'map__svg')).toHaveLength(0)
    expect(textDeep(host)).toMatch(/Nothing to plot yet/i)
  })
})
