import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eventually } from '../../../test-support/eventually.mjs';
import { JQ, killProcessGroup, pidAlive, runUpdater, tempUpdaterDir, updaterSource } from './updater-fixture.js';

const DOCKERFILE = fileURLToPath(new URL('../../updater/Dockerfile', import.meta.url));
const INSTALL = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));

const SERVER = 'https://hornhoof.example.test';
const HOST = 'a'.repeat(64);
const SERVER_HOST = 'f'.repeat(64);
const NODE = 'ghcr.io/invariant0x/hornhoof-node';
const UPDATER = 'ghcr.io/invariant0x/hornhoof-updater';
const OLD_NODE = `${NODE}@sha256:${'1'.repeat(64)}`;
const NEW_NODE = `${NODE}@sha256:${'2'.repeat(64)}`;
const SELF = `${UPDATER}@sha256:${'3'.repeat(64)}`;
const NEXT = `${UPDATER}@sha256:${'4'.repeat(64)}`;
const PLAN_A = '1c07dac4-c52e-48b4-b316-81c19de61bd7';
const PLAN_B = '9f1e2d3c-0000-4000-8000-000000000002';
const PLAN_C = '22222222-0000-4000-8000-000000000003';
const CLAUDE = 'hornhoof-claude-1c07dac4';
const CODEX = 'hornhoof-codex-9f1e2d3c';
const KIMI = 'hornhoof-kimi-22222222';
/* Two nodes on the build before, and one on the server's build already. */
const BEHIND = `${CLAUDE}=${PLAN_A}=${OLD_NODE} ${CODEX}=${PLAN_B}=${OLD_NODE} ${KIMI}=${PLAN_C}=${NEW_NODE}`;

type Served = { build?: string; updater?: string | null; host?: string; extra?: string[] };

/* What GET /install.sh answers: the lines install.sh says its build in, and commands, which nothing may ever run. */
function serve(dir: string, { build = NEW_NODE, updater = SELF, host = SERVER_HOST, extra = [] }: Served): string {
  const file = join(dir, 'served.sh');
  writeFileSync(file, [
    '#!/usr/bin/env bash',
    'touch "$STUB_STATE/pwned"',
    'SERVER="${HORNHOOF_SERVER:-https://elsewhere.example.test}"',
    `BUILD_IMAGE="${build}"`,
    ...(updater === null ? [] : [`UPDATER_BUILD="${updater}"`]),
    `SERVER_HOST_ID="${host}"`,
    ...extra,
    'printf \'served installer ran\\n\' >> "$STUB_LOG"',
    '',
  ].join('\n'));
  return file;
}

/* The installer inside the updater image: install.sh's lines with its placeholders, and a record of what it was given. */
function bundled(dir: string): string {
  const file = join(dir, 'bundled.sh');
  writeFileSync(file, [
    '#!/usr/bin/env bash',
    'SERVER="${HORNHOOF_SERVER:-__HORNHOOF_SERVER__}"',
    'BUILD_IMAGE="__HORNHOOF_NODE_IMAGE__"',
    'UPDATER_BUILD="__HORNHOOF_UPDATER_IMAGE__"',
    'SERVER_HOST_ID="__HORNHOOF_HOST_ID__"',
    'printf \'bundled installer SERVER=%s BUILD_IMAGE=%s UPDATER_BUILD=%s SERVER_HOST_ID=%s NODES_ONLY=%s FROM_UPDATER=%s TTY=%s\\n\' "$SERVER" "$BUILD_IMAGE" "$UPDATER_BUILD" "$SERVER_HOST_ID" "${HORNHOOF_NODES_ONLY:-}" "${HORNHOOF_FROM_UPDATER:-}" "${HORNHOOF_TTY:-}" >> "$STUB_LOG"',
    '[ -z "${STUB_INSTALLER_HOLD:-}" ] || { mkfifo "$STUB_STATE/installer-hold"; printf \'%s %s\\n\' "$$" "$PPID" > "$STUB_INSTALLER_HOLD"; read -r _ < "$STUB_STATE/installer-hold"; }',
    '[ -z "${STUB_INSTALLER_FAILS:-}" ] || { echo "Could not start the node." >&2; exit 1; }',
    'echo "Starting the node."',
    '',
  ].join('\n'));
  return file;
}

