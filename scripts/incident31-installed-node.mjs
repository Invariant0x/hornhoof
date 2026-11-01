// Compare installed node modules without building or starting the application.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';

assert.equal(JSON.parse(readFileSync('apps/node/package.json', 'utf8')).type, 'module');
assert.equal(JSON.parse(readFileSync('/app/apps/node/package.json', 'utf8')).type, 'module');
const config = ts.readConfigFile('apps/node/tsconfig.json', ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, 'apps/node');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const files = [];
for (const name of ['main', 'state', 'runner', 'terminal/host', 'terminal/programs', 'providers/codex', 'terminal/bridge']) {
  const source = `apps/node/src/${name}.ts`;
  const installed = `/app/apps/node/dist/${name}.js`;
  // The package is ESM. Isolated NodeNext transpilation otherwise assumes CJS.
  const emitted = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: { ...parsed.options, module: ts.ModuleKind.ESNext },
    fileName: source,
  }).outputText;
  const actual = readFileSync(installed, 'utf8');
  files.push({ source, installed, installedSha256: sha256(actual), emittedSha256: sha256(emitted), byteIdentical: actual === emitted });
}
console.log(JSON.stringify({
  sourceCommit: 'bd696b0724385b6b11da53a24ada2f188b031217',
  method: 'Exact emitted ESM bytes with node tsconfig; no build or startup',
  files,
  limitation: 'Read-time installed module comparison, not complete build commit or historical launch arguments. Requires the authorized /app installation.',
}, null, 2));
assert.ok(files.every(file => file.byteIdentical), 'Installed node modules differ from source emission');
