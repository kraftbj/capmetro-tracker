/**
 * A schedule the board knows is out of date must never be read out as today's.
 *
 * This is the half of the eviction fix that the first version missed. That
 * version marked an expired document `stale`, kept it — correctly, because
 * deleting it is how a failed refetch loses a whole service day — and then handed
 * it to the renderers unchanged, because nothing read the status. Every unit test
 * and every state assertion passed. A phone at breakfast still showed yesterday's
 * departure times under today's heading, which is the entire bug.
 *
 * So these tests assert on the RENDERED PAGE and never on `state.depStatus`. The
 * state was right the whole time; the screen was wrong. A test that reads state
 * here would have passed against the broken build.
 *
 * `/yesterday/` serves a fresh live payload with a departures document dated the
 * service day before it, and keeps serving it — the case where the refetch cannot
 * succeed, which is the branch where the board must degrade honestly rather than
 * guess.
 */
import { expect, test } from '@playwright/test'

/*
 * ?stop= is required, not incidental. The Next-buses band only renders once a
 * stop is chosen, so without it every assertion below about "no times are shown"
 * would hold on a page that never drew the band at all — passing for the wrong
 * reason. 6293 is a stop the fixture schedule actually serves; the control test
 * at the end of this block is what proves the selector is live.
 *
 * Route 800, not 4, because the fixture server hands out a different schedule
 * per route id: 4 gets the committed golden document that the trip view is
 * asserted against, and 800 gets the synthetic one 6293 belongs to. The live
 * payload is the same either way — SCENARIOS ignores the route id — so the only
 * thing the id selects here is which schedule the board is holding.
 */

test.describe('the board view, holding a schedule from a service day that has ended', () => {
  const band = (page) => page.locator('[aria-label="Next buses at a stop"]').first()

  test('does not read the stop out of a schedule belonging to another day', async ({ page }) => {
    await page.goto('/yesterday/index.html?route=800&stop=6293')
    await expect(page.locator('#board')).toBeVisible()
    await expect(band(page)).toBeVisible()

    /*
     * `.nextdir` is one row per direction the stop is served in, and it is built
     * FROM the departures document. Its absence is the observable fact that the
     * board declined to answer from a schedule it knows is out of date.
     *
     * Deliberately not asserting on `.nextbus` (the upcoming-departure rows): the
     * committed fixture's service day is in the past, so that count is zero in
     * both scenarios and an assertion on it would pass whether or not the fix
     * works. It was written that way first, and the control below caught it.
     */
    await expect(band(page).locator('.nextdir')).toHaveCount(0)
    await expect(band(page)).not.toContainText('Simond SB')
  })

  test('says the schedule is not loaded, and does not claim it loads only once', async ({ page }) => {
    await page.goto('/yesterday/index.html?route=800&stop=6293')
    await expect(page.locator('#board')).toBeVisible()

    const notice = band(page).locator('.notice--empty').first()
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('schedule')
    /*
     * The sub-line used to read "so it only loads once", which this change made
     * false — a schedule now expires at the service-day roll. Prose asserting
     * something the code stopped doing is the same defect as a comment that does.
     */
    await expect(notice).not.toContainText('only loads once')
  })

  test('the control: a schedule for the current service day IS read', async ({ page }) => {
    await page.goto('/fresh/index.html?route=800&stop=6293')
    await expect(page.locator('#board')).toBeVisible()
    /*
     * Same page, same stop, same selectors — the only difference is the service
     * date the fixture server puts on the departures document. Without this the
     * two assertions above would hold on a board that failed to render anything.
     */
    await expect(band(page).locator('.nextdir').first()).toBeVisible()
    await expect(band(page)).toContainText('Simond SB')
    await expect(band(page)).not.toContainText('Loading this route')
  })
})

test.describe('a saved trip whose schedule is from a service day that has ended', () => {
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

  test('reports the schedule as not loaded rather than resolving against yesterday', async ({ page }) => {
    await page.addInitScript((trip) => {
      window.localStorage.setItem('cmb.watches', JSON.stringify(trip))
    }, A_TRIP)

    await page.goto('/yesterday/index.html?route=800&view=saved')
    await expect(page.locator('.band--saved')).toBeVisible()

    const card = page.locator('.watchcard').first()
    await expect(card).toBeVisible()
    await expect(card).toContainText('has not loaded yet')
  })
})
