/**
 * End-to-end flows against the static client, served from fixtures.
 *
 * The unit suites prove the arithmetic. These prove the thing a rider actually
 * looks at: that a stale file shows a banner and no numbers, that a torn
 * response degrades instead of blanking, and that the closed stop on route 4 is
 * struck through rather than quietly rendered as served.
 *
 * Scenario prefixes are served by tests/e2e/server.mjs. Nothing here reaches
 * the network.
 */
import { expect, test } from '@playwright/test'

const NUMERIC_LATENESS = /[+\-−]\s?\d+\s?m/

test.describe('the board renders the route from a fresh file', () => {
  test('shows the route identity before anything else has loaded', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await expect(page.locator('#board')).toBeVisible()
    await expect(page.getByText('7th Street', { exact: false }).first()).toBeVisible()
    await expect(page.locator('.routechip__id')).toHaveText('4')
  })

  test('lists a vehicle row for every bus on the route', async ({ page }) => {
    await page.goto('/fresh/index.html')
    const rows = page.locator('.vrow')
    await expect(rows.first()).toBeVisible()
    expect(await rows.count()).toBeGreaterThan(0)
  })

  test('shows a lateness value with a shape beside it, not colour alone', async ({ page }) => {
    await page.goto('/fresh/index.html')
    const badge = page.locator('.vrow__badge').first()
    await expect(badge).toBeVisible()
    const text = (await badge.innerText()).trim()
    expect(text.length, 'the badge carries no glyph at all').toBeGreaterThan(0)
    expect(text).toMatch(/[◀●▲■?○]/)
  })

  test('names the stop a lateness value is measured against', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await expect(page.locator('.vrow__stop').first()).toBeVisible()
  })

  test('shows no staleness banner on a fresh file', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await expect(page.locator('.vrow').first()).toBeVisible()
    await expect(page.locator('.banner')).toHaveCount(0)
  })
})

test.describe('silent failure 2: a file the cron stopped regenerating', () => {
  test('shows a banner saying the data is old', async ({ page }) => {
    await page.goto('/dead/index.html')
    const banner = page.locator('.banner').first()
    await expect(banner).toBeVisible()
    await expect(banner).toHaveText(/down|old|last/i)
  })

  test('shows no lateness number anywhere on the board', async ({ page }) => {
    await page.goto('/dead/index.html')
    await expect(page.locator('.vrow').first()).toBeVisible()
    const badges = await page.locator('.vrow__badge').allInnerTexts()
    expect(badges.length).toBeGreaterThan(0)
    for (const text of badges) {
      expect(text, `a suppressed board still shows "${text}"`).not.toMatch(NUMERIC_LATENESS)
    }
  })

  test('still shows every bus, because positions do not go stale the way numbers do', async ({ page }) => {
    await page.goto('/dead/index.html')
    expect(await page.locator('.vrow').count()).toBeGreaterThan(0)
  })

  test('announces the banner to assistive technology rather than only changing colour', async ({ page }) => {
    await page.goto('/dead/index.html')
    await expect(page.locator('.banner[role="status"]').first()).toBeVisible()
  })
})

test.describe('section 11: a response torn mid-write', () => {
  test('does not leave a blank screen', async ({ page }) => {
    await page.goto('/torn/index.html')
    await expect(page.locator('#app')).not.toBeEmpty()
    const body = await page.locator('body').innerText()
    expect(body.trim().length).toBeGreaterThan(0)
  })

  test('says something went wrong instead of showing an empty board', async ({ page }) => {
    await page.goto('/torn/index.html')
    await expect(page.locator('body')).toHaveText(/can.?t|error|problem|reach|unavailable|old/i)
  })
})

test.describe('an API that fails outright', () => {
  test('falls back to the last-known data or names the failure, never both blank', async ({ page }) => {
    await page.goto('/missing/index.html')
    const body = await page.locator('body').innerText()
    expect(body.trim().length).toBeGreaterThan(0)
    expect(body).toMatch(/can.?t|error|reach|unavailable|showing/i)
  })
})

test.describe('contract section 0: a payload from a newer schema', () => {
  test('refuses to render rather than misrendering, and says the app needs updating', async ({ page }) => {
    await page.goto('/future/index.html')
    await expect(page.locator('body')).toHaveText(/updat/i)
    await expect(page.locator('.vrow')).toHaveCount(0)
  })
})

test.describe('empty is a feature', () => {
  test('says why the board is empty instead of showing nothing', async ({ page }) => {
    await page.goto('/empty/index.html')
    const body = await page.locator('body').innerText()
    expect(body).toMatch(/no bus|not in service|no vehicles/i)
  })
})

test.describe('the board fits the target device', () => {
  test('does not scroll sideways at 412 pixels', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await expect(page.locator('.vrow').first()).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, 'the board scrolls horizontally on a Pixel 8a').toBeLessThanOrEqual(1)
  })
})

