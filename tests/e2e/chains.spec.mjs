/**
 * Transfer chains, driven the way a person drives them.
 *
 * The unit suite proves the arithmetic against the same fixture. This proves the
 * part the unit suite structurally cannot: that a real browser can get from an
 * empty Saved tab to a saved chain by pressing things, and that the card it ends
 * up with says something. The vm sandbox the node tests use has no layout, no
 * events and no classList, so every one of these steps is invisible to it.
 *
 * The journey built here is the one the feature was asked for — the 07:52 route
 * 800 southbound from Simond SB, changing onto route 4 — and the two routes share
 * no stop ids, so the connection step is only populated at all if the walk radius
 * works end to end.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'

/* The board opened straight off disk, which index.html states is a requirement
   and not a convenience. Nothing about it is simulated: no origin, so no api/*. */
const FILE_BOARD = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/index.html')
).href

/* The fixture's own service day; the client's clock follows the feed, not the
 * device, so nothing here depends on when the suite is run. */
/*
 * The chain scenario, not /fresh/: it serves the schedules this feature was
 * designed against rather than the ones the rest of the suite uses. The live
 * payload is the ordinary fresh one either way.
 *
 * Not load bearing, and worth saying so plainly: pointed at /fresh/ these 24
 * tests all still pass, because the synthetic route 800 schedule happens to
 * carry the same trip and the golden route 4 document is a superset. The prefix
 * is here so that editing either fixture cannot quietly change what the other
 * one's tests mean — it is insulation, not a dependency.
 */
const SAVED = '/chain/index.html?view=saved'

/** Walk the editor as far as a picked first-leg departure. */
async function pickFirstLeg(page) {
  await page.goto(SAVED)
  await page.getByRole('button', { name: 'Save a chain' }).click()

  /* 1. Route. The fallback catalog is the six routes this household rides. */
  await page.locator('.routegrid__item', { hasText: '800' }).first().click()

  /* 2. Direction: southbound is the one that serves Simond SB. */
  await page.locator('.chipbtn').filter({ hasText: /SB/ }).first().click()

  /* 3. Stop. */
  await page.locator('.stoplist__item', { hasText: 'Simond SB' }).first().click()

  /* 4. Departure. */
  await page.locator('.timegrid__item', { hasText: '7:52a' }).first().click()
}

