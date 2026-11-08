import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../updater/updater.sh', import.meta.url));
const STUBS = fileURLToPath(new URL('./updater-stubs/', import.meta.url));
const JQ = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
const TOOLS = mkdtempSync(join(tmpdir(), 'hh-updater-tools-'));
if (JQ) symlinkSync(JQ, join(TOOLS, 'jq'));

const SERVER = 'https://hornhoof.example.test';
const HOST = 'a'.repeat(64);
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

type Served = { build?: string; noNode?: string | null; updater?: string | null; host?: string };

/* What GET /install.sh answers: an installer that says what its build is in the lines install.sh has, and records how it ran. */
function serve(dir: string, { build = NEW_NODE, noNode = '', updater = SELF, host = 'f'.repeat(64) }: Served): string {
  const file = join(dir, 'served.sh');
  writeFileSync(file, [
    '#!/usr/bin/env bash',
    `BUILD_IMAGE="${build}"`,
    ...(noNode === null ? [] : [`NO_NODE="${noNode}"`]),
    ...(updater === null ? [] : [`UPDATER_BUILD="${updater}"`]),
    `SERVER_HOST_ID="${host}"`,
    'printf \'served installer %s NODES_ONLY=%s FROM_UPDATER=%s SERVER=%s TTY=%s\\n\' "$*" "${HORNHOOF_NODES_ONLY:-}" "${HORNHOOF_FROM_UPDATER:-}" "${HORNHOOF_SERVER:-}" "${HORNHOOF_TTY:-}" >> "$STUB_LOG"',
    '[ -z "${STUB_INSTALLER_FAILS:-}" ] || { echo "Could not start the node." >&2; exit 1; }',
    'echo "Starting the node."',
    '',
  ].join('\n'));
  return file;
}

function updater(args: string[], env: Record<string, string> = {}, served: Served = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-updater-nodes-'));
  const log = join(dir, 'stub.log');
  writeFileSync(log, '');
  const res = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: `${STUBS}:${TOOLS}:/usr/bin:/bin`, HOME: dir, STUB_LOG: log, STUB_STATE: dir, STUB_SERVED: serve(dir, served), ...env },
  });
  return { code: res.status, out: res.stdout + res.stderr, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

const look = (env: Record<string, string> = {}, served: Served = {}) => updater(['nodes', SERVER, SELF, HOST, '--once'], { STUB_PLAN_NODES: BEHIND, ...env }, served);
const installers = (calls: string[]) => calls.filter(c => c.startsWith('served installer'));
const moves = (calls: string[]) => calls.filter(c => c.startsWith('docker run') && c.includes(' start-nodes '));

describe('updater of a server\'s nodes on another computer', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('The updater tests need jq. Install it (brew install jq on a Mac, apt install jq on Debian or Ubuntu), then run them again.');
  });

  it('replaces each node on another image than the server\'s build through the installer the server serves, side by side', () => {
    const r = look();
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.startsWith('curl') && c.includes(`${SERVER}/install.sh`))).toBe(true);
    expect(r.calls).toContain(`docker ps --filter label=hornhoof.subscription --filter label=hornhoof.server=${SERVER} --format {{.Names}} {{.Label "hornhoof.subscription"}} {{.Label "hornhoof.check"}}`);
    /* Each installer asks the server, with the node's own key in its volume, to let the node's work end, and replaces only it. */
    expect(installers(r.calls).sort()).toEqual([PLAN_A, PLAN_B].sort().map(plan => `served installer  NODES_ONLY=${plan} FROM_UPDATER=1 SERVER=${SERVER} TTY=/dev/null`));
    expect(r.out).toContain('Starting the node.');
  });

  it('runs the installer of a build from before this once for all of them, since it replaces every node of its server', () => {
    const r = look({}, { updater: null });
    expect(r.code).toBe(0);
    expect(installers(r.calls)).toEqual([`served installer  NODES_ONLY=${PLAN_A} ${PLAN_B} FROM_UPDATER=1 SERVER=${SERVER} TTY=/dev/null`]);
    expect(moves(r.calls)).toEqual([]);
  });

  it('leaves the nodes of another server on this computer alone', () => {
    const r = look({ STUB_FOREIGN_NODES: CODEX });
    expect(installers(r.calls)).toEqual([`served installer  NODES_ONLY=${PLAN_A} FROM_UPDATER=1 SERVER=${SERVER} TTY=/dev/null`]);
  });

  it('leaves a node that check-node moved for a live check on its build for a day, and moves it after that', () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = look({ STUB_CHECKED_NODES: `${CLAUDE}=${now - 3600}` });
    expect(installers(fresh.calls)).toEqual([`served installer  NODES_ONLY=${PLAN_B} FROM_UPDATER=1 SERVER=${SERVER} TTY=/dev/null`]);
    const old = look({ STUB_CHECKED_NODES: `${CLAUDE}=${now - 25 * 3600}` });
    expect(installers(old.calls)).toHaveLength(2);
  });

  it('changes nothing when every node runs the server\'s build', () => {
    const r = look({ STUB_PLAN_NODES: `${KIMI}=${PLAN_C}=${NEW_NODE}` });
    expect(r.code).toBe(0);
    expect(installers(r.calls)).toEqual([]);
    expect(moves(r.calls)).toEqual([]);
  });

  it('changes nothing while the server\'s build has no live check, and says why', () => {
    const r = look({}, { noNode: 'This build has no live check of Claude, Codex, Kimi and Antigravity.' });
    expect(r.code).toBe(0);
    expect(installers(r.calls)).toEqual([]);
    expect(moves(r.calls)).toEqual([]);
    expect(r.out).toContain('has no live check');
  });

  it('changes nothing for a server that does not say whether its build has a live check', () => {
    const r = look({}, { noNode: null });
    expect(installers(r.calls)).toEqual([]);
    expect(moves(r.calls)).toEqual([]);
  });

  it.each([`${NODE}:${'c'.repeat(40)}`, 'local', `ghcr.io/acme/hornhoof-node@sha256:${'2'.repeat(64)}`])('changes nothing until the server names its node image by a digest of Hornhoof\'s: %s', build => {
    const r = look({}, { build });
    expect(r.code).toBe(0);
    expect(installers(r.calls)).toEqual([]);
  });

  it('stands aside on the server\'s own computer, whose own updater moves the nodes', () => {
    const r = look({}, { host: HOST, updater: NEXT });
    expect(r.code).toBe(0);
    expect(installers(r.calls)).toEqual([]);
    expect(moves(r.calls)).toEqual([]);
  });

  it('looks again later after the server did not answer', () => {
    const r = look({ STUB_SERVED_DOWN: '1' });
    expect(r.code).toBe(1);
    expect(installers(r.calls)).toEqual([]);
    expect(r.out).toContain(`Could not reach ${SERVER}`);
  });

  it('looks again later after an installer failed, and says what it said', () => {
    const r = look({ STUB_INSTALLER_FAILS: '1' }, { updater: NEXT });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Could not start the node.');
    expect(moves(r.calls)).toEqual([]);
  });

  it('moves itself to the updater image of the server\'s build afterwards, through a helper that outlives it', () => {
    const r = look({}, { updater: NEXT });
    expect(r.code).toBe(0);
    expect(moves(r.calls)).toEqual([`docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock ${NEXT} start-nodes ${SERVER} ${NEXT} ${HOST}`]);
    expect(r.calls.indexOf(moves(r.calls)[0]!)).toBeGreaterThan(Math.max(...installers(r.calls).map(c => r.calls.indexOf(c))));
    expect(moves(look({ STUB_PLAN_NODES: `${KIMI}=${PLAN_C}=${NEW_NODE}` }, { updater: NEXT }).calls)).toHaveLength(1);
  });

  it.each([['the one it runs', SELF], ['none', null], ['a local build', 'local'], ['another repository', `ghcr.io/acme/hornhoof-updater@sha256:${'4'.repeat(64)}`]])('stays as it is when the build names %s', (_, served) => {
    const r = look({ STUB_PLAN_NODES: `${KIMI}=${PLAN_C}=${NEW_NODE}` }, { updater: served });
    expect(r.code).toBe(0);
    expect(moves(r.calls)).toEqual([]);
  });

  it('refuses a server address or an image it cannot take as they are', () => {
    for (const args of [['nodes', 'https://x.test/"; rm -rf /', SELF, HOST, '--once'], ['nodes', SERVER, 'ubuntu:latest', HOST, '--once'], ['nodes', SERVER, SELF, 'not-a-host', '--once']]) {
      const r = updater(args, { STUB_PLAN_NODES: BEHIND });
      expect(r.code).not.toBe(0);
      expect(r.calls.filter(c => c.startsWith('curl') || c.startsWith('docker'))).toEqual([]);
    }
  });
});

