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

test.describe('focus, when the control holding it is rebuilt', () => {
  test('goes back to the same bus, found by its key, after it moves up the list', async ({ page }) => {
    /*
     * Rows run in route order, furthest along first. The later payload puts the
     * focused bus at the front, so the same PLACE now holds a different bus and
     * only the key can find the right one.
     */
    let lead = null
    await page.route('**/fresh/api/route/4.json', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      if (lead) for (const v of body.vehicles) if (v.vehicle_id === lead) v.progress = { ...v.progress, current_stop_sequence: 999 }
      await route.fulfill({ response: res, json: body })
    })
    await page.goto(BOARD)
    const second = page.locator('.vrow__main').nth(1)
    await expect(second).toBeVisible()
    const key = await second.getAttribute('data-key')
    await second.focus()

    lead = key.replace(/^vrow:/, '')
    await tick(page)
    const r = await page.evaluate(() => ({
      key: document.activeElement.getAttribute('data-key'),
      at: [...document.querySelectorAll('.vrow__main')].indexOf(document.activeElement),
    }))
    expect(r.key).toBe(key)
    expect(r.at, 'the bus did not move, so this cannot tell a key from a place').not.toBe(1)
  })

  test('comes back to a ladder segment after expanding it', async ({ page }) => {
    await page.goto(BOARD)
    const seg = page.locator('.segbtn').first()
    await expect(seg).toBeVisible()
    const key = await seg.getAttribute('data-key')
    await seg.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator(`.segbtn[data-key="${key}"]`)).toHaveAttribute('aria-expanded', 'true')
    expect(await page.evaluate(() => document.activeElement.getAttribute('data-key'))).toBe(key)
  })
})

/*
 * A route payload the test can rewrite between ticks. `edit` gets the parsed
 * body and changes it in place; set it back to null for the untouched fixture.
 */
async function steerRoute(page) {
  const ctl = { edit: null }
  await page.route('**/fresh/api/route/4.json', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    if (ctl.edit) ctl.edit(body)
    await route.fulfill({ response: res, json: body })
  })
  return ctl
}

test.describe('a banner coming and going above the board', () => {
  /*
   * Matching by position alone, a banner at the top of <main> shifted every band
   * below it one place and the whole board was replaced, focus and all. The
   * bands are keyed now, so the banner is inserted and dropped around them.
   */
  test('leaves the bands and the focus where they were', async ({ page }) => {
    const ctl = await steerRoute(page)
    await page.goto(BOARD)
    await expect(page.locator('.band--nextbus .band__sub')).toBeVisible()
    await expect(page.locator('#board > .banner')).toHaveCount(0)
    await page.locator('.band--nextbus .linkbtn').focus()
    await page.evaluate(() => { window.__band = document.querySelector('.band--nextbus') })

    ctl.edit = (b) => { b.staleness = { ...b.staleness, level: 'aging', oldest_feed_age_s: 150 } }
    await tick(page)
    await expect(page.locator('#board > .banner')).toHaveCount(1)
    expect(await page.evaluate(() => window.__band === document.querySelector('.band--nextbus'))).toBe(true)
    await expect(page.locator('.band--nextbus .linkbtn')).toBeFocused()

    ctl.edit = null
    await tick(page)
    await expect(page.locator('#board > .banner')).toHaveCount(0)
    expect(await page.evaluate(() => window.__band === document.querySelector('.band--nextbus'))).toBe(true)
    await expect(page.locator('.band--nextbus .linkbtn')).toBeFocused()
  })
})