test.describe('building a chain', () => {
  test('the Saved tab offers a chain before there is one', async ({ page }) => {
    await page.goto(SAVED)
    await expect(page.locator('.band--chains')).toBeVisible()
    await expect(page.getByText('journey with a change in it')).toBeVisible()
  })

  test('the first leg is picked exactly like a saved trip', async ({ page }) => {
    await pickFirstLeg(page)
    await expect(page.locator('.step__chosen').first()).toContainText('7:52a')
    await expect(page.locator('.step__chosen').first()).toContainText('Simond SB')
  })

  test('the onward route offers connections that exist, across a walk', async ({ page }) => {
    await pickFirstLeg(page)
    await page.locator('.routegrid__item', { hasText: '4' }).first().click()
    await page.locator('.chipbtn').first().click()

    const rows = page.locator('.connlist__item')
    await expect(rows.first()).toBeVisible()
    expect(await rows.count()).toBeGreaterThan(0)

    /*
     * Routes 800 and 4 share no stop ids, so every connection here is a walk
     * between two differently-named stops. A row that said "same stop" would mean
     * the transfer had been found by an id intersection, which on this pair can
     * only have matched by accident.
     */
    await expect(rows.first()).toContainText('walk')
    /* "spare", not "wait": the figure is what is left AFTER the walk is charged,
       and calling it the wait understated the standing-around by the whole walk. */
    await expect(rows.first()).toContainText('min spare')
    await expect(rows.first()).not.toContainText('min wait')
  })

  test('the route already being ridden is not offered as a change', async ({ page }) => {
    await pickFirstLeg(page)
    const ids = await page.locator('.routegrid__id').allInnerTexts()
    expect(ids).not.toContain('800')
  })

  test('saving one produces a card that reads as a single journey', async ({ page }) => {
    await pickFirstLeg(page)
    await page.locator('.routegrid__item', { hasText: '4' }).first().click()
    await page.locator('.chipbtn').first().click()
    await page.locator('.connlist__item').first().click()
    await page.getByRole('button', { name: 'Save this chain' }).click()

    const card = page.locator('.chaincard').first()
    await expect(card).toBeVisible()
    await expect(card).toContainText('800 → 4')
    await expect(card).toContainText('1 change')

    /*
     * The verdict is the point of the card, and it must be words, not a color.
     *
     * Matched against the whole vocabulary rather than /Connection|Chain/, which
     * was a loose proxy that happened to exclude three of the six real verdicts —
     * "Tight connection", "Not reached" and the lowercase half of the others. It
     * broke the moment TIGHT_S moved and this card graded tight instead of
     * holding, which is a correct verdict, not a regression. An exhaustive list
     * still fails on a blank label or a card that renders colour alone.
     */
    const verdict = card.locator('.chaincard__verdictlabel').first()
    await expect(verdict).toBeVisible()
    await expect(verdict).toHaveText(
      /^(Connection holds|Tight connection|Connection missed|Chain broken|Not reached|Connection unknown)$/
    )

    /* Both legs, in the order they are ridden. */
    const legs = card.locator('.chaincard__legroute')
    await expect(legs).toHaveCount(2)
    await expect(legs.nth(0)).toHaveText('800')
    await expect(legs.nth(1)).toHaveText('4')
  })

  test('a saved chain survives a reload, because it lives in this browser', async ({ page }) => {
    await pickFirstLeg(page)
    await page.locator('.routegrid__item', { hasText: '4' }).first().click()
    await page.locator('.chipbtn').first().click()
    await page.locator('.connlist__item').first().click()
    await page.getByRole('button', { name: 'Save this chain' }).click()
    await expect(page.locator('.chaincard').first()).toBeVisible()

    await page.goto(SAVED)
    await expect(page.locator('.chaincard').first()).toContainText('800 → 4')
  })

  test('and can be removed again', async ({ page }) => {
    await pickFirstLeg(page)
    await page.locator('.routegrid__item', { hasText: '4' }).first().click()
    await page.locator('.chipbtn').first().click()
    await page.locator('.connlist__item').first().click()
    await page.getByRole('button', { name: 'Save this chain' }).click()
    await expect(page.locator('.chaincard')).toHaveCount(1)

    await page.locator('.chaincard__remove').first().click()
    await expect(page.locator('.chaincard')).toHaveCount(0)
    await expect(page.getByText('journey with a change in it')).toBeVisible()
  })
})

