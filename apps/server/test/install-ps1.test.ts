import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { testApp } from './helpers.js';

const DOCKERFILE = fileURLToPath(new URL('../../../Dockerfile', import.meta.url));
const SERVER = 'https://hornhoof.example.test';
const COMMIT = 'c'.repeat(40);
const DIGEST = `sha256:${'e'.repeat(64)}`;
const UPDATER = `ghcr.io/invariant0x/hornhoof-updater@${DIGEST}`;
/* A code may start with a dash, as base64url may. */
const CODE = '-Ab3_d-Ef'.repeat(4) + 'xyz';

/* The Windows installer GET /install.ps1 answers on a server of this commit, whose registry knows this digest of the updater. */
async function served(env: Record<string, string> = { PUBLIC_URL: SERVER }, commit = COMMIT) {
  const { app } = await testApp({ HORNHOOF_VERSION: '0.7.3', HORNHOOF_COMMIT: commit, ...env });
  vi.spyOn(app.ctx.updates, 'siblings').mockResolvedValue({ node: '', updater: DIGEST });
  return app.inject({ url: '/install.ps1' });
}

describe('GET /install.ps1', () => {
  it("serves the Windows installer with this server's address and the updater image of its build filled in", async () => {
    const res = await served();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain(`$server = '${SERVER}'`);
    expect(res.body).toContain(`$helper = '${UPDATER}'`);
    expect(res.body).not.toMatch(/__HORNHOOF_[A-Z_]+__/);
  });

  it("comes in the server's image next to install.sh", () => {
    expect(readFileSync(DOCKERFILE, 'utf8')).toMatch(/^COPY scripts\/install\.sh scripts\/install\.sh\nCOPY scripts\/install\.ps1 scripts\/install\.ps1$/m);
  });

  it('is plain ASCII, which Windows PowerShell reads the same in any language Windows runs in', async () => {
    expect((await served()).body).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
  });
});

/* Where pwsh is, if this computer has it: the script runs there with a stub in place of docker. */
const PWSH = spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).stdout.trim();

/* docker as install.ps1 meets it, writing each call and the settings it was handed as a line of JSON. STUB_DOCKER "stopped"
   answers info only once Docker Desktop started; STUB_OSTYPE is the kind of containers it runs; STUB_PULL "fail" downloads
   nothing and STUB_IMAGE_LOCAL "1" has the image here. run runs the shell command it gets, as the container would, with curl
   writing STUB_INSTALL_SH where it is told to, and ends as that ends. */
const DOCKER_STUB = `#!${process.execPath}
const { appendFileSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const env = {};
for (const name of ['HORNHOOF_SERVER', 'HORNHOOF_HOME', 'HORNHOOF_MACHINE', 'HORNHOOF_HOST_CPU', 'HORNHOOF_HOST_CPUS', 'HORNHOOF_HOST_MEMORY']) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, env }) + '\\n');
const s = process.env;
if (args[0] === 'info') {
  if ((s.STUB_DOCKER || 'ok') !== 'ok' && !existsSync(s.STUB_STATE + '/started')) { console.error('error during connect'); process.exit(1); }
  if (args.join(' ').includes('OSType')) console.log(s.STUB_OSTYPE || 'linux');
} else if (args[0] === 'pull') {
  if (s.STUB_PULL === 'fail') process.exit(1);
} else if (args[0] === 'image') {
  if (s.STUB_IMAGE_LOCAL !== '1') process.exit(1);
} else if (args[0] === 'run') {
  const c = args.indexOf('-c');
  const r = spawnSync('/bin/sh', args.slice(c), { stdio: 'inherit', env: { ...process.env, HORNHOOF_HOME: s.STUB_STATE + '/inside' } });
  process.exit(r.status);
}
`;

/* curl in the container: it writes the installer the test gave to the file it is told to. */
const CURL_STUB = `#!/bin/sh
[ -n "$STUB_INSTALL_SH" ] || { echo 'curl: (6) Could not resolve host' >&2; exit 6; }
echo "curl $*" >> "$STUB_STATE/curl.log"
while [ $# -gt 1 ]; do [ "$1" = -o ] && cp "$STUB_INSTALL_SH" "$2"; shift; done
`;

/* What install.sh does with what it gets: the words, the key where it looks for it, and an end. */
const INSTALL_SH = `printf 'install.sh %s\\n' "$*"
printf 'machine %s\\n' "$(cat "$HORNHOOF_HOME/machine")"
exit "\${STUB_INSTALL_EXIT:-0}"
`;

type Run = { args?: string[]; env?: Record<string, string>; docker?: boolean; app?: boolean; home?: string };

function windows(script: string, { args = ['--join', CODE], env = {}, docker = true, app = false, home }: Run = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-ps1-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const file = join(dir, 'install.ps1');
  writeFileSync(file, script);
  if (docker) writeFileSync(join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), CURL_STUB, { mode: 0o755 });
  writeFileSync(join(dir, 'install.sh'), INSTALL_SH);
  const programs = join(dir, 'programs');
  if (app) {
    const desktop = join(programs, 'Docker', 'Docker');
    mkdirSync(desktop, { recursive: true });
    writeFileSync(join(desktop, 'Docker Desktop.exe'), `#!/bin/sh\ntouch "${dir}/started"\n`);
    chmodSync(join(desktop, 'Docker Desktop.exe'), 0o755);
  }
  const log = join(dir, 'calls.jsonl');
  writeFileSync(log, '');
  /* As the command Hornhoof shows runs it, with the script read from the file in place of irm. */
  const command = `& ([scriptblock]::Create([IO.File]::ReadAllText('${file}'))) ${args.join(' ')}`;
  const res = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-c', command], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home ?? join(dir, 'home'),
      TMPDIR: dir,
      ProgramFiles: programs,
      STUB_LOG: log,
      STUB_STATE: dir,
      STUB_INSTALL_SH: join(dir, 'install.sh'),
      ...env,
    },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { args: string[]; env: Record<string, string> });
  return { code: res.status, out: res.stdout + res.stderr, calls, dir, run: calls.find(c => c.args[0] === 'run') };
}

