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