test.describe('the card at 412 pixels', () => {
  test('does not push the page sideways', async ({ page }) => {
    await pickFirstLeg(page)
    await page.locator('.routegrid__item', { hasText: '4' }).first().click()
    await page.locator('.chipbtn').first().click()
    await page.locator('.connlist__item').first().click()
    await page.getByRole('button', { name: 'Save this chain' }).click()
    await expect(page.locator('.chaincard').first()).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test('the whole chain is spoken for a screen reader, not only colored', async ({ page }) => {
    await pickFirstLeg(page)
    await page.locator('.routegrid__item', { hasText: '4' }).first().click()
    await page.locator('.chipbtn').first().click()
    await page.locator('.connlist__item').first().click()
    await page.getByRole('button', { name: 'Save this chain' }).click()

    const spoken = page.locator('.chaincard .sr-only').first()
    await expect(spoken).toHaveText(/route 800 to route 4/)
  })
})

/*
 * Regression, found by the removal test above timing out: every card was being
 * detached and rebuilt continuously.
 *
 * loadRouteData() is called from paint() and its success handler calls render().
 * Its only guard was "am I already fetching", which is false by the time the
 * handler runs, so one fetch repainted, the repaint started another fetch, and
 * the Saved view sat in an unthrottled request loop against the origin for as
 * long as it was open. Nothing looked wrong on screen — the numbers were right
 * — which is exactly the class of failure this project keeps finding.
 */
test.describe('the Saved view does not hammer the origin', () => {
  test('fetches each route payload once, not once per repaint', async ({ page }) => {
    let hits = 0
    await page.route('**/api/route/800.json', (route) => {
      hits += 1
      return route.continue()
    })

    await page.goto(SAVED)
    await page.getByRole('button', { name: 'Save a chain' }).click()
    await page.locator('.routegrid__item', { hasText: '800' }).first().click()
    await page.locator('.chipbtn').filter({ hasText: /SB/ }).first().click()
    await page.locator('.stoplist__item', { hasText: 'Simond SB' }).first().click()
    await page.locator('.timegrid__item', { hasText: '7:52a' }).first().click()
    await page.locator('.routegrid__item', { hasText: '4' }).first().click()
    await page.locator('.chipbtn').first().click()
    await page.locator('.connlist__item').first().click()
    await page.getByRole('button', { name: 'Save this chain' }).click()
    await expect(page.locator('.chaincard').first()).toBeVisible()

    const afterSave = hits
    /* Long enough for a loop to run hundreds of times, well short of the 60s
       refresh that is allowed to fetch again. */
    await page.waitForTimeout(3000)
    expect(hits - afterSave).toBeLessThanOrEqual(1)
    expect(hits).toBeLessThanOrEqual(3)
  })

  /*
   * The first fix here enumerated the statuses that STOP ('loading', 'ok'), so
   * 'error' matched neither and a route that could not be fetched looped hardest of
   * all — a tight spin, since a rejected fetch has no round trip to slow it down.
   * A chain names two or three routes, none of which need be the one on screen, so
   * one unreachable id was enough. Reachable two ways in production: a `file://`
   * board, and a GTFS republish dropping a route a saved chain still names.
   */
  test('a route that 404s is not retried on every paint', async ({ page }) => {
    let hits = 0
    /*
     * Route 800, not route 4. Route 4 is the board's default, and loadRouteData
     * returns early for the route already in state.data — so 404ing route 4 never
     * reaches the guard under test and the assertion passes for the wrong reason.
     * It has to be a route the Saved view fetches on a chain's behalf.
     */
    await page.route('**/api/route/800.json', (route) => {
      hits += 1
      return route.fulfill({ status: 404, body: '{"error":"gone"}' })
    })

    await pickFirstLeg(page)
    await page.locator('.routegrid__item', { hasText: '4' }).first().click()
    await page.locator('.chipbtn').first().click()
    await page.locator('.connlist__item').first().click()
    await page.getByRole('button', { name: 'Save this chain' }).click()
    await expect(page.locator('.chaincard').first()).toBeVisible()

    const afterSave = hits
    await page.waitForTimeout(3000)
    expect(hits - afterSave).toBeLessThanOrEqual(1)
  })

  test('a card stays put long enough to press a button on it', async ({ page }) => {
    await pickFirstLeg(page)
    await page.locator('.routegrid__item', { hasText: '4' }).first().click()
    await page.locator('.chipbtn').first().click()
    await page.locator('.connlist__item').first().click()
    await page.getByRole('button', { name: 'Save this chain' }).click()

    const remove = page.locator('.chaincard__remove').first()
    await expect(remove).toBeVisible()
    /* toBeStable is the assertion the loop failed: the node was being replaced
       between Playwright resolving it and clicking it, 59 times in a row. */
    await remove.click({ timeout: 5000 })
    await expect(page.locator('.chaincard')).toHaveCount(0)
  })
})

/** Build the fixture's chain and leave the browser on the Saved view. */
async function saveTheChain(page) {
  await pickFirstLeg(page)
  await page.locator('.routegrid__item', { hasText: '4' }).first().click()
  await page.locator('.chipbtn').first().click()
  await page.locator('.connlist__item').first().click()
  await page.getByRole('button', { name: 'Save this chain' }).click()
  await expect(page.locator('.chaincard').first()).toBeVisible()
}

/*
 * Staleness was enforced for the route on the board and for nothing else. The Saved
 * view is where that matters most: its routes are by definition NOT the one being
 * watched, so nobody is looking at their board to notice the feed died, and a chain
 * leg on a dead route was graded against frozen positions.
 */
test.describe('a chain leg on a route whose feed died', () => {
  test('says so, and names which route', async ({ page }) => {
    await saveTheChain(page)

    /* Same origin, so the saved chain survives the hop to the dead-cron scenario,
       which serves a 47-minute-old payload for every route id under it. */
    await page.goto('/chaindead/index.html?view=saved')
    const banners = page.locator('.savedbanner')
    await expect(banners.first()).toBeVisible()

    /* Route 800 is leg 1 and is not the board's route — the case that had none. */
    await expect(page.locator('.savedbanner', { hasText: 'Route 800' })).toHaveCount(1)
    await expect(page.locator('.savedbanner', { hasText: 'Route 800' }))
      .toContainText(/Data|Feed is down/)
  })

  test('and the card shows no lateness it cannot stand behind', async ({ page }) => {
    await saveTheChain(page)
    await page.goto('/chaindead/index.html?view=saved')
    await expect(page.locator('.chaincard').first()).toBeVisible()

    /*
     * suppress_adherence is authoritative. With it set, the chain must fall back to
     * the timetable and say so, never print a signed lateness on a frozen position.
     */
    const card = await page.locator('.chaincard').first().innerText()
    expect(card).not.toMatch(/[+\u2212-]\s?\d+\s?m\b/)
  })
})

/*
 * Every refresh ends in render(), which rebuilds the band from scratch. On a
 * six-step editor that discards focus, scroll and any half-made tap once a minute.
 */
test.describe('the editor is not rebuilt underneath the reader', () => {
  test('a mid-edit choice survives a refresh tick', async ({ page }) => {
    await pickFirstLeg(page)
    await page.locator('.routegrid__item', { hasText: '4' }).first().click()
    await page.locator('.chipbtn').first().click()
    await expect(page.locator('.connlist__item').first()).toBeVisible()

    /* Longer than one 60s tick would need if the guard were missing; the point is
       that no repaint replaces the node under us. */
    const before = await page.locator('.step__chosen').first().innerText()
    await page.waitForTimeout(2000)
    const row = page.locator('.connlist__item').first()
    await expect(row).toBeVisible()
    await row.click({ timeout: 5000 })
    await expect(page.locator('.step__chosen').first()).toHaveText(before)
    await expect(page.getByRole('button', { name: 'Save this chain' })).toBeVisible()
  })
})

/*
 * The staleness machinery covered routes that loaded. The route most in need of a
 * banner is the one that did NOT: with no payload it drew nothing, no status, and
 * resolveLeg graded it against the timetable with full confidence — so a leg the
 * board knows nothing about rendered identically to a leg running exactly on time.
 */
test.describe('a chain leg whose route will not load at all', () => {
  test('is visible as missing rather than silently trusted', async ({ page }) => {
    await saveTheChain(page)

    /* A republish renumbering the route is the real-world version of this. */
    await page.route('**/api/route/800.json', (route) =>
      route.fulfill({ status: 404, body: '{"error":"gone"}' })
    )
    await page.goto(SAVED)

    const missing = page.locator('.savedbanner', { hasText: 'Route 800' })
    await expect(missing).toHaveCount(1)
    await expect(missing).toContainText('No live data for route 800')
    await expect(missing.getByRole('button', { name: 'Try again' })).toBeVisible()
  })
})

/*
 * The board announced "Saved …" and navigated away from six steps of work even when
 * localStorage refused, landing the reader on "No transfer chains yet". They cannot
 * tell that from their own mistake, so they do it again.
 */
test.describe('a browser that will not save', () => {
  test('says the browser refused instead of claiming success', async ({ page }) => {
    await page.addInitScript(() => {
      const real = Storage.prototype.setItem
      Storage.prototype.setItem = function (k, v) {
        if (String(k) === 'cmb.chains') throw new Error('QuotaExceededError')
        return real.call(this, k, v)
      }
    })

    await pickFirstLeg(page)
    await page.locator('.routegrid__item', { hasText: '4' }).first().click()
    await page.locator('.chipbtn').first().click()
    await page.locator('.connlist__item').first().click()
    await page.getByRole('button', { name: 'Save this chain' }).click()

    /* Still in the editor, with the choices intact, and told why — on screen... */
    await expect(page.locator('.notice__head', {
      hasText: 'This browser would not save the chain.',
    })).toBeVisible()
    /* ...and out loud, since a reader using a screen reader gets no other signal
       that the button they just pressed did nothing. */
    await expect(page.locator('[role="status"][aria-live="polite"]'))
      .toContainText('would not save')

    await expect(page.locator('.chaincard')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save this chain' })).toBeVisible()
    /* The legs picked over six steps are still there to save or amend. */
    await expect(page.locator('.step__chosen').first()).toContainText('7:52a')
  })
})

/*
 * The third request loop in this file, and the same shape as the other two:
 * paint -> a loader mutates state -> the loader's handler renders -> paint.
 *
 * evictStaleDepartures() drops a cached schedule whose service day is not the
 * board's, and loadSavedRoutes() calls it from paintSaved(). It also deleted the
 * route's depStatus, which is loadDepartures' single-flight guard -- so eviction
 * put the route back to "never fetched", the refetch repainted, and the repaint
 * evicted again for as long as the two dates disagreed.
 *
 * Two ways to disagree persistently in production. After a GTFS republish the
 * board falls back to the embedded fixture, pinning service_day.date at 20260819
 * while departures return today's date -- permanent. And the 3 a.m. rollover gives
 * a transient one for up to a minute.
 */
test.describe('a schedule from another service day does not become a request loop', () => {
  /** Serve every departures document with `date` as its service day. */
  async function departuresDated(page, date) {
    let hits = 0
    await page.route('**/api/departures/*.json', async (route) => {
      hits += 1
      const res = await route.fetch()
      const doc = await res.json()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...doc, service_date: date }),
      })
    })
    return () => hits
  }

  test('an out-of-date schedule is re-asked for once, not on every paint', async ({ page }) => {
    /*
     * The 3 a.m. rollover, with the board across the line and the schedule not:
     * api/route says the service day is the 20th while api/departures still says
     * the 19th. Built first against a board that agrees with itself, because the
     * editor cannot be driven without a schedule it is allowed to use.
     *
     * "Re-asked for", not "evicted": the document is KEPT and withheld rather
     * than deleted, because deleting is only safe if the refetch cannot fail and
     * it can — that loses a whole service day to one bad request. What this
     * asserts is unchanged either way, and it is the part that matters: asking
     * again must not become a thing every paint does.
     */
    await saveTheChain(page)

    const hits = await departuresDated(page, '20260819')
    await page.route('**/api/route/*.json', async (route) => {
      const res = await route.fetch()
      const doc = await res.json()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...doc, service_day: { ...doc.service_day, date: '20260820' } }),
      })
    })

    await page.goto(SAVED)
    await expect(page.locator('.chaincard').first()).toBeVisible()

    const settled = hits()
    /* Long enough for a loop to run hundreds of times, and well short of the 60s
       refresh that is allowed to ask again. */
    await page.waitForTimeout(3000)
    expect(hits() - settled).toBeLessThanOrEqual(1)

    /*
     * And it is not answered from while it is held. A chain is resolved across
     * two or three routes at once, so it takes the whole schedule map rather
     * than one document — and it was handed the raw map, which is how the board
     * ended up grading a connection off a service day that had ended. Same shape
     * as the trip view before it: a surface written after the rule, reading by a
     * route the rule did not cover.
     */
    const card = page.locator('.chaincard').first()
    await expect(card.locator('.chaincard__transfer')).toHaveCount(0)
  })

  test('and a NEWER schedule is still answered from, because the board is the stale one',
    async ({ page }) => {
      /*
       * The republish case. state.data is the embedded fixture, pinned a year
       * back; the departures document is today's and perfectly good. Refusing it
       * — which comparing the two dates for INEQUALITY rather than for older-than
       * does — throws away the only usable schedule on the page.
       */
      const hits = await departuresDated(page, '20260820')
      await saveTheChain(page)
      await expect(page.locator('.chaincard').first()).toBeVisible()

      const settled = hits()
      await page.waitForTimeout(3000)
      expect(hits() - settled).toBeLessThanOrEqual(1)
      /* And the card still has a schedule to reason from. */
      await expect(page.locator('.chaincard__transfer').first()).toBeVisible()
      await expect(page.locator('.chaincard').first()).not.toContainText('Nothing to show')
    })
})