describe.runIf(PWSH)('install.ps1 in PowerShell', () => {
  it("runs the server's install.sh in the updater image of its build with this computer's Docker, the words of the command and the computer's key", async () => {
    const script = (await served()).body;
    const home = mkdtempSync(join(tmpdir(), 'hh-ps1-home-'));
    const r = windows(script, { home });
    expect(r.code).toBe(0);
    expect(r.calls.map(c => c.args[0])).toEqual(['info', 'info', 'pull', 'run']);
    expect(r.calls[2]!.args).toEqual(['pull', UPDATER]);
    const run = r.run!.args;
    expect(run.slice(0, 3)).toEqual(['run', '--rm', '-i']);
    expect(run[run.indexOf('--hostname') + 1]).toMatch(/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/);
    expect(run[run.indexOf('-v') + 1]).toBe('//var/run/docker.sock:/var/run/docker.sock');
    expect(run.slice(run.indexOf('--entrypoint'), run.indexOf('-c'))).toEqual(['--entrypoint', 'sh', UPDATER]);
    expect(run.slice(run.indexOf('-c') + 2)).toEqual(['install', '--join', CODE]);
    /* Settings go through the environment by name only, so no value is on a command line. */
    expect(run.filter((_, i) => run[i - 1] === '-e').every(word => /^HORNHOOF_[A-Z_]+$/.test(word))).toBe(true);
    const key = readFileSync(join(home, '.hornhoof', 'machine'), 'utf8');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(r.run!.env).toMatchObject({ HORNHOOF_SERVER: SERVER, HORNHOOF_HOME: '/hornhoof', HORNHOOF_MACHINE: key });
    expect(r.run!.env.HORNHOOF_HOST_CPUS).toMatch(/^[1-9][0-9]*$/);
    expect(r.out).toContain(`install.sh --join ${CODE}`);
    expect(r.out).toContain(`machine ${key}`);
    expect(readFileSync(join(r.dir, 'curl.log'), 'utf8')).toContain(`${SERVER}/install.sh`);

    /* The update without a code goes as this computer, with the same key. */
    const again = windows(script, { args: [], home });
    expect(again.code).toBe(0);
    expect(again.run!.args.at(-1)).toBe('install');
    expect(again.run!.env.HORNHOOF_MACHINE).toBe(key);
    expect(again.out).toContain(`machine ${key}`);
  });

  it('takes the latest updater image for a server CI did not build', async () => {
    const r = windows((await served({ PUBLIC_URL: SERVER }, 'local')).body);
    expect(r.code).toBe(0);
    expect(r.run!.args).toContain('ghcr.io/invariant0x/hornhoof-updater:latest');
  });

  it('says how to get Docker Desktop when it is missing, and starts nothing', async () => {
    const r = windows((await served()).body, { docker: false });
    expect(r.code).toBe(1);
    expect(r.out).toContain('winget install -e --id Docker.DockerDesktop');
    expect(r.out).toContain('https://www.docker.com/products/docker-desktop/');
    expect(r.out).toContain('run this command again');
    expect(r.calls).toEqual([]);
  });

  it('starts Docker Desktop that does not run, waits for it and says so, then goes on', async () => {
    const r = windows((await served()).body, { app: true, env: { STUB_DOCKER: 'stopped' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Starting Docker Desktop.');
    expect(r.out).toContain('Waiting for Docker to start.');
    expect(r.run).toBeDefined();
  });

  it('asks for Linux containers when Docker Desktop runs Windows ones', async () => {
    const r = windows((await served()).body, { env: { STUB_OSTYPE: 'windows' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Switch to Linux containers');
    expect(r.calls.some(c => c.args[0] === 'pull' || c.args[0] === 'run')).toBe(false);
  });

  it('sends a Windows computer that runs the server itself to WSL, as Docker cannot reach localhost', async () => {
    const r = windows((await served({})).body);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Ubuntu terminal of WSL');
    expect(r.calls).toEqual([]);
  });

  it('uses the updater image on this computer when it cannot be downloaded, and stops when it is not here either', async () => {
    const script = (await served()).body;
    const local = windows(script, { env: { STUB_PULL: 'fail', STUB_IMAGE_LOCAL: '1' } });
    expect(local.code).toBe(0);
    expect(local.run).toBeDefined();
    const none = windows(script, { env: { STUB_PULL: 'fail' } });
    expect(none.code).toBe(1);
    expect(none.out).toContain(`Could not download ${UPDATER}. Check the internet connection, then run this command again.`);
    expect(none.run).toBeUndefined();
  });

  it("ends as install.sh ends, which said why itself, and says when the installer does not download", async () => {
    const script = (await served()).body;
    const failed = windows(script, { env: { STUB_INSTALL_EXIT: '1' } });
    expect(failed.code).toBe(1);
    expect(failed.out.trim().split('\n').at(-1)).toMatch(/^machine [0-9a-f]{32}$/);
    const offline = windows(script, { env: { STUB_INSTALL_SH: '' } });
    expect(offline.code).toBe(1);
    expect(offline.out).toContain(`Could not download the installer from ${SERVER}. Check the connection, then run this command again.`);
  });
});
