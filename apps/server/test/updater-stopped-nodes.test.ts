import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP, DIGESTS, JQ, NODE_DIGESTS, refs, runOnce, stand } from './updater-fixture.js';

const SCRIPT = fileURLToPath(new URL('../../updater/updater.sh', import.meta.url));
const STUBS = fileURLToPath(new URL('./updater-stubs/', import.meta.url));
const TOOLS = mkdtempSync(join(tmpdir(), 'hh-stopped-updater-tools-'));
if (JQ) symlinkSync(JQ, join(TOOLS, 'jq'));

const REMOTE_SERVER = 'https://hornhoof.stopped.test';
const REMOTE_HOST = 'b'.repeat(64);
const SERVER_HOST = 'e'.repeat(64);
const NODE_REPO = 'ghcr.io/invariant0x/hornhoof-node';
const UPDATER_REPO = 'ghcr.io/invariant0x/hornhoof-updater';
const OLD_BUILD = `${NODE_REPO}@sha256:${'5'.repeat(64)}`;
const NEW_BUILD = `${NODE_REPO}@sha256:${'6'.repeat(64)}`;
const UPDATER_SELF = `${UPDATER_REPO}@sha256:${'7'.repeat(64)}`;

const PLAN_STOPPED_OLD = 'aaaaaaaa-1111-4111-8111-111111111111';
const PLAN_STOPPED_NEW = 'bbbbbbbb-2222-4222-8222-222222222222';
const PLAN_RUNNING_NEW = 'cccccccc-3333-4333-8333-333333333333';
const PLAN_REMOVED = 'eeeeeeee-5555-4555-8555-555555555555';

async function remotePass(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-stopped-remote-'));
  const log = join(dir, 'calls.log');
  const served = join(dir, 'served.sh');
  const installer = join(dir, 'installer.sh');
  writeFileSync(log, '');
  writeFileSync(served, `#!/usr/bin/env bash\nBUILD_IMAGE="${NEW_BUILD}"\nUPDATER_BUILD="${UPDATER_SELF}"\nSERVER_HOST_ID="${SERVER_HOST}"\n`);
  writeFileSync(installer, '#!/usr/bin/env bash\nprintf \'started plan=%s image=%s server=%s\\n\' "${HORNHOOF_NODES_ONLY:-}" "__HORNHOOF_NODE_IMAGE__" "${HORNHOOF_SERVER:-__HORNHOOF_SERVER__}" >> "$STUB_LOG"\n');
  const child = spawn('bash', [SCRIPT, 'nodes', REMOTE_SERVER, UPDATER_SELF, REMOTE_HOST, '--once'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: `${STUBS}:${TOOLS}:/usr/bin:/bin`, HOME: dir, STUB_LOG: log, STUB_STATE: dir, STUB_SERVED: served, HORNHOOF_INSTALLER: installer, ...env },
  });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, out, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

