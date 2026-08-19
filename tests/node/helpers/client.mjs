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

/*
 * A richer sandbox than loadClient's, for the panels that BUILD a tree rather than
 * compute a number. rows.js and map.js need classList and childNodes, and ladder.js
 * needs createElementNS; loadClient's stub has none of the three, so a test that calls
 * render() against it throws rather than asserting.
 *
 * Still deliberately thin: no layout, no events, no real elements. Anything that needs a
 * box on screen belongs in the Playwright suite, which drives the actual page.
 */
export function renderClient(scripts) {
  const element = (tag, ns) => {
    const node = {
      tagName: tag,
      ns,
      className: '',
      textContent: '',
      children: [],
      attributes: {},
      appendChild(child) {
        this.children.push(child)
        return child
      },
      removeChild(child) {
        this.children = this.children.filter((c) => c !== child)
        return child
      },
      get childNodes() {
        return this.children
      },
      get firstChild() {
        return this.children[0] ?? null
      },
      setAttribute(k, v) {
        this.attributes[k] = String(v)
      },
      getAttribute(k) {
        return this.attributes[k] ?? null
      },
      removeAttribute(k) {
        delete this.attributes[k]
      },
      addEventListener() {},
      get classList() {
        const self = this
        return {
          add(c) {
            self.className = `${self.className} ${c}`.trim()
          },
          remove(c) {
            self.className = self.className.split(/\s+/).filter((x) => x !== c).join(' ')
          },
          contains: (c) => self.className.split(/\s+/).includes(c),
          toggle(c, on) {
            if (on) this.add(c)
            else this.remove(c)
          },
        }
      },
    }
    return node
  }

  const missing = scripts.filter((s) => {
    try {
      readFileSync(path.join(ROOT, 'client', s))
      return false
    } catch {
      return true
    }
  })
  if (missing.length) {
    return { cmb: null, document: null, reason: `client/${missing.join(', client/')} does not exist yet` }
  }

  const document = {
    createElement: (tag) => element(tag),
    createElementNS: (ns, tag) => element(tag, ns),
  }
  const window = { CMB: {}, document, location: { reload() {} } }
  window.window = window
  const context = vm.createContext({ window, document, globalThis: window, console })

  try {
    for (const s of scripts) {
      vm.runInContext(readFileSync(path.join(ROOT, 'client', s), 'utf8'), context, {
        filename: `client/${s}`,
      })
    }
  } catch (err) {
    return { cmb: null, document: null, reason: `client/${scripts.join(', ')} failed to evaluate: ${err.message}` }
  }

  return { cmb: window.CMB, document, reason: null }
}

/*
 * Every node in a stubbed tree whose class list carries `cls`.
 *
 * It reads BOTH className and the `class` attribute on purpose. HTML nodes here get their
 * classes through classList, but the map and the ladder build SVG through
 * createElementNS with a class ATTRIBUTE, and a matcher that only knew about className
 * silently found nothing in either panel — a green suite that had asserted on an empty
 * list.
 */
export function all(node, cls) {
  const out = []
  const has = (n) => {
    const names = `${n.className || ''} ${n.attributes?.class || ''}`
    return names.split(/\s+/).includes(cls)
  }
  const walk = (n) => {
    if (!n) return
    if (has(n)) out.push(n)
    ;(n.children || []).forEach(walk)
  }
  walk(node)
  return out
}

/** Every character a subtree carries, the way a reader would see it. */
export function textDeep(node) {
  if (!node) return ''
  return [node.textContent || '', ...(node.children || []).map(textDeep)].join(' ').trim()
}
