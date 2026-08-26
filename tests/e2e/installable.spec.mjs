/**
 * The board as an app on a phone, driven in a real browser.
 *
 * tests/node/client-installable.test.mjs reads the manifest and the tags, and
 * tests/node/client-sw.test.mjs drives the worker against a fake global scope.
 * Neither can see the three things that only exist once a server and a browser
 * are both involved:
 *
 *   1. Whether the manifest and the icons are actually SERVED, at the right
 *      content type, from the directory the board is served from. Every href in
 *      index.html is relative so that the board works under the scenario
 *      prefixes this server uses and under file://; an absolute one passes every
 *      unit test and 404s here.
 *   2. Whether the worker's scope follows the prefix. `register('sw.js')`
 *      resolves against the <base> the bootstrap set; `register('/sw.js')` does
 *      not, and would claim every other scenario on this origin.
 *   3. Whether the board actually opens with the network off -- and whether the
 *      LIVE FEED still fails when it does, which is the rule the whole worker is
 *      written around.
 */
import { expect, test } from '@playwright/test'

/** Resolved once the worker has installed, activated and taken the page over. */
async function controlled(page) {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 })
}

test.describe('what a phone is offered', () => {
  test('serves the manifest at the right type, under the prefix the board is at', async ({ page, request }) => {
    await page.goto('/fresh/route/4/eb')

    /* The <base> bootstrap has already run, so this is the resolved URL the
       browser will fetch -- the assertion is that it kept the prefix. */
    const href = await page.evaluate(() => document.querySelector('link[rel="manifest"]').href)
    expect(new URL(href).pathname).toBe('/fresh/manifest.webmanifest')

    const res = await request.get(href)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('application/manifest+json')

    const manifest = JSON.parse(await res.text())
    expect(manifest.name).toBe('Dillo Bus Board')
    /* start_url is relative, so it resolves to the prefix rather than the origin
       root. An installed board opening at / would be a 404 under this server and
       somebody else's site on a shared host. */
    expect(new URL(manifest.start_url, href).pathname).toBe('/fresh/')
  })

  test('serves every icon the manifest and the page name', async ({ page, request }) => {
    await page.goto('/fresh/index.html')
    const hrefs = await page.evaluate(() => {
      const manifest = document.querySelector('link[rel="manifest"]').href
      const tags = [...document.querySelectorAll('link[rel="apple-touch-icon"], link[rel="icon"]')]
      return { manifest, tags: tags.map((l) => l.href) }
    })

    const manifest = JSON.parse(await (await request.get(hrefs.manifest)).text())
    const icons = manifest.icons.map((i) => new URL(i.src, hrefs.manifest).href)

    for (const url of [...icons, ...hrefs.tags]) {
      const res = await request.get(url)
      expect(res.status(), `${url} did not serve`).toBe(200)
      expect(res.headers()['content-type'], `${url} has the wrong type`).toMatch(/^image\//)
    }
  })

  test('does not scroll sideways once the safe-area padding is on the body', async ({ page }) => {
    /* The insets resolve to 0 in a browser tab, so the 412px design must not
       have moved. Same check the other suites make, on the selector that grew a
       new declaration. */
    await page.goto('/fresh/route/4/eb')
    await expect(page.locator('.vrow').first()).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

test.describe('the service worker', () => {
  test('registers at the directory the board is served from, not at the origin root', async ({ page }) => {
    await page.goto('/fresh/route/4/eb')
    await controlled(page)
    const scope = await page.evaluate(() =>
      navigator.serviceWorker.getRegistration().then((r) => r.scope))
    expect(new URL(scope).pathname).toBe('/fresh/')
  })

  test('opens the board with the network off, at a path nothing cached', async ({ page, context }) => {
    await page.goto('/fresh/route/4/eb')
    await controlled(page)

    await context.setOffline(true)
    try {
      /* Never requested while online, and not a file on any server: the vhosts
         answer it with index.html and the worker has to do the same. */
      await page.goto('/fresh/trip/7/2641')
      expect(await page.evaluate(() => typeof window.CMB)).toBe('object')
      await expect(page.locator('.viewtabs')).toBeVisible()
    } finally {
      await context.setOffline(false)
    }
  })

  test('leaves the live feed failing when offline, rather than answering from a cache', async ({ page, context }) => {
    /*
     * The one rule this worker is written around. api/*.json is regenerated
     * every 60 seconds; a cached answer here is the board showing where the
     * buses were the last time the phone had signal, with nothing on screen
     * saying so. Failing is what makes app.js fall back to the bundled fixture
     * and say "Sample data" out loud.
     */
    await page.goto('/fresh/route/4/eb')
    await controlled(page)

    await context.setOffline(true)
    try {
      const reached = await page.evaluate(() =>
        fetch('api/route/4.json').then(() => 'answered', () => 'failed'))
      expect(reached).toBe('failed')

      await page.goto('/fresh/route/4/eb')
      await expect(page.locator('.banner--info')).toContainText('Sample data')
      await expect(page.locator('.vrow').first()).toBeVisible()
    } finally {
      await context.setOffline(false)
    }
  })
})