test.describe('what the board remembers across a refresh, and for how long', () => {
  test('keeps the alerts list open for its own route only', async ({ page }) => {
    const ctl = await steerRoute(page)
    await page.goto(BOARD)
    await page.locator('.alerts__toggle').click()
    await expect(page.locator('.alerts__list')).toBeVisible()

    /* The same alerts, reported for another route. */
    ctl.edit = (b) => { b.route = { ...b.route, id: '7' } }
    await tick(page)
    await expect(page.locator('.alerts__list')).toBeHidden()

    ctl.edit = null
    await tick(page)
    await expect(page.locator('.alerts__list')).toBeVisible()
  })

  test('keeps a row open through a dropped position, and forgets it after five minutes gone', async ({ page }) => {
    const ctl = await steerRoute(page)
    await page.goto(BOARD)
    const first = page.locator('.vrow__main').first()
    const key = await first.getAttribute('data-key')
    const id = key.replace(/^vrow:/, '')
    await first.click()
    const row = page.locator(`.vrow__main[data-key="${key}"]`)
    await expect(row).toHaveAttribute('aria-expanded', 'true')

    const gone = (after) => (b) => {
      b.generated_at += after
      b.vehicles = b.vehicles.filter((v) => v.vehicle_id !== id)
    }
    const back = (after) => (b) => { b.generated_at += after }

    /* One minute missing, then back: still open. */
    ctl.edit = gone(60)
    await tick(page)
    await expect(row).toHaveCount(0)
    ctl.edit = back(120)
    await tick(page)
    await expect(row).toHaveAttribute('aria-expanded', 'true')

    /* Gone for more than five minutes, then back: closed. */
    ctl.edit = gone(180)
    await tick(page)
    ctl.edit = gone(600)
    await tick(page)
    ctl.edit = back(660)
    await tick(page)
    await expect(row).toHaveAttribute('aria-expanded', 'false')
  })
})

test.describe('an editor', () => {
  /*
   * An editor's handlers close over a state snapshot its buttons do not show,
   * so a button kept because it looks the same could save the wrong trip. Its
   * paints rebuild, and only the board's are patched.
   */
  test('is rebuilt on each paint rather than patched', async ({ page }) => {
    await page.goto(BOARD)
    await expect(page.locator('#board')).toBeVisible()
    await page.evaluate(() => window.CMB.app.selectView('saved-edit'))
    await page.waitForTimeout(200)
    await page.evaluate(() => { window.__first = document.querySelector('#board').firstElementChild })
    expect(await page.evaluate(() => !!window.__first)).toBe(true)
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    /* Waits for the paint itself rather than a fixed time: a patched paint
       would keep the node and this would time out. */
    await page.waitForFunction(() => window.__first !== document.querySelector('#board').firstElementChild)
  })
})

test.describe('a paint that throws', () => {
  test('leaves no staging copy behind, and the next paint still lands', async ({ page }) => {
    await page.goto(BOARD)
    await expect(page.locator('.band--nextbus .band__sub')).toBeVisible()
    await page.evaluate(() => {
      const real = window.CMB.stopboard.render
      window.CMB.stopboard.render = function () {
        window.CMB.stopboard.render = real
        throw new Error('boom')
      }
    })
    await tick(page)
    await expect(page.locator('main')).toHaveCount(1)
    await tick(page)
    await expect(page.locator('main')).toHaveCount(1)
    await expect(page.locator('.band--nextbus .band__sub')).toBeVisible()
  })
})

