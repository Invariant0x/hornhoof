import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));
const STUBS = fileURLToPath(new URL('./install-stubs/', import.meta.url));
/* System tools the script and the stubs may use. Real docker, brew, curl and sudo are never reachable. */
const TOOLS = ['bash', 'sh', 'env', 'cat', 'od', 'tr', 'head', 'base64', 'sleep', 'mkdir', 'rm', 'chmod', 'grep', 'sed', 'cut', 'cp', 'mv', 'touch', 'basename', 'dirname', 'wc', 'mktemp', 'date', 'sort', 'kill', 'printf', 'tail', 'awk', 'sha256sum', 'shasum', 'tee'];
const OLD_NODE = 'ghcr.io/invariant0x/hornhoof-node:0.6.1';
const NEW_NODE = `ghcr.io/invariant0x/hornhoof-node@sha256:${'c'.repeat(64)}`;
const CLAUDE = 'hornhoof-claude-1c07dac4';
const GOOGLE = 'hornhoof-antigravity-22222222';

/* install.sh server as the updater runs it for nodes behind, on a computer with the built-in node and two plan nodes. */
function fromUpdater(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-nodes-only-'));
  const bin = join(dir, 'stubs');
  const sys = join(dir, 'sys');
  mkdirSync(bin);
  mkdirSync(sys);
  for (const f of readdirSync(STUBS)) if (!f.startsWith('_')) copyFileSync(join(STUBS, f), join(bin, f));
  for (const tool of TOOLS) {
    const real = ['/usr/bin', '/bin'].map(d => join(d, tool)).find(p => existsSync(p));
    if (real) symlinkSync(real, join(sys, tool));
  }
  const log = join(dir, 'stub.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, '.env'), 'HORNHOOF_SECRET=s\nNODE_KEY=k\nPUBLIC_URL=http://localhost:8081\nHORNHOOF_PORT=8081\nHORNHOOF_VERSION=0.6.1\n');
  const compose = join(dir, 'brought.yaml');
  writeFileSync(compose, 'services: {app: {}}\n');
  const res = spawnSync(join(sys, 'bash'), [SCRIPT, 'server'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${bin}:${sys}`,
      HOME: join(dir, 'home'),
      STUB_LOG: log,
      STUB_SRC: STUBS,
      STUB_BIN: bin,
      STUB_STATE: dir,
      HORNHOOF_HOME: join(dir, 'home', '.hornhoof'),
      HORNHOOF_DIR: join(dir, 'home', 'hornhoof'),
      HORNHOOF_FROM_UPDATER: '1',
      HORNHOOF_UPDATER_REV: '2',
      HORNHOOF_PULLED: '1',
      HORNHOOF_SERVER_DIR: dir,
      HORNHOOF_VERSION: '0.7.0',
      HORNHOOF_COMPOSE_FILE: compose,
      HORNHOOF_APP_REF: `ghcr.io/invariant0x/hornhoof@sha256:${'b'.repeat(64)}`,
      HORNHOOF_NODE_REF: NEW_NODE,
      HORNHOOF_UPDATER_REF: `ghcr.io/invariant0x/hornhoof-updater@sha256:${'f'.repeat(64)}`,
      STUB_NODE_RUNNING: OLD_NODE,
      STUB_CONTAINERS: `${CLAUDE}=http://localhost:8081 ${GOOGLE}=http://localhost:8081`,
      HORNHOOF_NODES_FREE: '1',
      ...env,
    },
  });
  const table = existsSync(join(dir, 'containers')) ? readFileSync(join(dir, 'containers'), 'utf8').trim().split('\n').filter(Boolean) : [];
  return { code: res.status, out: res.stdout + res.stderr, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), containers: table };
}

const touched = (calls: string[], name: string) => calls.filter(c => c.includes(name) && !c.startsWith('docker ps'));
const STOPS_BUILTIN = 'docker exec nodecid node /app/apps/node/dist/main.js prepare-stop hornhoof_update';
/* The built-in node alone is started again when it is named: the app and what it stands on run this build already. */
const ONLY_NODE = 'docker compose up -d --no-build --no-deps node';
/* With none named, the app goes in with the built-in node, as in any update whose nodes are free. */
const APP_AND_NODE = 'docker compose up -d --no-build app node';
const started = (calls: string[]) => calls.filter(c => c.startsWith('docker compose up'));

