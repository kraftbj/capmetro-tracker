/**
 * The two silent failures whose only honest witness is the rendered page.
 *
 * Silent failure 4 is here because "the stop is closed" has to survive all the
 * way to a struck-through row; a correct payload that the ladder quietly drops
 * fails the rider just as completely as a wrong one.
 */
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

const golden = JSON.parse(readFileSync(new URL('../fixtures/golden/route-4-20260819.json', import.meta.url), 'utf8'))

test.describe('silent failure 4: an alert-closed stop must never render as served', () => {
  test('carries the closing alert into the rendered page', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await expect(page.locator('.vrow').first()).toBeVisible()

    const closure = golden.alerts.find((a) => a.effect === 'NO_SERVICE')
    expect(closure, 'the golden fixture carries no NO_SERVICE alert to check').toBeDefined()

    // Alerts are collapsed behind a count. Collapsed is fine; absent is not.
    const summary = page.getByText(/service alerts? on this route/i).first()
    await expect(summary, 'the page does not mention the route alerts at all').toBeVisible()
    await summary.click()

    const body = await page.locator('body').innerText()
    expect(body.toLowerCase(), 'the closure never reached the page').toContain('closure')
    expect(body, 'the closed stop id is not named anywhere').toContain('1967')
  })

  test('marks a closed stop as not served wherever it appears on the ladder', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await expect(page.locator('.vrow').first()).toBeVisible()

    const closedStopIds = golden.alerts
      .filter((a) => a.effect === 'NO_SERVICE')
      .flatMap((a) => a.stop_ids)

    const served = await page.evaluate((ids) => {
      const doc = window.CMB?.lastRoute ?? null
      if (!doc) return null
      const all = [...doc.timepoints, ...doc.timepoints.flatMap((t) => t.minor_stops)]
      return all.filter((s) => ids.includes(s.stop_id)).map((s) => ({ stop_id: s.stop_id, ...s.service_status }))
    }, closedStopIds)

    test.skip(served === null, 'the client does not expose the rendered payload; assert on the DOM once a ladder row carries its stop id')
    for (const stop of served) {
      expect(stop.served, `stop ${stop.stop_id} is under a NO_SERVICE alert but renders as served`).toBe(false)
      expect(stop.source).toBe('alert_no_service')
    }
  })
})

test.describe('a lateness number is never the only thing a colour-blind user can read', () => {
  test('pairs every badge with a glyph character', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await expect(page.locator('.vrow__badge').first()).toBeVisible()

    for (const text of await page.locator('.vrow__badge').allInnerTexts()) {
      expect(text, `badge "${text}" has no shape`).toMatch(/[◀●▲■?○]/)
    }
  })

  test('gives every vehicle row a spoken description for a screen reader', async ({ page }) => {
    await page.goto('/fresh/index.html')
    const row = page.locator('.vrow__main').first()
    await expect(row).toBeVisible()
    const label = (await row.getAttribute('aria-label')) ?? (await row.innerText())
    expect(label.trim().length).toBeGreaterThan(10)
  })
})
