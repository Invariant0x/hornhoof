import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createAgentCommandGuard } from '../src/check-runtime.js';
import { CheckClient } from '../src/check-client.js';
import { setCheckClient } from '../src/check-queue.js';
import { NodeTestMessages } from '../src/test-environment.js';
import { deferred } from '../../../test-support/deferred.mjs';
import type { CheckQueueRequest } from '@hornhoof/protocol';

function workspace() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hh-command-context-'))), key = 'agent-550';
  const root = join(dir, 'work', 'agents', key), repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'one.test.ts'), 'export {};');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run one.test.ts', build: 'tsc' } }));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, key, root, repo, guard: createAgentCommandGuard(dir) };
}

describe('node-owned command context', () => {
  it.each(['one.test.ts', 'new.test.ts'])('allows one regular test file %s inside the authenticated workspace', async file => {
    const c = workspace();
    writeFileSync(join(c.repo, file), 'export {};');
    expect(await c.guard(c.key, { command: ['vitest', 'run', file], cwd: c.repo })).toMatchObject({ allow: true, kind: 'test_files' });
  });

  it('allows an ordinary command and resolves scripts from the canonical cwd', async () => {
    const c = workspace();
    expect(await c.guard(c.key, { command: ['git', 'status'], cwd: c.repo })).toMatchObject({ allow: true });
    expect(await c.guard(c.key, { command: ['npm', 'test'], cwd: c.repo })).toMatchObject({ allow: true, kind: 'test_files' });
    expect(await c.guard(c.key, { command: ['npm', 'run', 'build'], cwd: c.repo })).toMatchObject({ allow: true });
  });

  it.each(['../agent-550', '', 'x/y', 'x'.repeat(65), 'other-agent'])('refuses missing or invalid node-owned key %j', async key => {
    const c = workspace();
    expect(await c.guard(key, { command: ['git', 'status'], cwd: c.repo })).toMatchObject({ allow: false, code: 'command_guard_unavailable' });
  });

  it.each(['relative', 'foreign', 'missing'])('refuses %s cwd instead of treating it as authority', async kind => {
    const c = workspace(), cwd = kind === 'relative' ? 'repo' : kind === 'foreign' ? c.dir : join(c.root, 'missing');
    expect(await c.guard(c.key, { command: ['git', 'status'], cwd })).toMatchObject({ allow: false, code: 'command_guard_unavailable' });
  });

  it('refuses a removed workspace and a workspace replaced by a symlink', async () => {
    const c = workspace(), moved = join(c.dir, 'moved');
    renameSync(c.root, moved);
    expect(await c.guard(c.key, { command: ['git', 'status'], cwd: moved })).toMatchObject({ allow: false, code: 'command_guard_unavailable' });
    symlinkSync(moved, c.root);
    expect(await c.guard(c.key, { command: ['git', 'status'], cwd: c.repo })).toMatchObject({ allow: false, code: 'command_guard_unavailable' });
  });

  it('does not read a file outside the workspace through a cwd symlink', async () => {
    const c = workspace();
    symlinkSync(c.dir, join(c.root, 'escape'));
    expect(await c.guard(c.key, { command: ['git', 'status'], cwd: join(c.root, 'escape') })).toMatchObject({ allow: false, code: 'command_guard_unavailable' });
  });
});

it('identifies a queued environment description by its request ID', async () => {
  const requestId = '55555555-5555-4555-8555-555555555555', asked = deferred();
  let acquired: CheckQueueRequest | undefined;
  const client = new CheckClient(frame => { if (frame.type === 'check.acquire') { acquired = frame; asked.resolve(); } return true; });
  client.online(true); setCheckClient(client);
  const messages = new NodeTestMessages({ dir: '/tmp', capabilities: { testEnvironmentVersion: 1 }, stopped: () => false,
    testing: new Map(), unconfirmed: new Map(), run: async () => {}, emit: () => {} });
  const pending = messages.handle({ type: 'tests.describe', requestId, commitSha: 'a'.repeat(40), repo: { url: 'https://example.test/repo', token: '' },
    repositoryScope: { companyId: requestId, repositoryOwnerId: requestId, repoUrlHash: 'b'.repeat(64) } });
  try { await asked.promise; expect(acquired).toMatchObject({ label: `Describe product test environment ${requestId}` }); }
  finally {
    client.stop(); setCheckClient(null);
    await pending;
  }
});
