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
/*
 * The turnaround scenario, not /fresh/. Route 4's schedule here is the turnaround
 * trim this view exists for; under /fresh/ it is the whole golden service day
 * the trip view is asserted against, and neither can stand in for the other.
 * The live payload is the ordinary fresh one either way.
 */
const LINK = `/turnaround/index.html#plan=${PLAN}`

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
    await page.goto('/turnaround/index.html#plan=1;837.1.2112.all')
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
    await page.goto('/turnaround/index.html')
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Stops')
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()
    await expect(page.locator('.offer')).toHaveCount(0)
  })

  test('still shows the stops when the offer is declined, and forgets them on reload', async ({ page }) => {
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Just this once' }).click()
    await expect(page.locator('.offer')).toHaveCount(0)
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()

    await page.goto('/turnaround/index.html')
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

  /*
   * AND IT IS MOVED BEFORE THE FIRST REQUEST GOES OUT, NOT MERELY BEFORE THE
   * SECOND REPAINT.
   *
   * A Referer header carries the query string of the page that issued the
   * request. Every fetch made while '?plan=' is still in the address bar can
   * therefore hand a legible description of a child's routine to whatever it was
   * addressed to. index.html and the vhost both declare no-referrer, so this is
   * the third lock on the same door — but it is the one boot() controls, and it
   * is free.
   *
   * Nothing pinned it. adoptPlan() could be moved below loadCatalog() and the
   * whole suite stayed green, because by the time anything is on screen the
   * scrub has happened either way. So this watches the address bar at the moment
   * each request leaves, which is the only moment that decides it.
   */
  test('scrubs the query before the first request leaves, not after', async ({ page }) => {
    await page.addInitScript(() => {
      window.__leaks = []
      const realFetch = window.fetch
      window.fetch = function (...args) {
        window.__leaks.push({
          kind: 'fetch',
          url: String(args[0]),
          search: window.location.search,
        })
        return realFetch.apply(this, args)
      }
      const realReplace = window.History.prototype.replaceState
      window.History.prototype.replaceState = function (...args) {
        const out = realReplace.apply(this, args)
        window.__leaks.push({ kind: 'scrub', search: window.location.search })
        return out
      }
    })

    await page.goto(`/turnaround/index.html?plan=${encodeURIComponent(PLAN)}`)
    await expect(page.locator('.stopcard').first()).toBeVisible()

    const events = await page.evaluate(() => window.__leaks)
    const fetches = events.filter((e) => e.kind === 'fetch')
    expect(fetches.length, 'nothing was fetched, so nothing was proved').toBeGreaterThan(0)

    /* The scrub is first, and every request after it went out clean. */
    expect(events[0].kind, 'a request left before the query string was scrubbed').toBe('scrub')
    for (const f of fetches) {
      expect(f.search, `${f.url} was requested with the plan still in the query`)
        .not.toContain('plan')
    }
  })

  test('moves a plan out of the query string, so a reload stops leaking it', async ({ page }) => {
    await page.goto(`/turnaround/index.html?plan=${encodeURIComponent(PLAN)}`)
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
    const seen = await countRequests(page, '/turnaround/index.html#plan=1;4.1.6243.all;7.1.847.all')
    for (const [url, n] of seen) {
      expect(n, `${url} was fetched ${n} times`).toBeLessThanOrEqual(2)
    }
  })
})

