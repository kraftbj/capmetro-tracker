/**
 * Lets a test bind to code another lane has not written yet.
 *
 * build/, runtime/ and client/ are being authored concurrently. A test that
 * cannot run today is written and skipped with a reason, never omitted, so the
 * gap is visible in the runner output instead of living in someone's head.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Import a module that may not exist yet. Never throws. */
export async function optionalModule(relPath) {
  const abs = path.join(ROOT, relPath)
  if (!existsSync(abs)) {
    return { mod: null, relPath, reason: `${relPath} does not exist yet (owned by another lane)` }
  }
  try {
    return { mod: await import(pathToFileURL(abs).href), relPath, reason: null }
  } catch (err) {
    return { mod: null, relPath, reason: `${relPath} exists but failed to import: ${err.message}` }
  }
}

/** Named export, falling back to a property of the default export. */
export function pick(loaded, name) {
  const m = loaded?.mod
  if (!m) return undefined
  return m[name] ?? m.default?.[name]
}

function unavailable(loaded, required) {
  if (!loaded.mod) return loaded.reason
  const missing = required.filter((n) => typeof pick(loaded, n) !== 'function')
  if (missing.length) {
    return `${loaded.relPath} does not export ${missing.join(', ')} (name assumed by tests/NOTES.md)`
  }
  return null
}

/**
 * Build an `it` that skips itself, with a reason, when the module or the
 * export it needs is missing.
 *
 *   const t = gate(await optionalModule('build/time.js'), ['serviceClockToEpoch'], it)
 *   t('resolves 25:10:00 to 1:10am the next day', (mod) => { ... })
 */
export function gate(loaded, required, it) {
  return (name, fn) =>
    it(name, (ctx) => {
      const why = unavailable(loaded, required)
      if (why) ctx.skip(why)
      return fn(loaded.mod, (n) => pick(loaded, n))
    })
}
