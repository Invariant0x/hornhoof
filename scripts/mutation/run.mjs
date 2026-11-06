#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* The mutation suite of a test run: mutator on each selected risky source file, against the fast tests that reach it. Its own
   snapshot, which the suite keeps between runs, leaves it only survivors and rewritten functions. A survivor is a finding, not a
   failure: the note keeps it with the result, so that a file that did not change need not run again and still says so. What cannot
   judge a file fails it: no fast test, tests that fail unmutated, nothing to mutate. */

const MANIFEST = '.hornhoof/test-environment.json';
const WORKERS = '4';
const TOTAL = /^Total\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s*$/m;

const word = text => (/^[\w./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

export function selectedSources(listed, mutation) {
  return listed ? JSON.parse(listed).map(path => normalize(path)) : mutation.sourcePaths;
}

/* The bare configuration leaves out what prepares a database or a report, which a pure test does not need. */
export function testCommand(tests) {
  const packages = Map.groupBy(tests, test => test.split('/').slice(0, 2).join('/'));
  return [...packages].map(([root, files]) => `npx --no-install vitest run --config ../../scripts/mutation/vitest.config.mjs --root ${word(root)} ${files.map(file => word(file.slice(root.length + 1))).join(' ')}`).join(' && ');
}

export function outcomeOf(code, output) {
  const total = TOTAL.exec(output);
  if ((code !== 0 && code !== 3) || !total || total[4] === '0') return { status: 'failed' };
  return { status: 'passed', note: `${total[1]} killed, ${total[2]} survived, ${total[3]} uncovered of ${total[4]} sites` };
}

export async function mutateSources(sources, fastTests, mutate) {
  const files = [];
  for (const file of sources) {
    const started = Date.now(), tests = fastTests.get(file) ?? [];
    if (!tests.length) process.stdout.write(`${file}: no fast test reaches it, so mutation cannot judge it.\n`);
    const outcome = tests.length ? outcomeOf(...Object.values(await mutate(file, tests))) : { status: 'failed' };
    files.push({ file, ...outcome, ms: Date.now() - started });
  }
  return files;
}

function mutate(tool, source, tests) {
  const env = { ...process.env, HH_TEST_FILES: '', HH_TEST_REPORT: '' };
  const args = ['--root', '.', '--source-root', source, '--no-coverage', '--max-workers', WORKERS, '--test-command', testCommand(tests)];
  return new Promise(done => {
    const child = spawn(tool, args, { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.on('error', error => { process.stdout.write(`${tool} could not start: ${error.message}\n`); done({ code: null, output }); });
    child.on('close', code => done({ code, output }));
  });
}

/* The same fast tests a source's fingerprint reads: what they reach decides both. */
async function fastTestsOf(manifest, sources) {
  const fingerprint = await import('../../apps/node/dist/test-fingerprint.js');
  const tracked = execFileSync('git', ['ls-files', '--stage', '--full-name', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean).map(line => {
    const [head, path] = line.split('\t'), [mode, oid] = head.split(' ');
    return { path, mode, oid };
  });
  const texts = new Map(fingerprint.codeFilesOf(tracked).map(path => [path, readFileSync(path, 'utf8')]));
  return fingerprint.fastTestsOf({ description: { manifest, inventory: [], inputDigests: [], runtimeCapabilities: [] }, tracked, texts }, manifest.mutation, sources);
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')), { mutation } = manifest;
  const sources = selectedSources(process.env.HH_TEST_FILES && readFileSync(process.env.HH_TEST_FILES, 'utf8'), mutation);
  const files = await mutateSources(sources, await fastTestsOf(manifest, sources), (source, tests) => mutate(mutation.tool, source, tests));
  if (process.env.HH_TEST_REPORT) writeFileSync(process.env.HH_TEST_REPORT, JSON.stringify({ files }));
  process.exitCode = files.some(file => file.status === 'failed') ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
