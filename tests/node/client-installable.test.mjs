/**
 * What makes this board an app on a phone rather than a page, and the several
 * ways that quietly stops being true.
 *
 * Every failure in this area is silent. A manifest with a relative URL turned
 * absolute still parses, still validates, and installs a shortcut that 404s. An
 * icon renamed but not re-listed installs as a blank square. A theme colour that
 * drifts from tokens.css shows as a strip of the wrong colour behind the status
 * bar on somebody's home screen and nowhere else. None of it is visible in a
 * browser tab, which is where all the other tests look.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './helpers/optional.mjs'
import { PALETTE } from '../../client/icons/regenerate.js'

const CLIENT = path.join(ROOT, 'client')
const html = readFileSync(path.join(CLIENT, 'index.html'), 'utf8')
const manifestText = readFileSync(path.join(CLIENT, 'manifest.webmanifest'), 'utf8')
const manifest = JSON.parse(manifestText)
const tokens = readFileSync(path.join(CLIENT, 'tokens.css'), 'utf8')

/** The <link rel="..."> hrefs in index.html, by rel. */
function links(rel) {
  const out = []
  const tag = /<link\b[^>]*>/gi
  let m
  while ((m = tag.exec(html.replace(/<!--[\s\S]*?-->/g, ''))) !== null) {
    const r = (m[0].match(/\brel\s*=\s*"([^"]*)"/) || [])[1]
    const href = (m[0].match(/\bhref\s*=\s*"([^"]*)"/) || [])[1]
    if (r === rel && href) out.push(href)
  }
  return out
}

function meta(name) {
  const m = html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`))
  return m ? m[1] : null
}

/** Width and height out of a PNG's IHDR, which is always the first chunk. */
function pngSize(file) {
  const buf = readFileSync(file)
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(sig)) throw new Error(`${file} is not a PNG`)
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error(`${file} has no IHDR`)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), depth: buf[24], color: buf[25] }
}

describe('the web app manifest', () => {
  it('is the JSON a browser will actually parse, with no comments in it', () => {
    /* A manifest is strict JSON. The reasoning that would normally sit in a
       comment lives in client/NOTES.md instead, which is why this asserts. */
    expect(manifestText).not.toMatch(/^\s*\/\//m)
    expect(typeof manifest).toBe('object')
  })

  it('carries the fields an install prompt requires', () => {
    expect(manifest.name).toBe('Dillo Bus Board')
    expect(manifest.short_name.length).toBeGreaterThan(0)
    /* Android truncates a short_name past about twelve characters on the home
       screen, and truncates it without an ellipsis. */
    expect(manifest.short_name.length).toBeLessThanOrEqual(12)
    expect(manifest.start_url).toBeTruthy()
    expect(manifest.display).toBe('standalone')
  })

  it('names no absolute URL anywhere, which is what lets it be served at depth', () => {
    /*
     * The load-bearing one. tests/e2e/server.mjs serves the whole client under a
     * scenario prefix and the board reads its own base out of the path; a
     * manifest URL beginning "/" would resolve against the origin root instead,
     * so start_url, scope and every icon would point at a 404 under the fixture
     * server and at whatever else happens to be at the root of a shared host.
     *
     * `id` is absent for the same reason and cannot be fixed the same way: it is
     * resolved against the ORIGIN rather than against the manifest, so there is
     * no relative spelling of it that survives a prefix. Left out, it defaults
     * to start_url, which is correct under every prefix.
     */
    const urls = [
      manifest.start_url,
      manifest.scope,
      ...manifest.icons.map((i) => i.src),
      ...(manifest.shortcuts || []).map((s) => s.url),
    ]
    for (const u of urls) {
      expect(u, `${u} must be relative`).not.toMatch(/^([a-z]+:)?\/\//i)
      expect(u, `${u} must not start at the origin root`).not.toMatch(/^\//)
    }
    expect(manifest.id, 'id resolves against the origin and cannot be prefix-safe').toBeUndefined()
  })

  it('takes both colours from tokens.css, so the home screen matches the board', () => {
    const surface = (tokens.match(/--surface:\s*(#[0-9a-f]{6})/i) || [])[1]
    expect(surface).toBe('#0b0d12')
    expect(manifest.theme_color).toBe(surface)
    expect(manifest.background_color).toBe(surface)
    /* And the tab colour the browser reads before the manifest is fetched. */
    expect(meta('theme-color')).toBe(surface)
  })

  it('offers the two sizes an installer looks for, in both purposes', () => {
    const by = (purpose, size) =>
      manifest.icons.filter((i) => i.purpose === purpose && i.sizes === `${size}x${size}`)
    for (const size of [192, 512]) {
      expect(by('any', size), `no ${size}px any icon`).toHaveLength(1)
      /*
       * Maskable is a separate file rather than `purpose: "any maskable"` on the
       * same one. A launcher may crop a maskable icon to 80% of its width, and
       * the tile art fills the frame -- declaring one file as both would show
       * the rounded tile cropped through its own corners.
       */
      expect(by('maskable', size), `no ${size}px maskable icon`).toHaveLength(1)
    }
  })

  it('lists icons that exist, at the size each one claims', () => {
    for (const icon of manifest.icons) {
      const file = path.join(CLIENT, icon.src)
      expect(existsSync(file), `${icon.src} is listed but not committed`).toBe(true)
      const png = pngSize(file)
      const [w, h] = icon.sizes.split('x').map(Number)
      expect(png.width, `${icon.src} is ${png.width}px, listed as ${w}`).toBe(w)
      expect(png.height).toBe(h)
      expect(icon.type).toBe('image/png')
    }
  })

  it('only takes shortcuts to paths the vhosts actually answer', () => {
    /*
     * A launcher shortcut is a long-press away and gets used cold. Both vhosts
     * fall back to index.html for exactly four verbs and 404 everything else, so
     * a shortcut to anything outside that list is a 404 from a home screen.
     */
    const VERBS = ['route', 'buses', 'trip', 'saved']
    for (const s of manifest.shortcuts || []) {
      expect(VERBS, `shortcut "${s.name}" points at ${s.url}`).toContain(s.url.split('/')[0])
    }
  })
})

describe('what index.html tells a phone', () => {
  it('links the manifest, relatively', () => {
    expect(links('manifest')).toEqual(['manifest.webmanifest'])
  })

  it('links an apple-touch-icon, because iOS reads no manifest icon at all', () => {
    const apple = links('apple-touch-icon')
    expect(apple).toHaveLength(1)
    const file = path.join(CLIENT, apple[0])
    expect(existsSync(file)).toBe(true)
    /* 180 is the largest size iOS asks for; it downsamples for everything else. */
    expect(pngSize(file).width).toBe(180)
  })

  it('links a favicon in both an old and a new form', () => {
    const icons = links('icon')
    expect(icons).toContain('favicon.svg')
    expect(icons).toContain('favicon.ico')
    for (const href of icons) expect(existsSync(path.join(CLIENT, href))).toBe(true)
  })

  it('resolves every one of those against the <base>, never against the origin', () => {
    for (const href of [...links('manifest'), ...links('icon'), ...links('apple-touch-icon')]) {
      expect(href, `${href} would break under the e2e prefix and on file://`).not.toMatch(/^\//)
    }
  })

  it('says it can be installed, in both the standard and the Apple spelling', () => {
    expect(meta('mobile-web-app-capable')).toBe('yes')
    expect(meta('apple-mobile-web-app-capable')).toBe('yes')
    expect(meta('apple-mobile-web-app-title')).toBe(manifest.short_name)
  })

  it('does not ask iOS for a translucent status bar it is not laid out for', () => {
    /*
     * black-translucent puts the board UNDER the notch. styles.css pads for the
     * safe area, which keeps content out of it, but nothing here lays out
     * around it -- so translucent would be a promise the stylesheet does not
     * keep. If that ever changes, this is the test to change with it.
     */
    expect(meta('apple-mobile-web-app-status-bar-style')).toBe('black')
  })

  it('keeps the description the manifest and the page agree on', () => {
    expect(meta('description')).toBe(manifest.description)
  })
})

