/**
 * A refused save has to be visible, not only announced.
 *
 * The announcement goes to a `sr-only` live region. That is right for a screen
 * reader and useless on its own for everyone else: a sighted reader would be
 * looking at a saved list that silently does not contain the trip they just
 * saved, with nothing on screen having suggested anything went wrong.
 *
 * The unit suite proves add() reports the refusal (client-save-refused.test.mjs).
 * This proves the board does something a person can see with it.
 */
import { expect, test } from '@playwright/test'

test.describe('when localStorage refuses the write', () => {
  test('the saved view says nothing was saved, in words', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await expect(page.locator('#board')).toBeVisible()

    await page.evaluate(() => {
      window.CMB.app.state.storageFailed = true
      window.CMB.app.selectView('saved')
    })

    const notice = page.locator('.notice--error')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('Nothing was saved')
    await expect(notice).toContainText(/private browsing|storage turned off/i)
  })

  test('and says nothing of the kind when the write went through', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await expect(page.locator('#board')).toBeVisible()

    await page.evaluate(() => {
      window.CMB.app.state.storageFailed = false
      window.CMB.app.selectView('saved')
    })

    /* The control. Without it the assertion above would pass on a view that
     * failed to render at all. */
    await expect(page.locator('.band--saved')).toBeVisible()
    await expect(page.locator('.notice--error')).toHaveCount(0)
  })
})