test.describe('a cancelled trip on a stops card', () => {
  /* Republic Square: route 837 turns around here, and CapMetro canceled the
   * 10:13 northbound in the 2026-08-19 capture. */
  const CANCELED = '/turnaround/index.html#plan=1;837.1.2112.all'

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

  /*
   * A DELETE IS A WRITE, AND CAN BE REFUSED THE SAME WAY.
   *
   * Both of these announced that something had been removed, and left it in
   * storage. The stops came back on the next load having been declared gone,
   * which is the same lie as claiming a save that never happened, told in the
   * other direction — and it was told by the two call sites the save fix did not
   * reach.
   */
  const refuseWrites = (page, kinds) =>
    page.addInitScript((k) => {
      const setItem = Storage.prototype.setItem
      const removeItem = Storage.prototype.removeItem
      if (k.includes('set')) {
        Storage.prototype.setItem = function (key, v) {
          if (String(key).indexOf('cmb.plan') === 0) throw new Error('QuotaExceededError')
          return setItem.call(this, key, v)
        }
      }
      if (k.includes('remove')) {
        Storage.prototype.removeItem = function (key) {
          if (String(key).indexOf('cmb.plan') === 0) throw new Error('SecurityError')
          return removeItem.call(this, key)
        }
      }
    }, kinds)

  test('says storage refused instead of announcing stops were forgotten', async ({ page }) => {
    /* Kept first, with writes still working, so there is something real to
     * refuse to remove. */
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Keep on this phone' }).click()
    await expect(page.locator('.offer')).toHaveCount(0)

    await refuseWrites(page, ['remove'])
    await page.reload()
    await page.getByRole('button', { name: 'Forget these stops' }).click()

    await expect(page.getByText('Nothing could be saved on this phone.')).toBeVisible()
    /* Still kept, and still SAYING it is kept — the button is the proof, because
     * it only appears for a set that storage holds. */
    await expect(page.getByRole('button', { name: 'Forget these stops' })).toBeVisible()

    /* And they really are still there, which is the half the reader would have
     * discovered tomorrow. */
    await page.goto('/turnaround/index.html')
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()
  })

  test('says storage refused instead of announcing a stop was removed', async ({ page }) => {
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Keep on this phone' }).click()
    await expect(page.locator('.stopcard')).toHaveCount(2)

    await refuseWrites(page, ['set'])
    await page.reload()
    await expect(page.locator('.stopcard')).toHaveCount(2)
    await page.locator('.stopcard').filter({ hasText: 'Simond SB' })
      .getByRole('button', { name: /Remove/ }).click()

    await expect(page.getByText('Nothing could be saved on this phone.')).toBeVisible()
    /* The stop stays on screen, because it stayed in storage. Taking it off and
     * then discarding the refusal put it back on the next load, which reads as
     * the board undoing an edit by itself. */
    await expect(page.locator('.stopcard')).toHaveCount(2)
    await expect(page.getByText('Simond SB').first()).toBeVisible()
  })
})

test.describe('a link is untrusted input', () => {
  test('a stop id naming something on Object.prototype does not blank the board', async ({ page }) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/turnaround/index.html#plan=1;4.1.constructor.all;4.1.6243.all')
    await expect(page.locator('.stopcard').first()).toBeVisible()
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()
    await page.waitForTimeout(1000)
    expect(errors, errors.join('; ')).toHaveLength(0)
  })

  test('a ROUTE id naming something on Object.prototype does not kill the fixture server', async ({ page }) => {
    /*
     * The sibling of the test above, one field to the left, and it did not fail
     * here — it failed everywhere else.
     *
     * A route id becomes a request for api/departures/{id}.json, and the fixture
     * server looked that id up in a bare object. `DEPARTURES['constructor']` is
     * the Object function: truthy, so the 404 branch never fired, and path.join()
     * was then handed a function and threw inside the request handler. That takes
     * the node process down, so this one link killed the server and every test
     * scheduled after it failed for reasons of its own — which is the worst way
     * for a suite to break, because nothing points at the cause.
     */
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/turnaround/index.html#plan=1;constructor.1.6243.all;4.1.6243.all')
    await expect(page.locator('.stopcard').first()).toBeVisible()
    await page.waitForTimeout(500)
    expect(errors, errors.join('; ')).toHaveLength(0)

    /* The part that actually mattered: the server is still there for whatever
     * runs next. */
    const after = await page.request.get('/fresh/api/departures/4.json')
    expect(after.status(), 'the fixture server did not survive the link').toBe(200)
  })

  test('the fixture server answers hostile paths rather than dying on them', async ({ page }) => {
    for (const url of [
      '/fresh/api/departures/constructor.json',
      '/fresh/api/departures/toString.json',
      '/fresh/api/departures/__proto__.json',
      '/constructor/api/route/4.json',
      '/toString/index.html',
    ]) {
      const res = await page.request.get(url)
      expect(res.status(), `${url} took the server down or was answered as real`)
        .toBeGreaterThanOrEqual(400)
    }
    expect((await page.request.get('/fresh/api/departures/4.json')).status()).toBe(200)
  })

  test('a link with hundreds of stops is capped rather than fetched in full', async ({ page }) => {
    const routes = new Set()
    page.on('request', (r) => {
      const m = /\/api\/departures\/([^/]+)\.json/.exec(r.url())
      if (m) routes.add(m[1])
    })
    const many = Array.from({ length: 300 }, (_, i) => `r${i}.1.6243.all`).join(';')
    await page.goto(`/turnaround/index.html#plan=1;${many}`)
    await expect(page.locator('.stopcard').first()).toBeVisible()
    await page.waitForTimeout(1500)
    /* Plus the open route board's own schedule, which is not part of the plan. */
    expect(routes.size).toBeLessThanOrEqual(7)
  })
})

