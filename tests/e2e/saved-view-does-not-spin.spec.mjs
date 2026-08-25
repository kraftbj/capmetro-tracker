/**
 * A board sitting on the saved tab, doing nothing, must not talk to the origin.
 *
 * paintSaved asks for each saved trip's route document, and the fetch calls
 * render() when it resolves. loadRouteData only declined while a request was
 * already in flight, so a route that had FINISHED loading sat at 'ok', passed
 * the guard, fetched again, painted again, and went round: measured at 364
 * requests in six seconds against one route file, from a phone whose owner had
 * put it down.
 *
 * This asserts on the network rather than on state, because the cost is the
 * network: a page that renders perfectly while hammering the box is the whole
 * failure. The rule the codebase already states twice — a render that starts a
 * fetch is a render that can trigger another render — now holds here too, with
 * the 60s timer as the only thing that reopens the question.
 */
import { expect, test } from '@playwright/test'

const A_TRIP = [
  {
    route_id: '800',
    direction_id: 1,
    direction_tag: 'SB',
    stop_id: '6293',
    stop_name: 'Simond SB',
    scheduled_time: '07:52:09',
    day_type: 'weekday',
  },
]

test('the saved view does not spin requests at the origin', async ({ page }) => {
  await page.addInitScript((trip) => {
    window.localStorage.setItem('cmb.watches', JSON.stringify(trip))
  }, A_TRIP)

  const counts = {}
  page.on('request', (r) => {
    const u = new URL(r.url()).pathname
    if (/\/api\//.test(u)) counts[u] = (counts[u] || 0) + 1
  })

  await page.goto('/fresh/index.html?route=4&view=saved')
  await expect(page.locator('.band--saved')).toBeVisible()
  await expect(page.locator('.watchcard').first()).toBeVisible()

  /*
   * Long enough for a loop to be unmistakable (the measured rate was ~60/s) and
   * short enough to stay well inside the 60s refresh, so anything counted here
   * came from repainting rather than from the timer legitimately asking again.
   */
  await page.waitForTimeout(3000)

  const route800 = Object.keys(counts).filter((u) => /api\/route\/800\.json$/.test(u))
  expect(route800.length).toBeGreaterThan(0)   /* the path under test really ran */
  for (const u of Object.keys(counts)) {
    expect(counts[u], `${u} was requested ${counts[u]} times while the board sat still`).toBeLessThan(4)
  }
})
