/**
 * Loads the client's classic scripts into a sandbox.
 *
 * client/*.js are classic scripts, not ES modules, because the board has to run
 * from a file:// URL where module loading is blocked. They attach to
 * window.CMB. Rather than adding a DOM library just to reach the pure parts,
 * this evaluates them in a vm context with a minimal window, which is enough
 * for the logic; anything that needs a real DOM belongs in the Playwright
 * suite, where it runs against the actual page.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { ROOT } from './optional.mjs'

/** Load client scripts in order. Returns window.CMB, or null with a reason. */
export function loadClient(scripts) {
  const missing = scripts.filter((s) => {
    try {
      readFileSync(path.join(ROOT, 'client', s))
      return false
    } catch {
      return true
    }
  })
  if (missing.length) {
    return { cmb: null, reason: `client/${missing.join(', client/')} does not exist yet` }
  }

  /*
   * A DOM stub thin enough to stay honest: it records tag, class, attributes
   * and text so a test can read what a builder produced, and nothing more.
   * Anything that needs layout, events or real elements belongs in the
   * Playwright suite, which drives the actual page.
   */
  const document = {
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        children: [],
        attributes: {},
        firstChild: null,
        setAttribute(k, v) {
          this.attributes[k] = String(v)
        },
        getAttribute(k) {
          return this.attributes[k] ?? null
        },
        appendChild(child) {
          this.children.push(child)
          this.firstChild = this.children[0]
          return child
        },
        removeChild(child) {
          this.children = this.children.filter((c) => c !== child)
          this.firstChild = this.children[0] ?? null
          return child
        },
        addEventListener() {},
      }
    },
  }

  const window = { CMB: {}, document, location: { reload() {} } }
  window.window = window
  const context = vm.createContext({ window, document, globalThis: window, console })

  try {
    for (const s of scripts) {
      const src = readFileSync(path.join(ROOT, 'client', s), 'utf8')
      vm.runInContext(src, context, { filename: `client/${s}` })
    }
  } catch (err) {
    return { cmb: null, reason: `client/${scripts.join(', ')} failed to evaluate: ${err.message}` }
  }

  return { cmb: window.CMB, reason: null }
}

/** An `it` that skips with a reason when the client scripts could not load. */
export function gateClient(loaded, namespace, it) {
  return (name, fn) =>
    it(name, (ctx) => {
      if (!loaded.cmb) ctx.skip(loaded.reason)
      const ns = loaded.cmb[namespace]
      if (!ns) ctx.skip(`client scripts loaded but window.CMB.${namespace} is not defined`)
      return fn(ns, loaded.cmb)
    })
}

/** All the text a stubbed element tree carries, flattened. */
export function textOf(node) {
  if (!node) return ''
  const own = node.textContent ?? ''
  const kids = (node.children ?? []).map(textOf).join(' ')
  return `${own} ${kids}`.trim()
}