test.describe('the link and the screen stay in step', () => {
  /*
   * The path says which view is on screen; the fragment says which stops a link
   * is proposing. Both are in the address bar and neither may erase the other.
   *
   * They are separate for a reason that is not tidiness: a path is sent to the
   * server and turns up in a Referer, and what the plan describes is where a
   * child stands and at what time. That half stays after the `#`, which browsers
   * do not send.
   */
  test('the address bar names the stops view, and still carries the stops', async ({ page }) => {
    await page.goto(LINK)
    await expect(page.locator('.stopcard').first()).toBeVisible()

    const url = new URL(page.url())
    /* Not `/route/4/...`, which is what the board would say. Sharing that would
     * send the recipient somewhere other than what the sender was looking at —
     * the failure the URL work already fixed once for the legacy query links. */
    expect(url.pathname, 'the path should describe the view on screen').toMatch(/\/stops$/)
    expect(url.hash, 'and the stops should still be in the fragment').toContain('plan=')
    /* And never in the part that reaches the server. */
    expect(url.search).not.toContain('plan=')
  })

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
    /* /missing/ 500s every api/route request, so the client is on the fixture.
     * A 'flaky*' schedule loads once, is dated 20260818, and 500s thereafter —
     * one counter per route id, so this test owns 'flaky-kept' outright. */
    await page.goto('/missing/index.html#plan=1;flaky-kept.1.6243.all')

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
    const status = await page.evaluate(() => window.CMB.app.state.depStatus['flaky-kept'])
    expect(status, 'the bundled fixture was read as today').not.toBe('stale')
  })

  test('does not spin re-requesting it either', async ({ page }) => {
    const seen = new Map()
    page.on('request', (r) => {
      const u = new URL(r.url()).pathname
      if (!/\/api\/departures\//.test(u)) return
      seen.set(u, (seen.get(u) ?? 0) + 1)
    })
    await page.goto('/missing/index.html#plan=1;flaky-spin.1.6243.all')
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
  const STOPS = '/turnaround/index.html#plan=1;4.1.6243.all'

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
    /* Held, so a failed replacement cannot lose it — but not believed, so the
     * card says it is out of date instead of answering out of it. */
    await expect(page.locator('.stopcard')).toContainText('Schedule out of date')
    expect(await statusOf(page)).toBe('stale')
    expect(await dateHeld(page)).toBe(YESTERDAY)

    await tick(page)
    await expect.poll(() => dateHeld(page)).toBe(TODAY)
    expect(asked()).toBe(2)
    expect(await statusOf(page)).toBe('ok')
    /* And the card answers again the moment a current document arrives. */
    await expect(page.locator('.stopcard .stopdep').first()).toBeVisible()
  })

  test('a replacement that fails leaves the schedule already in hand', async ({ page }) => {
    const fix = await fixtures(page)
    const asked = await departuresServedBy(page, (route, n) =>
      n === 1
        ? dated(route, fix.departures, YESTERDAY)
        : route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"gone"}' }),
    )
    await page.goto(STOPS)
    const card = page.locator('.stopcard').first()
    await expect(card).toContainText('Schedule out of date')
    expect(await statusOf(page)).toBe('stale')

    await tick(page)
    await expect.poll(() => statusOf(page)).toBe('error')
    expect(asked()).toBe(2)

    /*
     * The whole point. On a dead connection the old code deleted a good schedule
     * and then could not fetch one back.
     *
     * The two outcomes are distinguishable on screen, which is what makes this a
     * test and not an inspection of a variable: a document that is still there
     * reads "Schedule out of date", and one that was destroyed reads "Schedule
     * not loaded" — the card having nothing at all to describe.
     */
    expect(await dateHeld(page), 'the schedule was destroyed by a failed refetch')
      .toBe(YESTERDAY)
    await expect(card).toContainText('Schedule out of date')
    await expect(page.getByText('Schedule not loaded')).toHaveCount(0)
  })

  test('does not treat a document from the FUTURE as expired', async ({ page }) => {
    /*
     * Older, not merely different. Around the service-day roll the live payload
     * can still be from before it while a schedule fetched a moment later is from
     * after; testing for `!==` called the fresher of the two expired and re-asked
     * for it every sixty seconds until the live payload caught up. Any skew in
     * that direction has the same shape.
     */
    const fix = await fixtures(page)
    const asked = await departuresServedBy(page, (route) => dated(route, fix.departures, TOMORROW))
    await page.goto(STOPS)
    await expect(page.locator('.stopcard').first()).toBeVisible()

    expect(await statusOf(page), 'a schedule from ahead of today was called expired').toBe('ok')
    await tick(page, 3)
    await page.waitForTimeout(400)
    expect(asked()).toBe(1)
  })

  test('an out-of-date schedule never claims today’s service is over', async ({ page }) => {
    /*
     * The sentence at issue is "The last one today has gone. Back tomorrow."
     *
     * A document from a previous service day measures its times from yesterday's
     * midnight, so nothing on it is ever upcoming and every stop falls through to
     * that sentence — a claim about TODAY made out of a document that does not
     * describe today. On a board left open overnight and picked up at breakfast,
     * it is the sentence that sends somebody home.
     */
    const fix = await fixtures(page)
    await departuresServedBy(page, (route) =>
      route.fulfill({
        json: {
          ...fix.departures,
          service_date: YESTERDAY,
          /* Genuinely yesterday's document: the day start goes back with the
             date, which is what puts every departure behind the clock. */
          service_day_start_epoch: fix.departures.service_day_start_epoch - 86400,
        },
      }),
    )
    await page.goto(STOPS)
    const card = page.locator('.stopcard').first()
    await expect(card).toBeVisible()

    await expect(card).not.toContainText('Back tomorrow')
    await expect(card).not.toContainText('Nothing left today')
    await expect(card).toContainText('Schedule out of date')
    await expect(card).toContainText('earlier service day')
    /* And it is not passed off as a schedule that has not arrived, which would
     * have the reader waiting for something already on the phone. */
    await expect(card).not.toContainText('Schedule not loaded')
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
    /*
     * Asked AGAIN, rather than asked exactly twice.
     *
     * Two mechanisms now act on the roll and both are wanted: the route
     * payload's own handler re-checks the schedule the moment the new date
     * lands, so the board does not read yesterday's times for a further full
     * minute, and the timer's sweep asks again after that. This fixture keeps
     * serving the same out-of-date document, so every turn is entitled to
     * another attempt — which is the point, since the day it describes has
     * ended. Pinning the count to 2 pinned it to one of the two mechanisms.
     *
     * The loop this could become is covered next door: a repaint may not ask,
     * and a request already in flight may not be duplicated.
     */
    await expect.poll(() => asked(), { message: 'yesterday was kept for the life of the tab' })
      .toBeGreaterThanOrEqual(2)
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
    await expect(page.locator('.stopcard')).toContainText('Schedule out of date')
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
    await page.goto('/turnaround/index.html')
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
    await page.goto('/turnaround/index.html')
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Route')
    await page.evaluate(() => { window.location.hash = 'somewhere-else' })
    await page.waitForTimeout(300)
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Route')
  })

  test('an unrelated fragment does not empty a board opened from a link', async ({ page }) => {
    /*
     * Declined, so the stops live nowhere but this page. A fragment naming
     * something else - an in-page anchor, or a Back onto the URL as it was
     * before the link - used to drag the plan through a rebuild, find no link
     * and nothing in storage, and replace two stops the reader was looking at
     * with "No stops on this phone yet". Nothing about that fragment said the
     * stops had stopped being the right answer.
     */
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Just this once' }).click()
    await expect(page.locator('.stopcard')).toHaveCount(2)

    await page.evaluate(() => { window.location.hash = 'somewhere-else' })
    await page.waitForTimeout(300)
    await expect(page.locator('.stopcard')).toHaveCount(2)
    await expect(page.getByText('No stops on this phone yet')).toHaveCount(0)
  })

  test('a declined offer does not come back after a detour through another link', async ({ page }) => {
    /*
     * Back onto the same fragment is the easy half, and the early return above
     * covers it: the plan on screen still matches, so nothing is rebuilt.
     *
     * This is the half that needs the decline to be remembered. A second,
     * DIFFERENT link in between makes the plan on screen no longer match, so
     * coming back does run adoptPlan() — which builds `offer` from the link and
     * storage and knows nothing about what the reader has already answered. A
     * decline is about a set of stops, so it is remembered as one.
     */
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Just this once' }).click()
    await expect(page.locator('.offer')).toHaveCount(0)

    /* Somewhere else entirely, with its own stops, and offered as it should be. */
    await page.evaluate(() => { window.location.hash = 'plan=1;837.1.2112.all' })
    await expect(page.locator('.offer')).toBeVisible()

    await page.goBack()
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()
    await expect(page.locator('.offer'), 'the declined offer came back').toHaveCount(0)
  })

  test('a declined offer does not come back on Back', async ({ page }) => {
    /*
     * Going somewhere and pressing Back is the ordinary way to arrive at the
     * link's own URL a second time, and adoptPlan() rebuilds `offer` from
     * scratch every time it runs. A decline was a property of that one run, so
     * the offer the reader had just dismissed came straight back. Asking twice
     * is how a board teaches somebody to stop reading it.
     */
    await page.goto(LINK)
    await page.getByRole('button', { name: 'Just this once' }).click()
    await expect(page.locator('.offer')).toHaveCount(0)

    await page.evaluate(() => { window.location.hash = 'somewhere-else' })
    await page.waitForTimeout(200)
    await page.goBack()
    await expect(page.locator('.stopcard').first()).toBeVisible()
    await expect(page.locator('.offer'), 'the declined offer came back').toHaveCount(0)
  })
})

