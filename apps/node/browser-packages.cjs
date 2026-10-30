// Prints the Debian packages Playwright's Chromium needs on a platform, such as debian12-arm64, from Playwright's
// own table. The table is not exported, so its section of the bundle runs alone. Run at image build time only.
const fs = require('node:fs');

const [bundle, platform] = process.argv.slice(2);
const src = fs.readFileSync(bundle, 'utf8');
const start = src.indexOf('// packages/playwright-core/src/server/registry/nativeDeps.ts');
const end = src.indexOf('\n// packages/', start + 1);
if (start < 0 || end < 0) throw new Error(`No package table in ${bundle}`);
const esm = section => Object.values(section)[0];
const deps = new Function('__esm', `${src.slice(start, end)}\ninit_nativeDeps();\nreturn deps;`)(esm);
const wanted = deps[platform];
if (!wanted?.tools?.length || !wanted?.chromium?.length) throw new Error(`No packages for ${platform}`);
console.log([...wanted.tools, ...wanted.chromium].join(' '));
