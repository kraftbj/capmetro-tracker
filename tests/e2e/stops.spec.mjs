/**
 * The stops link, end to end, at 412 pixels.
 *
 * The unit suite proves the join and the turnaround pairing. These prove the
 * thing that actually happens: a link arrives in a message, gets tapped, and has
 * to land on a board that is already answering — then has to still be there
 * tomorrow when the link is not.
 *
 * Two properties here are not cosmetic and have their own tests:
 *
 *   the plan lives in the fragment, which browsers never send, so bus.dillo.dev's
 *   access log cannot accumulate a description of a child's routine (contract §9);
 *
 *   a turnaround stop names the bus coming the OTHER way, because at Campbell/5th
 *   there is no eastbound bus to see approaching, ever.
 *
 * Route 4 is served here by departures-4-turnaround.json and route 800 by the
 * ordinary mid-route trim, so both card shapes are on screen together.
 */
import { expect, test } from '@playwright/test'

/* Campbell/5th eastbound and Simond southbound, both all-day so neither falls
 * into the "later today" section on a fixture clock fixed at 10:10am. */
const PLAN = '1;4.1.6243.all;800.1.6293.all'
const LINK = `/fresh/index.html#plan=${PLAN}`

test.describe('opening a stops link', () => {
  test('lands on the stops view with the stops already resolved', async ({ page }) => {
    await page.goto(LINK)
    await expect(page.locator('.stopcard').first()).toBeVisible()
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Stops')
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()
    await expect(page.getByText('Simond SB').first()).toBeVisible()
  })

  test('names the westbound bus that becomes the eastbound departure', async ({ page }) => {
    await page.goto(LINK)
    const card = page.locator('.stopcard').filter({ hasText: 'Campbell/5th' })
    await expect(card).toBeVisible()
    await expect(card.locator('.stopcard__turn')).toHaveText('turnaround')
    /* The sentence the whole feature exists for. Without it this card is a time
     * and a stop with no bus in sight, which is the blank the design doc calls
     * the failure this board is built to avoid. */
    await expect(card.locator('.stopdep__note').first()).toContainText(/comes in on the .* WB/i)
  })

  test('names the live bus running the inbound leg, hedged as the feed requires', async ({ page }) => {
    /*
     * Republic Square, with a route payload whose vehicle really is on the
     * southbound leg that becomes this northbound departure. Every route 837
     * block in the 2026-08-19 capture is confidence "low", so the sentence has
     * to read as a likelihood — contract section 4.
     */
    await page.goto('/fresh/index.html#plan=1;837.1.2112.all')
    const card = page.locator('.stopcard').filter({ hasText: '5th/Guadalupe' })
    await expect(card).toBeVisible()
    await expect(card).toContainText(/Bus 8021 likely brings it in on the .* SB/)
    await expect(card).toContainText('due here in')
    /* The word is the hedge on every line; the explanation is once per card. */
    await expect(card.locator('.stopcard__caveat')).toHaveCount(1)
    await expect(card.locator('.stopcard__caveat')).toContainText('has not confirmed which bus')
  })

  test('does not claim a turnaround at a stop that is not one', async ({ page }) => {
    await page.goto(LINK)
    const card = page.locator('.stopcard').filter({ hasText: 'Simond SB' })
    await expect(card).toBeVisible()
    await expect(card.locator('.stopcard__turn')).toHaveCount(0)
  })

  test('shows more than one departure, because which bus gets caught is decided on the day', async ({ page }) => {
    await page.goto(LINK)
    const card = page.locator('.stopcard').filter({ hasText: 'Campbell/5th' })
    expect(await card.locator('.stopdep').count()).toBeGreaterThan(1)
    await expect(card.locator('.stopdep--next')).toHaveCount(1)
  })

  test('does not scroll sideways at 412 pixels', async ({ page }) => {
    await page.goto(LINK)
    await expect(page.locator('.stopcard').first()).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

test.describe('the offer to keep them', () => {
  test('offers, and keeps them when asked', async ({ page }) => {
    await page.goto(LINK)
    await expect(page.locator('.offer')).toBeVisible()
    await page.getByRole('button', { name: 'Keep on this phone' }).click()
    await expect(page.locator('.offer')).toHaveCount(0)

    /* The point of keeping them: the same board with no link in the address. */
    await page.goto('/fresh/index.html')
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Stops')
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()
    await expect(page.locator('.offer')).toHaveCount(0)
  })

  test('still shows the stops when the offer is declined, and forgets them on reload', async ({ page }) => {
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Just this once' }).click()
    await expect(page.locator('.offer')).toHaveCount(0)
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()

    await page.goto('/fresh/index.html')
    await page.getByRole('button', { name: 'Stops' }).click()
    await expect(page.getByText('No stops on this phone yet')).toBeVisible()
  })

  test('does not offer a link that is already kept', async ({ page }) => {
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Keep on this phone' }).click()
    await page.goto(LINK)
    await expect(page.locator('.stopcard').first()).toBeVisible()
    await expect(page.locator('.offer')).toHaveCount(0)
  })
})

test.describe('the plan never reaches the server', () => {
  test('hands out a link whose stops are in the fragment, not the query', async ({ page }) => {
    await page.goto(LINK)
    const shared = await page.locator('.share__field').inputValue()
    expect(shared).toContain('#plan=')
    expect(shared.split('#')[0]).not.toContain('plan')
    expect(shared.split('#')[0]).not.toContain('?')
  })

  test('moves a plan out of the query string, so a reload stops leaking it', async ({ page }) => {
    await page.goto(`/fresh/index.html?plan=${encodeURIComponent(PLAN)}`)
    await expect(page.locator('.stopcard').first()).toBeVisible()
    expect(page.url()).not.toContain('?plan=')
    expect(page.url()).toContain('#plan=')
    /* And it says so, rather than tidying up silently — the reader needs to know
     * which link to share next time. */
    await expect(page.locator('.offer')).toContainText('web address')
  })
})

/*
 * The fetch-and-render loop, which is the bug most likely to be quietly undone.
 *
 * loadRouteData and loadDepartures both call render() from their callbacks, and
 * the views that need them call those loaders from inside paint(). Any status
 * other than 'idle' therefore has to stop a re-fetch, or a route that had already
 * resolved gets asked for again by the very paint its own response triggered.
 *
 * The guard reads like an optimisation and is not one, so the assertion here is
 * the REQUEST COUNT rather than anything on screen. Unfixed, this loop issues a
 * request per animation frame — roughly sixty a second — so the gap between pass
 * and fail is two versus hundreds, not a number that needs a tolerance.
 */
test.describe('a resolved route is fetched once, not once per frame', () => {
  const countRequests = async (page, url) => {
    const seen = new Map()
    page.on('request', (r) => {
      const u = new URL(r.url()).pathname
      if (!/\/api\/(route|departures)\//.test(u)) return
      seen.set(u, (seen.get(u) ?? 0) + 1)
    })
    await page.goto(url)
    await expect(page.locator('.stopcard').first()).toBeVisible()
    await page.waitForTimeout(2500)
    return seen
  }

  test('on the success path', async ({ page }) => {
    const seen = await countRequests(page, LINK)
    expect(seen.size).toBeGreaterThan(0)
    for (const [url, n] of seen) {
      expect(n, `${url} was fetched ${n} times`).toBeLessThanOrEqual(2)
    }
  })

  test('on the failure path, where the rejection is immediate', async ({ page }) => {
    /* Route 999 has no schedule and no route file: both fetches 404. An errored
     * status must stop the retry just as a resolved one does. */
    const seen = await countRequests(page, '/missing/index.html#plan=1;4.1.6243.all;999.1.1.all')
    for (const [url, n] of seen) {
      expect(n, `${url} was fetched ${n} times`).toBeLessThanOrEqual(2)
    }
  })

  test('on a schedule that describes a service day that is not today', async ({ page }) => {
    /* Route 7 is served a document dated 20260818 while the route payload says
     * 20260819. The client must not trust it for the session, and must not spin
     * evicting and re-fetching it either. */
    const seen = await countRequests(page, '/fresh/index.html#plan=1;4.1.6243.all;7.1.847.all')
    for (const [url, n] of seen) {
      expect(n, `${url} was fetched ${n} times`).toBeLessThanOrEqual(2)
    }
  })
})

test.describe('a cancelled trip on a stops card', () => {
  /* Republic Square: route 837 turns around here, and CapMetro canceled the
   * 10:13 northbound in the 2026-08-19 capture. */
  const CANCELED = '/fresh/index.html#plan=1;837.1.2112.all'

  test('says the word rather than reading as a bus that has not started', async ({ page }) => {
    await page.goto(CANCELED)
    const card = page.locator('.stopcard').filter({ hasText: '5th/Guadalupe' })
    await expect(card).toBeVisible()
    const canceled = card.locator('.stopdep--canceled')
    await expect(canceled).toHaveCount(1)
    await expect(canceled).toContainText('CANCELED')
    await expect(canceled).toContainText('No bus is coming for it')
    await expect(canceled).not.toContainText('reporting')
  })

  test('never claims a bus is bringing in a trip that is not running', async ({ page }) => {
    await page.goto(CANCELED)
    const canceled = page.locator('.stopdep--canceled')
    await expect(canceled).toHaveCount(1)
    await expect(canceled).not.toContainText('brings it in')
  })
})

test.describe('the board never claims a save it did not make', () => {
  test('says storage refused instead of announcing success', async ({ page }) => {
    await page.addInitScript(() => {
      /* Safari private browsing, an exhausted quota, storage switched off. */
      const real = Storage.prototype.setItem
      Storage.prototype.setItem = function (k, v) {
        if (String(k).indexOf('cmb.plan') === 0) throw new Error('QuotaExceededError')
        return real.call(this, k, v)
      }
    })
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Keep on this phone' }).click()

    await expect(page.getByText('Nothing could be saved on this phone.')).toBeVisible()
    /* The offer stays up, because the link in the address bar is still the way
     * back to these stops. */
    await expect(page.locator('.offer')).toBeVisible()
  })
})

test.describe('a link is untrusted input', () => {
  test('a stop id naming something on Object.prototype does not blank the board', async ({ page }) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/fresh/index.html#plan=1;4.1.constructor.all;4.1.6243.all')
    await expect(page.locator('.stopcard').first()).toBeVisible()
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()
    await page.waitForTimeout(1000)
    expect(errors, errors.join('; ')).toHaveLength(0)
  })

  test('a link with hundreds of stops is capped rather than fetched in full', async ({ page }) => {
    const routes = new Set()
    page.on('request', (r) => {
      const m = /\/api\/departures\/([^/]+)\.json/.exec(r.url())
      if (m) routes.add(m[1])
    })
    const many = Array.from({ length: 300 }, (_, i) => `r${i}.1.6243.all`).join(';')
    await page.goto(`/fresh/index.html#plan=1;${many}`)
    await expect(page.locator('.stopcard').first()).toBeVisible()
    await page.waitForTimeout(1500)
    /* Plus the open route board's own schedule, which is not part of the plan. */
    expect(routes.size).toBeLessThanOrEqual(7)
  })
})

test.describe('the link and the screen stay in step', () => {
  test('opens the stops view on a second visit, after the stops are kept', async ({ page }) => {
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Keep on this phone' }).click()
    await expect(page.locator('.offer')).toHaveCount(0)

    /* The switch used to hang off the offer, so once there was nothing to offer
     * the same bookmarked link landed on the route board and looked inert. */
    await page.goto(LINK)
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Stops')
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()
  })

  test('rewrites the fragment when a stop is removed, so a reload does not restore it', async ({ page }) => {
    await page.goto(LINK)
    await expect(page.locator('.stopcard')).toHaveCount(2)
    await page.locator('.stopcard').filter({ hasText: 'Simond SB' })
      .getByRole('button', { name: /Remove/ }).click()
    await expect(page.locator('.stopcard')).toHaveCount(1)
    expect(page.url()).not.toContain('6293')

    await page.reload()
    await expect(page.locator('.stopcard')).toHaveCount(1)
    await expect(page.getByText('Simond SB')).toHaveCount(0)
  })
})
