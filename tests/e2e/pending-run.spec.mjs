/**
 * The pending run, in a real browser at real width.
 *
 * Route 837's 17:03 northbound left the stop board at 17:04:30 and came back at
 * 17:13:56, while bus 8007 finished the southbound trip it was 820s late on. For
 * those nine minutes a rider at 5th/Guadalupe was shown the 17:33 as their next
 * bus. The unit suite proves the arithmetic against the same capture; this proves
 * the two sentences it produces actually render, keep their badge, and fit on a
 * phone.
 *
 * It needs its own scenario because route 4 cannot reach this state: the golden
 * fixture has no block continuation whose successor is late enough, and CLAUDE.md
 * is explicit that a route-4-only pass reports clean on bugs the other routes
 * carry. The `predictor` prefix serves the real 2026-09-17 capture, and because
 * the board's clock follows the feed rather than the device (app.js nowEpoch
 * returns generated_at), loading it puts the client at 17:07:48 — mid-bug —
 * without faking a clock.
 */
import { expect, test } from '@playwright/test'

/* 5th/Guadalupe, where the northbound trip starts and where the row vanished. */
const ORIGIN = '2112'
const AT_ORIGIN = `/predictor/index.html?route=837&stop=${ORIGIN}`

/*
 * The northbound column, which is where the 17:03 departs from.
 *
 * Scoped because the panel now shows ninety minutes rather than two buses, and
 * at this stop that reaches a SOUTHBOUND predictor row too — the 18:30 arrival
 * that bus 8006 becomes — which renders first because direction 0 does. An
 * unscoped `.first()` then found that row and asserted 8007's facts against it.
 */
const northbound = (page) =>
  page.locator('.nextdir').filter({ has: page.locator('.dirtag', { hasText: /^NB$/ }) })
const predictorRow = (page) =>
  northbound(page).locator('.nextbus', { hasText: 'becomes this run' }).first()

test.describe('a run whose bus is still finishing the trip before', () => {
  test('is on the board, timed, and names the bus that will run it', async ({ page }) => {
    await page.goto(AT_ORIGIN)

    const rows = page.locator('.nextbus')
    await expect(rows.first()).toBeVisible()

    /*
     * The row itself, found by the sentence only a predictor row produces. The
     * bug was its absence, so this locator resolving at all is the assertion.
     */
    const predictor = predictorRow(page)
    await expect(predictor).toBeVisible()
    await expect(predictor).toContainText('bus 8007')
    await expect(predictor).toContainText('running very late')
  })

  test('leads with the predicted time and keeps the booked one beside it', async ({ page }) => {
    await page.goto(AT_ORIGIN)
    const predictor = predictorRow(page)

    /* 17:03 + 820s. The headline is when the bus will really leave... */
    await expect(predictor.locator('.nextbus__clock')).toHaveText('5:16p')
    /* ...and the booked time stays, because it is what identifies the run to
       somebody who came out for the 5:03. */
    await expect(predictor.locator('.nextbus__sched')).toContainText('5:03p')
    await expect(predictor).toContainText('in 9 minutes')
  })

  test('keeps its badge, and the badge agrees with the clock', async ({ page }) => {
    await page.goto(AT_ORIGIN)
    const predictor = predictorRow(page)

    /* 820s late, and 5:16p minus 5:03p is the same 820s — the identity that
       earns this row its badge. */
    const badge = predictor.locator('.badge')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('+14m')
    /* Shape and number, never colour alone (task D1). */
    await expect(badge.locator('.badge__glyph')).not.toBeEmpty()
  })

  test('speaks the same facts it prints', async ({ page }) => {
    await page.goto(AT_ORIGIN)
    const predictor = predictorRow(page)

    /*
     * textContent, not innerText. `.sr-only` is clipped to a 1px box with
     * `clip-path: inset(50%)` and `overflow: hidden`, and innerText is computed
     * from layout, so it comes back empty depending on when the read lands. This
     * test flaked exactly once that way before the assertion was changed.
     */
    const spoken = await predictor.locator('.sr-only').allTextContents()
    const said = spoken.join(' ')
    expect(said).toContain('Bus 8007')
    expect(said).toContain('becomes this run')
    expect(said).toContain('scheduled 5:03 PM')
  })

  test('does not scroll sideways at 412 pixels', async ({ page }) => {
    await page.goto(AT_ORIGIN)
    await expect(predictorRow(page)).toBeVisible()

    /*
     * The two new sentences are the longest strings either panel produces, which
     * is the whole reason this file exists rather than a node assertion.
     */
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test('every tap target on the panel is still at least 44px', async ({ page }) => {
    await page.goto(AT_ORIGIN)
    await expect(page.locator('.nextbus').first()).toBeVisible()

    const small = await page.evaluate(() => {
      const out = []
      for (const b of document.querySelectorAll('#stopboard button, #stopboard a')) {
        const r = b.getBoundingClientRect()
        if (r.width > 0 && r.height > 0 && r.height < 44) {
          out.push(`${b.className || b.tagName}:${Math.round(r.height)}`)
        }
      }
      return out
    })
    expect(small).toEqual([])
  })
})

test.describe('the cancellations above it do not crowd out the buses', () => {
  test('shows the recent cancellation and still reaches two real departures', async ({ page }) => {
    await page.goto(AT_ORIGIN)
    await expect(page.locator('.nextbus').first()).toBeVisible()

    /*
     * Route 837 had six cancellations that afternoon. A canceled row rides along
     * without consuming one of the two answers being asked for, so the panel must
     * still get to two buses a rider can actually catch.
     */
    const canceled = page.locator('.nextbus--canceled')
    const catchable = page.locator('.nextbus:not(.nextbus--canceled):not(.nextbus--overdue)')
    expect(await canceled.count()).toBeGreaterThan(0)
    expect(await catchable.count()).toBeGreaterThanOrEqual(2)

    /* The word, not a colour and not a strike-through alone. */
    await expect(canceled.first()).toContainText('CANCELED')
  })

  test('does not show a cancellation that went half an hour ago', async ({ page }) => {
    await page.goto(AT_ORIGIN)
    await expect(page.locator('.nextbus').first()).toBeVisible()

    /*
     * The 16:53 was canceled and, at 17:07, fourteen minutes gone. It used to
     * ride the 30-minute overdue window — a window meant for a no-show CapMetro
     * has NOT announced — and stacked above the buses actually coming.
     */
    await expect(page.locator('.nextbus', { hasText: '4:53p' })).toHaveCount(0)
  })
})