/*
 * Not rebuilding the editor was right. Stopping the whole interval to do it was
 * not: the fix returned before the refreshes as well as before the render, so the
 * board's clock stopped for as long as anybody stood in a six-step editor. Ten
 * minutes of picking stops and the Saved view behind it still said "in 11 minutes"
 * about a bus due in one, because nowEpoch() reads generated_at from a payload
 * nothing was fetching any more.
 */
test.describe('an open editor stops the repaint, not the clock', () => {
  /* One tick per 300 ms rather than per minute. Real timers, real callback --
     only the delay is compressed, so what runs is what ships. */
  async function fastTicks(page) {
    await page.addInitScript(() => {
      const real = window.setInterval.bind(window)
      window.setInterval = (fn, ms) => real(fn, ms >= 60000 ? 300 : ms)
    })
  }

  test('data keeps refreshing behind the editor, and the editor is not rebuilt',
    async ({ page }) => {
      const hits = { 4: 0, 800: 0 }
      await page.route('**/api/route/*.json', async (route) => {
        const id = new URL(route.request().url()).pathname.split('/').pop().replace('.json', '')
        if (hits[id] !== undefined) hits[id] += 1
        return route.continue()
      })
      await fastTicks(page)

      /* A saved chain, so route 800 is a route the Saved view depends on. */
      await saveTheChain(page)

      /* Back into the editor and part-way through it. */
      await page.getByRole('button', { name: 'Save another chain' }).click()
      await page.locator('.routegrid__item', { hasText: '800' }).first().click()
      await page.locator('.chipbtn').filter({ hasText: /SB/ }).first().click()
      await page.locator('.stoplist__item', { hasText: 'Simond SB' }).first().click()
      await page.locator('.timegrid__item', { hasText: '7:52a' }).first().click()
      await page.locator('.routegrid__item', { hasText: '4' }).first().click()
      await page.locator('.chipbtn').first().click()
      await expect(page.locator('.connlist__item').first()).toBeVisible()

      const chosen = await page.locator('.step__chosen').first().innerText()
      const before = { 4: hits[4], 800: hits[800] }
      await page.waitForTimeout(2000)

      /* The board's own route and every route a saved chain names are still being
         fetched. Neither was, while the interval returned early. */
      expect(hits[4] - before[4]).toBeGreaterThan(0)
      expect(hits[800] - before[800]).toBeGreaterThan(0)

      /* And nothing under the reader moved: the choice is intact and the row they
         were about to press is still the same node. */
      await expect(page.locator('.step__chosen').first()).toHaveText(chosen)
      await page.locator('.connlist__item').first().click({ timeout: 5000 })
      await expect(page.getByRole('button', { name: 'Save this chain' })).toBeVisible()
    })
})

