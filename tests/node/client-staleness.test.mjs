/**
 * Silent failure 2: the cron dies and the webroot serves the last file forever.
 *
 * Every file in that webroot is still valid JSON with a plausible number on
 * every row. What stands between a rider and a confidently wrong "+3 min" from
 * forty minutes ago is that the client renders age as a visible state rather
 * than writing it to a log nobody reads.
 */
import { describe, expect, it } from 'vitest'
import { gateClient, loadClient, textOf } from './helpers/client.mjs'
import { goldenRoute4, synthetic } from './helpers/fixtures.mjs'

const client = loadClient(['format.js', 'states.js'])
const t = gateClient(client, 'states', it)

const fresh = goldenRoute4()
const dead = synthetic('route-4-dead-cron.json')

describe('a file that stopped being regenerated says so on screen', () => {
  t('draws a banner for the dead-cron payload', (ns) => {
    const banner = ns.stalenessBanner(dead.staleness, dead.feeds)
    expect(banner).not.toBeNull()
    expect(banner.className).toContain('banner')
  })

  t('says the feed is down rather than quietly showing older numbers', (ns) => {
    const text = textOf(ns.stalenessBanner(dead.staleness, dead.feeds)).toLowerCase()
    expect(text).toMatch(/down|last|old/)
    expect(text).toMatch(/\d/)
  })

  t('repeats the server reason so the banner is specific, not generic', (ns) => {
    expect(textOf(ns.stalenessBanner(dead.staleness, dead.feeds))).toContain(dead.staleness.reason)
  })

  t('announces itself to assistive technology instead of being a silent colour change', (ns) => {
    expect(ns.stalenessBanner(dead.staleness, dead.feeds).getAttribute('role')).toBe('status')
  })

  t('draws no banner on a fresh file, so the warning keeps its meaning', (ns) => {
    expect(ns.stalenessBanner(fresh.staleness, fresh.feeds)).toBeNull()
  })
})

describe('the banner escalates with the level rather than being one flat warning', () => {
  const at = (level, age) => ({ level, oldest_feed_age_s: age, schedule_age_days: 1, suppress_adherence: level === 'stale' || level === 'dead', reason: `${level} for ${age}s` })

  t('marks an aging file as information, not as an error', (ns) => {
    expect(ns.stalenessBanner(at('aging', 300), fresh.feeds).className).toContain('info')
  })

  t('marks a stale file as a warning and says lateness is hidden', (ns) => {
    const banner = ns.stalenessBanner(at('stale', 900), fresh.feeds)
    expect(banner.className).toContain('warn')
    expect(textOf(banner).toLowerCase()).toMatch(/hidden|until/)
  })

  t('marks a dead file as a danger', (ns) => {
    expect(ns.stalenessBanner(at('dead', 4000), fresh.feeds).className).toContain('danger')
  })

  t('names the last position time so the user can judge the data themselves', (ns) => {
    const banner = ns.stalenessBanner(at('dead', 4000), fresh.feeds)
    expect(textOf(banner)).toMatch(/last position/i)
  })
})

describe('a payload written for a newer schema is refused rather than misrendered', () => {
  t('offers a whole-app refusal screen naming both versions', (ns) => {
    const screen = ns.schemaTooNew(2, 1)
    const text = textOf(screen)
    expect(text).toContain('2')
    expect(text).toContain('1')
    expect(text.toLowerCase()).toMatch(/updat/)
  })
})

describe('an empty panel states what is missing and what happens next', () => {
  t('never returns a blank notice', (ns) => {
    const notice = ns.notice('empty', 'No buses on route 350 right now.', 'Next departure 2:14pm from Airport/12th.')
    const text = textOf(notice)
    expect(text).toContain('No buses on route 350 right now.')
    expect(text).toContain('Next departure')
  })

  t('reports the absence of the next fact rather than hiding it', (ns) => {
    expect(textOf(ns.notice('empty', 'No buses on route 350 right now.'))).toContain('No buses')
  })
})

describe('the degraded payload keeps positions and drops only the numbers', () => {
  it('carries the same vehicles as the fresh payload', () => {
    expect(dead.vehicles.length).toBe(fresh.vehicles.length)
    expect(dead.vehicles.every((v) => v.position)).toBe(true)
  })

  it('carries no lateness value anywhere', () => {
    for (const v of dead.vehicles) {
      expect(v.adherence.seconds).toBeNull()
      expect(v.adherence.against).toBeNull()
    }
  })

  it('marks every in-service vehicle unknown with a stale_data reason, not ontime', () => {
    const inService = dead.vehicles.filter((v) => v.in_service)
    expect(inService.length).toBeGreaterThan(0)
    for (const v of inService) {
      expect(v.adherence.state).toBe('unknown')
      expect(v.adherence.reason).toBe('stale_data')
    }
  })

  it('is older than the ten-minute threshold that forces suppression', () => {
    expect(dead._expected.generated_at_age_s).toBeGreaterThan(600)
    expect(dead.staleness.suppress_adherence).toBe(true)
  })
})
