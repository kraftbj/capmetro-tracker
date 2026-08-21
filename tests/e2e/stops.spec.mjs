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
    /*
     * reload(), not goto(LINK) again. The address bar is already at LINK, so a
     * second goto to the same URL is a same-document no-op: nothing re-boots,
     * and the assertions below read the DOM the FIRST load left behind — which
     * still has no offer on it because the button was just clicked. The test
     * passed with the dedupe deleted. It has to be a real load or it is not
     * testing the second visit at all.
     */
    await page.reload()
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

    /*
     * Then go and look at the route board, which is what somebody does between
     * one commute and the next, and which is what the board REMEMBERS.
     *
     * Both halves of this setup are load-bearing. A second goto(LINK) while the
     * address bar is already at LINK navigates nothing at all — the assertions
     * would read the DOM the first load left. And leaving the remembered view on
     * Stops lets the tab land on Stops out of memory, so the test held even with
     * the link's own switch deleted. The link has to win against a remembered
     * view pointing elsewhere or it is not being tested.
     */
    await page.locator('.viewtabs__btn[data-view="board"]').click()
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Route')

    /* The switch used to hang off the offer, so once "Keep on this phone" had
     * been tapped there was nothing to offer, nothing switched the view, and the
     * same bookmarked link landed on the route board looking inert. */
    await page.reload()
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