describe('the safe-area padding an installed board needs', () => {
  const css = readFileSync(path.join(CLIENT, 'styles.css'), 'utf8')

  it('pads for a notch and a home indicator, with a zero fallback', () => {
    /*
     * Standalone mode has no browser chrome absorbing the insets, and the
     * viewport meta already says viewport-fit=cover. Each of these has to carry
     * its own `, 0px` fallback: env() with no fallback is invalid in a
     * calc() on a browser that does not know the variable, and the whole
     * declaration is then dropped.
     */
    for (const side of ['top', 'bottom', 'left', 'right']) {
      expect(css, `no safe-area-inset-${side}`).toContain(`env(safe-area-inset-${side}, 0px)`)
    }
  })

  it('still asks for viewport-fit=cover, without which none of it resolves', () => {
    expect(html).toMatch(/<meta name="viewport"[^>]*viewport-fit=cover/)
  })
})

describe('the icons and the palette they were cut from', () => {
  it('draws the mark in the adherence colours tokens.css publishes', () => {
    /*
     * The icon is the board's own string-line: a spine with three dots placed by
     * how late each bus is. If tokens.css is ever repalletted, this fails rather
     * than leaving the old colours on somebody's home screen -- where they are
     * not next to the board and nobody would notice the difference.
     */
    const token = (name) => (tokens.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i')) || [])[1]
    expect(PALETTE.early).toBe(token('adh-early'))
    expect(PALETTE.ontime).toBe(token('adh-ontime'))
    expect(PALETTE.late).toBe(token('adh-late'))
    expect(PALETTE.surface).toBe(token('surface'))
    expect(PALETTE.hairline).toBe(token('hairline'))
  })

  it('committed every file the generator writes, as a real PNG', () => {
    for (const file of [
      'icons/icon-192.png',
      'icons/icon-512.png',
      'icons/maskable-192.png',
      'icons/maskable-512.png',
      'icons/apple-touch-icon.png',
    ]) {
      const png = pngSize(path.join(CLIENT, file))
      expect(png.depth, `${file} is not 8-bit`).toBe(8)
      expect(png.color, `${file} is not RGBA`).toBe(6)
    }
  })

  it('wrote an .ico a browser asking for /favicon.ico with no link can read', () => {
    const buf = readFileSync(path.join(CLIENT, 'favicon.ico'))
    expect(buf.readUInt16LE(0)).toBe(0)   /* reserved */
    expect(buf.readUInt16LE(2)).toBe(1)   /* type: icon, not cursor */
    expect(buf.readUInt16LE(4)).toBe(1)   /* one image */
    expect(buf[6]).toBe(32)               /* 32x32 */
    const offset = buf.readUInt32LE(18)
    const length = buf.readUInt32LE(14)
    expect(offset + length).toBe(buf.length)
    /* The payload is a PNG, which every icon reader since Vista accepts. */
    expect(buf.subarray(offset, offset + 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('drew the svg favicon from the same numbers, so it cannot drift', () => {
    const svg = readFileSync(path.join(CLIENT, 'favicon.svg'), 'utf8')
    for (const color of [PALETTE.surface, PALETTE.spine, PALETTE.early, PALETTE.ontime, PALETTE.late]) {
      expect(svg, `favicon.svg does not use ${color}`).toContain(color)
    }
  })
})
