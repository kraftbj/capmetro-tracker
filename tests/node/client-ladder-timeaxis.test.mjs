/**
 * Task D3, second cut: the ladder's x axis is clock time, not signed deviation.
 *
 * The old axis put every live bus in one column, which is exactly the layout
 * that cannot show bunching or a headway gap — the two things a dispatch board
 * exists to show. Time across and route down draws scheduled trips as
 * diagonals, and the horizontal gap between a bus and its own diagonal becomes
 * the lateness.
 *
 * Four facts are worth a regression test, because each one is a place where a
 * plausible-looking render would be wrong rather than ugly:
 *
 *   1. `offsets[i]` is null when a trip does not serve timepoint i (§3.2). That
 *      vertex is omitted; it must not become a gap the schedule never claimed.
 *   2. A direction may carry empty `timepoint_stop_ids` or empty `trips`. The
 *      contract guarantees the key rather than omitting it, so the client draws
 *      an empty state and never a blank box.
 *   3. The window comes from `schedule.window`, never from a client constant.
 *      Widening it is a build change and nothing else.
 *   4. `staleness.suppress_adherence` still forbids every lateness reading —
 *      including the drawn one, which is a reading whether or not a number is
 *      printed beside it. The clock gridlines stay: they are facts about the
 *      clock, not about any bus.
 *
 * The pure geometry is exercised through window.CMB.ladder. The suppression
 * rule lives inside the renderer, so this file carries a DOM stub thin enough
 * to run it — createElementNS and a class list, and nothing more.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { gateClient, loadClient } from './helpers/client.mjs'
import { goldenRoute4 } from './helpers/fixtures.mjs'
import { ROOT } from './helpers/optional.mjs'

const client = loadClient(['format.js', 'adherence.js', 'states.js', 'ladder.js'])
const t = gateClient(client, 'ladder', it)

const NUMERIC_LATENESS = /[+\-−]\s?\d+\s?m/

/* A window that is deliberately not the contract's current 900 / 2700. */
const WIDE = { from: 1787150439, until: 1787157639, before_s: 1800, after_s: 5400 }

/** The three timepoint rows the geometry tests index against. */
const TP_Y = [48, 92, 136]

const scheduleOf = (directions, window = WIDE) => ({ window, directions })

/* ---- pure geometry ---------------------------------------------------- */

describe('the window is read off the payload, never assumed', () => {
  t('takes both bounds from schedule.window on the golden route 4 file', (ns) => {
    const data = goldenRoute4()
    expect(ns.scheduleWindow(data)).toEqual({
      from: data.schedule.window.from,
      until: data.schedule.window.until,
    })
  })

  t('follows a wider window without a client change', (ns) => {
    const scale = ns.timeScale(ns.scheduleWindow({ schedule: scheduleOf([]) }), 138, 376)
    expect(scale.x(WIDE.from)).toBeCloseTo(138, 6)
    expect(scale.x(WIDE.until)).toBeCloseTo(376, 6)
    /* the midpoint of a 2-hour window is an hour in, not 900s in */
    expect(scale.x(WIDE.from + (WIDE.until - WIDE.from) / 2)).toBeCloseTo(257, 6)
  })

  t('places generated_at by the payload window rather than a fixed fraction', (ns) => {
    const narrow = { from: 1787151339, until: 1787154939 }
    const at = 1787152239
    const nudged = ns.timeScale({ from: narrow.from - 3600, until: narrow.until }, 138, 376)
    const plain = ns.timeScale(narrow, 138, 376)
    expect(plain.x(at)).not.toBeCloseTo(nudged.x(at), 1)
  })

  t('reports no window at all rather than inventing one', (ns) => {
    expect(ns.scheduleWindow({})).toBeNull()
    expect(ns.scheduleWindow({ schedule: {} })).toBeNull()
    expect(ns.scheduleWindow({ schedule: { window: { from: 5, until: 5 } } })).toBeNull()
  })

  t('keeps every clock gridline inside the payload window', (ns) => {
    const ticks = ns.axisTicks(WIDE.from, WIDE.until, 238)
    expect(ticks.length).toBeGreaterThan(1)
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(WIDE.from)
      expect(tick).toBeLessThanOrEqual(WIDE.until)
    }
  })

  t('widens the gridline step rather than letting two clock labels touch', (ns) => {
    const narrow = ns.axisTicks(WIDE.from, WIDE.from + 3600, 238)
    const wide = ns.axisTicks(WIDE.from, WIDE.until, 238)
    const stepOf = (ticks) => ticks[1] - ticks[0]
    expect(stepOf(wide)).toBeGreaterThan(stepOf(narrow))
    expect((stepOf(wide) / (WIDE.until - WIDE.from)) * 238).toBeGreaterThanOrEqual(56)
  })
})

