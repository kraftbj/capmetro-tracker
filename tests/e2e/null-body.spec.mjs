/**
 * A 200 is not by itself an answer.
 *
 * A proxy error page, or any body that parses to null, used to be stored under
 * an 'ok' status. The cache guard treats a falsy cached value as "nothing
 * cached", so the next paint asked again, stored null again, and painted again —
 * an unbounded fetch-and-render loop against the origin.
 *
 * It has to be driven from the SAVED view: that is the paint path that calls
 * loadDepartures on every render, which is what closes the loop. On the board
 * view the only callers are boot and the 60s timer, so the same broken response
 * costs one request and the bug is invisible.
 */
import { expect, test } from '@playwright/test'

test('a 200 whose body is null does not spin the board against the origin', async ({ page }) => {
  const asked = []
  await page.route('**/api/departures/*.json', (route) => {
    asked.push(1)
    route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
  })
  await page.addInitScript(() => {
    window.localStorage.setItem('cmb.watches', JSON.stringify([{
      route_id: '800', direction_id: 1, direction_tag: 'SB', stop_id: '6293',
      stop_name: 'Simond SB', scheduled_time: '07:52:09', day_type: 'weekday',
    }]))
  })

  await page.goto('/fresh/index.html?route=800&view=saved')
  await expect(page.locator('.band--saved')).toBeVisible()
  await page.waitForTimeout(1200)

  /*
   * One attempt, then the existing 'error' path holds it until the timer comes
   * round. Anything above a handful means the response is being re-requested by
   * the render it triggered.
   */
  expect(asked.length, `asked for the schedule ${asked.length} times in 1.2s`).toBeLessThanOrEqual(3)
  expect(asked.length, 'never asked at all, so this proves nothing').toBeGreaterThan(0)
})
