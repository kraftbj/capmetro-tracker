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
 * RIDDEN is hand-typed, and deliberately not read out of client/app.js. Parsing
 * the literal would remove the duplicate maintenance and, with it, the only thing
 * these tests are really for: an entry dropped or mistyped by a careless edit to
 * FAVORITES. A test that re-derives its expectation from the thing under test
 * follows that edit silently and reports nothing. The cost is that adding a route
 * means editing two places; the failing test IS the reminder, and it names the
 * diff. What no test here can catch is a wrong number typed into both on purpose
 * -- that is an intent error, and the live catalog is the only thing that settles
 * it, which is why 335 was checked against it before being pinned.
 */
test.describe('the routes we ride sit at the top of the picker', () => {
  const RIDDEN = ['4', '7', '335', '337', '350', '800', '837']

  /*
   * Not pinned, so the picker has something to pin them ABOVE -- and chosen to
   * be awkward rather than convenient.
   *
   * '33' is a prefix of 335 and 337; '47' contains both 4 and 7. A filter that
   * matched loosely instead of by exact id equality would pull one of them into
   * the pinned grid, in whichever direction it was loose. With decoys like
   * '1', '20', '550' -- no substring relationship to any favorite -- both loose
   * variants pass, which is how this was found.
   */
  const OTHERS = ['20', '33', '47', '550']
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
   * The behavior the heading claims, picking seven out of a real catalog and
   * excluding them from the rest, was never observed.
   *
   * Stubbed per test rather than added to tests/e2e/server.mjs: every other spec
   * boots with no catalog, and giving the shared fixture one would change what
   * they all render. Route 837 shadowing the predictor capture is what that
   * mistake looks like in this repo.
   */
  const CATALOG_ORDER = [
    '4', '20', '7', '33', '335', '47', '337', '550', '350', '800', '837',
  ]

  const openPicker = async (page, { catalog = true } = {}) => {
    if (catalog) await page.route('**/api/routes.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        /*
         * INTERLEAVED, not favorites-then-decoys. paintPicker never sorts -- it
         * renders the catalog in fetch order -- so with every favorite listed
         * first, array POSITION stands in for identity and `shown.slice(0, 7)`
         * selects the same seven that `FAVORITES.indexOf(...) !== -1` does. That
         * mutation passed all four tests. The favorites keep their relative order
         * here, so the order assertion still means what it says.
         */
        routes: CATALOG_ORDER.map((id) => ({
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
    if (catalog) {
      await expect(page.locator('.routegrid'),
        'the catalog stub did not take, so the favorites are the whole list again')
        .toHaveCount(2)
    }
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
    expect(rest, 'the full list lost the routes that are not pinned')
      .toEqual(CATALOG_ORDER.filter((id) => !RIDDEN.includes(id)))
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

/*
 * THE TWO PICKER PATHS THE PINNING TESTS DO NOT REACH.
 *
 * Both were found by review rather than by the suite, and both are the kind that
 * stay green: nothing in this repo's e2e suite types into the picker's search
 * field at all, and after the pinning tests started stubbing a catalog, nothing
 * renders the no-catalog picker either.
 */
test.describe('the picker beyond the pinned grid', () => {
  const openSearch = async (page) => {
    await page.route('**/api/routes.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        routes: ['4', '20', '7', '33', '335', '47', '337', '550', '350', '800', '837']
          .map((id) => ({
            id, short_name: id, long_name: `${ id } Test`,
            directions: [{ id: 0, headsign: `${ id } A` }, { id: 1, headsign: `${ id } B` }],
            vehicles: { in_service: 1, out_of_service: 0 },
            has_service_today: true,
          })),
      }),
    }))
    await page.goto('/fresh/index.html')
    await expect(page.locator('#board')).toBeVisible()
    await page.locator('.routechip').click()
    await expect(page.locator('.picker')).toBeVisible()
  }

  /*
   * The favorites are removed from the list below ONLY while the query is empty.
   * Move that one line outside the `if (!q)` guard and a search for 335 answers
   * "No route matches" for the seven routes this household actually rides -- the
   * routes somebody is most likely to be typing. Every test passed before this.
   */
  test('a search finds the pinned routes, rather than hiding them', async ({ page }) => {
    await openSearch(page)
    await page.locator('.picker__search').fill('3')

    const ids = await page.locator('.routegrid__id').allInnerTexts()
    for (const id of ['335', '337', '350']) {
      expect(ids, `searching hid pinned route ${ id }`).toContain(id)
    }
    expect(ids, 'the search stopped filtering').not.toContain('800')
    await expect(page.locator('.notice')).toHaveCount(0)
  })

  /*
   * And the board opened from a file, which is a supported way to run it. With no
   * catalog every route the picker knows is already pinned, so the list below is
   * empty by arithmetic -- not because a search failed. It used to say "No route
   * matches “”" and then `return` past the hint written to explain exactly this.
   */
  test('says why the list is short when the catalog has not loaded', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await expect(page.locator('#board')).toBeVisible()
    await page.locator('.routechip').click()
    await expect(page.locator('.picker')).toBeVisible()

    await expect(page.locator('.routegrid'), 'a catalog loaded, so this is the wrong path')
      .toHaveCount(1)
    const text = await page.locator('.picker').innerText()
    expect(text, 'a filter failure reported for a filter nobody typed')
      .not.toContain('No route matches')
    expect(text).toContain('pinned above')
  })
})