/*
 * The banner covers a route whose payload SAYS it is stale, and a route with no
 * payload at all. It missed the one in between: a route that loaded once and has
 * not refreshed since. Its payload still says `fresh`, because it was, an hour
 * ago -- so no banner drew, and the chain leg on it was graded with full
 * confidence against frozen positions. That is the "cron stopped an hour ago"
 * case the banner claims to cover, and it is the one it cannot see, because a
 * document cannot report how long the client has been holding it.
 */
test.describe('a route that loaded once and then stopped refreshing', () => {
  test('goes stale on the clock, draws a banner, and stops being graded',
    async ({ page }) => {
      /* Wall-clock, compressed. The code measures how long it has held a payload
         with Date.now(), so that is the clock the test moves. Route 4 keeps
         refreshing and stays inside its 120 s fresh window throughout. */
      await page.addInitScript(() => {
        const t0 = Date.now()
        const real = Date.now.bind(Date)
        Date.now = () => t0 + (real() - t0) * 200
        const realInterval = window.setInterval.bind(window)
        window.setInterval = (fn, ms) => realInterval(fn, ms >= 60000 ? 300 : ms)
      })

      await saveTheChain(page)
      await expect(page.locator('.chaincard').first()).toBeVisible()

      /* From here on route 800 is unreachable. The payload already fetched stays
         in memory, saying `fresh`, exactly as it would if the cron had died. */
      await page.route('**/api/route/800.json', (route) =>
        route.fulfill({ status: 404, body: '{"error":"gone"}' })
      )

      /* Past 600 s of held time -- the age at which the contract calls a feed
         stale and suppresses lateness. */
      await page.waitForTimeout(4500)

      const banner = page.locator('.savedbanner', { hasText: 'Route 800' })
      await expect(banner).toHaveCount(1)
      await expect(banner).toContainText('Lateness is hidden')

      /* And the verdict stops being asserted from the frozen positions. */
      await expect(page.locator('.chaincard__verdictlabel').first())
        .toHaveText('Connection unknown')
    })
})

