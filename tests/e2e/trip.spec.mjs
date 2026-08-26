/**
 * The trip view at 412px, against the bundled fixture.
 *
 * The unit tests cover the join. This covers what a person actually meets: the
 * picker, the divider, the countdown column, and the states where the board
 * must refuse to show a time.
 */
import { expect, test } from '@playwright/test'

test.describe('trip view', () => {
  test('picks a bus and lists the stops ahead of it', async ({ page }) => {
    await page.goto('/fresh/index.html?view=trip&route=4')
    await expect(page.locator('.trip__picker')).toBeVisible()
    await page.locator('.trip__pick').nth(1).click()
    await page.locator('.trip__buslist button').first().click()
    await expect(page.locator('.tripstop')).not.toHaveCount(0)
    await expect(page.locator('.tripstop__sched').first()).toBeVisible()
  })

  test('draws the feed/estimate divider exactly once, with an estimated row present', async ({
    page,
  }) => {
    /*
     * Every in-service vehicle in the bundled fixture carries a full feed
     * prediction for every stop ahead of it, so unaided this branch never
     * renders (see client/states.js's 'trip-estimated' comment). The harness
     * scenario truncates predictions to half so a feed segment and an
     * estimated segment both exist to look at.
     */
    await page.goto('/fresh/index.html?view=trip&route=4&bus=2641&state=trip-estimated')
    const dividers = page.locator('.tripstops__divider')
    await expect(page.locator('.tripstop').first()).toBeVisible()
    expect(await dividers.count()).toBe(1)
    await expect(page.locator('.tripstop__pred', { hasText: '~' }).first()).toBeVisible()
    await expect(page.getByText('estimated').first()).toBeVisible()
  })

  test('shows no arrival time when the feed is stale', async ({ page }) => {
    await page.goto('/fresh/index.html?view=trip&route=4&bus=2641&state=stale')
    await expect(page.locator('.tripstop').first()).toBeVisible()
    await expect(page.locator('.tripstop__pred')).toHaveCount(0)
    await expect(page.getByText(/no arrival times right now/i)).toBeVisible()
  })

  test('keeps the list when the bus leaves the feed', async ({ page }) => {
    await page.goto('/fresh/index.html?view=trip&route=4&bus=2641&state=trip-gone')
    await expect(page.getByText(/no longer in the feed/i)).toBeVisible()
    await expect(page.locator('.tripstop').first()).toBeVisible()
  })

  test('does not overflow horizontally at 412px', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 })
    await page.goto('/fresh/index.html?view=trip&route=4&bus=2641')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(overflow).toBe(false)
  })

  test('every target is at least 44px', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 })
    await page.goto('/fresh/index.html?view=trip&route=4&bus=2641')
    await expect(page.locator('.tripstop').first()).toBeVisible()
    for (const b of await page.locator('.band--trip button').all()) {
      const box = await b.boundingBox()
      if (box) expect(box.height).toBeGreaterThanOrEqual(44)
    }
  })
})
