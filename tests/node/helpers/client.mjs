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

/*
 * The client's load order, read out of client/index.html rather than retyped.
 *
 * Every sandbox below takes a list of scripts, and each caller used to hand over
 * its own hand-written one. That broke the moment app.js gained a dependency:
 * when the trip view and the URL grammar landed, the list in
 * client-schedule-eviction.test.mjs still ended at near.js, app.js threw
 * reaching for CMB.urls.parse before exporting anything, and all fourteen
 * assertions in the file went out as one unreadable "Cannot read properties of
 * undefined". Nothing was wrong with the code under test.
 *
 * So a test that wants the whole client asks for CLIENT_SCRIPTS and stays right
 * as the client changes. A test that wants three modules still names its three;
 * that is a real choice and not a maintenance burden. The data/*.js fixture
 * includes are left out — they are a frozen capture, and a sandbox that wants
 * one should say so.
 */
export const CLIENT_SCRIPTS = (() => {
  /*
   * Comments stripped first, and attributes tolerated after the src. The obvious
   * one-line regex is wrong in both directions and silently: it matches inside
   * `<!-- ... -->`, so a commented-out tag still loads, and it requires `>` to
   * follow the src, so adding `defer` to a real tag drops that script from every
   * sandbox. Either way the suite goes green having tested something other than
   * the client. client-scripts.test.mjs is what makes that loud.
   */
  const html = readFileSync(path.join(ROOT, 'client/index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  const out = []
  const tag = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
  let m
  while ((m = tag.exec(html)) !== null) out.push(m[1])
  const scripts = out.filter((src) => !src.startsWith('data/'))
  if (!scripts.length) throw new Error('no client scripts found in client/index.html')
  return scripts
})()

/*
 * Which of these do not exist. Written once: all three sandboxes need the same
 * answer, and the point of the check is to report a missing file as a named
 * reason rather than as a stack trace from inside vm.
 */
function missingScripts(scripts) {
  return scripts.filter((s) => {
    try {
      readFileSync(path.join(ROOT, 'client', s))
      return false
    } catch {
      return true
    }
  })
}

/** Load client scripts in order. Returns window.CMB, or null with a reason. */
export function loadClient(scripts) {
  const missing = missingScripts(scripts)
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
 * One stub element, shared by renderClient and bootClient so the two sandboxes
 * cannot drift into disagreeing about what a node can do.
 */
function stubElement(tag, ns) {
  const node = {
    tagName: tag,
    ns,
    className: '',
    textContent: '',
    children: [],
    attributes: {},
    dataset: {},
    style: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    blur() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    contains: () => false,
    insertBefore(child) {
      this.children.unshift(child)
      return child
    },
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
  const element = stubElement

  const missing = missingScripts(scripts)
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

/*
 * A sandbox that can BOOT app.js, rather than only load the modules it uses.
 *
 * app.js is the one client file that runs on load: it reaches for
 * document.getElementById, installs listeners and starts the refresh timer. The
 * other two sandboxes have no getElementById at all, so app.js throws before it
 * exports anything and its decisions cannot be asserted.
 *
 * location.protocol is 'file:' on purpose. It is the one value that makes boot
 * inert and deterministic: getJson rejects immediately rather than reaching for
 * a network that is not there, and app.js skips installing the 60s interval
 * entirely, so nothing is left running after the test returns.
 */
export function bootClient(scripts) {
  const missing = missingScripts(scripts)
  if (missing.length) {
    return { cmb: null, reason: `client/${missing.join(', client/')} does not exist yet` }
  }

  const document = {
    readyState: 'complete',
    createElement: (tag) => stubElement(tag),
    createElementNS: (ns, tag) => stubElement(tag, ns),
    getElementById: () => stubElement('div'),
    createDocumentFragment: () => stubElement('#fragment'),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: stubElement('html'),
    body: stubElement('body'),
  }
  const store = new Map()
  const window = {
    CMB: {},
    document,
    location: { protocol: 'file:', search: '', href: 'file:///index.html', reload() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => void store.set(k, String(v)),
      removeItem: (k) => void store.delete(k),
    },
    addEventListener() {},
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    requestAnimationFrame: (fn) => { fn(0); return 0 },
    cancelAnimationFrame() {},
  }
  window.window = window
  const context = vm.createContext({
    window,
    document,
    globalThis: window,
    console,
    localStorage: window.localStorage,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    Promise,
    JSON,
    Math,
    Date,
  })

  try {
    for (const s of scripts) {
      vm.runInContext(readFileSync(path.join(ROOT, 'client', s), 'utf8'), context, {
        filename: `client/${s}`,
      })
    }
  } catch (err) {
    return { cmb: null, window: null, reason: `client/${scripts.join(', ')} failed to evaluate: ${err.message}` }
  }

  /* The window comes back so a test can break localStorage and watch what the
   * client does about it. */
  return { cmb: window.CMB, window, reason: null }
}