describe('a null offset omits the vertex, it does not break the diagonal', () => {
  const scale = (ns) => ns.timeScale(WIDE, 138, 376)

  t('drops an interior timepoint the trip does not serve and joins straight across', (ns) => {
    const pts = ns.tripPoints(['t', WIDE.from, [0, null, 1200]], TP_Y, scale(ns))
    expect(pts.map((p) => p.y)).toEqual([TP_Y[0], TP_Y[2]])
    expect(pts).toHaveLength(2)
  })

  t('starts at the first served timepoint when the leading offsets are null', (ns) => {
    /* the shape route 333 direction 1 actually publishes */
    const pts = ns.tripPoints(['t', WIDE.from, [null, null, 360]], TP_Y, scale(ns))
    expect(pts).toHaveLength(1)
    expect(pts[0].y).toBe(TP_Y[2])
    expect(pts[0].t).toBe(WIDE.from + 360)
  })

  t('stops at the last served timepoint when the trailing offsets are null', (ns) => {
    /* the shape route 550 direction 1 actually publishes */
    const pts = ns.tripPoints(['t', WIDE.from, [0, 240, null]], TP_Y, scale(ns))
    expect(pts.map((p) => p.y)).toEqual([TP_Y[0], TP_Y[1]])
  })

  t('puts each kept point at start_epoch plus its own offset', (ns) => {
    const s = scale(ns)
    const pts = ns.tripPoints(['t', WIDE.from, [0, null, 1200]], TP_Y, s)
    expect(pts.map((p) => p.t)).toEqual([WIDE.from, WIDE.from + 1200])
    expect(pts.map((p) => p.x)).toEqual([s.x(WIDE.from), s.x(WIDE.from + 1200)])
  })

  t('yields too few points to be a line when only one timepoint survives', (ns) => {
    /* route 640 direction 0 publishes exactly this, twice */
    expect(ns.tripPoints(['t', WIDE.from, [174, null]], TP_Y, scale(ns)).length).toBeLessThan(2)
  })

  t('anchors a bus stem on the diagonal even across an omitted timepoint', (ns) => {
    const s = scale(ns)
    const pts = ns.tripPoints(['t', WIDE.from, [0, null, 1200]], TP_Y, s)
    const mid = ns.xAtY(pts, (TP_Y[0] + TP_Y[2]) / 2)
    expect(mid).toBeCloseTo((pts[0].x + pts[1].x) / 2, 6)
  })

  t('refuses to anchor a stem outside the stretch the trip actually covers', (ns) => {
    const pts = ns.tripPoints(['t', WIDE.from, [null, 240, 1200]], TP_Y, scale(ns))
    expect(ns.xAtY(pts, TP_Y[0])).toBeNull()
    expect(ns.xAtY([], TP_Y[0])).toBeNull()
  })
})

describe('a direction with nothing in it is a state, not a crash', () => {
  const empty = { direction_id: 1, timepoint_stop_ids: [], trips: [] }

  t('returns the entry the contract guarantees rather than treating it as absent', (ns) => {
    const dir = ns.scheduleDirection({ schedule: scheduleOf([empty]) }, 1)
    expect(dir).not.toBeNull()
    expect(dir.trips).toEqual([])
    expect(dir.timepoint_stop_ids).toEqual([])
  })

  t('says so when a route does not run the direction at all', (ns) => {
    expect(ns.scheduleDirection({ schedule: scheduleOf([empty]) }, 0)).toBeNull()
    expect(ns.scheduleDirection({}, 0)).toBeNull()
  })

  t('draws no diagonal from an empty trip list', (ns) => {
    const s = ns.timeScale(WIDE, 138, 376)
    expect(empty.trips.map((trip) => ns.tripPoints(trip, TP_Y, s))).toEqual([])
  })
})