test.describe('a failed route fetch must not destroy a good schedule', () => {
  /*
   * The chain the second review traced: a dropped `api/route` request swaps in the
   * bundled 20260819 fixture, and if that frozen date is read as "today" then every
   * cached schedule looks expired. Evicting one before its replacement arrives then
   * loses a whole service day to a connection that has just proved it cannot fetch.
   *
   * Route 4 is the default and the only bundled fixture, so this was the ordinary
   * user on the ordinary route.
   */
  test('keeps the cached schedule when the route payload falls back to the fixture', async ({ page }) => {
    await page.goto('/__reset')
    /* /missing/ 500s every api/route request, so the client is on the fixture.
     * The 'flaky' schedule loads once, is dated 20260818, and 500s thereafter. */
    await page.goto('/missing/index.html#plan=1;flaky.1.6243.all')

    const card = page.locator('.stopcard').first()
    await expect(card).toBeVisible()
    await expect(card.locator('.stopdep').first()).toBeVisible()

    /* Long enough for a repaint or two to have thrown it away. */
    await page.waitForTimeout(2000)
    await expect(card.locator('.stopdep').first()).toBeVisible()
    await expect(page.getByText('Schedule not loaded')).toHaveCount(0)

    /*
     * And the schedule is not merely surviving — it was never judged against the
     * fixture's frozen date in the first place. Without that guard the document
     * is marked 'stale' and re-requested every 60 seconds forever, on a route
     * whose schedule is in fact perfectly current. Asserting the decision rather
     * than waiting out a timer.
     */
    const status = await page.evaluate(() => window.CMB.app.state.depStatus.flaky)
    expect(status, 'the bundled fixture was read as today').not.toBe('stale')
  })

  test('does not spin re-requesting it either', async ({ page }) => {
    await page.goto('/__reset')
    const seen = new Map()
    page.on('request', (r) => {
      const u = new URL(r.url()).pathname
      if (!/\/api\/departures\//.test(u)) return
      seen.set(u, (seen.get(u) ?? 0) + 1)
    })
    await page.goto('/missing/index.html#plan=1;flaky.1.6243.all')
    await expect(page.locator('.stopcard').first()).toBeVisible()
    await page.waitForTimeout(2000)
    for (const [url, n] of seen) {
      expect(n, `${url} was fetched ${n} times`).toBeLessThanOrEqual(2)
    }
  })
})

/*
 * A DEPARTURES DOCUMENT DESCRIBES ONE SERVICE DAY, AND IS KEPT FOR EXACTLY THAT
 * LONG.
 *
 * It is a whole service day of scheduled stop times, so it is fetched once and
 * held. It used to be held for the life of the tab: a phone left on the counter
 * overnight and picked up at seven still had yesterday's, with every stop reading
 * "the last one today has gone" on the surface someone consults at breakfast and
 * has no reason to doubt.
 *
 * The eviction that fixed it had no test at all — the whole block, and the
 * scheduleExpired line in retryDepartures, could be deleted and the suite stayed
 * green. The three cases below are the three the code actually distinguishes, and
 * the third is the one that matters most: a replacement that FAILS must leave the
 * document that is already there. The first attempt at this deleted before it
 * fetched, which loses a whole service day to a connection that has just proved
 * it cannot fetch anything.
 *
 * The service date comes from the LIVE route payload, never a device clock, so
 * these drive the two documents against each other rather than touching a clock.
 * Requests are answered per page — no shared server state, nothing another test
 * running beside this one can disturb.
 */
test.describe('a schedule is kept for the service day it describes, and no longer', () => {
  const TODAY = '20260819' /* what the golden route payload says it is */
  const YESTERDAY = '20260818'
  const TOMORROW = '20260820'
  const STOPS = '/fresh/index.html#plan=1;4.1.6243.all'

  /*
   * The two real fixtures, read once up front rather than through route.fetch()
   * inside each handler. A handler that awaits the network can still be running
   * when the page it was serving has gone, and the response it was holding is
   * disposed out from under it — a flake, and a flake in a test about a dead
   * connection is worse than no test.
   */
  const fixtures = async (page) => ({
    route: await (await page.request.get('/fresh/api/route/4.json')).json(),
    departures: await (await page.request.get('/fresh/api/departures/4.json')).json(),
  })

  /*
   * Serve api/departures/4.json through a handler that may change its mind.
   *
   * The first answer is held until the live route payload has actually landed in
   * the client. That is not a convenience: the live payload is the only thing
   * that says what service day it is, and a schedule judged before one has
   * arrived is deliberately judged against nothing and marked 'ok'. Which of two
   * independent requests returns first would otherwise decide the state every
   * assertion below starts from. Holding it pins the ordinary case — the one
   * where the board knows what day it is — and leaves the other to the test that
   * is actually about it.
   */
  const departuresServedBy = async (page, answer) => {
    let n = 0
    await page.route('**/api/departures/4.json', async (route) => {
      n += 1
      if (n === 1) {
        await page.waitForFunction(() => !!(window.CMB && window.CMB.app && window.CMB.app.state.data))
      }
      await answer(route, n)
    })
    return () => n
  }

  /** The real fixture, re-dated. */
  const dated = (route, doc, date) => route.fulfill({ json: { ...doc, service_date: date } })

  const statusOf = (page) => page.evaluate(() => window.CMB.app.state.depStatus['4'])
  const dateHeld = (page) =>
    page.evaluate(() => {
      const d = window.CMB.app.state.departures['4']
      return d ? d.service_date : null
    })
  const tick = (page, times = 1) =>
    page.evaluate((n) => {
      for (let i = 0; i < n; i += 1) window.CMB.app.tick()
    }, times)

  test('keeps one dated today, and does not ask for it again', async ({ page }) => {
    const fix = await fixtures(page)
    const asked = await departuresServedBy(page, (route) => dated(route, fix.departures, TODAY))
    await page.goto(STOPS)
    await expect(page.locator('.stopcard .stopdep').first()).toBeVisible()
    expect(await statusOf(page)).toBe('ok')

    await tick(page, 3)
    await page.waitForTimeout(400)
    expect(asked(), 'a current schedule was re-fetched').toBe(1)
    expect(await statusOf(page)).toBe('ok')
    expect(await dateHeld(page)).toBe(TODAY)
  })

  test('replaces one describing a service day that has passed', async ({ page }) => {
    /* Yesterday's on the first ask, today's on the second — so a swap is visible
     * as a swap rather than as the same bytes arriving twice. */
    const fix = await fixtures(page)
    const asked = await departuresServedBy(page, (route, n) =>
      dated(route, fix.departures, n === 1 ? YESTERDAY : TODAY),
    )
    await page.goto(STOPS)
    await expect(page.locator('.stopcard .stopdep').first()).toBeVisible()
    /* Shown, because it is still the best answer there is — but marked, so the
     * timer asks again instead of trusting it for the session. */
    expect(await statusOf(page)).toBe('stale')
    expect(await dateHeld(page)).toBe(YESTERDAY)

    await tick(page)
    await expect.poll(() => dateHeld(page)).toBe(TODAY)
    expect(asked()).toBe(2)
    expect(await statusOf(page)).toBe('ok')
  })

  test('a replacement that fails leaves the schedule already in hand', async ({ page }) => {
    const fix = await fixtures(page)
    const asked = await departuresServedBy(page, (route, n) =>
      n === 1
        ? dated(route, fix.departures, YESTERDAY)
        : route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"gone"}' }),
    )
    await page.goto(STOPS)
    const departure = page.locator('.stopcard .stopdep').first()
    await expect(departure).toBeVisible()
    expect(await statusOf(page)).toBe('stale')

    await tick(page)
    await expect.poll(() => statusOf(page)).toBe('error')
    expect(asked()).toBe(2)

    /*
     * The whole point. On a dead connection the old code deleted a good schedule
     * and then could not fetch one back, and the card that had a service day on
     * it a second earlier said "Schedule not loaded".
     */
    expect(await dateHeld(page), 'the schedule was destroyed by a failed refetch')
      .toBe(YESTERDAY)
    await expect(departure).toBeVisible()
    await expect(page.getByText('Schedule not loaded')).toHaveCount(0)
  })

  test('re-asks when the service day rolls over under a document that fetched cleanly', async ({ page }) => {
    /*
     * The one case the 'stale' marking does not cover: the document was current
     * when it arrived and stopped being so while the tab stayed open. Only the
     * timer may clear an 'ok' status — paint() calls loadDepartures, so a status
     * paint could clear is a fetch-and-render loop — which is why this lives in
     * retryDepartures and not anywhere a repaint can reach.
     */
    const fix = await fixtures(page)
    let routeAsked = 0
    await page.route('**/api/route/4.json', (route) => {
      routeAsked += 1
      route.fulfill({
        json: routeAsked > 1
          ? { ...fix.route, service_day: { ...fix.route.service_day, date: TOMORROW } }
          : fix.route,
      })
    })
    const asked = await departuresServedBy(page, (route) => dated(route, fix.departures, TODAY))

    await page.goto(STOPS)
    await expect(page.locator('.stopcard .stopdep').first()).toBeVisible()
    expect(await statusOf(page)).toBe('ok')
    expect(asked()).toBe(1)

    /* One turn to pick up the new date, one to act on it. */
    await tick(page)
    await expect.poll(() =>
      page.evaluate(() => window.CMB.app.state.data.service_day.date)).toBe(TOMORROW)
    await tick(page)
    await expect.poll(() => asked(), { message: 'yesterday was kept for the life of the tab' })
      .toBe(2)
  })

  test('does not fire a second request while one is still in flight', async ({ page }) => {
    /*
     * The retry runs once a minute against a document that is still expired,
     * because the request replacing it has not come back yet. Clearing the status
     * there fired a duplicate alongside it, then a third — and with nothing
     * tracking any of them the older response could land last and reinstate what
     * the newer one had already replaced. A slow connection is the only place
     * this happens, and is exactly the place it must not.
     */
    const fix = await fixtures(page)
    const asked = await departuresServedBy(page, async (route, n) => {
      if (n > 1) await new Promise((resolve) => setTimeout(resolve, 1500))
      await dated(route, fix.departures, YESTERDAY)
    })
    await page.goto(STOPS)
    await expect(page.locator('.stopcard .stopdep').first()).toBeVisible()
    expect(await statusOf(page)).toBe('stale')

    await tick(page)
    await page.waitForFunction(() => window.CMB.app.state.depStatus['4'] === 'loading')
    await tick(page, 3)
    await page.waitForTimeout(300)
    expect(asked(), 'a request in flight was forgotten and re-issued').toBe(2)
  })
})

