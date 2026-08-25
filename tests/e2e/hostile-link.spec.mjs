/**
 * A link anyone can send must not be able to disable the board.
 *
 * Every query parameter this client reads is an attacker-controlled string that
 * gets used as an object key, and a bare `{}` answers to every member of
 * Object.prototype. The `?stop=` case blanked the page loudly. `?state=` is the
 * dangerous one precisely because it is quiet: `?state=valueOf` passed the
 * `if (q.state && STATE_SCENARIOS[q.state])` guard, made `state.scenario`
 * truthy, and app.js gates the 60s refresh on `!state.scenario` — so the board
 * rendered correctly and then never updated again.
 *
 * That is the worst failure this product has. A board that is visibly broken
 * sends someone to look up the timetable. A board that looks current and is
 * frozen sends a child to a stop.
 *
 * These tests assert on the page, not on internal state, and each has a control
 * so it cannot pass because the page failed to render at all.
 *
 * Worth knowing before trusting a green run: the fix is in TWO places, and
 * either alone keeps these passing — the hasOwnProperty check at the lookup in
 * app.js, and STATE_SCENARIOS being null-prototype in states.js. Reverting one
 * leaves the suite green. What these assert is the behaviour with neither, which
 * is the code as it actually shipped; restore both to watch them fail.
 */
import { expect, test } from '@playwright/test'

/* Names that exist on Object.prototype and are not scenarios, stops or routes. */
const PROTOTYPE_KEYS = ['valueOf', 'constructor', 'toString', 'hasOwnProperty']

test.describe('?state= naming a prototype member', () => {
  for (const key of PROTOTYPE_KEYS) {
    test(`?state=${key} leaves the board live and refreshing`, async ({ page }) => {
      await page.goto(`/fresh/index.html?route=4&state=${key}`)
      await expect(page.locator('#board')).toBeVisible()

      /* It renders the real route, not the schema refusal. */
      await expect(page.locator('.routechip__id')).toHaveText('4')
      await expect(page.locator('#board')).not.toContainText('too old')

      /*
       * And the refresh is installed. This is the half that made the quiet
       * variant worse than the loud one: with `state.scenario` truthy, app.js
       * never called setInterval and the tab was frozen for good.
       */
      /*
       * Booleans computed IN the page, not the values themselves.
       *
       * `state.scenario` is a FUNCTION in the failing case (Object.prototype
       * .valueOf), and a function does not survive serialisation across the
       * evaluate boundary — it arrives as undefined, so `toBeFalsy()` passed
       * against the very build this test exists to reject. The `?state=valueOf`
       * case, the quiet one, was the only one that slipped through.
       */
      const live = await page.evaluate(() => ({
        hasScenario: !!window.CMB.app.state.scenario,
        status: window.CMB.app.state.status,
      }))
      expect(live.hasScenario, `?state=${key} was accepted as a scenario`).toBe(false)
      expect(live.status).toBe('ok')
    })
  }

  test('the control: a real scenario name still works', async ({ page }) => {
    await page.goto('/fresh/index.html?route=4&state=empty')
    await expect(page.locator('#board')).toBeVisible()
    /*
     * Without this the assertions above would pass on a build where ?state= had
     * simply been removed, which would break the state-preview harness the
     * design review depends on.
     */
    const scenario = await page.evaluate(() => !!window.CMB.app.state.scenario)
    expect(scenario, 'a genuine scenario name stopped being recognised').toBe(true)
  })
})

test.describe('?stop= and ?route= naming a prototype member', () => {
  for (const key of PROTOTYPE_KEYS) {
    test(`?stop=${key} renders an empty stop rather than a blank page`, async ({ page }) => {
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))

      await page.goto(`/fresh/index.html?route=4&stop=${key}`)
      await expect(page.locator('#board')).toBeVisible()
      await expect(page.locator('.routechip__id')).toHaveText('4')
      expect(errors, `?stop=${key} threw during render`).toEqual([])
    })
  }

  test('?route= naming a prototype member still asks the server for that route', async ({ page }) => {
    const asked = []
    await page.route('**/api/departures/*.json', (route) => {
      asked.push(route.request().url())
      route.continue()
    })

    await page.goto('/fresh/index.html?route=constructor')
    await expect(page.locator('#board')).toBeVisible()

    /*
     * With a bare `{}` for the cache map, `state.departures['constructor']`
     * reads back the Object function — truthy — so the guard concluded the
     * document was already cached and the board never asked for anything.
     */
    await expect
      .poll(() => asked.length, { message: 'the board never requested a schedule at all' })
      .toBeGreaterThan(0)
  })
})
