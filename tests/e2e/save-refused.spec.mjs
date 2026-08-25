/**
 * A refused save has to be visible, not only announced.
 *
 * The announcement goes to a `sr-only` live region. That is right for a screen
 * reader and useless on its own for everyone else: a sighted reader would be
 * looking at a saved list that silently does not contain the trip they just
 * saved, with nothing on screen having suggested anything went wrong.
 *
 * THE FIRST VERSION OF THIS FILE DID NOT TEST THAT. It set
 * `state.storageFailed = true` by hand and asserted the notice rendered — which
 * tests the notice, not the wiring. Inverting `state.storageFailed = !res.saved`
 * in app.js restored the original bug with the whole suite still green. The unit
 * suite covered `watch.add()` reporting the refusal and this file covered the
 * notice; nothing covered the line joining them, which is the only line the
 * reader experiences.
 *
 * So the first test below breaks localStorage for real and drives the real
 * editor: route, direction, stop, departure — the same four taps a person makes.
 */
import { expect, test } from '@playwright/test'

/* Refuse every write, the way an exhausted quota or disabled storage does. */
const breakStorage = (page) =>
  page.addInitScript(() => {
    const proto = Object.getPrototypeOf(window.localStorage)
    proto.setItem = function () {
      throw new DOMException('QuotaExceededError')
    }
  })

test.describe('a save the browser refuses, driven through the real editor', () => {
  test('tells the reader nothing was saved, and does not list the trip', async ({ page }) => {
    await breakStorage(page)
    await page.goto('/fresh/index.html?route=800')
    await expect(page.locator('#board')).toBeVisible()

    /* Saved view, then the editor. */
    await page.getByRole('button', { name: 'Saved', exact: false }).first().click()
    await page.getByRole('button', { name: /Save a trip|Save another trip/ }).first().click()

    /* Route, direction, stop, departure — the four steps the editor asks for. */
    await page.locator('.routegrid__item', { hasText: '800' }).first().click()
    await page.locator('.chipbtn, .dirgrid__item').first().click()
    await page.locator('.stoplist__item').first().click()
    await page.locator('.timegrid__item').first().click()

    /*
     * The whole point: this assertion runs against a flag the APP set from what
     * the store actually did, not one the test planted.
     */
    const notice = page.locator('.notice--error').first()
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('Nothing was saved')
    await expect(notice).toContainText(/private browsing|storage turned off/i)

    /* And the list must not show a trip that was not kept. */
    await expect(page.locator('.watchcard')).toHaveCount(0)
  })

  test('the control: the same four taps with working storage save the trip and show no error', async ({ page }) => {
    await page.goto('/fresh/index.html?route=800')
    await expect(page.locator('#board')).toBeVisible()

    await page.getByRole('button', { name: 'Saved', exact: false }).first().click()
    await page.getByRole('button', { name: /Save a trip|Save another trip/ }).first().click()
    await page.locator('.routegrid__item', { hasText: '800' }).first().click()
    await page.locator('.chipbtn, .dirgrid__item').first().click()
    await page.locator('.stoplist__item').first().click()
    await page.locator('.timegrid__item').first().click()

    /*
     * Without this the test above would pass on an editor that never completed a
     * save at all — the notice would be absent for the wrong reason.
     */
    await expect(page.locator('.watchcard').first()).toBeVisible()
    await expect(page.locator('.notice--error')).toHaveCount(0)
  })
})