/* The updater with these arguments, as long as it takes: only the runner's limit for the test ends one that never ends. */
async function updater(args: string[], env: Record<string, string> = {}, served: Served = {}) {
  const dir = tempUpdaterDir('hh-updater-nodes-');
  const log = join(dir, 'stub.log');
  writeFileSync(log, '');
  const { code, out } = await runUpdater(args, {
    TMPDIR: dir,
    HOME: dir,
    STUB_LOG: log,
    STUB_STATE: dir,
    STUB_SERVED: serve(dir, served),
    HORNHOOF_INSTALLER: bundled(dir),
    ...env,
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  /* Whatever happens, nothing of what the server served ran. */
  expect(existsSync(join(dir, 'pwned'))).toBe(false);
  expect(calls).not.toContain('served installer ran');
  return { code, out, calls };
}

const look = (env: Record<string, string> = {}, served: Served = {}) => updater(['nodes', SERVER, SELF, HOST, '--once'], { STUB_PLAN_NODES: BEHIND, ...env }, served);
const installers = (calls: string[]) => calls.filter(c => c.startsWith('bundled installer'));
const ran = (plan: string) => `bundled installer SERVER=${SERVER} BUILD_IMAGE=${NEW_NODE} UPDATER_BUILD=${SELF} SERVER_HOST_ID=${SERVER_HOST} NODES_ONLY=${plan} FROM_UPDATER=1 TTY=/dev/null`;
const moves = (calls: string[]) => calls.filter(c => c.startsWith('docker run') && c.includes(' start-nodes '));

describe('updater of a server\'s nodes on another computer', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('The updater tests need jq. Install it (brew install jq on a Mac, apt install jq on Debian or Ubuntu), then run them again.');
  });

  it('replaces each node on another image than the server\'s build through the installer in its own image, side by side', async () => {
    const r = await look();
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.startsWith('curl') && c.includes(`${SERVER}/install.sh`))).toBe(true);
    expect(r.calls).toContain(`docker ps -a --filter label=hornhoof.subscription --filter label=hornhoof.server=${SERVER} --format {{.Names}} {{.Label "hornhoof.subscription"}}`);
    /* Each installer asks the server, with the node's own key in its volume, to let the node's work end, and replaces only it.
       It goes to the address the updater was started with, not one the server's answer names. */
    expect(installers(r.calls).sort()).toEqual([ran(PLAN_A), ran(PLAN_B)].sort());
    expect(r.out).toContain('Starting the node.');
  });

  it('runs nothing the server serves, also a value that carries a command', async () => {
    const r = await look({}, { build: `${NEW_NODE}$(touch "$STUB_STATE/pwned")`, extra: ['$(touch "$STUB_STATE/pwned")', '`touch "$STUB_STATE/pwned"`'] });
    expect(r.code).toBe(0);
    expect(installers(r.calls)).toEqual([]);
    expect(installers((await look({}, { extra: ['$(touch "$STUB_STATE/pwned")'] })).calls)).toHaveLength(2);
  });

  it.each([
    ['by its tag', `${NODE}:${'c'.repeat(40)}`],
    ['as a local build', 'local'],
    ['in another repository', `ghcr.io/acme/hornhoof-node@sha256:${'2'.repeat(64)}`],
    ['by a digest of another length', `${NODE}@sha256:${'2'.repeat(63)}`],
    ['by a digest with a command after it', `${NEW_NODE};touch /tmp/x`],
  ])('changes nothing when the server names its node image %s', async (_, build) => {
    const r = await look({}, { build });
    expect(r.code).toBe(0);
    expect(installers(r.calls)).toEqual([]);
    expect(moves(r.calls)).toEqual([]);
  });

  it.each([
    ['by its tag', `${UPDATER}:${'c'.repeat(40)}`],
    ['as a local build', 'local'],
    ['in another repository', `ghcr.io/acme/hornhoof-updater@sha256:${'4'.repeat(64)}`],
    ['not at all, as a build from before 0.8.4', null],
  ])('changes nothing when the server names its updater image %s', async (_, updater) => {
    const r = await look({}, { updater });
    expect(r.code).toBe(0);
    expect(installers(r.calls)).toEqual([]);
    expect(moves(r.calls)).toEqual([]);
  });

  it('changes nothing when the server names its own computer in a way no hash is written', async () => {
    const r = await look({}, { host: 'not-a-hash' });
    expect(installers(r.calls)).toEqual([]);
  });

  it('moves itself to the updater image of the server\'s build first, through a helper that outlives it, and replaces no node meanwhile', async () => {
    const r = await look({}, { updater: NEXT });
    expect(r.code).toBe(0);
    const name = `hornhoof-updater-${createHash('sha256').update(SERVER).digest('hex').slice(0, 12)}`;
    expect(moves(r.calls)).toEqual([`docker run -d --rm --name ${name}-move -v /var/run/docker.sock:/var/run/docker.sock ${NEXT} start-nodes ${SERVER} ${NEXT} ${HOST}`]);
    expect(installers(r.calls)).toEqual([]);
    expect(moves((await look({ STUB_PLAN_NODES: `${KIMI}=${PLAN_C}=${NEW_NODE}` }, { updater: NEXT })).calls)).toHaveLength(1);
  });

  it('stays as it is on the updater image of the server\'s build', async () => {
    const r = await look({ STUB_PLAN_NODES: `${KIMI}=${PLAN_C}=${NEW_NODE}` });
    expect(r.code).toBe(0);
    expect(moves(r.calls)).toEqual([]);
  });

  it('leaves the nodes of another server on this computer alone', async () => {
    const r = await look({ STUB_FOREIGN_NODES: CODEX });
    expect(installers(r.calls)).toEqual([ran(PLAN_A)]);
  });

  it('changes nothing when every node runs the server\'s build', async () => {
    const r = await look({ STUB_PLAN_NODES: `${KIMI}=${PLAN_C}=${NEW_NODE}` });
    expect(r.code).toBe(0);
    expect(installers(r.calls)).toEqual([]);
    expect(moves(r.calls)).toEqual([]);
  });

  it('moves the nodes to every build the server names by digest, whatever else the installer it serves says', async () => {
    const r = await look({}, { extra: ['NO_NODE="This build has no live check."'] });
    expect(r.code).toBe(0);
    expect(installers(r.calls).sort()).toEqual([ran(PLAN_A), ran(PLAN_B)].sort());
  });

  it('stands aside on the server\'s own computer, whose own updater moves the nodes', async () => {
    const r = await look({}, { host: HOST, updater: NEXT });
    expect(r.code).toBe(0);
    expect(installers(r.calls)).toEqual([]);
    expect(moves(r.calls)).toEqual([]);
  });

  it('looks again later after the server did not answer', async () => {
    const r = await look({ STUB_SERVED_DOWN: '1' });
    expect(r.code).toBe(1);
    expect(installers(r.calls)).toEqual([]);
    expect(r.out).toContain(`Could not reach ${SERVER}`);
  });

  it('looks again later after an installer failed, and says what it said', async () => {
    const r = await look({ STUB_INSTALLER_FAILS: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Could not start the node.');
  });

  it('refuses a server address or an image it cannot take as they are', async () => {
    for (const args of [['nodes', 'https://x.test/"; rm -rf /', SELF, HOST, '--once'], ['nodes', SERVER, 'ubuntu:latest', HOST, '--once'], ['nodes', SERVER, `${UPDATER}:${'c'.repeat(40)}`, HOST, '--once'], ['nodes', SERVER, SELF, 'invalid-host', '--once']]) {
      const r = await updater(args, { STUB_PLAN_NODES: BEHIND });
      expect(r.code).not.toBe(0);
      expect(r.calls.filter(c => c.startsWith('curl') || c.startsWith('docker'))).toEqual([]);
    }
  });

  it('runs the installer its own image carries, which fills in every value the server fills in', async () => {
    expect(readFileSync(DOCKERFILE, 'utf8')).toMatch(/^COPY scripts\/install\.sh \/usr\/local\/share\/hornhoof\/install\.sh$/m);
    const updaterScript = updaterSource();
    expect(updaterScript).toContain('INSTALLER="${HORNHOOF_INSTALLER:-/usr/local/share/hornhoof/install.sh}"');
    const placeholders = [...new Set(readFileSync(INSTALL, 'utf8').match(/__HORNHOOF_[A-Z_]+__/g))];
    expect(placeholders.sort()).toEqual(['__HORNHOOF_HOST_ID__', '__HORNHOOF_NODE_IMAGE__', '__HORNHOOF_SERVER__', '__HORNHOOF_UPDATER_IMAGE__']);
    for (const placeholder of placeholders) expect(updaterScript).toContain(placeholder);
  });
});

