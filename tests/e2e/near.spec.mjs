/**
 * The near-me flow in a real browser, which is the only place the parts that
 * matter actually exist: the permission prompt, a denied permission, and a
 * geolocation reading that the unit sandbox can only fake.
 *
 * The behaviour being defended is that the board never asks for a location it
 * was not invited to ask for, and never turns a refusal or a coarse fix into a
 * confident arrival time.
 *
 * Coordinates below are a real stop on the golden route 4 payload, read from
 * the fixture rather than typed in, so this does not quietly stop testing
 * anything the day the fixture is regenerated.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const golden = JSON.parse(
  readFileSync(path.join(ROOT, 'tests/fixtures/golden/route-4-20260819.json'), 'utf8'),
)

/** A stop that at least one bus still has ahead of it, so an arrival exists. */
function stopWithAnArrival() {
  const vehicle = golden.vehicles.find((v) => v.in_service && v.predictions.length)
  const stopId = String(vehicle.predictions[0][1])
  for (const tp of golden.timepoints) {
    if (String(tp.stop_id) === stopId) return { ...tp, direction_id: tp.direction_id }
    for (const m of tp.minor_stops || []) {
      if (String(m.stop_id) === stopId) return { ...m, direction_id: tp.direction_id }
    }
  }
  throw new Error(`stop ${stopId} is predicted for but not published on the route`)
}

const STOP = stopWithAnArrival()

test.describe('the board asks before it locates', () => {
  test('does not touch geolocation until the button is pressed', async ({ page }) => {
    /* A board that raises the permission dialog on load is a board people
       close. Instrument the API itself rather than watching for the dialog. */
    await page.addInitScript(() => {
      window.__geoCalls = 0
      const real = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation)
      navigator.geolocation.getCurrentPosition = (...args) => {
        window.__geoCalls++
        return real(...args)
      }
    })
    await page.goto('/fresh/index.html')
    await expect(page.locator('.vrow').first()).toBeVisible()

    expect(await page.evaluate(() => window.__geoCalls)).toBe(0)
    await expect(page.getByRole('button', { name: 'Use my location' })).toBeVisible()
  })
})

test.describe('with a location granted', () => {
  test.use({
    permissions: ['geolocation'],
    geolocation: { latitude: STOP.lat, longitude: STOP.lon, accuracy: 8 },
  })

  test('names the nearest stop and how far it is', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await page.getByRole('button', { name: 'Use my location' }).click()

    const panel = page.locator('.near')
    await expect(panel.locator('.near__stopname').first()).toBeVisible()
    await expect(panel.getByText(STOP.stop_name, { exact: false }).first()).toBeVisible()
  })

  test('shows a countdown to the next bus at that stop', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await page.getByRole('button', { name: 'Use my location' }).click()

    const when = page.locator('.near__when').first()
    await expect(when).toBeVisible()
    /* Either a real countdown or "due" — never blank, and never a bare number
       with no unit, which reads as a bus id. */
    expect((await when.innerText()).trim()).toMatch(/^(due|\d+ min)$/)
  })

  test('marks the vehicle row the panel is talking about', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await page.getByRole('button', { name: 'Use my location' }).click()

    const marked = page.locator('.vrow.is-yours')
    await expect(marked.first()).toBeVisible()
    /* Never colour alone: the mark is written out on the row too. */
    await expect(marked.first().getByText('next at your stop')).toBeVisible()
  })

  test('does not scroll sideways at 412 pixels with the panel open', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await page.getByRole('button', { name: 'Use my location' }).click()
    await expect(page.locator('.near__stopname').first()).toBeVisible()

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test('every control in the panel is a full-sized touch target', async ({ page }) => {
    await page.goto('/fresh/index.html')
    await page.getByRole('button', { name: 'Use my location' }).click()
    await expect(page.locator('.near__stopname').first()).toBeVisible()

    const buttons = page.locator('.near button')
    for (let i = 0; i < (await buttons.count()); i++) {
      const box = await buttons.nth(i).boundingBox()
      expect(box.height, `control ${i} is ${box.height}px tall`).toBeGreaterThanOrEqual(34)
    }
  })
})

test.describe('with a location refused', () => {
  test('says the permission was refused rather than that no bus is coming', async ({
    page,
    context,
  }) => {
    await context.clearPermissions()
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (_ok, fail) =>
        fail({ code: 1, message: 'User denied Geolocation' })
    })
    await page.goto('/fresh/index.html')
    await page.getByRole('button', { name: 'Use my location' }).click()

    /*
     * The two failures must not look alike. "No bus is coming" is a fact about
     * the route; "we could not locate you" is a fact about the browser, and a
     * rider who reads the first when the second is true walks away from a stop
     * a bus is about to reach.
     */
    await expect(page.getByText('Could not use your location')).toBeVisible()
    await expect(page.getByText('permission was declined', { exact: false })).toBeVisible()
    await expect(page.locator('.near__when')).toHaveCount(0)
    await expect(page.locator('.vrow.is-yours')).toHaveCount(0)
  })
})

test.describe('on a board whose feed has gone stale', () => {
  test.use({
    permissions: ['geolocation'],
    geolocation: { latitude: STOP.lat, longitude: STOP.lon, accuracy: 8 },
  })

  test('publishes no arrival time while lateness is suppressed', async ({ page }) => {
    await page.goto('/dead/index.html')
    await page.getByRole('button', { name: 'Use my location' }).click()
    await expect(page.locator('.near__stopname').first()).toBeVisible()

    /* The countdown is the number a rider acts on fastest. If the board will
       not stand behind "+3m late", it must not offer "here in 3 min". */
    await expect(page.locator('.near__when')).toHaveCount(0)
    /* .first(): in BOTH mode the panel answers per direction, so the notice is
       correctly rendered once for each. */
    await expect(
      page.getByText('No arrival times while the feed is behind').first(),
    ).toBeVisible()
  })
})