/*
 * A SECOND LINK MUST NOT QUIETLY UNDO THE FIRST.
 *
 * The case is a parent with one child's stops kept who opens the other child's
 * link. save() replaces, so tapping the one obvious button threw the first set
 * away - no warning, no undo, and the only way back is finding the original
 * link again. That is the feature destroying the exact thing it exists to keep.
 */
test.describe('keeping a second link', () => {
  const FIRST = '/turnaround/index.html#plan=1;4.1.6243.all'
  const SECOND = '/turnaround/index.html#plan=1;800.1.6293.all'

  test('adds to the stops already kept instead of replacing them', async ({ page }) => {
    await page.goto(FIRST)
    await page.getByRole('button', { name: 'Keep on this phone' }).click()
    await expect(page.locator('.offer')).toHaveCount(0)

    await page.goto(SECOND)
    /* It says what is about to happen, and the button says ADD. */
    const offer = page.locator('.offer')
    await expect(offer).toContainText('already keeps 1 stop')
    await expect(offer).toContainText('Nothing already on this phone is removed')
    await page.getByRole('button', { name: 'Add to this phone' }).click()

    /* Both sets, on the board with no link in the address bar - which is the
     * only place the answer actually matters. */
    await page.goto('/turnaround/index.html')
    await expect(page.locator('.viewtabs__btn.is-on')).toHaveText('Stops')
    await expect(page.getByText('Campbell/5th').first()).toBeVisible()
    await expect(page.getByText('Simond SB').first()).toBeVisible()
  })

  test('offers plainly to keep, not to add, when nothing is kept yet', async ({ page }) => {
    await page.goto(FIRST)
    await expect(page.locator('.offer')).not.toContainText('already keeps')
    await expect(page.getByRole('button', { name: 'Keep on this phone' })).toBeVisible()
  })

  test('does not re-offer a link whose stops are all already kept', async ({ page }) => {
    await page.goto(FIRST)
    await page.getByRole('button', { name: 'Keep on this phone' }).click()
    await page.reload()
    await expect(page.locator('.stopcard').first()).toBeVisible()
    await expect(page.locator('.offer')).toHaveCount(0)
  })
})