const removedOld = (calls: string[], name: string) => calls.some(c => c.startsWith(`docker rm -f ${name}-old-`));

describe('install.sh when the updater names the nodes that are free', () => {
  it('replaces only a plan node it names: the built-in node and the other plan node go on with what they run', () => {
    const r = fromUpdater({ HORNHOOF_NODES_ONLY: `id-of-${CLAUDE}` });
    expect(r.code).toBe(0);
    expect(started(r.calls)).toEqual([]);
    expect(r.calls).not.toContain(STOPS_BUILTIN);
    expect(r.calls).toContain(`docker exec ${CLAUDE} node /app/apps/node/dist/main.js prepare-stop hornhoof_update`);
    expect(removedOld(r.calls, CLAUDE)).toBe(true);
    expect(touched(r.calls, GOOGLE)).toEqual([]);
  });

  it('replaces only the built-in node when it names that one', () => {
    const r = fromUpdater({ HORNHOOF_NODES_ONLY: 'builtin' });
    expect(r.code).toBe(0);
    expect(started(r.calls)).toEqual([ONLY_NODE]);
    expect(r.calls).toContain(STOPS_BUILTIN);
    expect(touched(r.calls, CLAUDE)).toEqual([]);
    expect(touched(r.calls, GOOGLE)).toEqual([]);
  });

  it('replaces all it names at once', () => {
    const r = fromUpdater({ HORNHOOF_NODES_ONLY: `builtin id-of-${CLAUDE} id-of-${GOOGLE}` });
    expect(started(r.calls)).toEqual([ONLY_NODE]);
    expect(removedOld(r.calls, CLAUDE)).toBe(true);
    expect(removedOld(r.calls, GOOGLE)).toBe(true);
  });

  it('takes a plan node it names on when the built-in node runs that image already', () => {
    const r = fromUpdater({ HORNHOOF_NODES_ONLY: `id-of-${GOOGLE}`, STUB_NODE_RUNNING: NEW_NODE });
    expect(r.code).toBe(0);
    expect(removedOld(r.calls, GOOGLE)).toBe(true);
    expect(touched(r.calls, CLAUDE)).toEqual([]);
  });

  it('replaces them all, as before, when it names none', () => {
    const r = fromUpdater({});
    expect(r.calls).toContain(APP_AND_NODE);
    expect(removedOld(r.calls, CLAUDE)).toBe(true);
    expect(removedOld(r.calls, GOOGLE)).toBe(true);
  });

  it('matches a whole plan, never part of a longer one', () => {
    const r = fromUpdater({ HORNHOOF_NODES_ONLY: `id-of-${CLAUDE}-longer` });
    expect(r.code).toBe(0);
    expect(touched(r.calls, CLAUDE)).toEqual([]);
  });

  it('renames the old node container with restart=no before starting the new one and removes -old-* once the new node is healthy', () => {
    const r = fromUpdater({ HORNHOOF_NODES_ONLY: `id-of-${CLAUDE}` });
    expect(r.code).toBe(0);
    const renameIdx = r.calls.findIndex(c => c.startsWith(`docker rename ${CLAUDE} ${CLAUDE}-old-`));
    expect(renameIdx).toBeGreaterThanOrEqual(0);
    const oldName = r.calls[renameIdx].split(' ')[3];
    const noRestartIdx = r.calls.indexOf(`docker update --restart=no ${oldName}`);
    const runIdx = r.calls.findIndex(c => c.startsWith(`docker run -d --name ${CLAUDE} `));
    const healthIdx = r.calls.indexOf(`docker inspect --format {{.State.Running}} {{.State.Restarting}} ${CLAUDE}`);
    const rmOldIdx = r.calls.indexOf(`docker rm -f ${oldName}`);
    expect(noRestartIdx).toBeGreaterThan(renameIdx);
    expect(runIdx).toBeGreaterThan(noRestartIdx);
    expect(healthIdx).toBeGreaterThan(runIdx);
    expect(rmOldIdx).toBeGreaterThan(healthIdx);
    expect(r.calls.some(c => c.startsWith('docker volume rm'))).toBe(false);
    expect(r.containers).toContain(`${CLAUDE}|http://localhost:8081|unless-stopped`);
    expect(r.containers.some(line => line.startsWith(`${CLAUDE}-old-`))).toBe(false);
  });

  it('keeps and restores the old node container without touching volumes when the new node fails or is unhealthy', () => {
    const cases: Record<string, string>[] = [
      { STUB_RUN: 'fail' },
      { STUB_NEW_NODE_STOPPED: CLAUDE },
      { STUB_NEW_NODE_RESTARTING: CLAUDE },
    ];
    for (const bad of cases) {
      const r = fromUpdater({ HORNHOOF_NODES_ONLY: `id-of-${CLAUDE}`, ...bad });
      expect(r.code).toBe(1);
      const renameIdx = r.calls.findIndex(c => c.startsWith(`docker rename ${CLAUDE} ${CLAUDE}-old-`));
      expect(renameIdx).toBeGreaterThanOrEqual(0);
      const oldName = r.calls[renameIdx].split(' ')[3];
      expect(r.calls).toContain(`docker update --restart=no ${oldName}`);
      expect(r.calls).not.toContain(`docker rm -f ${oldName}`);
      expect(r.calls).toContain(`docker rename ${oldName} ${CLAUDE}`);
      expect(r.calls).toContain(`docker update --restart=unless-stopped ${CLAUDE}`);
      expect(r.calls).toContain(`docker start ${CLAUDE}`);
      expect(r.calls.some(c => c.startsWith('docker volume rm'))).toBe(false);
      expect(r.containers).toContain(`${CLAUDE}|http://localhost:8081|unless-stopped`);
      expect(r.containers.some(line => line.startsWith(`${CLAUDE}-old-`))).toBe(false);
    }
  });

  it('sweeps leftover -old-* node containers whose new nodes are healthy and disables restart on kept ones', () => {
    const kimi = 'hornhoof-kimi-fd5eff72';
    const kimiOld = `${kimi}-old-01817`;
    const codex = 'hornhoof-codex-606af686';
    const codexOld = `${codex}-old-01817`;
    const stoppedNode = 'hornhoof-claude-33333333';
    const stoppedOld = `${stoppedNode}-old-01817`;
    const foreignOld = 'hornhoof-kimi-44444444-old-01817';
    const r = fromUpdater({
      HORNHOOF_NODES_ONLY: 'builtin',
      STUB_CONTAINERS: [
        `${kimi}=http://localhost:8081`,
        `${kimiOld}=http://localhost:8081`,
        `${codex}=http://localhost:8081`,
        `${codexOld}=http://localhost:8081`,
        `${stoppedNode}=http://localhost:8081`,
        `${stoppedOld}=http://localhost:8081`,
        `${foreignOld}=https://other.example`,
      ].join(' '),
      STUB_STOPPED: stoppedNode,
    });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker update --restart=no ${kimiOld}`);
    expect(r.calls).toContain(`docker update --restart=no ${codexOld}`);
    expect(r.calls).toContain(`docker update --restart=no ${stoppedOld}`);
    expect(r.calls).toContain(`docker rm -f ${kimiOld}`);
    expect(r.calls).toContain(`docker rm -f ${codexOld}`);
    expect(r.calls).not.toContain(`docker rm -f ${stoppedOld}`);
    expect(r.calls.some(c => c.includes(foreignOld) && !c.startsWith('docker ps'))).toBe(false);
    expect(r.calls.some(c => c.startsWith('docker run -d --name ') && c.includes('-old-'))).toBe(false);
    expect(r.calls.some(c => c.startsWith('docker volume rm'))).toBe(false);
    expect(r.containers).toContain(`${stoppedOld}|http://localhost:8081|no`);
  });
});