test.describe('pasting a link into a tab that is already open', () => {
  /*
   * The commonest way a link actually gets used: the board is open, the link
   * arrives in a message, it goes in the address bar. Only the fragment changes,
   * so nothing reloads.
   */
  test('switches to the stops view even when those stops are already kept', async ({ page }) => {
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Keep on this phone' }).click()

    /* Reopen with no plan in the address bar and get onto the route board, which
     * is the state a tab is in when a link arrives in a message. */
    await page.goto('/fresh/index.html')
    await page.locator('.viewtabs__btn[data-view="board"]').click()
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Route')

    await page.evaluate((plan) => { window.location.hash = `plan=${plan}` }, PLAN)
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Stops')
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()
  })

  test('does not re-open a declined offer when some other fragment changes', async ({ page }) => {
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Just this once' }).click()
    await expect(page.locator('.offer')).toHaveCount(0)

    /* An unrelated fragment must not drag adoptPlan() through a rebuild, which is
     * what would put the declined offer back on screen. */
    await page.evaluate(() => { window.location.hash = 'something-else' })
    await page.waitForTimeout(300)
    await expect(page.locator('.offer')).toHaveCount(0)
  })

  test('kept stops survive an unrelated fragment replacing the plan', async ({ page }) => {
    /* Once they are on the phone the address bar is not the only copy, so
     * overwriting the fragment must not take them off screen. */
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Keep on this phone' }).click()
    await page.evaluate(() => { window.location.hash = 'something-else' })
    await page.waitForTimeout(300)
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()
    await expect(page.locator('.offer')).toHaveCount(0)
  })

  test('leaves an unrelated fragment alone', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Route')
    await page.evaluate(() => { window.location.hash = 'somewhere-else' })
    await page.waitForTimeout(300)
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Route')
  })
})