/* ---- the renderer ----------------------------------------------------- */

/*
 * A DOM stub that goes one step further than tests/node/helpers/client.mjs:
 * the ladder draws SVG, so it needs createElementNS, a classList and a style
 * bag. Everything a real page does beyond that — layout, hit testing, events —
 * belongs to the Playwright suite, which drives the actual board.
 */
function sandbox() {
  const element = (tag, ns) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      namespaceURI: ns || null,
      className: '',
      textContent: '',
      children: [],
      attributes: {},
      style: {},
      firstChild: null,
      parentNode: null,
      classList: {
        add(cls) { node.className = node.className ? `${node.className} ${cls}` : cls },
      },
      setAttribute(k, v) {
        node.attributes[k] = String(v)
        if (k === 'class') node.className = String(v)
      },
      getAttribute(k) { return node.attributes[k] ?? null },
      /*
       * appendChild MOVES a node, and the renderer relies on that: it drains a
       * built track into its slot with `while (node.firstChild)`. A stub that
       * copies instead of moving turns that drain into an infinite loop.
       */
      appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child)
        child.parentNode = node
        node.children.push(child)
        node.firstChild = node.children[0]
        return child
      },
      removeChild(child) {
        node.children = node.children.filter((c) => c !== child)
        node.firstChild = node.children[0] ?? null
        child.parentNode = null
        return child
      },
      addEventListener() {},
    }
    return node
  }
  const document = {
    createElement: (tag) => element(tag),
    createElementNS: (ns, tag) => element(tag, ns),
  }
  const window = { CMB: {}, document, location: { reload() {} } }
  window.window = window
  const context = vm.createContext({ window, document, globalThis: window, console })
  for (const s of ['format.js', 'adherence.js', 'states.js', 'ladder.js']) {
    vm.runInContext(readFileSync(path.join(ROOT, 'client', s), 'utf8'), context, { filename: `client/${s}` })
  }
  return { cmb: window.CMB, document }
}

/** Every node in the tree whose class list carries `cls`. */
function all(node, cls) {
  const out = []
  const walk = (n) => {
    if (!n) return
    if (String(n.className || '').split(/\s+/).includes(cls)) out.push(n)
    ;(n.children || []).forEach(walk)
  }
  walk(node)
  return out
}

const textOfAll = (nodes) => nodes.map((n) => n.textContent || '')

/** Every character a subtree carries, the way a reader would see it. */
function textDeep(node) {
  if (!node) return ''
  return [node.textContent || '', ...(node.children || []).map(textDeep)].join(' ').trim()
}

function draw(data, direction = 0) {
  const { cmb, document } = sandbox()
  const host = document.createElement('section')
  cmb.ladder.render(host, data, { direction, status: 'ok', onToggle() {} })
  return host
}

const suppress = (data) => ({
  ...data,
  staleness: { ...data.staleness, level: 'dead', suppress_adherence: true, reason: 'cron down' },
})