/*
 * THE ROUTES THIS HOUSEHOLD RIDES, PINNED ABOVE THE OTHER SEVENTY.
 *
 * Nothing covered this list. It is a hand-maintained literal in app.js, it is the
 * first thing in the picker, and the owner asked for it by name -- so a typo in a
 * route number, or an entry dropped by a careless edit, would have shipped with
 * every suite green.
 *
 * The fixture server publishes no api/routes.json, so the client falls back to
 * fallbackCatalog(), which is built FROM that literal. That makes the pinned grid
 * exactly the list under test rather than whatever a catalog happened to carry.
 */
test.describe('the routes we ride sit at the top of the picker', () => {
  const RIDDEN = ['4', '7', '335', '337', '350', '800', '837']

  /* Not pinned, so the picker has something to pin them ABOVE. */
  const OTHERS = ['1', '20', '550']
  /* One pinned route with no service today: a favorite must not vanish from its
   * own heading just because it is not running, which is when somebody is most
   * likely to be looking for it. */
  const NO_SERVICE = '350'

  /*
   * The catalog is stubbed for every test in this block, not just the one that
   * needs two grids.
   *
   * Without it the client falls back to fallbackCatalog(), which is built FROM
   * the literal under test -- so every route in the catalog is a favorite,
   * `favs.length` equals the whole list by construction, and the tests prove
   * only that the code can render a seven-item array it was handed directly.
   * The behaviour the heading claims, picking seven out of a real catalog and
   * excluding them from the rest, was never observed.
   *
   * Stubbed per test rather than added to tests/e2e/server.mjs: every other spec
   * boots with no catalog, and giving the shared fixture one would change what
   * they all render. Route 837 shadowing the predictor capture is what that
   * mistake looks like in this repo.
   */
  const openPicker = async (page) => {
    await page.route('**/api/routes.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        routes: [...RIDDEN, ...OTHERS].map((id) => ({
          id, short_name: id, long_name: `${ id } Test`,
          directions: [{ id: 0, headsign: `${ id } A` }, { id: 1, headsign: `${ id } B` }],
          vehicles: { in_service: 1, out_of_service: 0 },
          has_service_today: id !== NO_SERVICE,
        })),
      }),
    }))
    await page.goto('/fresh/index.html')
    await expect(page.locator('#board')).toBeVisible()
    await page.locator('.routechip').click()
    await expect(page.locator('.picker')).toBeVisible()
    /* The catalog really landed: without it there is only one grid. */
    await expect(page.locator('.routegrid'),
      'the catalog stub did not take, so the favorites are the whole list again')
      .toHaveCount(2)
  }

  test('lists every one of them under its own heading', async ({ page }) => {
    await openPicker(page)
    await expect(page.getByText('Routes we ride')).toBeVisible()

    /* The FIRST grid is the pinned one; the "Every route" grid follows it. */
    const pinned = page.locator('.routegrid').first().locator('.routegrid__id')
    await expect(pinned).toHaveText(RIDDEN)
  })

  test('and 335 is one of them, in route-number order', async ({ page }) => {
    await openPicker(page)
    const pinned = page.locator('.routegrid').first().locator('.routegrid__id')
    const ids = await pinned.allInnerTexts()

    expect(ids, '335 is not pinned').toContain('335')
    /* Between 7 and 337, not appended. An addition that lands at the end reads as
     * an afterthought in a list somebody scans by number. */
    expect(ids.indexOf('335')).toBe(ids.indexOf('337') - 1)
    expect([...ids].sort((a, b) => Number(a) - Number(b))).toEqual(ids)
  })

  /*
   * The first version of this escaped early when there were fewer than two grids,
   * and there was only ever one -- so it was green and ran no assertion. That is
   * the shape this suite keeps finding, and it does not get to ship in the test
   * added to find it.
   */
  test('and they are not repeated again in the full list below', async ({ page }) => {
    await openPicker(page)
    const grids = page.locator('.routegrid')

    await expect(grids.first().locator('.routegrid__id')).toHaveText(RIDDEN)

    const rest = await grids.nth(1).locator('.routegrid__id').allInnerTexts()
    expect(rest, 'the full list lost the routes that are not pinned').toEqual(OTHERS)
    for (const id of RIDDEN) {
      expect(rest, `${ id } is pinned AND repeated in the full list`).not.toContain(id)
    }
  })

  /*
   * A pinned route with no service today still belongs under its own heading.
   * Dropping it there would be worst exactly when somebody is looking for it to
   * find out whether it is running.
   */
  test('keeps a pinned route that is not running today', async ({ page }) => {
    await openPicker(page)
    const pinned = page.locator('.routegrid').first()
    await expect(pinned.locator('.routegrid__id')).toHaveText(RIDDEN)

    const card = pinned.locator('.routegrid__item').filter({ hasText: NO_SERVICE })
    await expect(card).toHaveCount(1)
    await expect(card, 'it should say so rather than look ordinary')
      .toContainText('no service today')
  })
})
