/* Temporary diagnostic for task 378. Never merge this branch into turn-8. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setInterval, clearInterval } from 'node:timers';
import { gunzipSync } from 'node:zlib';
import { identity, resource } from './linux-pair.mjs';

const root = process.cwd(), started = performance.now(), initial = identity(), samples = [], stages = [];
const archive = join(root, 'docs/superpowers/reports/fixed-pair-assets/fixed-sources-6d0c79b0-b98035e6.tar.gz');
const archiveHash = '037b48a88284eebfca0f52c909731b338ab74cc45fe33972b882398614e5752d';
const pairs = [['control', '6d0c79b0ced4ab2fc4f771a46479680664d6b663'], ['optimized', 'b98035e6d1b6b75715a5839ff0a4ea243878e65a']];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let emittedBytes = 0, drift = false;

function emit(kind, value) {
  const line = kind + ' ' + JSON.stringify(value);
  emittedBytes += Buffer.byteLength(line + '\n');
  console.log(line);
  if (emittedBytes > 700 * 1024) throw new Error('Preflight stdout exceeds 700 KiB; incomplete evidence');
}

function sample(stage, point) {
  const value = resource({ scope: 'offline-bounded-preflight', stage }, point);
  drift ||= JSON.stringify(value.limits) !== JSON.stringify(initial);
  samples.push(value); emit('HH_PREFLIGHT_RESOURCE', value);
}

async function step(stage, args, cwd = root, cache) {
  sample(stage, 'before');
  const start = performance.now(), chunks = [];
  const child = spawn(args[0], args.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0',
      ...(cache ? { npm_config_cache: cache, NPM_CONFIG_CACHE: cache } : {}) } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => chunks.push(bytes));
  let error;
  child.once('error', value => { error = value.message; });
  const timer = setInterval(() => sample(stage, 'during'), 5000);
  const status = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code: code ?? 1, signal })));
  clearInterval(timer); sample(stage, 'after');
  const raw = Buffer.concat(chunks);
  const row = { stage, args, ...status, error, ms: Math.round(performance.now() - start),
    rawBytes: raw.length, sha256: digest(raw), rawBase64: raw.toString('base64') };
  stages.push(row); emit('HH_PREFLIGHT_STAGE', row);
  assert.ok(!drift, 'Execution identity or quotas changed');
  assert.equal(row.code, 0, stage + ' failed');
  return raw.toString();
}

function checkArchive(bytes) {
  assert.equal(digest(bytes), archiveHash, 'Pinned source archive hash differs');
  const tar = gunzipSync(bytes, { maxOutputLength: 50 * 1024 * 1024 });
  let members = 0, offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString().split('\0')[0];
    const prefix = field(345, 155), name = (prefix ? prefix + '/' : '') + field(0, 100);
    assert.ok((name === 'source.git' || name.startsWith('source.git/')) && !name.split('/').includes('..') && !name.includes('\\'), 'Unsafe archive path');
    assert.ok(['\0', '0', '5'].includes(String.fromCharCode(header[156])), 'Archive links or special types are forbidden');
    const octal = field(124, 12).trim();
    assert.match(octal, /^[0-7]+$/, 'Invalid archive member size');
    const size = Number.parseInt(octal, 8);
    assert.ok(offset + 512 + size <= tar.length, 'Truncated archive member');
    offset += 512 + Math.ceil(size / 512) * 512; members++;
  }
  assert.ok(members > 0, 'Source archive is empty');
  return { members, compressedBytes: bytes.length, tarBytes: tar.length, sha256: archiveHash };
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const summary = {};
emit('HH_PREFLIGHT_SCOPE', { source: git(root, 'rev-parse', 'HEAD'), pairs, fullSuite: false,
  acceptedPerformanceResult: false, maxWorkers: 2, sourceDelivery: 'pinned archive in the checked-out temporary task branch' });
try {
  assert.equal(initial.platform, 'linux'); sample('preflight', 'before');
  assert.ok(initial.cpuMax && initial.memoryMax && initial.cpuset, 'Quota facts required');
  const checked = checkArchive(readFileSync(archive)); emit('HH_PREFLIGHT_ARCHIVE', checked);
  assert.equal(execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim(), process.execPath, 'Node on PATH differs from preflight Node');
  const scratch = mkdtempSync(join(tmpdir(), 'hh-fixed-preflight-'));
  await step('source-unpack', ['tar', '-xzf', archive, '-C', scratch]);
  const bare = join(scratch, 'source.git');
  for (const [variant, sha] of pairs) assert.equal(git(bare, 'rev-parse', 'refs/heads/' + variant), sha);
  git(bare, 'merge-base', '--is-ancestor', pairs[0][1], pairs[1][1]);
  await step('offline-source-import', ['git', 'fetch', '--no-tags', '--update-shallow', bare,
    ...pairs.map(([variant]) => 'refs/heads/' + variant + ':refs/remotes/preflight/' + variant)]);
  for (const [variant, sha] of pairs) {
    assert.equal(git(root, 'rev-parse', 'refs/remotes/preflight/' + variant), sha);
    const folder = join(scratch, variant), cache = join(scratch, variant + '-cache'); mkdirSync(cache);
    await step(variant + ':worktree', ['git', 'worktree', 'add', '--detach', folder, sha]);
    assert.equal(git(folder, 'rev-parse', 'HEAD'), sha, 'Prepared worktree differs from the pinned source');
    emit('HH_PREFLIGHT_SOURCE', { variant, sha, folder });
    const counts = {}, times = {};
    const commands = [
      ['install', ['npm', 'ci', '--prefer-offline', '--no-audit', '--no-fund']],
      ['protocol-build', ['npm', 'run', 'build', '-w', '@hornhoof/protocol']],
      ['node-build', ['npm', 'run', 'build', '-w', '@hornhoof/node']],
      ...['apps/server', 'apps/web', 'apps/node'].map((pkg, index) => [pkg,
        ['npx', '--no-install', 'vitest', 'run', 'test/' + ['timers', 'css', 'check-command'][index] + '.test.ts', '--maxWorkers=2'], pkg]),
    ];
    for (const [name, args, pkg] of commands) {
      const output = await step(variant + ':' + name, args, pkg ? join(folder, pkg) : folder, cache);
      times[name] = stages.at(-1).ms;
      if (pkg) for (const line of output.split('\n')) {
        const marker = '::hh-test-timing::', at = line.indexOf(marker);
        if (at < 0) continue;
        const timing = JSON.parse(line.slice(at + marker.length));
        if (timing.kind === 'package') counts[timing.package] = timing.tests;
      }
    }
    assert.deepEqual(counts, { 'apps/server': 14, 'apps/web': 3, 'apps/node': 6 });
    summary[variant] = { sha, counts, times };
  }
  emit('HH_PREFLIGHT_RESULT', { complete: true, summary, stages: stages.length,
    ms: Math.round(performance.now() - started), emittedBytesBeforeResult: emittedBytes,
    load1: [Math.min(...samples.map(value => value.load[0])), Math.max(...samples.map(value => value.load[0]))], acceptedPerformanceResult: false });
} catch (error) {
  emit('HH_PREFLIGHT_RESULT', { complete: false, error: error.message, stages: stages.length,
    ms: Math.round(performance.now() - started), emittedBytesBeforeResult: emittedBytes, acceptedPerformanceResult: false });
  process.exitCode = 1;
}