/*
 * A schedule that fails to load leaves the editor on "Loading the schedule for
 * route 800…" for the life of the tab. Nothing retries it -- the interval's retry
 * covers the route on the board and the routes a saved chain names, and the route
 * somebody is part-way through picking is neither -- so there is no error, no
 * button, and no way forward. On a file:// board, which is a supported way to open
 * this, every route takes that path every time.
 */
/*
 * The other way an editor can be left with no schedule, and the one nothing
 * covered: the document is present and the board is WITHHOLDING it.
 *
 * A schedule from a service day that has ended is kept and refused rather than
 * deleted, so its status stays 'ok' — and 'ok' is not 'error', which is the only
 * thing the interval's retry acts on. The routes a chain is part-way through
 * naming are also in neither store yet, so the schedule sweep does not know
 * them either. The saved-trip editor has re-asked on every paint since that
 * withholding landed; this editor was written on another branch and the merge
 * never paired them, which left it on "Loading the schedule for route 800…"
 * with no retry button for the life of the view.
 */
test.describe('a schedule the editor is holding but may not use', () => {
  test('is asked for again rather than leaving the step list empty', async ({ page }) => {
    /* Serve it dated a day before the live payload: present, and unusable. */
    let stale = true
    await page.route('**/api/departures/800.json', async (route) => {
      const res = await route.fetch()
      const doc = await res.json()
      if (!stale) return route.fulfill({ response: res })
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...doc, service_date: '20260818' }),
      })
    })

    /* One tick per 300 ms rather than per minute. Real timers, real callback --
       only the delay is compressed, so what runs is what ships. The tick is what
       has to notice, because renderLive() stops the repaint while an editor is
       open and the paint-time re-ask therefore never runs. */
    await page.addInitScript(() => {
      const real = window.setInterval.bind(window)
      window.setInterval = (fn, ms) => real(fn, ms >= 60000 ? 300 : ms)
    })

    await page.goto(SAVED)
    await page.locator('button:visible', { hasText: 'Save a chain' }).first().click()
    await page.locator('.routegrid__item', { hasText: '800' }).first().click()
    await page.waitForTimeout(300)

    /* The replacement arrives. The editor must go and get it. */
    stale = false
    await page.waitForTimeout(1500)

    /* Directions come from the schedule, so their presence is the schedule
     * having been re-asked for and used. */
    await expect(page.locator('button:visible', { hasText: /Goodnight SB|Mueller NB/ }).first())
      .toBeVisible({ timeout: 5000 })
  })
})

