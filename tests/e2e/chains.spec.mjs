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
import { expect, test } from '@playwright/test'

/* The fixture's own service day; the client's clock follows the feed, not the
 * device, so nothing here depends on when the suite is run. */
const SAVED = '/fresh/index.html?view=saved'

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
    await expect(rows.first()).toContainText('min wait')
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

    /* The verdict is the point of the card, and it must be words, not a color. */
    const verdict = card.locator('.chaincard__verdictlabel').first()
    await expect(verdict).toBeVisible()
    await expect(verdict).toHaveText(/Connection|Chain/)

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
    await page.goto('/dead/index.html?view=saved')
    const banners = page.locator('.savedbanner')
    await expect(banners.first()).toBeVisible()

    /* Route 800 is leg 1 and is not the board's route — the case that had none. */
    await expect(page.locator('.savedbanner', { hasText: 'Route 800' })).toHaveCount(1)
    await expect(page.locator('.savedbanner', { hasText: 'Route 800' }))
      .toContainText(/Data|Feed is down/)
  })

  test('and the card shows no lateness it cannot stand behind', async ({ page }) => {
    await saveTheChain(page)
    await page.goto('/dead/index.html?view=saved')
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