describe('updater brings stopped nodes back up on the required image', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('jq is required for updater tests.');
  });

  it('sees stopped remote nodes on an older image and on the current image, starts both, and leaves running current or foreign nodes alone', async () => {
    const nodes = [
      `hornhoof-claude-old=${PLAN_STOPPED_OLD}=${OLD_BUILD}`,
      `hornhoof-codex-new=${PLAN_STOPPED_NEW}=${NEW_BUILD}`,
      `hornhoof-kimi-live=${PLAN_RUNNING_NEW}=${NEW_BUILD}`,
      `hornhoof-foreign=${'dddddddd-4444-4444-8444-444444444444'}=${OLD_BUILD}`,
    ].join(' ');
    const res = await remotePass({
      STUB_PLAN_NODES: nodes,
      STUB_STOPPED_NODES: 'hornhoof-claude-old hornhoof-codex-new hornhoof-foreign',
      STUB_FOREIGN_NODES: 'hornhoof-foreign',
    });
    expect(res.code).toBe(0);
    const started = res.calls.filter(c => c.startsWith('started ')).sort();
    expect(started).toEqual([
      `started plan=${PLAN_STOPPED_OLD} image=${NEW_BUILD} server=${REMOTE_SERVER}`,
      `started plan=${PLAN_STOPPED_NEW} image=${NEW_BUILD} server=${REMOTE_SERVER}`,
    ].sort());
  });

  it('sees stopped built-in and plan nodes on the server computer even when their container image already matches .env', async () => {
    const envText = `HORNHOOF_SECRET=s\nNODE_KEY=server-node-key\nHORNHOOF_VERSION=0.4.1\n${refs('0.4.1').replace(/ /g, '\n')}\n`;
    const currentNode = `${APP}-node@${NODE_DIGESTS['0.4.1']}`;
    const res = await runOnce(stand(envText), null, {
      STUB_RUNNING_IMAGES: `app=${APP}@${DIGESTS['0.4.1']} node=${currentNode}`,
      STUB_PLAN_NODES: `hornhoof-claude-stopped=${PLAN_STOPPED_NEW}=${currentNode} hornhoof-kimi-running=${PLAN_RUNNING_NEW}=${currentNode}`,
      STUB_STOPPED_NODES: 'nodecid hornhoof-claude-stopped',
      STUB_NODES: 'each',
      STUB_FREE: `builtin ${PLAN_STOPPED_NEW}`,
    });
    expect(res.code).toBe(0);
    const post = res.calls.find(c => c.startsWith('curl') && c.includes('/api/nodes/update') && c.includes('-X POST'));
    expect(post ?? '').toContain(JSON.stringify({ scope: 'server', nodes: ['builtin', PLAN_STOPPED_NEW] }));
    expect(res.calls).toContain(`installer told only builtin ${PLAN_STOPPED_NEW}`);
  });

  it('removes a stopped remote node whose volume marks its plan removed instead of starting it again', async () => {
    const removedName = 'hornhoof-claude-removed';
    const nodes = [
      `${removedName}=${PLAN_REMOVED}=${OLD_BUILD}`,
      `hornhoof-codex-new=${PLAN_STOPPED_NEW}=${NEW_BUILD}`,
      `hornhoof-kimi-live=${PLAN_RUNNING_NEW}=${NEW_BUILD}`,
    ].join(' ');
    const res = await remotePass({
      STUB_PLAN_NODES: nodes,
      STUB_STOPPED_NODES: `${removedName} hornhoof-codex-new`,
      STUB_REMOVED_NODES: removedName,
    });
    expect(res.code).toBe(0);
    expect(res.calls).toContain(`docker rm -f ${removedName}`);
    expect(res.calls).toContain(`docker volume rm ${removedName}`);
    expect(res.calls.filter(c => c.startsWith('started '))).toEqual([
      `started plan=${PLAN_STOPPED_NEW} image=${NEW_BUILD} server=${REMOTE_SERVER}`,
    ]);
    expect(res.out).toContain(`Removing ${removedName}, which was removed in Hornhoof.`);

    const onlyRemoved = await remotePass({
      STUB_PLAN_NODES: `${removedName}=${PLAN_REMOVED}=${NEW_BUILD}`,
      STUB_STOPPED_NODES: removedName,
      STUB_REMOVED_NODES: removedName,
    });
    expect(onlyRemoved.code).toBe(0);
    expect(onlyRemoved.calls).toContain(`docker rm -f ${removedName}`);
    expect(onlyRemoved.calls).toContain(`docker volume rm ${removedName}`);
    expect(onlyRemoved.calls.filter(c => c.startsWith('started '))).toEqual([]);
  });

  it('starts a stopped remote node without /data/removed and removes neither its container nor its volume', async () => {
    const res = await remotePass({
      STUB_PLAN_NODES: `hornhoof-codex-new=${PLAN_STOPPED_NEW}=${NEW_BUILD}`,
      STUB_STOPPED_NODES: 'hornhoof-codex-new',
      STUB_REMOVED_NODES: '',
    });
    expect(res.code).toBe(0);
    expect(res.calls).toContain('docker cp hornhoof-codex-new:/data/removed -');
    expect(res.calls.some(c => c.startsWith('docker rm') || c.startsWith('docker volume rm'))).toBe(false);
    expect(res.calls.filter(c => c.startsWith('started '))).toEqual([
      `started plan=${PLAN_STOPPED_NEW} image=${NEW_BUILD} server=${REMOTE_SERVER}`,
    ]);
  });

  it('leaves a stopped node of another server alone even when its volume has /data/removed', async () => {
    const res = await remotePass({
      STUB_PLAN_NODES: `hornhoof-foreign=${PLAN_REMOVED}=${OLD_BUILD}`,
      STUB_FOREIGN_NODES: 'hornhoof-foreign',
      STUB_STOPPED_NODES: 'hornhoof-foreign',
      STUB_REMOVED_NODES: 'hornhoof-foreign',
    });
    expect(res.code).toBe(0);
    expect(res.calls.some(c => c.includes('hornhoof-foreign'))).toBe(false);
    expect(res.calls.some(c => c.startsWith('docker rm') || c.startsWith('docker volume rm'))).toBe(false);
    expect(res.calls.filter(c => c.startsWith('started '))).toEqual([]);
  });

  it('sweeps leftover -old-* node containers on remote node hosts when live nodes are healthy and keeps -old-* (with restart=no) when live nodes are unhealthy', async () => {
    const kimi = 'hornhoof-kimi-fd5eff72';
    const kimiOld = `${kimi}-old-01817`;
    const codex = 'hornhoof-codex-606af686';
    const codexOld = `${codex}-old-01817`;
    const restarting = 'hornhoof-claude-33333333';
    const restartingOld = `${restarting}-old-01817`;
    const orphanOld = 'hornhoof-antigravity-44444444-old-01817';
    const foreignOld = 'hornhoof-kimi-55555555-old-01817';
    const nodes = [
      `${kimi}=11111111-1111-4111-8111-111111111111=${NEW_BUILD}`,
      `${kimiOld}=11111111-1111-4111-8111-111111111111=${OLD_BUILD}`,
      `${codex}=22222222-2222-4222-8222-222222222222=${NEW_BUILD}`,
      `${codexOld}=22222222-2222-4222-8222-222222222222=${OLD_BUILD}`,
      `${restarting}=33333333-3333-4333-8333-333333333333=${NEW_BUILD}`,
      `${restartingOld}=33333333-3333-4333-8333-333333333333=${OLD_BUILD}`,
      `${orphanOld}=44444444-4444-4444-8444-444444444444=${OLD_BUILD}`,
      `${foreignOld}=55555555-5555-4555-8555-555555555555=${OLD_BUILD}`,
    ].join(' ');
    const res = await remotePass({
      STUB_PLAN_NODES: nodes,
      STUB_RESTARTING_NODES: `${kimiOld} ${codexOld} ${restarting}`,
      STUB_FOREIGN_NODES: foreignOld,
    });
    expect(res.code).toBe(0);
    expect(res.calls.filter(c => c.startsWith('started '))).toEqual([]);
    expect(res.calls).toContain(`docker update --restart=no ${kimiOld}`);
    expect(res.calls).toContain(`docker update --restart=no ${codexOld}`);
    expect(res.calls).toContain(`docker update --restart=no ${restartingOld}`);
    expect(res.calls).toContain(`docker update --restart=no ${orphanOld}`);
    expect(res.calls).toContain(`docker rm -f ${kimiOld}`);
    expect(res.calls).toContain(`docker rm -f ${codexOld}`);
    expect(res.calls).not.toContain(`docker rm -f ${restartingOld}`);
    expect(res.calls).not.toContain(`docker rm -f ${orphanOld}`);
    expect(res.calls.some(c => c.includes(foreignOld))).toBe(false);
    expect(res.calls.some(c => c.startsWith('docker volume rm'))).toBe(false);
  });

  it('sweeps leftover -old-* node containers on the server computer without reporting them as behind plans', async () => {
    const envText = `HORNHOOF_SECRET=s\nNODE_KEY=server-node-key\nHORNHOOF_VERSION=0.4.1\n${refs('0.4.1').replace(/ /g, '\n')}\n`;
    const currentNode = `${APP}-node@${NODE_DIGESTS['0.4.1']}`;
    const kimi = 'hornhoof-kimi-fd5eff72';
    const kimiOld = `${kimi}-old-01817`;
    const stoppedBase = 'hornhoof-codex-606af686';
    const stoppedOld = `${stoppedBase}-old-01817`;
    const res = await runOnce(stand(envText), null, {
      STUB_RUNNING_IMAGES: `app=${APP}@${DIGESTS['0.4.1']} node=${currentNode}`,
      STUB_PLAN_NODES: [
        `${kimi}=${PLAN_RUNNING_NEW}=${currentNode}`,
        `${kimiOld}=${PLAN_RUNNING_NEW}=${OLD_BUILD}`,
        `${stoppedBase}=${PLAN_STOPPED_NEW}=${currentNode}`,
        `${stoppedOld}=${PLAN_STOPPED_NEW}=${OLD_BUILD}`,
      ].join(' '),
      STUB_STOPPED_NODES: `${stoppedBase} ${stoppedOld}`,
      STUB_NODES: 'each',
      STUB_FREE: '',
    });
    expect(res.code).toBe(0);
    const post = res.calls.find(c => c.startsWith('curl') && c.includes('/api/nodes/update') && c.includes('-X POST'));
    expect(post ?? '').toContain(JSON.stringify({ scope: 'server', nodes: [PLAN_STOPPED_NEW] }));
    expect(post ?? '').not.toContain(PLAN_RUNNING_NEW);
    expect(res.calls).toContain(`docker update --restart=no ${kimiOld}`);
    expect(res.calls).toContain(`docker update --restart=no ${stoppedOld}`);
    expect(res.calls).toContain(`docker rm -f ${kimiOld}`);
    expect(res.calls).not.toContain(`docker rm -f ${stoppedOld}`);
    expect(res.calls.some(c => c.startsWith('docker volume rm'))).toBe(false);
  });
});
