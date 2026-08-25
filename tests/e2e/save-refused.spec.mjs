/**
 * A refused save has to be visible, not only announced.
 *
 * The announcement goes to a `sr-only` live region. That is right for a screen
 * reader and useless on its own for everyone else: a sighted reader would be
 * looking at a saved list that silently does not contain the trip they just
 * saved, with nothing on screen having suggested anything went wrong.
 *
 * THE FIRST VERSION OF THIS FILE DID NOT TEST THAT. It set
 * the refusal flag by hand and asserted the notice rendered — which tests the
 * notice, not the wiring. Inverting the line that sets it from what the store
 * actually did restored the original bug with the whole suite still green. The unit
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

/**
 * A delete the browser refuses is the same lie with more at stake.
 *
 * The refusal leaves the trip in storage, and what stayed is a legible statement
 * of which stop a child stands at, at what time, on which days. On a borrowed or
 * shared phone that is the whole of the harm.
 *
 * What it looked like was a dead button — the card stays put, because every
 * render rebuilds the list from the store. So these assert on storage and on a
 * reload as well as on the notice: "a notice appeared" would also hold if the
 * trip had genuinely been deleted, and the harm is precisely that it was not.
 */
test.describe('a delete the browser refuses', () => {
  const A_TRIP = [{
    route_id: '800', direction_id: 1, direction_tag: 'SB', stop_id: '6293',
    stop_name: 'Simond SB', scheduled_time: '07:52:09', day_type: 'weekday',
  }]

  const seedTrip = (page) =>
    page.addInitScript((trip) => {
      window.localStorage.setItem('cmb.watches', JSON.stringify(trip))
    }, A_TRIP)

  test('says the trip is still saved, rather than nothing at all', async ({ page }) => {
    await seedTrip(page)
    await breakStorage(page)
    await page.goto('/fresh/index.html?route=800&view=saved')
    await expect(page.locator('.watchcard').first()).toBeVisible()

    await page.locator('.watchcard__remove').first().click()

    const notice = page.locator('.notice--error').first()
    await expect(notice).toBeVisible()
    /*
     * Not "Nothing was saved" — that is the opposite of what happened and would
     * tell the reader the record is gone when it is still there.
     */
    await expect(notice).toContainText('still saved on this device')
    await expect(notice).toContainText(/back the next time/i)

    /*
     * The notice is the report; this is the fact it reports. Asserting only the
     * words would hold just as well if the trip really had been deleted and the
     * board were lying in the other direction — and the harm here is precisely
     * that a record of which stop a child stands at is still on the device.
     */
    const stored = await page.evaluate(() => window.localStorage.getItem('cmb.watches'))
    expect(JSON.parse(stored || '[]')).toHaveLength(1)
    await expect(page.locator('.watchcard')).toHaveCount(1)
  })

  test('and the trip really is back on the next load, which is the harm', async ({ page }) => {
    await seedTrip(page)
    await breakStorage(page)
    await page.goto('/fresh/index.html?route=800&view=saved')
    await page.locator('.watchcard__remove').first().click()
    await expect(page.locator('.notice--error').first()).toBeVisible()

    /* Storage works again — a new tab, a new session, quota freed. The point is
     * that the reader's delete did not survive, and nothing on this page has
     * been carried over to admit it. */
    await page.reload()

    await expect(page.locator('.watchcard').first()).toBeVisible()
    await expect(page.locator('.notice--error')).toHaveCount(0)
  })

  test('a delete that works says so out loud, not only on screen', async ({ page }) => {
    /*
     * The live region is not repainted by render() — it sits outside the board —
     * so the last thing announced stands until something replaces it. A refusal
     * followed by a delete that worked therefore left a screen reader holding
     * "the board would not let it be deleted" about a trip that had just been
     * deleted: the visible notice cleared, the spoken one did not, and the two
     * channels disagreed with the spoken one wrong.
     */
    await seedTrip(page)
    await page.goto('/fresh/index.html?route=800&view=saved')
    await expect(page.locator('.watchcard').first()).toBeVisible()

    await page.locator('.watchcard__remove').first().click()
    await expect(page.locator('.watchcard')).toHaveCount(0)

    const spoken = page.locator('[role="status"]').first()
    await expect(spoken).toContainText(/removed/i)
    await expect(spoken).not.toContainText(/would not let/i)
  })

  test('the control: with working storage the trip goes, and nothing is claimed', async ({ page }) => {
    await seedTrip(page)
    await page.goto('/fresh/index.html?route=800&view=saved')
    await expect(page.locator('.watchcard').first()).toBeVisible()

    await page.locator('.watchcard__remove').first().click()

    await expect(page.locator('.watchcard')).toHaveCount(0)
    await expect(page.locator('.notice--error')).toHaveCount(0)
    /* It really left the store, rather than only the screen. */
    const stored = await page.evaluate(() => window.localStorage.getItem('cmb.watches'))
    expect(JSON.parse(stored || '[]')).toEqual([])
  })
})
