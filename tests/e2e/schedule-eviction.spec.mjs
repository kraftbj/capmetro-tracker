/**
 * The phone left on the counter overnight.
 *
 * The unit suite proves the two decisions — what "today" is, and whether a
 * document is older than it. This proves the thing those decisions were written
 * for: that a real board, fed real responses over HTTP, notices its schedule
 * belongs to a service day that has passed and goes and gets the current one,
 * rather than answering from yesterday for as long as the tab stays open.
 *
 * The bug was one line: `if (state.departures[routeId]) return;`. The first
 * document a tab fetched was the only one it ever had. Everything below is
 * arranged so that line, and not merely the labelling around it, is what decides
 * whether the tests pass — the labelling was written at the same time and would
 * otherwise cover for it.
 */
import { expect, test } from '@playwright/test'

/* What the client thinks, read off the seam app.js already exposed for tests. */
const depState = (page, routeId) =>
  page.evaluate(
    (id) => ({
      status: window.CMB.app.state.depStatus[id] ?? null,
      hasDocument: !!window.CMB.app.state.departures[id],
      serviceDate: (window.CMB.app.state.departures[id] || {}).service_date ?? null,
      today:
        (window.CMB.app.state.data &&
          window.CMB.app.state.data.service_day &&
          window.CMB.app.state.data.service_day.date) ||
        null,
    }),
    routeId,
  )

test.describe('a departures document from the current service day', () => {
  test('is accepted, and the board says so', async ({ page }) => {
    await page.goto('/fresh/index.html?route=4')
    await expect(page.locator('#board')).toBeVisible()
    await expect.poll(async () => (await depState(page, '4')).status).toBe('ok')

    const seen = await depState(page, '4')
    expect(seen.hasDocument).toBe(true)
    /* The control: this scenario really is serving a same-day schedule, so the
     * stale assertions below are a difference and not an artefact. */
    expect(seen.serviceDate).toBe(seen.today)
  })
})

test.describe('a departures document from an earlier service day', () => {
  test('is marked stale rather than trusted', async ({ page }) => {
    await page.goto('/yesterday/index.html?route=4')
    await expect(page.locator('#board')).toBeVisible()
    await expect.poll(async () => (await depState(page, '4')).status).toBe('stale')
  })

  test('is KEPT, because deleting it is how a failed refetch loses a service day', async ({ page }) => {
    await page.goto('/yesterday/index.html?route=4')
    await expect(page.locator('#board')).toBeVisible()
    await expect.poll(async () => (await depState(page, '4')).status).toBe('stale')

    const seen = await depState(page, '4')
    expect(seen.hasDocument, 'the expired schedule was thrown away').toBe(true)
    expect(Number(seen.serviceDate)).toBeLessThan(Number(seen.today))
  })
})

/*
 * The service-day roll, inside one tab.
 *
 * The schedule is served dated yesterday first and dated today afterwards, which
 * is what the box really does when the cron rolls over while a phone sits on the
 * counter. Clearing depStatus and re-entering through selectView('saved') is
 * exactly what the 60s timer does a few lines further down in app.js — done here
 * directly so the test does not have to sit through a minute of real time.
 *
 * This is the case that fails if `loadDepartures` goes back to returning early
 * whenever any document is cached: the board keeps yesterday's schedule forever,
 * and the second response never lands.
 */
test.describe('when the service day rolls over while the tab is open', () => {
  test('the board replaces yesterdays schedule with todays', async ({ page }) => {
    let served = 0
    let todayDate = null

    await page.route('**/api/departures/*.json', async (route) => {
      const response = await route.fetch()
      const doc = await response.json()
      served += 1
      /* First answer: the service day before the live payload's. Afterwards: the
       * live payload's own day, as the box would serve once the cron has rolled. */
      doc.service_date = served === 1 ? String(Number(doc.service_date) - 1) : doc.service_date
      todayDate = doc.service_date
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) })
    })

    /* One saved trip on route 4, so the saved view has a reason to ask for that
     * route's schedule. */
    await page.addInitScript(() => {
      window.localStorage.setItem(
        'cmb.watches',
        JSON.stringify([
          {
            route_id: '4',
            direction_id: 0,
            direction_tag: 'EB',
            stop_id: '5860',
            stop_name: 'a stop on route 4',
            scheduled_time: '07:52:09',
            day_type: 'weekday',
          },
        ]),
      )
    })

    await page.goto('/fresh/index.html?route=4')
    await expect(page.locator('#board')).toBeVisible()

    /* It arrived out of date, and the board said so rather than trusting it. */
    await expect.poll(async () => (await depState(page, '4')).status).toBe('stale')
    const stale = await depState(page, '4')
    expect(Number(stale.serviceDate)).toBeLessThan(Number(stale.today))
    expect(served).toBe(1)

    /* What the refresh timer does once a minute. */
    await page.evaluate(() => {
      delete window.CMB.app.state.depStatus['4']
      window.CMB.app.selectView('saved')
    })

    await expect
      .poll(async () => (await depState(page, '4')).serviceDate, {
        message: 'the board never asked again and is still answering from yesterday',
      })
      .toBe(stale.today)

    const fixed = await depState(page, '4')
    expect(fixed.status).toBe('ok')
    expect(served).toBe(2)
  })

  test('does not spin the board into a fetch-and-render loop', async ({ page }) => {
    const asked = []
    await page.route('**/api/departures/*.json', (route) => {
      asked.push(route.request().url())
      route.continue()
    })

    await page.goto('/yesterday/index.html?route=4')
    await expect(page.locator('#board')).toBeVisible()
    await expect.poll(async () => (await depState(page, '4')).status).toBe('stale')

    /*
     * An expired document is re-requested, but not on every repaint. 'stale' is a
     * stop in the same way 'error' is: without it, each paint would see an
     * out-of-date document, ask again, and paint again. The 60s timer clears it.
     */
    await page.waitForTimeout(1500)
    expect(asked.length, `asked for the schedule ${asked.length} times`).toBeLessThanOrEqual(2)
    expect(asked.length, 'never asked for the schedule at all').toBeGreaterThan(0)
  })
})

