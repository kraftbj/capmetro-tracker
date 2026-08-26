/**
 * The bundled fixture is a frozen capture, and nothing may grade from it.
 *
 * When a route payload cannot be fetched over HTTP the board falls back to the
 * copy compiled into the page, and says so with a "Sample data" banner. That
 * fixture declares its own staleness as `fresh` with adherence usable, because
 * it was fresh on the day it was captured. So handing it to the graders meant a
 * saved trip or a chain reading a months-old lateness as a current measurement —
 * and printing a live-looking "on time" beside a banner saying no live feed was
 * reachable. GTFS trip ids are stable within a feed version, so the join
 * succeeds and the contradiction never surfaces on its own.
 *
 * currentServiceDate() has always excluded the fixture, on the same argument:
 * a frozen capture must not define what today is. This asserts the other half.
 */
import { expect, test } from '@playwright/test'

/*
 * Chosen so it JOINS. This is the 10:41 call at Pleasant Valley/5th on trip
 * 3014769_15202, which is the trip the bundled fixture's bus 2216 is running and
 * which it reports as on time. A watch that matched no fixture vehicle would
 * pass this test whatever the code did.
 */
const A_TRIP = [{
  route_id: '4', direction_id: 1, direction_tag: 'EB', stop_id: '1368',
  stop_name: 'Pleasant Valley/5th', scheduled_time: '10:41:00', day_type: 'weekday',
}]

test('a saved trip does not read a months-old lateness as a live one', async ({ page }) => {
  await page.addInitScript((trip) => {
    window.localStorage.setItem('cmb.watches', JSON.stringify(trip))
  }, A_TRIP)
  /* Every route payload fails, which is what puts route 4 on its fixture. */
  await page.route('**/api/route/*.json', (route) => route.fulfill({ status: 502, body: '' }))

  await page.goto('/fresh/index.html?route=4&view=saved')
  await expect(page.locator('.band--saved')).toBeVisible()

  /* The fallback really happened — otherwise this proves nothing. */
  const usingFixture = await page.evaluate(() => window.CMB.app.state.usingFixture)
  expect(usingFixture, 'the board should be on the bundled fixture').toBe(true)
  await expect(page.locator('#board')).toContainText(/sample data/i)

  /*
   * The card may say plenty — that it cannot find a bus, that the schedule is
   * all it has. What it may not do is describe a bus as running to time, which
   * is a claim about right now sourced from a capture months old, printed
   * directly under a banner saying no live feed is reachable.
   */
  const card = page.locator('.watchcard').first()
  await expect(card).toBeVisible()
  await expect(card).not.toContainText(/on time/i)
  await expect(card).not.toContainText(/running late/i)
  await expect(card).not.toContainText(/minutes? late/i)
})
