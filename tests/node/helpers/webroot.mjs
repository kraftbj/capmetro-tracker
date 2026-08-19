/**
 * The generated webroot, once the runtime job writes one.
 *
 * Acceptance criteria 1-10 are statements about generated output. Until the
 * runtime lane lands, there is nothing to point them at, so they skip with a
 * reason rather than being omitted. Override with CAPMETRO_WEBROOT.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './optional.mjs'

export const WEBROOT = path.resolve(process.env.CAPMETRO_WEBROOT ?? path.join(ROOT, 'webroot'))
export const API = path.join(WEBROOT, 'api')

export const hasGeneratedOutput = () => existsSync(API) && statSync(API).isDirectory()

export const MISSING = `no generated output at ${API}; the runtime job has not run yet. Set CAPMETRO_WEBROOT to a webroot the runtime job wrote.`

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? walk(full) : [full]
  })
}

export const generatedFiles = () => walk(API).filter((f) => f.endsWith('.json'))
export const readGenerated = (f) => JSON.parse(readFileSync(f, 'utf8'))

export function routeFiles() {
  return generatedFiles().filter((f) => f.includes(`${path.sep}route${path.sep}`))
}

export function routeFile(routeId) {
  const f = path.join(API, 'route', `${routeId}.json`)
  return existsSync(f) ? readGenerated(f) : null
}

/** Skip the current test unless generated output exists. */
export function requireGenerated(ctx) {
  if (!hasGeneratedOutput()) ctx.skip(MISSING)
}
