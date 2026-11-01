const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [workflow, mainArchive, nativeArchive] = process.argv.slice(2);
if (!workflow || !mainArchive || !nativeArchive) throw new Error('Usage: node test-archive-integrity.cjs WORKFLOW MAIN_ARCHIVE NATIVE_ARCHIVE');
const yaml = fs.readFileSync(workflow, 'utf8');
const checks = [...yaml.matchAll(/node -e '([^']+)' \\\n\s+"\$RUNNER_TEMP\/codex-(main|native)\.tgz" '([^']+)'/g)];
if (checks.length !== 2) throw new Error(`Expected two inline archive checks, found ${checks.length}`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task73-sri-'));
let failed = 0;
try {
  for (const match of checks) {
    const [, code, kind, integrity] = match;
    const archive = kind === 'main' ? mainArchive : nativeArchive;
    const corrupt = path.join(temp, `${kind}.tgz`);
    const bytes = fs.readFileSync(archive);
    bytes[0] ^= 1;
    fs.writeFileSync(corrupt, bytes);
    for (const [name, file, expected] of [[`${kind}_valid`, archive, 0], [`${kind}_corrupt`, corrupt, 1]]) {
      const result = spawnSync(process.execPath, ['-e', code, file, integrity], { encoding: 'utf8', timeout: 30000 });
      const actual = result.status === 0 ? 0 : 1;
      console.log(`${name}: expected=${expected} actual=${actual} exit=${result.status}`);
      if (actual !== expected) {
        failed += 1;
        if (result.stderr) process.stderr.write(result.stderr);
      }
    }
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('ARCHIVE_SRI_REGRESSION_OK: valid archives accepted and corrupted archives rejected through both exact YAML argument paths');