describe('updater start-nodes', () => {
  const name = `hornhoof-updater-${createHash('sha256').update(SERVER).digest('hex').slice(0, 12)}`;

  it('starts the one updater of a server\'s nodes, named after the server, with the Docker socket, once the ones before it are gone', async () => {
    const r = await updater(['start-nodes', SERVER, NEXT, HOST], { STUB_NODES_UPDATERS: 'old-1 old-2', STUB_NODES_UPDATER_IMAGE: SELF });
    expect(r.code).toBe(0);
    const run = r.calls.findIndex(c => c.startsWith('docker run -d'));
    expect(r.calls[run]).toBe(`docker run -d --name ${name} --label hornhoof.updater=nodes --label hornhoof.server=${SERVER} --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock ${NEXT} nodes ${SERVER} ${NEXT} ${HOST}`);
    expect(r.calls).toContain(`docker ps -aq --filter label=hornhoof.updater=nodes --filter label=hornhoof.server=${SERVER}`);
    for (const old of ['old-1', 'old-2']) expect(r.calls.indexOf(`docker rm -f ${old}`)).toBeLessThan(run);
  });

  it('keeps the one that runs that image already', async () => {
    const r = await updater(['start-nodes', SERVER, NEXT, HOST], { STUB_NODES_UPDATERS: 'old-1', STUB_NODES_UPDATER_IMAGE: NEXT });
    expect(r.code).toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker rm') || c.startsWith('docker run'))).toEqual([]);
  });

  it.each(['ubuntu:latest', `${UPDATER}:${'c'.repeat(40)}`])('starts nothing on an image that is not Hornhoof\'s updater by its digest: %s', async image => {
    const r = await updater(['start-nodes', SERVER, image, HOST], { STUB_NODES_UPDATERS: 'old-1' });
    expect(r.code).not.toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker rm') || c.startsWith('docker run'))).toEqual([]);
  });
});