describe('the renderer draws a time axis over the real route 4 payload', () => {
  t('draws one diagonal per schedule row that keeps two timepoints', (ns, cmb) => {
    const data = goldenRoute4()
    const host = draw(data)
    const drawable = data.schedule.directions
      .find((d) => d.direction_id === 0).trips
      .filter((trip) => trip[2].filter((o) => o !== null).length >= 2).length
    expect(all(host, 'sched')).toHaveLength(drawable)
    expect(drawable).toBeGreaterThan(0)
  })

  t('labels the axis with clock times, not with plus-or-minus minutes', (ns) => {
    const labels = textOfAll(all(draw(goldenRoute4()), 'axis-lab'))
    expect(labels.length).toBeGreaterThan(1)
    expect(labels.some((l) => /\d:\d\d[ap]/.test(l))).toBe(true)
    expect(labels.some((l) => /^[+−-]\d+$/.test(l))).toBe(false)
  })

  t('marks NOW at generated_at', (ns) => {
    const data = goldenRoute4()
    const now = textOfAll(all(draw(data), 'axis-lab--zero')).join(' ')
    expect(now).toContain('NOW')
    expect(now).toContain(client.cmb.fmt.clock(data.generated_at))
  })

  t('keeps a shape and a signed number on every bus, so grayscale still reads', (ns) => {
    const host = draw(goldenRoute4())
    const labels = textOfAll(all(host, 'bus__label'))
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) expect(label).toMatch(NUMERIC_LATENESS)
    expect(all(host, 'dot').length).toBe(labels.length)
  })

  t('no longer claims the old deviation scale in the caption', (ns) => {
    const caption = textOfAll(all(draw(goldenRoute4()), 'track__cap')).join(' ')
    expect(caption).not.toMatch(/±\s?10|Left of the line/i)
    expect(caption).toMatch(/\d:\d\d[ap]/)
  })

  t('draws both directions as their own ladder, each with its own axis', (ns) => {
    const { cmb, document } = sandbox()
    const host = document.createElement('section')
    cmb.ladder.render(host, goldenRoute4(), { direction: 'both', status: 'ok', onToggle() {} })
    expect(all(host, 'track__svg')).toHaveLength(2)
    expect(all(host, 'track__cap')).toHaveLength(2)
  })
})

describe('a direction the payload leaves empty renders a state, never a blank box', () => {
  const hollow = () => {
    const data = goldenRoute4()
    return {
      ...data,
      vehicles: [],
      schedule: {
        ...data.schedule,
        directions: data.schedule.directions.map((d) =>
          d.direction_id === 0 ? { ...d, timepoint_stop_ids: [], trips: [] } : d),
      },
    }
  }

  t('draws the rows and the axis with no diagonal at all', (ns) => {
    const host = draw(hollow())
    expect(all(host, 'sched')).toHaveLength(0)
    expect(all(host, 'axis-tick').length).toBeGreaterThan(0)
    expect(all(host, 'tplabel').length).toBeGreaterThan(0)
  })

  t('says in words that nothing is scheduled, rather than leaving it unexplained', (ns) => {
    const caption = textOfAll(all(draw(hollow()), 'track__cap')).join(' ')
    expect(caption.length).toBeGreaterThan(0)
    expect(caption.toLowerCase()).toMatch(/nothing is scheduled|no diagonal/)
  })

  t('names the absence when the whole schedule block is missing', (ns) => {
    const data = goldenRoute4()
    delete data.schedule
    const host = draw(data)
    expect(all(host, 'sched')).toHaveLength(0)
    const notices = all(host, 'notice')
    expect(notices.length).toBeGreaterThan(0)
    expect(notices.map(textDeep).join(' ').toLowerCase()).toContain('schedule')
  })
})

describe('suppress_adherence forbids the drawn lateness as well as the printed one', () => {
  t('prints no lateness number beside any bus', (ns) => {
    const labels = textOfAll(all(draw(suppress(goldenRoute4())), 'bus__label'))
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      expect(label, `a suppressed ladder still shows "${label}"`).not.toMatch(NUMERIC_LATENESS)
    }
  })

  t('draws no stem, because a gap to the schedule is a reading with no number on it', (ns) => {
    expect(all(draw(suppress(goldenRoute4())), 'bus__stem')).toHaveLength(0)
    expect(all(draw(goldenRoute4()), 'bus__stem').length).toBeGreaterThan(0)
  })

  t('keeps the clock gridlines and their labels, which are facts about the clock', (ns) => {
    const host = draw(suppress(goldenRoute4()))
    expect(all(host, 'axis-tick').length).toBeGreaterThan(0)
    expect(textOfAll(all(host, 'axis-lab')).some((l) => /\d:\d\d[ap]/.test(l))).toBe(true)
  })

  t('still draws the scheduled diagonals, which the feed age does not change', (ns) => {
    expect(all(draw(suppress(goldenRoute4())), 'sched').length).toBeGreaterThan(0)
  })

  t('says the numbers are suppressed instead of quietly dropping them', (ns) => {
    const caption = textOfAll(all(draw(suppress(goldenRoute4())), 'track__cap')).join(' ')
    expect(caption.toLowerCase()).toContain('suppressed')
  })
})
