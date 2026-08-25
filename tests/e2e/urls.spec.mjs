/**
 * Shareable URLs, driven in a real browser.
 *
 * The unit tests in tests/node/client-urls.test.mjs cover the grammar. These
 * cover the two things a grammar test cannot see:
 *
 *   1. Whether the page's own assets still load when the path has depth. A
 *      relative <script src="format.js"> read from /route/4/eb resolves to
 *      /route/4/format.js, and the server's app-path fallback answers that with
 *      index.html -- so every script becomes a copy of the page and the board
 *      renders nothing, with no console error to say why. The <base> bootstrap
 *      in index.html exists for this and is only testable here.
 *   2. Whether a cold open actually lands on the right view with the right
 *      direction, which needs the route document to have loaded first.
 */
import { expect, test } from '@playwright/test'

test.describe('shareable urls', () => {
  test('loads its own scripts when the path has depth', async ({ page }) => {
    await page.goto('/fresh/route/4/eb')
    /* If the base bootstrap fails, the scripts are HTML and nothing defines
       window.CMB -- which is a silent failure worth naming directly. */
    expect(await page.evaluate(() => typeof window.CMB)).toBe('object')
    expect(await page.evaluate(() => !!(window.CMB && window.CMB.urls))).toBe(true)
    await expect(page.locator('.vrow').first()).toBeVisible()
  })

  test('a direction in the path is selected once the route loads', async ({ page }) => {
    await page.goto('/fresh/route/4/eb')
    await expect(page.locator('.dirtoggle button.is-on')).toHaveText('EB')

    await page.goto('/fresh/route/4/wb')
    await expect(page.locator('.dirtoggle button.is-on')).toHaveText('WB')

    await page.goto('/fresh/route/4/both')
    await expect(page.locator('.dirtoggle button.is-on')).toHaveText('BOTH')
  })

  test('each view has a path that opens it cold', async ({ page }) => {
    for (const [path, tab] of [
      ['/fresh/buses', 'All buses'],
      ['/fresh/saved', 'Saved'],
      ['/fresh/trip', 'Trip'],
      ['/fresh/route/4', 'Route'],
    ]) {
      await page.goto(path)
      await expect(page.locator('.viewtabs__btn.is-on')).toHaveText(tab)
    }
  })

  test('a bus qualified by its route opens straight onto that bus', async ({ page }) => {
    await page.goto('/fresh/trip/4/2641')
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Trip')
    await expect(page.locator('.tripstop').first()).toBeVisible()
  })

  test('the address bar follows what is on screen', async ({ page }) => {
    await page.goto('/fresh/route/4/eb')
    await page.locator('.viewtabs__btn', { hasText: 'All buses' }).click()
    await expect(page).toHaveURL(/\/fresh\/buses/)

    await page.locator('.viewtabs__btn', { hasText: 'Saved' }).click()
    await expect(page).toHaveURL(/\/fresh\/saved/)
  })

  test('carries nothing but the tab name on saved', async ({ page }) => {
    /* Saved trips live in localStorage. A watch reaching the address bar would
       publish somebody's routine to whoever they sent the link to. */
    await page.goto('/fresh/saved')
    const { pathname, search } = new URL(page.url())
    expect(pathname).toBe('/fresh/saved')
    /* Nothing about a watch -- no stop, no time, no route -- reaches the URL. */
    expect(search).toBe('')
    expect(pathname).not.toMatch(/\d/)
  })

  test('every link that predates this still works', async ({ page }) => {
    /* The query form is permanent: it is the only form file:// can use, and the
       ?state= harness is written in it. */
    await page.goto('/fresh/index.html?view=trip&route=4&bus=2641')
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Trip')
    await expect(page.locator('.tripstop').first()).toBeVisible()
  })

  test('a query rides on top of a path, so states stay reachable', async ({ page }) => {
    await page.goto('/fresh/trip/4/2641?state=trip-estimated')
    await expect(page.locator('.tripstops__divider').first()).toBeVisible()
  })

  test('a missing asset still 404s rather than answering with the page', async ({ page }) => {
    /* The fallback is scoped to the four app verbs precisely so this holds: a
       blanket fallback makes a broken script tag look like it loaded. */
    const res = await page.request.get('/fresh/nope.js')
    expect(res.status()).toBe(404)
  })

  test('does not scroll sideways at 412 pixels on a path url', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 })
    await page.goto('/fresh/route/4/eb')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(overflow).toBe(false)
  })
})

test.describe('a bare bus link, whose route has to be looked up', () => {
  /*
   * /trip/1234 names a bus and not its route — the form that makes the link
   * short enough to read to somebody over the phone. Resolving it means
   * fetching the fleet document, which is the only entry path in the client
   * that does. Nothing else in this suite exercises it: every other trip test
   * supplies the route, which skips the lookup entirely.
   */
  const FLEET = { schema: 1, generated_at: 1787152239, vehicles: [
    { vehicle_id: '2641', label: '2641', route_id: '4', in_service: true },
  ] }

  test('resolves the route and upgrades the link to the qualified form', async ({ page }) => {
    await page.route('**/api/all.json', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FLEET) }))

    await page.goto('/fresh/trip/2641')
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Trip')
    /* The short link rewrites itself to the one that needs no lookup. */
    await expect(page).toHaveURL(/\/fresh\/trip\/4\/2641/)
    await expect(page.locator('.tripstop').first()).toBeVisible()
  })

  test('does not strand the reader when the fleet document fails', async ({ page }) => {
    await page.route('**/api/all.json', (r) => r.fulfill({ status: 500, body: 'nope' }))

    await page.goto('/fresh/trip/2641')
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Trip')
    /* No route was learned, so no route is claimed. The picker is offered
       rather than a bus sitting under a route it may not be on. */
    await expect(page).toHaveURL(/\/fresh\/trip$/)
    await expect(page.getByText(/pick a bus/i)).toBeVisible()
  })

  test('a late fleet answer does not undo what the reader did meanwhile', async ({ page }) => {
    /* The staleness guard. Before it, a fleet request failing seconds after the
       reader picked their own bus wiped that choice and emptied the board. */
    await page.route('**/api/all.json', async (r) => {
      await new Promise((done) => setTimeout(done, 2500))
      await r.fulfill({ status: 500, body: 'nope' })
    })

    await page.goto('/fresh/trip/2641')
    await page.locator('.trip__pick').nth(1).click()
    await page.locator('.trip__buslist button:not([disabled])').first().click()
    await expect(page.locator('.tripstop').first()).toBeVisible()
    const chosen = page.url()

    await page.waitForTimeout(3000)
    /* Still on the bus the reader chose, not reset by an answer they had
       stopped waiting for. */
    await expect(page.locator('.tripstop').first()).toBeVisible()
    expect(page.url()).toBe(chosen)
  })
})