/*
 * The two things the first version of this fix left uncovered.
 *
 * Both are about WHEN the board re-asks, and both were previously "tested" by the
 * spec re-implementing the code under test — deleting depStatus by hand and
 * calling selectView, rather than running what the timer runs.
 */
test.describe('when the board re-asks for a schedule', () => {
  const departuresAsked = (page) => {
    const asked = []
    page.route('**/api/departures/*.json', (route) => {
      asked.push(route.request().url())
      route.continue()
    })
    return asked
  }

  test('one tick is enough when the service day rolls, not two', async ({ page }) => {
    let rolled = false

    /* The live payload rolls to the next service day on demand. */
    await page.route('**/api/route/*.json', async (route) => {
      const doc = await (await route.fetch()).json()
      if (rolled) {
        doc.service_day.date = String(Number(doc.service_day.date) + 1)
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) })
    })

    await page.goto('/fresh/index.html?route=4')
    await expect(page.locator('#board')).toBeVisible()
    await expect.poll(async () => (await depState(page, '4')).status).toBe('ok')

    /* The cron rolls over. The schedule the tab holds is now yesterday's. */
    rolled = true
    await page.evaluate(() => window.CMB.app.refreshTick())

    /*
     * ONE tick, not two.
     *
     * refreshTick calls load() and then, synchronously, sweeps the schedules —
     * so the sweep runs against the service date from BEFORE this tick's payload
     * arrived and finds nothing expired. load() therefore re-checks when its own
     * response lands. Without that re-check the roll is invisible until the NEXT
     * tick, and the board spends a further REFRESH_MS answering from a service
     * day that has ended.
     */
    await expect
      .poll(async () => (await depState(page, '4')).status, {
        message: 'the roll was not noticed within the tick that carried it',
        timeout: 5000,
      })
      .toBe('stale')
  })

  test('refreshTick is the function the timer runs, and re-requests an expired schedule', async ({ page }) => {
    await page.goto('/yesterday/index.html?route=4')
    await expect(page.locator('#board')).toBeVisible()
    await expect.poll(async () => (await depState(page, '4')).status).toBe('stale')

    /* Only now start counting, so this measures the tick and nothing before it. */
    const asked = departuresAsked(page)
    await page.evaluate(() => window.CMB.app.refreshTick())

    /*
     * The real exported function, not a hand-written substitute for it. The tick
     * clears a 'stale' status and asks again; a test that deleted the status
     * itself would pass even if the tick did nothing.
     */
    await expect
      .poll(() => asked.length, { message: 'refreshTick did not re-request the expired schedule' })
      .toBeGreaterThanOrEqual(1)
  })

  test('refreshTick also re-asks for a saved trip on a route that is not on screen', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('cmb.watches', JSON.stringify([{
        route_id: '800', direction_id: 1, direction_tag: 'SB', stop_id: '6293',
        stop_name: 'Simond SB', scheduled_time: '07:52:09', day_type: 'weekday',
      }]))
    })
    await page.goto('/yesterday/index.html?route=4')
    await expect(page.locator('#board')).toBeVisible()

    const asked = departuresAsked(page)
    await page.evaluate(() => window.CMB.app.refreshTick())

    /*
     * The board view never paints route 800, so nothing else would ask for its
     * schedule. The tick's comment claimed it covered every route while the code
     * only re-issued for the open one; this is that claim, asserted.
     */
    await expect
      .poll(() => asked.filter((u) => u.includes('800')).length, {
        message: 'a saved trip on another route was never re-asked for',
      })
      .toBeGreaterThanOrEqual(1)
  })
})