describe('updater start-nodes', () => {
  const name = `hornhoof-updater-${createHash('sha256').update(SERVER).digest('hex').slice(0, 12)}`;

  it('starts the one updater of a server\'s nodes, named after the server, with the Docker socket, once the ones before it are gone', () => {
    const r = updater(['start-nodes', SERVER, NEXT, HOST], { STUB_NODES_UPDATERS: 'old-1 old-2', STUB_NODES_UPDATER_IMAGE: SELF });
    expect(r.code).toBe(0);
    const run = r.calls.findIndex(c => c.startsWith('docker run -d'));
    expect(r.calls[run]).toBe(`docker run -d --name ${name} --label hornhoof.updater=nodes --label hornhoof.server=${SERVER} --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock ${NEXT} nodes ${SERVER} ${NEXT} ${HOST}`);
    expect(r.calls).toContain(`docker ps -aq --filter label=hornhoof.updater=nodes --filter label=hornhoof.server=${SERVER}`);
    for (const old of ['old-1', 'old-2']) expect(r.calls.indexOf(`docker rm -f ${old}`)).toBeLessThan(run);
  });

  it('keeps the one that runs that image already', () => {
    const r = updater(['start-nodes', SERVER, NEXT, HOST], { STUB_NODES_UPDATERS: 'old-1', STUB_NODES_UPDATER_IMAGE: NEXT });
    expect(r.code).toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker rm') || c.startsWith('docker run'))).toEqual([]);
  });

  it('starts nothing on an image that is not Hornhoof\'s updater', () => {
    const r = updater(['start-nodes', SERVER, 'ubuntu:latest', HOST], { STUB_NODES_UPDATERS: 'old-1' });
    expect(r.code).not.toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker rm') || c.startsWith('docker run'))).toEqual([]);
  });
});
