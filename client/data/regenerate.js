/*
 * Rebuilds the embedded fixture copies in this directory from the golden
 * fixtures. Run with: node client/data/regenerate.js
 * Reads only; writes only inside client/data/.
 */
/* ESM, not CommonJS: package.json declares "type": "module", so a .js file here is
   loaded as a module and require() is not defined. This script used to use require and
   could not run at all. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DIR, '..', '..');
const SOURCES = [{ routeId: '4', file: 'tests/fixtures/golden/route-4-20260819.json' }];

const HEADER = [
  '/*',
  ' * Generated copy of %SRC%, verbatim.',
  ' * It exists because fetch() is blocked for file:// URLs, and the board must be',
  ' * openable straight from disk with no server. app.js prefers a real HTTP fetch',
  ' * whenever one is available and only falls back to this.',
  ' * Regenerate: node client/data/regenerate.js',
  ' */',
  'window.CMB_FIXTURES = window.CMB_FIXTURES || {};',
  'window.CMB_FIXTURES["%ID%"] =',
  ''
].join('\n');

for (const src of SOURCES) {
  const json = fs.readFileSync(path.join(REPO, src.file), 'utf8').replace(/\s+$/, '');
  const out = HEADER.replace('%SRC%', src.file).replace('%ID%', src.routeId) + json + ';\n';
  const dest = path.join(DIR, `route-${src.routeId}-20260819.js`);
  fs.writeFileSync(dest, out);
  console.log(`wrote ${path.relative(REPO, dest)} (${out.length} bytes)`);
}