test.describe('a state preview', () => {
  /*
   * The preview note is one node kept for the whole tab. Appending it to the
   * staging copy took it OUT of the live page mid-build, which shifted every
   * band after it one place and made the patch replace all of them.
   */
  test('keeps its note once and keeps the bands in place on a repaint', async ({ page }) => {
    await page.goto('/fresh/index.html?stop=1368&state=all-states')
    await expect(page.locator('.scenario')).toHaveCount(1)
    await page.evaluate(() => { window.__rows = document.querySelector('.band--rows') })
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await page.waitForTimeout(400)
    await expect(page.locator('.scenario')).toHaveCount(1)
    expect(await page.evaluate(() => window.__rows === document.querySelector('.band--rows'))).toBe(true)
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

  test('drops live children the new paint no longer has', async ({ page }) => {
    const html = await page.evaluate(() => {
      const live = document.createElement('div')
      live.innerHTML = '<p>a</p><p>b</p><p>c</p>'
      const next = document.createElement('div')
      next.innerHTML = '<p>a</p>'
      return window.CMB.states.patch(live, next).innerHTML
    })
    expect(html).toBe('<p>a</p>')
  })

  test('moves an SVG mark in place rather than redrawing it', async ({ page }) => {
    const r = await page.evaluate(() => {
      const NS = 'http://www.w3.org/2000/svg'
      const svg = (cx) => {
        const wrap = document.createElement('div')
        const s = document.createElementNS(NS, 'svg')
        const c = document.createElementNS(NS, 'circle')
        c.setAttribute('cx', cx)
        s.appendChild(c)
        wrap.appendChild(s)
        return wrap
      }
      const live = svg('10')
      const dot = live.querySelector('circle')
      window.CMB.states.patch(live, svg('40'))
      return { kept: live.querySelector('circle') === dot, cx: dot.getAttribute('cx') }
    })
    expect(r).toEqual({ kept: true, cx: '40' })
  })

  test('replaces a live region rather than changing its words in place', async ({ page }) => {
    /* Changing the text of a region already on the page is what a screen reader
       announces, so patching it would read it out once a minute. */
    const kept = await page.evaluate(() => {
      const live = document.createElement('div')
      live.innerHTML = '<p role="status">3 minutes old</p>'
      const region = live.firstChild
      const next = document.createElement('div')
      next.innerHTML = '<p role="status">4 minutes old</p>'
      window.CMB.states.patch(live, next)
      return live.firstChild === region
    })
    expect(kept).toBe(false)
  })

  test('does not call two fields the same when only their values differ', async ({ page }) => {
    /* plan.js sets its share link as a property, which isEqualNode cannot see. */
    const value = await page.evaluate(() => {
      const box = (v) => {
        const d = document.createElement('div')
        const s = document.createElement('section')
        const i = document.createElement('input')
        i.value = v
        s.appendChild(i)
        d.appendChild(s)
        return d
      }
      const live = box('#plan=old')
      window.CMB.states.patch(live, box('#plan=new'))
      return live.querySelector('input').value
    })
    expect(value).toBe('#plan=new')
  })

  test('does not keep a handlerless button in place of one that has a handler', async ({ page }) => {
    const said = await page.evaluate(() => {
      const S = window.CMB.states
      const said = []
      const live = document.createElement('div')
      live.innerHTML = '<section><button>go</button></section>'
      const next = document.createElement('div')
      next.innerHTML = '<section><button>go</button></section>'
      const b = next.querySelector('button')
      b.addEventListener('click', () => said.push('go'))
      b[S.UNIT] = true
      S.patch(live, next)
      live.querySelector('button').click()
      return said
    })
    expect(said).toEqual(['go'])
  })

  test('inserts and drops unkeyed nodes around keyed ones without moving them', async ({ page }) => {
    const r = await page.evaluate(() => {
      const S = window.CMB.states
      const build = (spec) => {
        const d = document.createElement('div')
        for (const [tag, key, text] of spec) {
          const n = document.createElement(tag)
          if (key) n.setAttribute('data-key', key)
          n.textContent = text
          d.appendChild(n)
        }
        return d
      }
      const live = build([['section', 'a', 'A'], ['section', 'b', 'B'], ['footer', 'f', 'F']])
      const [a, b, f] = live.children
      const out = []
      /* Two banners in, above and between. */
      S.patch(live, build([['div', null, 'x'], ['section', 'a', 'A'], ['div', null, 'y'], ['section', 'b', 'B2'], ['footer', 'f', 'F']]))
      out.push([live.textContent, live.children[1] === a, live.children[3] === b, live.children[4] === f])
      /* Both out again, and a keyed block dropped. */
      S.patch(live, build([['section', 'a', 'A'], ['footer', 'f', 'F']]))
      out.push([live.textContent, live.children[0] === a, live.children[1] === f])
      return out
    })
    expect(r[0]).toEqual(['xAyB2F', true, true, true])
    expect(r[1]).toEqual(['AF', true, true])
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
