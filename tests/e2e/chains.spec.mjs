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

    /* The verdict is the point of the card, and it must be words, not a colour. */
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

  test('the whole chain is spoken for a screen reader, not only coloured', async ({ page }) => {
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