describe('updater nodes process group cleanup', () => {
  const leakedPids = new Set<number>();
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const pid of leakedPids) killProcessGroup(pid);
    leakedPids.clear();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('stops background node installers and updater.sh when a test fails in afterEach', async () => {
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const work = mkdtempSync(join(tmpdir(), 'hh-nodes-abort-'));
    tempDirs.push(work);
    const holdFile = join(work, 'hold');
    const resultFile = join(work, 'result.json');
    const probeConfig = join(work, 'vitest.probe.config.mjs');
    writeFileSync(
      probeConfig,
      `export default { root: ${JSON.stringify(repoRoot)}, test: { pool: 'forks', testTimeout: 0, hookTimeout: 0, reporters: ['default'], include: ['apps/server/test/updater-nodes.test.ts'] } };\n`,
    );
    const runner = spawn(
      process.execPath,
      [join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', probeConfig, 'apps/server/test/updater-nodes.test.ts', '-t', 'updater nodes abort probe'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          VITEST: '',
          VITEST_WORKER_ID: '',
          VITEST_POOL_ID: '',
          HH_TEST_REPORT: '',
          HH_TEST_PART: '',
          HH_TEST_FILES: '',
          HH_NODES_ABORT_HOLD: holdFile,
          HH_NODES_ABORT_RESULT: resultFile,
        },
        stdio: 'ignore',
      },
    );
    await once(runner, 'exit');
    const observed = JSON.parse(readFileSync(resultFile, 'utf8')) as {
      installerPid: number; updaterPid: number; installerAlive: boolean; updaterAlive: boolean;
    };
    leakedPids.add(observed.installerPid);
    leakedPids.add(observed.updaterPid);
    expect(observed.installerAlive).toBe(false);
    expect(observed.updaterAlive).toBe(false);
    expect(pidAlive(observed.installerPid)).toBe(false);
    expect(pidAlive(observed.updaterPid)).toBe(false);
  });
});

const nodesAbortHold = process.env.HH_NODES_ABORT_HOLD;
const nodesAbortResult = process.env.HH_NODES_ABORT_RESULT;
if (nodesAbortHold && nodesAbortResult) {
  describe('updater nodes abort probe', () => {
    let saved = { installerPid: 0, updaterPid: 0 };
    it('fails while a background node installer is running', async () => {
      void look({ STUB_PLAN_NODES: `${CLAUDE}=${PLAN_A}=${OLD_NODE}`, STUB_INSTALLER_HOLD: nodesAbortHold }).catch(() => {});
      await eventually(() => existsSync(nodesAbortHold) && readFileSync(nodesAbortHold, 'utf8').includes('\n'));
      const [installerPid, updaterPid] = readFileSync(nodesAbortHold, 'utf8').trim().split(/\s+/).map(Number);
      saved = { installerPid: installerPid!, updaterPid: updaterPid! };
      writeFileSync(nodesAbortResult, JSON.stringify({ ...saved, installerAlive: true, updaterAlive: true }));
      throw new Error('simulated failure');
    });
    it('observes cleanup right after afterEach', () => {
      writeFileSync(nodesAbortResult, JSON.stringify({ ...saved, installerAlive: pidAlive(saved.installerPid), updaterAlive: pidAlive(saved.updaterPid) }));
      expect(saved.updaterPid).toBeGreaterThan(1);
    });
  });
}
