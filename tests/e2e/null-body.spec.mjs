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

/*
 * The same broken response on the other two documents. The loop was only the
 * schedule's way of failing; each endpoint has its own, and two of them are
 * worse than a wasted request.
 */
test('a 200 whose body is null does not make the board blame CapMetro for it', async ({ page }) => {
  /*
   * The fleet document stored under 'ok' rendered "CapMetro is reporting no
   * buses at all … a CapMetro problem rather than a problem with this board" —
   * a confident, specific, false claim about service that names somebody else
   * as the cause, while the real can't-reach-the-feed state and its Retry never
   * appeared. Asserting the accusation is absent AND the honest error is present,
   * because either alone would hold on a page that rendered nothing.
   */
  await page.route('**/api/all.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }))

  await page.goto('/fresh/index.html?route=4&view=all')
  const board = page.locator('#board')
  await expect(board).toBeVisible()
  await expect(board).not.toContainText('CapMetro problem')
  await expect(board).not.toContainText('no buses at all')
  await expect(board).toContainText('feed')
})

test('a 200 whose body is null leaves a route document askable again', async ({ page }) => {
  /*
   * A falsy body landed on 'ok', and the once-a-minute retry only ever clears
   * 'error' — so the one status it produced was the one status the retry cannot
   * see, and a bus detail read "loading the route…" for the life of the tab with
   * nothing loading. Asserted on the status rather than the panel because the
   * status is what the retry reads; the panel is downstream of it.
   */
  await page.route('**/api/route/7.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }))
  await page.addInitScript(() => {
    window.localStorage.setItem('cmb.watches', JSON.stringify([{
      route_id: '7', direction_id: 0, direction_tag: 'NB', stop_id: '1',
      stop_name: 'Somewhere NB', scheduled_time: '07:52:09', day_type: 'weekday',
    }]))
  })

  await page.goto('/fresh/index.html?route=4&view=saved')
  await expect(page.locator('.band--saved')).toBeVisible()
  await page.waitForTimeout(500)

  const status = await page.evaluate(() => window.CMB.app.state.routeStatus['7'])
  expect(status, 'a falsy body must not park the route on a status the retry cannot clear')
    .not.toBe('ok')
})