test.describe('a schedule the editor cannot load is not a dead end', () => {
  test('says what happened and offers a way out', async ({ page }) => {
    let failing = true
    await page.route('**/api/departures/800.json', (route) =>
      failing
        ? route.fulfill({ status: 500, body: '{"error":"upstream"}' })
        : route.continue()
    )

    await page.goto(SAVED)
    await page.getByRole('button', { name: 'Save a chain' }).click()
    await page.locator('.routegrid__item', { hasText: '800' }).first().click()

    /* Named, so the reader knows which of the three routes is the problem. */
    const notice = page.locator('.notice', { hasText: 'route 800' })
    await expect(notice).toContainText('could not be loaded')
    await expect(notice).not.toContainText('Loading the schedule')
    const retry = notice.getByRole('button', { name: 'Try again' })
    await expect(retry).toBeVisible()

    /* And the way out actually leads out. */
    failing = false
    await retry.click()
    await expect(page.locator('.chipbtn').filter({ hasText: /SB/ }).first()).toBeVisible()
  })

  test('and from a file it explains rather than offering a button that cannot help',
    async ({ page }) => {
      /*
       * There is no origin to read api/departures/ from, so the request never
       * happens and Try again has nothing to try. Saying "could not be loaded"
       * there sends the reader hunting for a fault in their network.
       */
      await page.goto(`${FILE_BOARD}?view=saved`)
      await page.getByRole('button', { name: 'Save a chain' }).click()
      await page.locator('.routegrid__item', { hasText: '800' }).first().click()

      const notice = page.locator('.notice', { hasText: 'route 800' })
      await expect(notice).toContainText('open from a file')
      await expect(notice.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    })
})

/*
 * The Saved view's banner already gets the file:// case right: no Try again, and
 * an explanation instead. The chain card sitting under it went on saying the
 * schedule "has not loaded yet", which is a promise, and one nothing on the page
 * will keep.
 */
test.describe('a saved chain on a board opened from a file', () => {
  test('is explained rather than left looking like it is loading', async ({ page }) => {
    /* Seeded, because the editor cannot be driven from a file -- which is the
       neighboring half of the same problem. */
    await page.addInitScript(() => {
      window.localStorage.setItem('cmb.chains', JSON.stringify([{
        day_type: 'weekday',
        legs: [
          { route_id: '800', direction_id: 1, direction_tag: 'SB', stop_id: '6293',
            stop_name: 'Simond SB', scheduled_time: '07:52:09' },
          { route_id: '4', direction_id: 0, direction_tag: 'WB', stop_id: '938',
            stop_name: 'Pleasant Valley', scheduled_time: '08:16:00',
            alight_stop_id: '1369', alight_stop_name: '7th Street SB',
            walk_m: 78, walk_s: 91 },
        ],
      }]))
    })
    await page.goto(`${FILE_BOARD}?view=saved`)

    const card = page.locator('.chaincard').first()
    await expect(card).toBeVisible()
    await expect(card).not.toContainText('has not loaded yet')
    await expect(card).toContainText('open from a file')
  })
})
