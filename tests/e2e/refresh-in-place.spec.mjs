/**
 * The minute's refresh updates the page; it does not replace it.
 *
 * Every paint used to empty <main> and rebuild it, so once a minute focus fell
 * to <body>, an opened vehicle row or alerts list snapped shut, and every node
 * on the page was swapped whether anything in it had changed or not.
 *
 * refreshTick() is what the timer runs, so each test takes a real turn of it
 * rather than waiting sixty seconds for one.
 */
import { expect, test } from '@playwright/test'

const BOARD = '/fresh/index.html?stop=1368'

/* One turn of the timer, and long enough for its fetches to land and paint. */
async function tick(page) {
  await page.evaluate(() => window.CMB.app.refreshTick())
  await page.waitForTimeout(500)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

test.describe('a refresh leaves the reader where they were', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BOARD)
    await expect(page.locator('.band--nextbus .band__sub')).toBeVisible()
  })

  /*
   * Not a regression test: a full rebuild did not move the scroll either. It
   * guards the staging <main> a paint is now built in, which is in the document
   * and would move the page if it ever contributed to its height.
   */
  test('keeps the scroll position at the bottom of the page', async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const before = await page.evaluate(() => window.scrollY)
    expect(before, 'the page is too short to scroll, so this proves nothing').toBeGreaterThan(0)
    await tick(page)
    expect(await page.evaluate(() => window.scrollY)).toBe(before)
  })

  test('updates the Next buses band in place rather than swapping it out', async ({ page }) => {
    await page.evaluate(() => { window.__band = document.querySelector('.band--nextbus') })
    await tick(page)
    expect(await page.evaluate(() => window.__band === document.querySelector('.band--nextbus'))).toBe(true)
    /* Exactly one <main>: the staging copy a paint builds in is gone again. */
    await expect(page.locator('main')).toHaveCount(1)
  })

  test('keeps focus on the control that had it', async ({ page }) => {
    await page.locator('.band--nextbus .linkbtn').focus()
    await tick(page)
    await expect(page.locator('.band--nextbus .linkbtn')).toBeFocused()
  })

  test('keeps an opened vehicle row open, and its button still works', async ({ page }) => {
    const row = page.locator('.vrow').first()
    await row.locator('.vrow__main').click()
    await expect(row.locator('.vrow__main')).toHaveAttribute('aria-expanded', 'true')
    await tick(page)
    await expect(row.locator('.vrow__main')).toHaveAttribute('aria-expanded', 'true')
    await expect(row.locator('.vrow__detail')).toBeVisible()
    await row.locator('.vrow__main').click()
    await expect(row.locator('.vrow__detail')).toBeHidden()
  })

  test('keeps the service alerts open', async ({ page }) => {
    const toggle = page.locator('.alerts__toggle')
    await toggle.click()
    await expect(page.locator('.alerts__list')).toBeVisible()
    await tick(page)
    await expect(page.locator('.alerts__list')).toBeVisible()
    await page.locator('.alerts__toggle').click()
    await expect(page.locator('.alerts__list')).toBeHidden()
  })
})

test.describe('a row whose bus changed is rebuilt with its handler, not patched under the old one', () => {
  /*
   * The hazard in patching: a node kept in place keeps the listener it was built
   * with, and that listener's closure holds the data of the paint that made it.
   * Here the second payload renames every bus. A row button patched in place
   * would still open "its" row under the OLD vehicle id, and the next paint,
   * built for the new id, would shut it again. Replacing any element with a
   * listener, together with its parent, whenever it differs is what stops that.
   */
  test('opens under the bus it now shows, and stays open', async ({ page }) => {
    let renamed = false
    await page.route('**/fresh/api/route/4.json', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      if (renamed) {
        for (const v of body.vehicles) { v.vehicle_id += '9'; v.label += '9' }
      }
      await route.fulfill({ response: res, json: body })
    })
    await page.goto(BOARD)
    const first = page.locator('.vrow').first()
    await expect(first).toBeVisible()

    renamed = true
    await tick(page)
    await expect(first.locator('.vrow__main')).toContainText('9')

    await first.locator('.vrow__main').click()
    await tick(page)
    await expect(first.locator('.vrow__main')).toHaveAttribute('aria-expanded', 'true')
    await expect(first.locator('.vrow__detail')).toBeVisible()
  })
})

test.describe('S.patch', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BOARD)
    await expect(page.locator('#board')).toBeVisible()
  })

  test('changes text in place and keeps the element', async ({ page }) => {
    const r = await page.evaluate(() => {
      const S = window.CMB.states
      const live = document.createElement('div')
      live.innerHTML = '<p class="a">one</p><p class="b">two</p>'
      const keep = live.firstChild
      const next = document.createElement('div')
      next.innerHTML = '<p class="a">uno</p><p class="c">two</p><span>three</span>'
      S.patch(live, next)
      return { html: live.innerHTML, kept: live.firstChild === keep }
    })
    expect(r.html).toBe('<p class="a">uno</p><p class="c">two</p><span>three</span>')
    expect(r.kept).toBe(true)
  })

  test('replaces a unit whole, so its new handler arrives with it', async ({ page }) => {
    const r = await page.evaluate(() => {
      const S = window.CMB.states
      const said = []
      const button = (text, unit) => {
        const b = document.createElement('button')
        b.textContent = text
        b.addEventListener('click', () => said.push(text))
        if (unit) b[S.UNIT] = true
        return b
      }
      const run = (unit) => {
        const live = document.createElement('div')
        live.appendChild(button('old', unit))
        const next = document.createElement('div')
        next.appendChild(button('new', unit))
        S.patch(live, next)
        live.firstChild.click()
        return live.textContent
      }
      return { unit: [run(true), said.pop()], plain: [run(false), said.pop()] }
    })
    expect(r.unit).toEqual(['new', 'new'])
    /* The hazard itself, shown: patched in place, it reads "new" and acts "old". */
    expect(r.plain).toEqual(['new', 'old'])
  })

  test('replaces a form control rather than patching its attributes', async ({ page }) => {
    const kept = await page.evaluate(() => {
      const S = window.CMB.states
      const live = document.createElement('div')
      live.innerHTML = '<input value="a">'
      const input = live.firstChild
      const next = document.createElement('div')
      next.innerHTML = '<input value="b">'
      S.patch(live, next)
      return live.firstChild === input && live.firstChild.value
    })
    expect(kept).toBe(false)
  })
})
