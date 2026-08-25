/**
 * What a link can put in a key.
 *
 * `?route=` and `?stop=` go straight into property lookups on objects parsed
 * from JSON, and a plain `{}` inherits from Object.prototype. So a crafted id is
 * not merely unknown — it can come back as a FUNCTION that is truthy, has a
 * `length`, and satisfies every `|| []` fallback written to catch a missing key.
 *
 * These are end-to-end on purpose. The unit tests cover the guards directly, but
 * every one of these bugs was a blank or lying SCREEN reached from a link
 * somebody could send, and the unit layer cannot see a screen. `?stop=` shipped
 * with unit coverage and no e2e; the two `?route=` cases had neither, and both
 * were found by review rather than by the suite.
 *
 * The two route cases run under `/missing/`, and that is load bearing rather
 * than incidental. The bundled fixture is only consulted when the route fetch
 * FAILS, which is what a junk id does against nginx (404) and what `/missing/`
 * does here (500). Under `/fresh/` the fixture server answers `api/route/` with
 * the golden payload whatever id is asked for, so the fetch succeeds, the
 * fallback never runs, and the test passes against the unfixed code — which is
 * exactly what the first draft of this file did, caught by re-running it with
 * the guard removed.
 */
import { expect, test } from '@playwright/test'

const board = (page) => page.locator('#board')

test.describe('a route id from a link that is a member of Object.prototype', () => {
  test('does not claim the reader’s copy of the app is out of date', async ({ page }) => {
    /*
     * `?route=__proto__` returned Object.prototype itself. deepCopy made `{}` of
     * it, `{}` has no numeric `schema`, and the schema branch renders "This app
     * needs updating … written for format undefined" and nothing else.
     *
     * A board that fails is bad. A board that fails while blaming something the
     * reader would then go and try to fix is worse, and this is the assertion
     * that matters: not that it works, but that it does not lie about why.
     */
    await page.goto('/missing/index.html?route=__proto__')
    await expect(board(page)).toBeVisible()
    await expect(board(page)).not.toContainText('needs updating')
    await expect(board(page)).not.toContainText('format undefined')
  })

  test('does not hang the board on a fixture that cannot be copied', async ({ page }) => {
    /*
     * `?route=constructor` returned the Object function. JSON.stringify of a
     * function is undefined, so deepCopy threw `"undefined" is not valid JSON`
     * — and it threw from inside a .catch, where nothing caught it again, so
     * render() was never reached from that path.
     *
     * Asserting on a page error as well as on the DOM: the symptom was a board
     * that stopped rather than a board that said something wrong, and an
     * assertion on text alone would pass against a page that had already died.
     */
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/missing/index.html?route=constructor')
    await expect(board(page)).toBeVisible()
    await expect(board(page)).not.toHaveText('')
    /*
     * The assertion that does the work. Without the guard the board still
     * reaches an error screen — an outer .catch swallows the throw — so
     * asserting merely that something rendered passes against the bug, which is
     * what the first draft of this test did. What actually leaks is the parser's
     * own words: "No data file for route constructor yet ("undefined" is not
     * valid JSON)". That string is the fixture being fed to JSON.parse, and it
     * has no business on a screen someone reads at a bus stop.
     */
    await expect(board(page)).not.toContainText('is not valid JSON')
    expect(errors).toEqual([])
  })

  test('the control: a real route id under the same failure still falls back', async ({ page }) => {
    /*
     * Without this the two tests above would hold on a board that rendered
     * nothing at all, which is the failure they exist to catch. Route 4 is the
     * one route with a bundled fixture, so under the same failing fetch it
     * reaches the fallback and shows the sample-data board — proving the path
     * under test is live and that only the crafted ids were being turned away.
     */
    await page.goto('/missing/index.html?route=4')
    await expect(board(page)).toBeVisible()
    await expect(board(page)).not.toHaveText('')
    await expect(board(page)).not.toContainText('needs updating')
  })
})

test.describe('a stop id from a link that is a member of Object.prototype', () => {
  /*
   * The bug this PR fixed, asserted where it actually appeared. `?stop=constructor`
   * made departures[stopId] return the Object function: truthy, so `|| []` never
   * fired, `length` 1, nothing at `[0]`, and `rows[0][1]` threw during render —
   * so the page went blank instead of showing an empty stop.
   *
   * Route 800 because it is the id the fixture server answers with a schedule
   * that has stops in it; the band needs a real schedule to be able to draw the
   * rows whose absence is the point.
   *
   * Worth knowing before trusting a green run here: rowsFor carries TWO guards,
   * `hasOwnProperty` and `isArray`, and either one alone is enough to keep these
   * five passing — no member of Object.prototype is an array. Removing just one
   * leaves the suite green. What these assert is the behaviour with neither,
   * which is the code as it actually shipped, and that is the form to restore if
   * you want to watch them fail.
   */
  for (const stop of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    test(`renders an empty stop rather than a blank page for ?stop=${stop}`, async ({ page }) => {
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`/fresh/index.html?route=800&stop=${stop}`)
      await expect(board(page)).toBeVisible()
      await expect(board(page)).not.toHaveText('')
      expect(errors).toEqual([])
    })
  }

  test('the control: a stop the schedule really serves still draws its rows', async ({ page }) => {
    await page.goto('/fresh/index.html?route=800&stop=6293')
    const band = page.locator('[aria-label="Next buses at a stop"]').first()
    await expect(band.locator('.nextdir').first()).toBeVisible()
  })
})
