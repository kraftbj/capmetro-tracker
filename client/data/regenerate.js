/*
 * Rebuilds the embedded fixture copies in this directory from the golden
 * fixtures. Run with: node client/data/regenerate.js
 * Reads only; writes only inside client/data/.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
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
  const dest = path.join(__dirname, `route-${src.routeId}-20260819.js`);
  fs.writeFileSync(dest, out);
  console.log(`wrote ${path.relative(REPO, dest)} (${out.length} bytes)`);
}
