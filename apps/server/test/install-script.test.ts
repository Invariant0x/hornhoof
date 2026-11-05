import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));
const STUBS = fileURLToPath(new URL('./install-stubs/', import.meta.url));
const SERVER = 'https://hornhoof.example.test';
const IMAGE = 'ghcr.io/invariant0x/hornhoof-node:latest';
const CODE = 'Ab3_d-Ef'.repeat(5) + 'xyz';
const SUB_A = '1c07dac4-c52e-48b4-b316-81c19de61bd7';
const SUB_B = '9f1e2d3c-0000-4000-8000-000000000002';
const TWO_LINES = `${SUB_A} claude node-key-aaaaaaaaaaaaaaaa\\n${SUB_B} codex node-key-bbbbbbbbbbbbbbbb\\n`;

/* System tools the script and the stubs may use. Real docker, brew, curl and sudo are never reachable. */
const TOOLS = ['bash', 'sh', 'env', 'cat', 'od', 'tr', 'head', 'base64', 'sleep', 'mkdir', 'rm', 'chmod', 'grep', 'sed', 'cut', 'cp', 'mv', 'touch', 'basename', 'dirname', 'wc', 'mktemp', 'date', 'sort', 'kill', 'printf', 'tail', 'awk', 'sha256sum', 'shasum', 'tee'];
/* The installer runs Docker's and Homebrew's install scripts only when their SHA-256 is the one it pins. */
const sha256 = (stub: string) => createHash('sha256').update(readFileSync(join(STUBS, stub))).digest('hex');

type Options = { args?: string[]; omit?: string[]; env?: Record<string, string>; tty?: string };

function install({ args = ['--join', CODE], omit = [], env = {}, tty = 'typed-answer\n' }: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-install-'));
  const bin = join(dir, 'stubs');
  const sys = join(dir, 'sys');
  mkdirSync(bin);
  mkdirSync(sys);
  for (const f of readdirSync(STUBS)) if (!f.startsWith('_') && !omit.includes(f)) copyFileSync(join(STUBS, f), join(bin, f));
  for (const tool of TOOLS) {
    const real = ['/usr/bin', '/bin'].map(d => join(d, tool)).find(p => existsSync(p));
    if (real) symlinkSync(real, join(sys, tool));
  }
  const ttyFile = join(dir, 'tty');
  writeFileSync(ttyFile, tty);
  const log = join(dir, 'stub.log');
  writeFileSync(log, '');
  const res = spawnSync(join(sys, 'bash'), [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${bin}:${sys}`,
      HOME: join(dir, 'home'),
      STUB_LOG: log,
      STUB_SRC: STUBS,
      STUB_BIN: bin,
      STUB_STATE: dir,
      HORNHOOF_SERVER: SERVER,
      HORNHOOF_TTY: ttyFile,
      HORNHOOF_HOME: join(dir, 'home', '.hornhoof'),
      HORNHOOF_DIR: join(dir, 'home', 'hornhoof'),
      STUB_JOIN_BODY: TWO_LINES,
      HORNHOOF_SIGNIN_WAIT: '0',
      HORNHOOF_DOCKER_SCRIPT_SHA256: sha256('_docker-install.sh'),
      HORNHOOF_BREW_SCRIPT_SHA256: sha256('_brew-install.sh'),
      ...env,
    },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { code: res.status, out: res.stdout + res.stderr, calls, dir, docker: calls.filter(c => /^(sudo )?docker /.test(c)) };
}

const indexOf = (calls: string[], start: string) => calls.findIndex(c => c.startsWith(start));

/* The installer as an updater runs it: in a server folder that has a .env, with the compose file the build brought. */
function fromUpdater(env: Record<string, string> = {}, dotEnv = 'HORNHOOF_SECRET=s\nNODE_KEY=k\nPUBLIC_URL=http://localhost:8080\nHORNHOOF_VERSION=0.4.0\n') {
  const folder = mkdtempSync(join(tmpdir(), 'hh-server-'));
  writeFileSync(join(folder, '.env'), dotEnv);
  const compose = join(folder, 'brought.yaml');
  writeFileSync(compose, 'services: {app: {}}\n');
  const r = install({ args: ['server'], tty: '', env: { HORNHOOF_FROM_UPDATER: '1', HORNHOOF_SERVER_DIR: folder, HORNHOOF_VERSION: '0.4.1', HORNHOOF_COMPOSE_FILE: compose, ...env } });
  return { ...r, folder, dotEnv: () => readFileSync(join(folder, '.env'), 'utf8') };
}
/* One key's lines of a .env, so a failed check never prints the secrets beside them. */
const linesOf = (dotEnv: string, key: string) => dotEnv.split('\n').filter(line => line.startsWith(`${key}=`));
const COMPOSE_STEP = /^docker compose (stop|up|pull)/;
const UPDATER_REF = `ghcr.io/invariant0x/hornhoof-updater@sha256:${'f'.repeat(64)}`;

/* Installs on one computer: one home, one list of ports, as several companies share them. */
function computer() {
  const base = mkdtempSync(join(tmpdir(), 'hh-computer-'));
  const home = join(base, 'home');
  const portsDir = join(base, 'ports');
  mkdirSync(home);
  mkdirSync(portsDir);
  const folder = (name = 'hornhoof') => join(home, name);
  return {
    folder,
    run: (args: string[] = [], env: Record<string, string> = {}) => install({ args: ['server', ...args], tty: '\n', env: { HOME: home, HORNHOOF_DIR: folder(), STUB_PORTS_DIR: portsDir, ...env } }),
    company: (dotEnv: string, name = 'hornhoof') => {
      mkdirSync(folder(name));
      writeFileSync(join(folder(name), '.env'), dotEnv);
    },
    dotEnv: (name = 'hornhoof') => readFileSync(join(folder(name), '.env'), 'utf8'),
    list: () => readFileSync(join(portsDir, 'registry'), 'utf8').trim().split('\n'),
    setList: (lines: string[]) => writeFileSync(join(portsDir, 'registry'), `${lines.join('\n')}\n`),
    holdLock: (id: string) => writeFileSync(join(portsDir, 'lock'), `${id}\n`),
    freeLock: () => rmSync(join(portsDir, 'lock')),
  };
}
/* The web and peer port lines of a .env. */
const portsIn = (dotEnv: string) => [...linesOf(dotEnv, 'HORNHOOF_PORT'), ...linesOf(dotEnv, 'HORNHOOF_PEER_PORT')];
const LOCK_BUSY = 'Another Hornhoof install on this computer is choosing its ports. Wait a minute, then run this command again.';
const REGISTRY_WRITE = 'cat > /ports/registry.new';
const portRange = (first: number, count: number) => Array.from({ length: count }, (_, i) => first + i).join(' ');

describe('install.sh', () => {
  it('records an update intent and stops an old node gracefully before replacing it', () => {
    const name = 'hornhoof-claude-1c07dac4';
    const r = install({ args: [], env: { STUB_CONTAINERS: `${name}=${SERVER}` } });
    expect(r.code).toBe(0);
    const steps = [
      `docker exec ${name} node /app/apps/node/dist/main.js prepare-stop node_update`,
      `docker stop --time 5 ${name}`,
      `docker rm -f ${name}`,
      'docker run -d',
    ].map(prefix => indexOf(r.calls, prefix));
    expect(steps.every(index => index >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it('still replaces a legacy node which cannot record the new stop intent', () => {
    const name = 'hornhoof-claude-1c07dac4';
    const r = install({ args: [], env: { STUB_CONTAINERS: `${name}=${SERVER}`, STUB_STOP_INTENT: 'unsupported' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker stop --time 5 ${name}`);
    expect(r.calls.some(call => call.startsWith('docker run -d'))).toBe(true);
  });

  it('passes bash -n', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
  });

  it('stops on Windows with the Linux and macOS line and never touches Docker', () => {
    const r = install({ env: { STUB_OS: 'MINGW64_NT-10.0' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Hornhoof nodes run on Linux and macOS only.');
    expect(r.docker).toEqual([]);
  });

  it('checks the server before any Docker step and explains PUBLIC_URL', () => {
    const r = install({ env: { STUB_HEALTH: 'fail' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SERVER}/api/health`);
    expect(r.out).toContain('PUBLIC_URL');
    expect(r.docker).toEqual([]);
  });

  it('installs Homebrew, Colima and Docker on a Mac that has none, in that order', () => {
    const r = install({ omit: ['docker', 'brew'], env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_DOCKER: 'after_start' } });
    expect(r.code).toBe(0);
    const steps = ['homebrew-install', 'brew install colima docker', 'brew services start colima'].map(s => indexOf(r.calls, s));
    expect(steps.every(i => i >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(r.out).toContain('password');
  });

  it("gives a new Colima all of the Mac's processors and three quarters of its memory before it starts at login", () => {
    const r = install({ omit: ['docker', 'brew'], env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_DOCKER: 'after_start', STUB_NCPU: '10', STUB_MEMSIZE: String(16 * 1024 ** 3) } });
    expect(r.code).toBe(0);
    const steps = ['colima start --cpu 10 --memory 12', 'colima stop', 'brew services start colima'].map(s => indexOf(r.calls, s));
    expect(steps.every(i => i >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(r.out).toContain('10 processors and 12 GB of memory');
  });

  it("tells each node on a Mac the Mac's processor, cores and memory, as Docker there runs in a smaller system", () => {
    const r = install({ env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_NCPU: '10', STUB_MEMSIZE: String(32 * 1024 ** 3), STUB_CPU_BRAND: 'Apple M2 Pro' } });
    expect(r.code).toBe(0);
    const runs = r.calls.filter(c => c.startsWith('docker run -d'));
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run).toContain(`-e HORNHOOF_HOST_CPU=Apple M2 Pro -e HORNHOOF_HOST_CPUS=10 -e HORNHOOF_HOST_MEMORY=${32 * 1024 ** 3}`);
  });

  it('tells a node on Linux nothing of the machine, which it sees itself', () => {
    const r = install();
    expect(r.code).toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker run -d')).some(c => c.includes('HORNHOOF_HOST'))).toBe(false);
  });

  it('leaves the processors and memory of a Colima set up before as they are', () => {
    const r = install({ omit: ['docker', 'brew'], env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_DOCKER: 'after_start', STUB_COLIMA_LIST: '{"name":"work","status":"Stopped","cpus":4}' } });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.startsWith('colima start'))).toBe(false);
    expect(indexOf(r.calls, 'brew services start colima')).toBeGreaterThanOrEqual(0);
  });

  it('starts Docker Desktop on a Mac where it is installed but not running, and says how to have it start at login', () => {
    const r = install({ env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_DOCKER: 'after_start', STUB_APPS: 'Docker OrbStack' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('open -g -a Docker');
    expect(r.calls.some(c => c.startsWith('open -g -a OrbStack') || c.startsWith('brew install'))).toBe(false);
    expect(r.out).toContain('Starting Docker Desktop.');
    expect(r.out).toContain('Start Docker Desktop when you sign in to your computer');
  });

  it('starts OrbStack when the Docker command line belongs to it', () => {
    const r = install({ env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_DOCKER: 'after_start', STUB_APPS: 'Docker OrbStack', STUB_CONTEXT: 'orbstack' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('open -g -a OrbStack');
    expect(r.calls).not.toContain('open -g -a Docker');
    expect(r.out).not.toContain('when you sign in');
  });

  it('asks to start Docker by hand on a Mac where its command line has no app to start', () => {
    const r = install({ env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_DOCKER: 'after_start' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Docker is installed but not running. Start Docker Desktop or OrbStack, then run this command again.');
  });

  it('uses a working Docker on Linux as it is, without sudo', () => {
    const r = install();
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.startsWith('sudo') || c.includes('get-docker') || c.startsWith('systemctl'))).toBe(false);
  });

  it('goes through sudo for every later Docker call when only sudo docker works', () => {
    const r = install({ env: { STUB_DOCKER: 'sudo_only' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('sudo');
    /* A call through sudo logs twice, "sudo docker ..." and "docker ...", so only the first probe runs without it. */
    const count = (prefix: string) => r.calls.filter(c => c.startsWith(prefix)).length;
    expect(count('docker ')).toBe(count('sudo docker ') + 1);
    expect(r.calls).toContain(`sudo docker pull ${IMAGE}`);
    expect(r.calls.some(c => c.startsWith('sudo docker run -d'))).toBe(true);
  });

  it('installs Docker Engine on Linux when it is missing', () => {
    const r = install({ omit: ['docker'], env: { STUB_DOCKER: 'after_start' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('get-docker');
    expect(r.calls).toContain('sudo systemctl enable --now docker');
  });

  it("runs Docker's install script from a pinned commit, and not at all when it is not the one pinned", () => {
    const ok = install({ omit: ['docker'], env: { STUB_DOCKER: 'after_start' } });
    expect(ok.code).toBe(0);
    expect(ok.calls.find(c => c.includes('docker-install'))).toMatch(/^curl .*https:\/\/raw\.githubusercontent\.com\/docker\/docker-install\/[0-9a-f]{40}\/install\.sh/);
    const changed = install({ omit: ['docker'], env: { STUB_DOCKER: 'after_start', HORNHOOF_DOCKER_SCRIPT_SHA256: '0'.repeat(64) } });
    expect(changed.code).toBe(1);
    expect(changed.calls).not.toContain('get-docker');
    expect(changed.out).toContain("Docker's install script did not download, or it is not the one Hornhoof checked, so it did not run.");
  });

  it("runs Homebrew's install script from a pinned commit, and not at all when it is not the one pinned", () => {
    const mac = { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_DOCKER: 'after_start' };
    const ok = install({ omit: ['docker', 'brew'], env: mac });
    expect(ok.code).toBe(0);
    expect(ok.calls.find(c => c.includes('Homebrew/install'))).toMatch(/^curl .*https:\/\/raw\.githubusercontent\.com\/Homebrew\/install\/[0-9a-f]{40}\/install\.sh/);
    const changed = install({ omit: ['docker', 'brew'], env: { ...mac, HORNHOOF_BREW_SCRIPT_SHA256: '0'.repeat(64) } });
    expect(changed.code).toBe(1);
    expect(changed.calls).not.toContain('homebrew-install');
    expect(changed.out).toContain("Homebrew's install script did not download, or it is not the one Hornhoof checked, so it did not run.");
  });

  it('runs everything directly as root, without sudo', () => {
    const r = install({ omit: ['docker'], env: { STUB_DOCKER: 'after_start', STUB_UID: '0' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('systemctl enable --now docker');
    expect(r.calls.some(c => c.startsWith('sudo '))).toBe(false);
  });

  it('starts one locked-down container per subscription and signs each in from the terminal', () => {
    const r = install({ tty: 'typed-answer\n', env: { STUB_STATUS: 'after_login' } });
    expect(r.code).toBe(0);
    expect(r.calls.find(c => c.startsWith('curl') && c.includes('/api/nodes/join'))).toContain('accept: text/plain');
    /* The code travels in a file, not on the command line where other users could see it. */
    const request = r.calls.find(c => c.startsWith('curl-data'))!;
    expect(r.calls.find(c => c.startsWith('curl ') && c.includes(CODE))).toBeUndefined();
    expect(request).toMatch(/"machineId":"[0-9a-f]{32}"/);
    expect(request).toContain(`"code":"${CODE}"`);
    expect(request).toContain('"os":"linux"');
    expect(request).toContain('"arch":"x86_64"');
    expect(request).toContain('"hostname":"test-box"');

    const runs = r.calls.filter(c => c.startsWith('docker run -d'));
    expect(runs).toHaveLength(2);
    for (const [name, id] of [['hornhoof-claude-1c07dac4', SUB_A], ['hornhoof-codex-9f1e2d3c', SUB_B]]) {
      const run = runs.find(c => c.includes(`--name ${name} `))!;
      expect(run).toContain(`--label hornhoof.subscription=${id}`);
      expect(run).toContain('--restart unless-stopped');
      expect(run).toContain('--cap-drop ALL');
      /* Root inside the container only, to run the agents as a user of their own and check which of them calls. */
      expect(run).toContain('--user 0:0');
      for (const cap of ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SETGID', 'SETUID', 'SYS_PTRACE']) expect(run).toContain(`--cap-add ${cap}`);
      expect(run).toContain('--security-opt no-new-privileges');
      /* Docker's AppArmor profile on newer Linux, as Debian 13, keeps the node from seeing and stopping its agents' programs. */
      expect(run).toContain('--security-opt apparmor=unconfined');
      expect(run).toContain('--shm-size 2g');
      expect(run).toContain(`-v ${name}:/data`);
      expect(run.endsWith(IMAGE)).toBe(true);
      expect(run).not.toContain('node-key-');
    }
    expect(r.calls).toContain(`stdin ${SERVER} ${SUB_A} claude node-key-aaaaaaaaaaaaaaaa`);
    /* The key goes into a file only root reads, through a container that may write the node's folder and nothing more. */
    const keys = r.calls.filter(c => c.startsWith('docker run --rm -i') && c.endsWith('set-key'));
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(/--network none --user 0:0 --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges /);
    expect(r.calls.filter(c => c.startsWith('tty '))).toEqual(['tty typed-answer', 'tty typed-answer']);
    expect(r.out).toContain('You can also sign in once in Hornhoof under Subscriptions, for all your machines.');
    expect(r.calls.filter(c => c.startsWith('docker exec -it') && c.endsWith('login'))).toHaveLength(2);
    expect(r.out).toMatch(/Claude.*ready/);
    expect(r.out).toMatch(/Codex.*ready/);
    expect(existsSync(join(r.dir, 'home', '.hornhoof', 'machine'))).toBe(true);
  });

  it("skips the terminal sign-in on a joined node that got its plan's sign-in from Hornhoof", () => {
    /* The owner signed the plan in once in Hornhoof: it reaches a new node of the plan within seconds. */
    const r = install({ env: { HORNHOOF_SIGNIN_WAIT: '20' } });
    expect(r.code).toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker exec -it'))).toEqual([]);
    expect(r.calls.filter(c => c.startsWith('tty '))).toEqual([]);
    expect(r.out).toContain('Claude on hornhoof-claude-1c07dac4 got its sign-in from Hornhoof.');
    expect(r.out).toMatch(/Claude: ready/);
    expect(r.out).toMatch(/Codex: ready/);
  });

  it('signs in nothing on a spare machine of a Codex plan, on the join and on an update', () => {
    const r = install({ env: { STUB_JOIN_BODY: `${SUB_B} codex node-key-bbbbbbbbbbbbbbbb\\n`, STUB_STATUS: 'spare', HORNHOOF_SIGNIN_WAIT: '20' } });
    expect(r.code).toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker exec -it'))).toEqual([]);
    expect(r.out).toContain('Codex on hornhoof-codex-9f1e2d3c is a spare machine: Codex runs on another machine of this plan and moves here when that one is away.');
    expect(r.out).toMatch(/Codex: spare, Codex runs on another machine of this plan now/);
    const update = install({ args: [], env: { STUB_CONTAINERS: `hornhoof-codex-9f1e2d3c=${SERVER}`, STUB_STATUS: 'spare' } });
    expect(update.calls.filter(c => c.startsWith('docker exec -it'))).toEqual([]);
  });

  it('waits a little for the sign-in from Hornhoof, then signs in here when it does not come', () => {
    const r = install({ env: { STUB_STATUS: 'after_login', HORNHOOF_SIGNIN_WAIT: '2' } });
    expect(r.code).toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker exec -it') && c.endsWith('login'))).toHaveLength(2);
    expect(r.out).not.toContain('got its sign-in from Hornhoof');
    expect(r.out).toMatch(/Claude: ready/);
  });

  it('says how else to sign in when a node is left without its sign-in', () => {
    const r = install({ env: { STUB_STATUS: 'needs_login', STUB_LOGIN_EXIT: '1' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('The sign-in on hornhoof-claude-1c07dac4 did not finish. Sign in once in Hornhoof under Subscriptions, or run the install command again without --join.');
    expect(r.out).toMatch(/Claude: needs sign-in, sign in once in Hornhoof under Subscriptions/);
  });

  it('sets up a node for a Google AI plan and signs in to Antigravity on it', () => {
    const r = install({ env: { STUB_JOIN_BODY: `${SUB_A} antigravity node-key-aaaaaaaaaaaaaaaa\\n` } });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.startsWith(`docker run -d --name hornhoof-antigravity-${SUB_A.slice(0, 8)}`))).toBe(true);
    expect(r.calls).toContain(`stdin ${SERVER} ${SUB_A} antigravity node-key-aaaaaaaaaaaaaaaa`);
    expect(r.out).toContain('Signing in to Antigravity on');
    expect(r.out).toMatch(/Antigravity.*ready/);
  });

  it('connects a machine without a plan: one node that needs no sign-in and lends itself to test runs', () => {
    const r = install({ env: { STUB_JOIN_BODY: `${SUB_A} machine node-key-mmmmmmmmmmmmmmmm\\n` } });
    expect(r.code).toBe(0);
    const runs = r.calls.filter(c => c.startsWith('docker run -d'));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain(`--name hornhoof-machine-${SUB_A.slice(0, 8)} `);
    expect(runs[0]).toContain(`--label hornhoof.subscription=${SUB_A}`);
    expect(r.calls).toContain(`stdin ${SERVER} ${SUB_A} machine node-key-mmmmmmmmmmmmmmmm`);
    expect(r.calls.filter(c => c.startsWith('docker exec -it'))).toEqual([]);
    expect(r.out).not.toContain('Signing in');
    expect(r.out).toMatch(/Test runs, no plan: ready/);
    expect(r.out).toContain('To run agents here too, add one of your plans to this machine in Hornhoof under Subscriptions.');
  });

  it('says to run a command made for another machine there, and starts nothing', () => {
    const r = install({ env: { STUB_JOIN_STATUS: '409', STUB_JOIN_BODY: '{"error":{"code":"conflict","reason":"other_machine"}}' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('This command is for another of your machines. Run it on the machine you got it for: Hornhoof shows which one under Machines.');
    expect(r.calls.some(c => c.startsWith('docker run -d'))).toBe(false);
  });

  it('says a machine that runs what the command brings already keeps it, and how to update it instead', () => {
    const r = install({ env: { STUB_JOIN_STATUS: '409', STUB_JOIN_BODY: '{"error":{"code":"conflict","reason":"already_on_machine"}}' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('This machine already runs what this command connects, and keeps it as it is.');
    expect(r.out).toContain(`curl -fsSL ${SERVER}/install.sh | bash`);
    expect(r.out).not.toContain('another of your machines');
    expect(r.calls.some(c => c.startsWith('docker run -d'))).toBe(false);
  });

  it('keeps the same machine id on the next run', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'hh-machine-')), '.hornhoof');
    const machineOf = (r: ReturnType<typeof install>) => r.calls.find(c => c.startsWith('curl-data'))!.match(/"machineId":"([0-9a-f]{32})"/)![1];
    const first = machineOf(install({ env: { HORNHOOF_HOME: home } }));
    expect(readFileSync(join(home, 'machine'), 'utf8').trim()).toBe(first);
    expect(machineOf(install({ env: { HORNHOOF_HOME: home } }))).toBe(first);
  });

  it('opens the sign-in link in the browser', () => {
    const r = install({ env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_STATUS: 'after_login', STUB_LOGIN_URL: 'https://claude.ai/oauth/authorize?code=1', STUB_LOGIN_SLEEP: '1.5' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('open https://claude.ai/oauth/authorize?code=1');
  });

  it('stops with a plain line when the command was already used', () => {
    const r = install({ env: { STUB_JOIN_STATUS: '410', STUB_JOIN_BODY: '{"error":"gone"}' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('This command was already used or is older than 24 hours. Get a new one in Hornhoof under Subscriptions.');
    expect(r.calls.some(c => c.startsWith('docker run -d'))).toBe(false);
  });

  it('stops with a plain line when the command is not valid', () => {
    const r = install({ env: { STUB_JOIN_STATUS: '404', STUB_JOIN_BODY: '{"error":"not_found"}' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('This command is not valid. Copy it again from Hornhoof.');
  });

  it('replaces existing containers and keeps their volumes', () => {
    const r = install({ env: { STUB_CONTAINERS: 'hornhoof-claude-1c07dac4 hornhoof-codex-9f1e2d3c' } });
    expect(r.code).toBe(0);
    const rm = indexOf(r.calls, 'docker rm -f hornhoof-claude-1c07dac4');
    const run = indexOf(r.calls, 'docker run -d --name hornhoof-claude-1c07dac4');
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(rm);
    expect(r.calls.some(c => c.startsWith('docker volume rm'))).toBe(false);
  });

  it('leaves the other nodes on this machine alone on --join', () => {
    const r = install({ env: { STUB_CONTAINERS: 'hornhoof-kimi-00000000' } });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.includes('hornhoof-kimi-00000000') && /docker (rm|run)/.test(c))).toBe(false);
    expect(r.calls.some(c => c.startsWith(`docker run -d --name hornhoof-claude-${SUB_A.slice(0, 8)}`))).toBe(true);
  });

  it('names the way out when a node does not start after the join used the code', () => {
    const r = install({ env: { STUB_RUN: 'fail' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('This command is used up: disconnect this machine in Hornhoof under Subscriptions, then get a new command.');
  });

  it('opens only https sign-in links', () => {
    for (const link of ['file:///etc/passwd', '-a Terminal']) {
      const r = install({ env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_STATUS: 'after_login', STUB_LOGIN_URL: link, STUB_LOGIN_SLEEP: '1.5' } });
      expect(r.code).toBe(0);
      expect(r.calls.filter(c => c.startsWith('open '))).toEqual([]);
    }
  });

  it('removes the nodes Hornhoof removed, with their volumes', () => {
    const r = install({ env: { STUB_CONTAINERS: `hornhoof-kimi-00000000=${SERVER}`, STUB_REMOVED: 'hornhoof-kimi-00000000' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('docker rm -f hornhoof-kimi-00000000');
    expect(r.calls).toContain('docker volume rm hornhoof-kimi-00000000');
  });

  it('points nodes at host.docker.internal when the server is on localhost', () => {
    const r = install({ env: { HORNHOOF_SERVER: 'http://localhost:8080' } });
    expect(r.code).toBe(0);
    const run = r.calls.find(c => c.startsWith('docker run -d'))!;
    expect(run).toContain('--add-host host.docker.internal:host-gateway');
    expect(r.calls).toContain(`stdin http://host.docker.internal:8080 ${SUB_A} claude node-key-aaaaaaaaaaaaaaaa`);
  });

  it('continues with the local image when the pull fails', () => {
    const r = install({ env: { STUB_PULL: 'fail', STUB_IMAGE_LOCAL: '1' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Using the local image.');
  });

  it('stops when the pull fails and there is no local image', () => {
    const r = install({ env: { STUB_PULL: 'fail' } });
    expect(r.code).toBe(1);
    expect(r.calls.some(c => c.startsWith('docker run -d'))).toBe(false);
  });

  it('updates the nodes on this machine when run without a code', () => {
    const r = install({ args: [], env: { STUB_CONTAINERS: `hornhoof-claude-1c07dac4=${SERVER}`, STUB_STATUS: 'needs_login' } });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.includes('/api/nodes/join'))).toBe(false);
    expect(r.calls).toContain('docker rm -f hornhoof-claude-1c07dac4');
    expect(r.calls.some(c => c.startsWith('docker run -d --name hornhoof-claude-1c07dac4'))).toBe(true);
    expect(r.calls.some(c => c.startsWith('docker exec -it hornhoof-claude-1c07dac4'))).toBe(true);
  });

  /* People get the company's link at setup, so the installer asks nothing about addresses: it takes this computer's own. */
  it('sets up the server with fresh secrets and its address on this computer, without a question', () => {
    const r = install({ args: ['server'], tty: 'https://hornhoof.my.test\n' });
    expect(r.code).toBe(0);
    const env = readFileSync(join(r.dir, 'home', 'hornhoof', '.env'), 'utf8');
    expect(env).toMatch(/^HORNHOOF_SECRET=[A-Za-z0-9+/=]{44}$/m);
    expect(env).toMatch(/^NODE_KEY=[A-Za-z0-9+/=]{44}$/m);
    expect(env).toContain('PUBLIC_URL=http://localhost:8080');
    expect(r.out).not.toContain('Address');
    /* It goes into the database address, so it keeps to characters an address takes as they are. */
    expect(env).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]{48}$/m);
    /* compose starts the images .env names; set up by hand, they are the build's tag. */
    expect(env).toMatch(/^HORNHOOF_APP_REF=ghcr\.io\/invariant0x\/hornhoof:latest$/m);
    expect(env).toMatch(/^HORNHOOF_NODE_REF=ghcr\.io\/invariant0x\/hornhoof-node:latest$/m);
    expect(env).toMatch(/^HORNHOOF_UPDATER_REF=ghcr\.io\/invariant0x\/hornhoof-updater:latest$/m);
    expect(existsSync(join(r.dir, 'home', 'hornhoof', 'compose.yaml'))).toBe(true);
    expect(r.calls).toContain('docker compose pull');
    expect(r.calls).toContain('docker compose up -d --no-build');
    expect(r.out).toContain('http://localhost:8080');
  });

  it("tells the built-in node of a server on a Mac the Mac's processor, cores and memory, through .env", () => {
    const r = install({ args: ['server'], tty: '\n', env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_NCPU: '10', STUB_MEMSIZE: String(32 * 1024 ** 3), STUB_CPU_BRAND: 'Apple M5' } });
    expect(r.code).toBe(0);
    const env = readFileSync(join(r.dir, 'home', 'hornhoof', '.env'), 'utf8');
    expect(env).toMatch(/^HORNHOOF_HOST_CPU=Apple M5$/m);
    expect(env).toMatch(/^HORNHOOF_HOST_CPUS=10$/m);
    expect(env).toMatch(new RegExp(`^HORNHOOF_HOST_MEMORY=${32 * 1024 ** 3}$`, 'm'));
  });

  it("tells the server which machine it runs on by a hash of the machine's key, which a later join on it sends", () => {
    const r = install({ args: ['server'], tty: '\n' });
    expect(r.code).toBe(0);
    const env = readFileSync(join(r.dir, 'home', 'hornhoof', '.env'), 'utf8');
    const key = readFileSync(join(r.dir, 'home', '.hornhoof', 'machine'), 'utf8').trim();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(env).toMatch(new RegExp(`^HORNHOOF_HOST_ID=${createHash('sha256').update(`hornhoof-host:${key}`).digest('hex')}$`, 'm'));
    expect(env).not.toContain(key);
  });

  it('tells the built-in node of a server on Linux nothing of the machine, which it sees itself', () => {
    const r = install({ args: ['server'], tty: '\n' });
    expect(r.code).toBe(0);
    expect(readFileSync(join(r.dir, 'home', 'hornhoof', '.env'), 'utf8')).not.toMatch(/^HORNHOOF_HOST_(CPU|CPUS|MEMORY)=/m);
  });

  it('keeps an existing .env and adds a missing NODE_KEY', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    writeFileSync(join(dir, '.env'), 'HORNHOOF_SECRET=keep-me\nPUBLIC_URL=http://localhost:8080\n');
    const r = install({ args: ['server'], env: { HORNHOOF_DIR: dir } });
    expect(r.code).toBe(0);
    const env = readFileSync(join(dir, '.env'), 'utf8');
    expect(env).toContain('HORNHOOF_SECRET=keep-me');
    expect(env).toMatch(/^NODE_KEY=.{44}$/m);
    /* Its database was made with the password compose gives when .env names none; the database, the app, the keeper and migrate each read it. */
    expect(env).not.toContain('POSTGRES_PASSWORD');
    const compose = readFileSync(fileURLToPath(new URL('../../../compose.yaml', import.meta.url)), 'utf8');
    expect(compose.match(/\$\{POSTGRES_PASSWORD:-hornhoof\}/g)).toHaveLength(4);
  });

  it('replaces an existing .env whole and leaves it readable by its owner only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'HORNHOOF_SECRET=keep-me\nPUBLIC_URL=http://localhost:8080\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    const before = statSync(file).ino;
    const r = install({ args: ['server'], env: { HORNHOOF_DIR: dir } });
    expect(r.code).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    /* A new file moved into place, so a failed write never leaves half a .env behind. */
    expect(statSync(file).ino).not.toBe(before);
    expect(readFileSync(file, 'utf8')).toContain('HORNHOOF_SECRET=keep-me');
    expect(readdirSync(dir).filter(f => f.startsWith('.env'))).toEqual(['.env']);
  });

  it('keeps an existing .env that has no PUBLIC_URL and opens localhost', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    writeFileSync(join(dir, '.env'), 'HORNHOOF_SECRET=keep-me\n');
    const r = install({ args: ['server'], env: { HORNHOOF_DIR: dir } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Hornhoof is running at http://localhost:8080.');
  });

  /* Whoever opens a new server first would become its owner, so only the link with its setup code sets it up. */
  it('shows the setup link the new server gives, once it answers', () => {
    const link = 'https://hornhoof.my.test/setup?code=Ab3_d-Ef0123456789abcdef';
    const r = install({ args: ['server', '--name', 'acme'], env: { STUB_SETUP_LINK: link } });
    expect(r.code).toBe(0);
    const ask = indexOf(r.calls, 'docker compose -p hornhoof-acme exec -T app node apps/server/dist/cli.js setup-link');
    expect(ask).toBeGreaterThan(r.calls.findIndex(c => c.startsWith('curl') && c.includes('/api/health')));
    expect(r.out).toContain(`Hornhoof is running. Open this link to set it up: ${link}`);
    for (const other of ['Usage: node apps/server/dist/cli.js owner-link', 'https://evil.test/ x/setup?code=1']) {
      const odd = install({ args: ['server'], tty: '\n', env: { STUB_SETUP_LINK: other } });
      expect(odd.out).not.toContain('Open this link');
      expect(odd.out).toContain('Hornhoof is running at http://localhost:8080.');
    }
  });

  it('removes the labelled containers on --uninstall after a y', () => {
    const r = install({ args: ['--uninstall'], tty: 'y\n', env: { STUB_CONTAINERS: `hornhoof-claude-1c07dac4=${SERVER} hornhoof-codex-9f1e2d3c=${SERVER}` } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('docker rm -f hornhoof-claude-1c07dac4');
    expect(r.calls).toContain('docker rm -f hornhoof-codex-9f1e2d3c');
    expect(r.calls).toContain('docker volume rm hornhoof-claude-1c07dac4');
  });

  it('labels each node with the server it works for', () => {
    const r = install();
    expect(r.code).toBe(0);
    for (const run of r.calls.filter(c => c.startsWith('docker run -d'))) expect(run).toContain(`--label hornhoof.server=${SERVER}`);
  });

  it('removes only this server\'s nodes on --uninstall when another company has nodes here too', () => {
    const r = install({ args: ['--uninstall'], tty: 'y\nn\n', env: { STUB_CONTAINERS: `hornhoof-claude-1c07dac4=${SERVER} hornhoof-codex-9f1e2d3c=https://other.example.test` } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('docker rm -f hornhoof-claude-1c07dac4');
    expect(r.calls.some(c => c.includes('hornhoof-codex-9f1e2d3c') && c.startsWith('docker rm'))).toBe(false);
    expect(r.out).not.toContain('hornhoof-codex-9f1e2d3c');
  });

  it('leaves a node alone on --uninstall when it cannot tell which server the node works for, and says so', () => {
    const r = install({ args: ['--uninstall'], tty: 'y\ny\n', env: { STUB_CONTAINERS: `hornhoof-claude-1c07dac4=${SERVER} hornhoof-kimi-00000000` } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('docker rm -f hornhoof-claude-1c07dac4');
    expect(r.calls).toContain('docker volume rm hornhoof-claude-1c07dac4');
    expect(r.calls.some(c => c.includes('hornhoof-kimi-00000000') && /docker (rm|volume rm|run)/.test(c))).toBe(false);
    expect(r.out).toContain('Leaving hornhoof-kimi-00000000 as it is: it does not say which Hornhoof it works for.');
  });

  it('updates only this server\'s nodes, and the ones from before servers were named', () => {
    const r = install({
      args: [],
      env: {
        STUB_CONTAINERS: `hornhoof-claude-1c07dac4=${SERVER} hornhoof-codex-9f1e2d3c=https://other.example.test hornhoof-kimi-00000000`,
        STUB_NODE_SERVERS: `hornhoof-kimi-00000000=${SERVER}`,
      },
    });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.startsWith('docker run -d --name hornhoof-claude-1c07dac4'))).toBe(true);
    expect(r.calls.some(c => c.startsWith('docker run -d --name hornhoof-kimi-00000000') && c.includes(`--label hornhoof.server=${SERVER}`))).toBe(true);
    expect(r.calls.some(c => c.includes('hornhoof-codex-9f1e2d3c') && /docker (rm|run)/.test(c))).toBe(false);
  });

  it('leaves a node from before servers were named alone when its own settings name another server', () => {
    const env = {
      STUB_CONTAINERS: 'hornhoof-kimi-00000000 hornhoof-codex-11111111',
      STUB_NODE_SERVERS: `hornhoof-kimi-00000000=http://host.docker.internal:8080 hornhoof-codex-11111111=${SERVER}`,
    };
    const r = install({ args: [], env });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.includes('hornhoof-kimi-00000000') && /docker (rm|run)/.test(c))).toBe(false);
    expect(r.calls.some(c => c.startsWith('docker run -d --name hornhoof-codex-11111111') && c.includes(`--label hornhoof.server=${SERVER}`))).toBe(true);
  });

  it('installs a named server in its own folder, compose project and free port', () => {
    const r = install({ args: ['server', '--name', 'acme'], tty: '\n', env: { STUB_PORTS_TAKEN: '8080' } });
    expect(r.code).toBe(0);
    const env = readFileSync(join(r.dir, 'home', 'hornhoof-acme', '.env'), 'utf8');
    expect(env).toContain('HORNHOOF_PORT=8081');
    expect(env).toContain('PUBLIC_URL=http://localhost:8081');
    expect(existsSync(join(r.dir, 'home', 'hornhoof', '.env'))).toBe(false);
    expect(r.calls).toContain('docker compose -p hornhoof-acme pull');
    expect(r.calls).toContain('docker compose -p hornhoof-acme up -d --no-build');
    expect(r.out).toContain('Hornhoof is running at http://localhost:8081.');
  });

  it('keeps the folder and port of a named server on the next run', () => {
    const first = install({ args: ['server', '--name', 'acme'], tty: '\n', env: { STUB_PORTS_TAKEN: '8080' } });
    const home = join(first.dir, 'home');
    const again = install({ args: ['server', '--name', 'acme'], env: { HOME: home, HORNHOOF_DIR: join(home, 'hornhoof'), STUB_PORTS_TAKEN: '8080 8081' } });
    expect(again.code).toBe(0);
    expect(again.out).toContain('Keeping the settings');
    expect(readFileSync(join(home, 'hornhoof-acme', '.env'), 'utf8')).toContain('HORNHOOF_PORT=8081');
    expect(again.out).toContain('Hornhoof is running at http://localhost:8081.');
  });

  it('leaves the port of another Hornhoof on this computer to it, even while it is stopped', () => {
    const first = install({ args: ['server'], tty: '\n' });
    const home = join(first.dir, 'home');
    const named = install({ args: ['server', '--name', 'beta'], tty: '\n', env: { HOME: home, HORNHOOF_DIR: join(home, 'hornhoof') } });
    expect(named.code).toBe(0);
    expect(readFileSync(join(home, 'hornhoof-beta', '.env'), 'utf8')).toContain('HORNHOOF_PORT=8081');
  });

  it('pins the version and the project name for the updater', () => {
    const r = install({ args: ['server', '--name', 'acme'], tty: '\n', env: { HORNHOOF_VERSION: '0.4.1', STUB_PORTS_TAKEN: '8080' } });
    expect(r.code).toBe(0);
    const env = readFileSync(join(r.dir, 'home', 'hornhoof-acme', '.env'), 'utf8');
    expect(env).toMatch(/^HORNHOOF_VERSION=0\.4\.1$/m);
    expect(env).toMatch(/^COMPOSE_PROJECT_NAME=hornhoof-acme$/m);
    expect(env).toContain(`HORNHOOF_SERVER_DIR=${join(r.dir, 'home', 'hornhoof-acme')}\n`);
    expect(env).toMatch(/^HORNHOOF_SECRET=.{44}$/m);
    const plain = install({ args: ['server'], tty: '\n' });
    const plainEnv = readFileSync(join(plain.dir, 'home', 'hornhoof', '.env'), 'utf8');
    expect(plainEnv).toMatch(/^HORNHOOF_VERSION=latest$/m);
    expect(plainEnv).toMatch(/^COMPOSE_PROJECT_NAME=hornhoof$/m);
    expect(plainEnv.match(/^HORNHOOF_VERSION=/gm)).toHaveLength(1);
  });

  it('takes compose.yaml from the build it installs, not from GitHub', () => {
    const r = install({ args: ['server'], tty: '\n', env: { HORNHOOF_VERSION: '0.4.1' } });
    expect(r.code).toBe(0);
    const dir = join(r.dir, 'home', 'hornhoof');
    expect(r.calls).toContain('docker pull ghcr.io/invariant0x/hornhoof:0.4.1');
    expect(r.calls).toContain('docker create ghcr.io/invariant0x/hornhoof:0.4.1');
    expect(r.calls).toContain(`docker cp cid-app:/app/compose.yaml ${dir}/compose.yaml`);
    expect(r.calls.some(c => c.startsWith('curl') && c.includes('compose.yaml'))).toBe(false);
    expect(readFileSync(join(dir, 'compose.yaml'), 'utf8')).toBe('services: {}\n');
  });

  it('updates without questions or downloads from the updater', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    writeFileSync(join(dir, '.env'), `HORNHOOF_SECRET=keep-me\nNODE_KEY=k\nPUBLIC_URL=http://localhost:8080\nCOMPOSE_PROJECT_NAME=hornhoof\nHORNHOOF_VERSION=0.4.0\nHORNHOOF_HOST_ID=${'e'.repeat(64)}\n`);
    const compose = join(dir, 'brought.yaml');
    writeFileSync(compose, 'services: {app: {}}\n');
    const r = install({
      args: ['server'],
      tty: '',
      env: {
        HORNHOOF_FROM_UPDATER: '1', HORNHOOF_UPDATER_REV: '2',
        HORNHOOF_PULLED: '1',
        HORNHOOF_SERVER_DIR: dir,
        HORNHOOF_VERSION: '0.4.1',
        HORNHOOF_COMPOSE_FILE: compose,
        HORNHOOF_APP_REF: `ghcr.io/invariant0x/hornhoof@sha256:${'b'.repeat(64)}`,
        HORNHOOF_NODE_REF: `ghcr.io/invariant0x/hornhoof-node@sha256:${'d'.repeat(64)}`,
        HORNHOOF_UPDATER_REF: `ghcr.io/invariant0x/hornhoof-updater@sha256:${'f'.repeat(64)}`,
        STUB_CONTAINERS: 'hornhoof-claude-1c07dac4=http://localhost:8080',
      },
    });
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, 'compose.yaml'), 'utf8')).toBe('services: {app: {}}\n');
    const env = readFileSync(join(dir, '.env'), 'utf8');
    expect(env).toMatch(/^HORNHOOF_VERSION=0\.4\.1$/m);
    expect(env).toContain('HORNHOOF_SECRET=keep-me');
    /* The updater runs in a container of its own, which is not the computer the server runs on. */
    expect(env).toMatch(new RegExp(`^HORNHOOF_HOST_ID=${'e'.repeat(64)}$`, 'm'));
    expect(env.match(/^HORNHOOF_HOST_ID=/gm)).toHaveLength(1);
    /* compose starts exactly the images the updater checked. */
    expect(env).toMatch(new RegExp(`^HORNHOOF_APP_REF=ghcr\\.io/invariant0x/hornhoof@sha256:${'b'.repeat(64)}$`, 'm'));
    expect(env).toMatch(new RegExp(`^HORNHOOF_NODE_REF=ghcr\\.io/invariant0x/hornhoof-node@sha256:${'d'.repeat(64)}$`, 'm'));
    expect(env).toMatch(new RegExp(`^HORNHOOF_UPDATER_REF=ghcr\\.io/invariant0x/hornhoof-updater@sha256:${'f'.repeat(64)}$`, 'm'));
    expect(r.calls.some(c => c.startsWith('curl'))).toBe(false);
    expect(r.calls.some(c => (c.startsWith('docker create') && !c.includes('hornhoof-port-lock')) || c.startsWith('docker info'))).toBe(false);
    /* The updater downloaded every image before it saved the database, so this only starts them. */
    expect(r.calls.some(c => c.startsWith('docker pull') || c.startsWith('docker compose pull'))).toBe(false);
    expect(r.calls).toContain('docker compose up -d --no-build app node');
    expect(r.calls).not.toContain('docker compose up -d --no-build');
    expect(r.calls.find(c => c.startsWith('docker run -d --name hornhoof-claude-1c07dac4'))).toMatch(new RegExp(` ghcr\\.io/invariant0x/hornhoof-node@sha256:${'d'.repeat(64)}$`));
  });

  /* The first update of a server from before runs through the updater it has, which downloads nothing and names the
     build by its tag only. */
  it('downloads the images itself for an updater that did not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    writeFileSync(join(dir, '.env'), 'HORNHOOF_SECRET=keep-me\nNODE_KEY=k\nPUBLIC_URL=http://localhost:8080\nHORNHOOF_VERSION=0.4.0\n');
    const compose = join(dir, 'brought.yaml');
    writeFileSync(compose, 'services: {app: {}}\n');
    const r = install({ args: ['server'], tty: '', env: { HORNHOOF_FROM_UPDATER: '1', HORNHOOF_UPDATER_REV: '2', HORNHOOF_SERVER_DIR: dir, HORNHOOF_VERSION: '0.4.1', HORNHOOF_COMPOSE_FILE: compose } });
    expect(r.code).toBe(0);
    expect(indexOf(r.calls, 'docker compose pull')).toBeGreaterThanOrEqual(0);
    expect(indexOf(r.calls, 'docker compose pull')).toBeLessThan(indexOf(r.calls, 'docker compose up -d --no-build app node'));
    const env = readFileSync(join(dir, '.env'), 'utf8');
    expect(env).toMatch(/^HORNHOOF_APP_REF=ghcr\.io\/invariant0x\/hornhoof:0\.4\.1$/m);
    expect(env).toMatch(/^HORNHOOF_NODE_REF=ghcr\.io\/invariant0x\/hornhoof-node:0\.4\.1$/m);
    expect(env).toMatch(/^HORNHOOF_UPDATER_REF=ghcr\.io\/invariant0x\/hornhoof-updater:0\.4\.1$/m);
  });

  it('moves the nodes that joined through the public link to the new build too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    writeFileSync(join(dir, '.env'), 'HORNHOOF_SECRET=s\nNODE_KEY=k\nPUBLIC_URL=http://localhost:8081\nHORNHOOF_PORT=8081\n');
    const r = install({
      args: ['server'],
      env: {
        HORNHOOF_FROM_UPDATER: '1', HORNHOOF_UPDATER_REV: '2',
        HORNHOOF_SERVER_DIR: dir,
        HORNHOOF_VERSION: '0.4.1',
        STUB_TUNNEL_SETTINGS: '{"url":"https://acme.hornhoof.test","name":"acme","key":"secret","tunnel":{"serverAddr":"hornhoof.test"}}',
        STUB_CONTAINERS: 'hornhoof-claude-1c07dac4=http://localhost:8081 hornhoof-glm-33333333=https://acme.hornhoof.test hornhoof-codex-9f1e2d3c=https://other.hornhoof.test',
      },
    });
    expect(r.code).toBe(0);
    const runs = r.calls.filter(c => c.startsWith('docker run -d'));
    expect(runs.map(c => c.match(/--name (\S+)/)![1]).sort()).toEqual(['hornhoof-claude-1c07dac4', 'hornhoof-glm-33333333']);
    expect(runs.find(c => c.includes('--name hornhoof-glm-33333333'))).toMatch(/--label hornhoof\.server=https:\/\/acme\.hornhoof\.test .*hornhoof-node:0\.4\.1$/);
    expect(r.out).not.toContain('secret');
  });

  it('moves only the nodes it knows when the tunnel settings say nothing usable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    writeFileSync(join(dir, '.env'), 'HORNHOOF_SECRET=s\nNODE_KEY=k\nPUBLIC_URL=http://localhost:8081\nHORNHOOF_PORT=8081\n');
    const r = install({
      args: ['server'],
      env: {
        HORNHOOF_FROM_UPDATER: '1', HORNHOOF_UPDATER_REV: '2',
        HORNHOOF_SERVER_DIR: dir,
        HORNHOOF_VERSION: '0.4.1',
        STUB_TUNNEL_SETTINGS: '{"url":"https://a b.test; rm -rf /","tunnel":{}}',
        STUB_CONTAINERS: 'hornhoof-claude-1c07dac4=http://localhost:8081',
      },
    });
    expect(r.code).toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker run -d'))).toHaveLength(1);
  });

  it("moves this server's nodes on this machine to the new build from the updater", () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    writeFileSync(join(dir, '.env'), 'HORNHOOF_SECRET=s\nNODE_KEY=k\nPUBLIC_URL=https://hh.acme.test\nHORNHOOF_PORT=8081\n');
    const r = install({
      args: ['server'],
      env: {
        HORNHOOF_FROM_UPDATER: '1', HORNHOOF_UPDATER_REV: '2',
        HORNHOOF_SERVER_DIR: dir,
        HORNHOOF_VERSION: '0.4.1',
        STUB_CONTAINERS: 'hornhoof-claude-1c07dac4=http://localhost:8081 hornhoof-kimi-22222222=https://hh.acme.test hornhoof-codex-9f1e2d3c=https://other.example.test',
      },
    });
    expect(r.code).toBe(0);
    const runs = r.calls.filter(c => c.startsWith('docker run -d'));
    expect(runs).toHaveLength(2);
    expect(runs.find(c => c.includes('--name hornhoof-claude-1c07dac4'))).toMatch(/--label hornhoof\.server=http:\/\/localhost:8081 .*--add-host host\.docker\.internal:host-gateway ghcr\.io\/invariant0x\/hornhoof-node:0\.4\.1$/);
    expect(runs.find(c => c.includes('--name hornhoof-kimi-22222222'))).toMatch(/--label hornhoof\.server=https:\/\/hh\.acme\.test .*hornhoof-node:0\.4\.1$/);
    expect(runs.find(c => c.includes('--name hornhoof-kimi-22222222'))).not.toContain('--add-host');
    expect(r.calls).toContain('docker pull ghcr.io/invariant0x/hornhoof-node:0.4.1');
  });

  it("leaves the built-in node and this server's plan nodes running when the node image did not change", () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    writeFileSync(join(dir, '.env'), 'HORNHOOF_SECRET=s\nNODE_KEY=k\nPUBLIC_URL=https://hh.acme.test\nHORNHOOF_PORT=8081\nHORNHOOF_VERSION=0.4.0\n');
    const compose = join(dir, 'brought.yaml');
    writeFileSync(compose, 'services: {app: {}}\n');
    const nodeRef = `ghcr.io/invariant0x/hornhoof-node@sha256:${'c'.repeat(64)}`;
    const r = install({
      args: ['server'],
      tty: '',
      env: {
        HORNHOOF_FROM_UPDATER: '1', HORNHOOF_UPDATER_REV: '2',
        HORNHOOF_PULLED: '1',
        HORNHOOF_SERVER_DIR: dir,
        HORNHOOF_VERSION: '0.4.1',
        HORNHOOF_COMPOSE_FILE: compose,
        HORNHOOF_APP_REF: `ghcr.io/invariant0x/hornhoof@sha256:${'b'.repeat(64)}`,
        HORNHOOF_NODE_REF: nodeRef,
        HORNHOOF_UPDATER_REF: `ghcr.io/invariant0x/hornhoof-updater@sha256:${'f'.repeat(64)}`,
        STUB_NODE_RUNNING: nodeRef,
        STUB_CONTAINERS: 'hornhoof-claude-1c07dac4=http://localhost:8081 hornhoof-kimi-22222222=https://hh.acme.test',
      },
    });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('docker compose up -d --no-build app');
    expect(r.calls).not.toContain('docker compose up -d --no-build app node');
    expect(r.calls.some(c => c.startsWith('docker rm -f hornhoof-') || c.startsWith('docker run -d'))).toBe(false);
    expect(r.calls.some(c => c.includes('tunnel.json'))).toBe(false);
  });

  it('leaves the built-in node and plan nodes running in server mode when the node image is unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    writeFileSync(join(dir, '.env'), 'HORNHOOF_SECRET=s\nNODE_KEY=k\nPUBLIC_URL=http://localhost:8080\nHORNHOOF_VERSION=0.4.0\n');
    const r = install({
      args: ['server'],
      tty: '',
      env: {
        HORNHOOF_DIR: dir,
        HORNHOOF_VERSION: '0.4.1',
        STUB_NODE_RUNNING: 'ghcr.io/invariant0x/hornhoof-node:0.4.0',
        STUB_IMAGE_IDS: 'ghcr.io/invariant0x/hornhoof-node:0.4.0=sha256:same ghcr.io/invariant0x/hornhoof-node:0.4.1=sha256:same',
        STUB_CONTAINERS: 'hornhoof-claude-1c07dac4=http://localhost:8080',
      },
    });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('docker compose up -d --no-build app updater');
    expect(r.calls).not.toContain('docker compose up -d --no-build');
    expect(r.calls.some(c => c.startsWith('docker rm -f hornhoof-claude') || c.startsWith('docker run -d'))).toBe(false);

    /* When the node image did change, compose recreates the built-in node as before. */
    const changed = install({
      args: ['server'],
      tty: '',
      env: {
        HORNHOOF_DIR: dir,
        HORNHOOF_VERSION: '0.4.2',
        STUB_NODE_RUNNING: 'ghcr.io/invariant0x/hornhoof-node:0.4.1',
      },
    });
    expect(changed.code).toBe(0);
    expect(changed.calls).toContain('docker compose up -d --no-build');
    const intent = indexOf(changed.calls, 'docker exec nodecid node /app/apps/node/dist/main.js prepare-stop hornhoof_update');
    const stopped = indexOf(changed.calls, 'docker stop --time 5 nodecid');
    expect(intent).toBeGreaterThanOrEqual(0);
    expect(stopped).toBeGreaterThan(intent);
    expect(changed.calls.indexOf('docker compose up -d --no-build')).toBeGreaterThan(stopped);
  });

  it('starts the database, then the keeper and front, then the app, which migrates first', () => {
    const r = install({ args: ['server'], tty: '\n' });
    expect(r.code).toBe(0);
    const steps = ['docker compose stop app', 'docker compose up -d --no-build --remove-orphans --wait db', 'docker compose up -d --no-build keeper front', 'docker compose up -d --no-build'].map(step => r.calls.indexOf(step));
    expect(steps.every(index => index >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it('says where to look when the database cannot be brought up to this build', () => {
    const r = install({ args: ['server'], tty: '\n', env: { STUB_MIGRATE: 'fail' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Hornhoof could not bring its database up to this build. Run docker compose logs migrate in ${join(r.dir, 'home', 'hornhoof')} to see why.`);
  });

  it('writes the machine id once: the host id by hand, a random one from the updater', () => {
    const byHand = install({ args: ['server'], tty: '\n' });
    expect(byHand.code).toBe(0);
    const made = readFileSync(join(byHand.dir, 'home', 'hornhoof', '.env'), 'utf8');
    expect(linesOf(made, 'HORNHOOF_MACHINE_ID')[0].split('=')[1]).toBe(linesOf(made, 'HORNHOOF_HOST_ID')[0].split('=')[1]);
    const updater = fromUpdater({ HORNHOOF_UPDATER_REV: '2' });
    expect(updater.code).toBe(0);
    expect(linesOf(updater.dotEnv(), 'HORNHOOF_MACHINE_ID')[0]).toMatch(/^HORNHOOF_MACHINE_ID=[0-9a-f]{32}$/);

    const kept = 'HORNHOOF_SECRET=s\nNODE_KEY=k\nHORNHOOF_MACHINE_ID=0123abcd\n';
    const fromKept = fromUpdater({ HORNHOOF_UPDATER_REV: '2' }, kept).dotEnv();
    const handDir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    writeFileSync(join(handDir, '.env'), kept);
    expect(install({ args: ['server'], tty: '\n', env: { HORNHOOF_DIR: handDir } }).code).toBe(0);
    for (const env of [fromKept, readFileSync(join(handDir, '.env'), 'utf8')]) expect(linesOf(env, 'HORNHOOF_MACHINE_ID')).toEqual(['HORNHOOF_MACHINE_ID=0123abcd']);
  });

  it("hands an update to this build's updater when an older updater runs it", () => {
    const r = fromUpdater({ HORNHOOF_UPDATER_REF: UPDATER_REF, HORNHOOF_HANDOVER_WAIT: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain("This build's updater takes over the update first.");
    expect(r.out).toContain(`The updater of this build did not take over, so nothing changed. Run install.sh server in ${r.folder}.`);
    expect(readFileSync(join(r.folder, 'compose.yaml'), 'utf8')).toBe('services: {app: {}}\n');
    const project = linesOf(r.dotEnv(), 'COMPOSE_PROJECT_NAME')[0].split('=')[1];
    expect(r.calls).toContain(`docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v ${r.folder}:${r.folder} -v ${project}_control:/control -e HORNHOOF_SERVER_DIR=${r.folder} ${UPDATER_REF} --take-over`);
    expect(r.calls.some(c => COMPOSE_STEP.test(c))).toBe(false);
  });

  it('stops when the hand-over helper does not start', () => {
    const r = fromUpdater({ HORNHOOF_UPDATER_REF: UPDATER_REF, STUB_RUN: 'fail' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Could not start the updater of this build, so nothing changed.');
    expect(r.out).not.toContain('did not take over');
    expect(linesOf(r.dotEnv(), 'HORNHOOF_VERSION')).toEqual(['HORNHOOF_VERSION=0.4.1']);
    expect(linesOf(r.dotEnv(), 'HORNHOOF_PEER_PORT')).toEqual([]);
    expect(existsSync(join(r.folder, 'compose.yaml'))).toBe(true);
    expect(r.calls.some(c => COMPOSE_STEP.test(c))).toBe(false);
  });

  /* updater.sh --take-over without the control folder and the server folder finds no update and exits 0, which the
     installer cannot see but as the update not being taken over. An older updater takes a 0 from this script for a
     finished install, and removes what the new compose file does not name while the old app runs. */
  it('fails loudly when the helper exits at once and takes nothing over', () => {
    const started = Date.now();
    const r = fromUpdater({ HORNHOOF_UPDATER_REF: UPDATER_REF, HORNHOOF_HANDOVER_WAIT: '2' });
    /* It waits it out: going back sooner would race the helper for the updater's place. */
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(r.code).toBe(1);
    expect(r.out).toContain('The updater of this build did not take over, so nothing changed.');
    expect(r.calls.some(c => COMPOSE_STEP.test(c))).toBe(false);
  });

  it('gives the helper its two folders, and waits until it replaces the updater this runs under', () => {
    const dotEnv = 'HORNHOOF_SECRET=s\nNODE_KEY=k\nCOMPOSE_PROJECT_NAME=hornhoof-acme\n';
    const r = fromUpdater({ HORNHOOF_UPDATER_REF: UPDATER_REF, HORNHOOF_HANDOVER_WAIT: '3', STUB_HELPER: 'replaces' }, dotEnv);
    expect(r.calls).toContain('helper replaced the updater');
    /* Compose killed it where it waited: it neither went on nor said the helper failed. */
    expect(r.code).toBeNull();
    expect(r.out).not.toContain('did not take over');
    expect(r.calls.some(c => COMPOSE_STEP.test(c))).toBe(false);
  });

  it('takes an updater that does not say a revision of 2 or more for an older one', () => {
    for (const rev of ['1', '', 'x']) {
      const r = fromUpdater({ HORNHOOF_UPDATER_REV: rev, HORNHOOF_UPDATER_REF: UPDATER_REF, HORNHOOF_HANDOVER_WAIT: '0' });
      expect(r.code).toBe(1);
      expect(r.calls.some(c => c.endsWith(`${UPDATER_REF} --take-over`))).toBe(true);
      expect(r.calls.some(c => COMPOSE_STEP.test(c))).toBe(false);
    }
  });

  it('starts no helper for an updater that names no server folder', () => {
    const r = fromUpdater({ HORNHOOF_SERVER_DIR: '', HORNHOOF_UPDATER_REF: UPDATER_REF });
    expect(r.code).toBe(1);
    expect(r.out).toContain('to update.');
    expect(r.calls.some(c => c.includes('--take-over'))).toBe(false);
  });

  it('goes on without a handover under an updater of revision 2', () => {
    const r = fromUpdater({ HORNHOOF_UPDATER_REV: '2', HORNHOOF_UPDATER_REF: UPDATER_REF, HORNHOOF_PULLED: '1' });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.includes('--take-over'))).toBe(false);
    expect(r.calls).toContain('docker compose up -d --no-build app node');
  });

  it('keeps a host-wide list of ports, so four companies on one computer never share one', () => {
    const c = computer();
    const companies: [string, string[]][] = [['hornhoof', []], ['hornhoof-b', ['--name', 'b']], ['hornhoof-c', ['--name', 'c']], ['hornhoof-d', ['--name', 'd']]];
    companies.forEach(([name, args], i) => {
      expect(c.run(args).code).toBe(0);
      expect(portsIn(c.dotEnv(name))).toEqual([`HORNHOOF_PORT=${8080 + i}`, `HORNHOOF_PEER_PORT=${8180 + i}`]);
    });
    expect(c.list()).toEqual(companies.map(([name], i) => `${c.folder(name)} ${8080 + i} ${8180 + i}`));
  });

  it('leaves the ports of a stopped and pruned company to it', () => {
    const c = computer();
    c.setList([`${c.folder('hornhoof-old')} 8080 8180`]);
    expect(c.run().code).toBe(0);
    expect(portsIn(c.dotEnv())).toEqual(['HORNHOOF_PORT=8081', 'HORNHOOF_PEER_PORT=8181']);
    expect(c.list()).toEqual([`${c.folder('hornhoof-old')} 8080 8180`, `${c.folder()} 8081 8181`]);
  });

  it('skips ports any container publishes, running or stopped', () => {
    const c = computer();
    expect(c.run([], { STUB_BOUND_PORTS: '8080 8180' }).code).toBe(0);
    expect(portsIn(c.dotEnv())).toEqual(['HORNHOOF_PORT=8081', 'HORNHOOF_PEER_PORT=8181']);
  });

  it('gives an existing company a peer port and keeps its web port', () => {
    const kept = computer();
    kept.company('HORNHOOF_SECRET=s\nNODE_KEY=k\nHORNHOOF_PORT=8085\n');
    expect(kept.run().code).toBe(0);
    expect(portsIn(kept.dotEnv())).toEqual(['HORNHOOF_PORT=8085', 'HORNHOOF_PEER_PORT=8180']);
    expect(kept.list()).toEqual([`${kept.folder()} 8085 8180`]);

    const older = computer();
    older.company('HORNHOOF_SECRET=s\nNODE_KEY=k\n');
    expect(older.run([], { STUB_BOUND_PORTS: '8080' }).code).toBe(0);
    expect(portsIn(older.dotEnv())).toEqual(['HORNHOOF_PORT=8080', 'HORNHOOF_PEER_PORT=8180']);
  });

  it("chooses a new company's ports by the free search though its .env is there by then", () => {
    const c = computer();
    expect(c.run([], { STUB_BOUND_PORTS: '8080' }).code).toBe(0);
    expect(linesOf(c.dotEnv(), 'HORNHOOF_PORT')).toEqual(['HORNHOOF_PORT=8081']);
    expect(linesOf(c.dotEnv(), 'PUBLIC_URL')).toEqual(['PUBLIC_URL=http://localhost:8081']);
    /* Its own front binds 8081 now. */
    expect(c.run([], { STUB_BOUND_PORTS: '8080 8081' }).code).toBe(0);
    expect(linesOf(c.dotEnv(), 'HORNHOOF_PORT')).toEqual(['HORNHOOF_PORT=8081']);
  });

  it('takes the lock and gives it back', () => {
    const c = computer();
    const r = c.run();
    expect(r.code).toBe(0);
    const taken = r.calls.findIndex(call => /^docker create --name hornhoof-port-lock --label io\.hornhoof\.since=\d+ \S+ true$/.test(call));
    const written = r.calls.findIndex(call => call.includes(REGISTRY_WRITE));
    expect(taken).toBeGreaterThanOrEqual(0);
    expect(written).toBeGreaterThan(taken);
    expect(r.calls.indexOf('docker rm lock-1')).toBeGreaterThan(written);
    expect(r.calls).toContain('docker volume create hornhoof-ports');

    const failing = computer();
    const failed = failing.run([], { STUB_REGISTRY: 'fail' });
    expect(failed.code).toBe(1);
    expect(linesOf(failing.dotEnv(), 'HORNHOOF_PEER_PORT')).toEqual([]);
    expect(failed.calls).toContain('docker rm lock-1');
    expect(failed.calls.some(call => call.startsWith('docker compose up'))).toBe(false);
  });

  it('writes nothing when another install took its lock over', () => {
    const c = computer();
    const r = c.run([], { STUB_LOCK_TAKEN: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain(LOCK_BUSY);
    expect(r.calls.some(call => call.includes(REGISTRY_WRITE))).toBe(false);
    expect(linesOf(c.dotEnv(), 'HORNHOOF_PEER_PORT')).toEqual([]);
    expect(r.calls).not.toContain('docker rm lock-other');
  });

  it('takes over a lock older than two minutes by its id, and waits for a younger one', () => {
    const now = Math.floor(Date.now() / 1000);
    const old = computer();
    old.holdLock('lock-old');
    const taken = old.run([], { STUB_LOCK_SINCE: String(now - 200) });
    expect(taken.code).toBe(0);
    expect(taken.calls).toContain('docker rm lock-old');
    expect(portsIn(old.dotEnv())).toEqual(['HORNHOOF_PORT=8080', 'HORNHOOF_PEER_PORT=8180']);

    const young = computer();
    young.holdLock('lock-young');
    const waited = young.run([], { STUB_LOCK_SINCE: String(now - 30), HORNHOOF_PORT_LOCK_WAIT: '2' });
    expect(waited.code).toBe(1);
    expect(waited.out).toContain(LOCK_BUSY);
    expect(waited.calls).not.toContain('docker rm lock-young');
  });

  it('moves a new port that something outside Docker holds, and its address with it', () => {
    const up = 'docker compose up -d --no-build keeper front';
    const peer = computer();
    const moved = peer.run([], { STUB_BIND_FAIL: '8180' });
    expect(moved.code).toBe(0);
    expect(portsIn(peer.dotEnv())).toEqual(['HORNHOOF_PORT=8080', 'HORNHOOF_PEER_PORT=8181']);
    expect(peer.list()).toEqual([`${peer.folder()} 8080 8181`]);
    expect(moved.calls.filter(call => call === up)).toHaveLength(2);
    expect(moved.out).toContain('Port 8180 is taken, so Hornhoof takes another one.');

    /* Docker words it otherwise when its proxy finds the port taken. */
    const web = computer();
    const moves = web.run([], { STUB_BIND_FAIL: '8080', STUB_BIND_WORDS: 'address' });
    expect(moves.code).toBe(0);
    expect(linesOf(web.dotEnv(), 'HORNHOOF_PORT')).toEqual(['HORNHOOF_PORT=8081']);
    expect(linesOf(web.dotEnv(), 'PUBLIC_URL')).toEqual(['PUBLIC_URL=http://localhost:8081']);
    expect(web.list()).toEqual([`${web.folder()} 8081 8180`]);
    expect(moves.calls.some(call => call.startsWith('curl') && call.includes('http://localhost:8081/api/health'))).toBe(true);
    expect(moves.out).toContain('Hornhoof is running at http://localhost:8081.');

    const six = computer().run([], { STUB_BIND_FAIL: portRange(8180, 6) });
    expect(six.code).toBe(1);
    expect(six.out).toContain('Port 8185 is taken by a program outside Docker. Stop what uses it, then run this command again.');
    expect(six.calls.filter(call => call === up)).toHaveLength(6);

    const before = computer();
    before.company('HORNHOOF_SECRET=s\nNODE_KEY=k\nHORNHOOF_PORT=8085\n');
    const taken = before.run([], { STUB_BIND_FAIL: '8085' });
    expect(taken.code).toBe(1);
    expect(taken.out).toContain('Port 8085 is taken by a program outside Docker.');
    expect(linesOf(before.dotEnv(), 'HORNHOOF_PORT')).toEqual(['HORNHOOF_PORT=8085']);
  });

  it('takes the last port of a range, and says so when a range has none free', () => {
    const last = computer();
    expect(last.run([], { STUB_BOUND_PORTS: portRange(8080, 99) }).code).toBe(0);
    expect(linesOf(last.dotEnv(), 'HORNHOOF_PORT')).toEqual(['HORNHOOF_PORT=8179']);

    const noWeb = computer();
    const web = noWeb.run([], { STUB_BOUND_PORTS: portRange(8080, 100) });
    expect(web.code).toBe(1);
    expect(web.out).toContain('No free port from 8080 to 8179 for Hornhoof. Stop what uses them, then run this command again.');
    expect(web.calls).toContain('docker rm lock-1');

    const peer = computer().run([], { STUB_BOUND_PORTS: portRange(8180, 100) });
    expect(peer.code).toBe(1);
    expect(peer.out).toContain('No free port from 8180 to 8279 for Hornhoof. Stop what uses them, then run this command again.');
  });

  it('hands out no port when it cannot read the list', () => {
    const c = computer();
    const r = c.run([], { STUB_REGISTRY: 'unreadable' });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Could not read the list of Hornhoof's ports on this computer. Run this command again.");
    expect(r.calls.some(call => call.includes(REGISTRY_WRITE))).toBe(false);
    expect(r.calls).toContain('docker rm lock-1');
    expect(linesOf(c.dotEnv(), 'HORNHOOF_PEER_PORT')).toEqual([]);
  });

  it('asks no port on localhost from the updater, whose localhost is its own container', () => {
    const r = fromUpdater({ HORNHOOF_UPDATER_REV: '2', STUB_PORTS_TAKEN: '8180' });
    expect(r.code).toBe(0);
    expect(linesOf(r.dotEnv(), 'HORNHOOF_PEER_PORT')).toEqual(['HORNHOOF_PEER_PORT=8180']);
    expect(r.calls.some(c => c.startsWith('curl'))).toBe(false);
  });

  it('counts a company whose first run stopped before it chose its ports as new', () => {
    const c = computer();
    expect(c.run().code).toBe(0);
    c.holdLock('lock-of-another-install');
    expect(c.run(['--name', 'b'], { HORNHOOF_PORT_LOCK_WAIT: '0' }).code).toBe(1);
    c.freeLock();
    expect(c.run(['--name', 'b']).code).toBe(0);
    expect(portsIn(c.dotEnv('hornhoof-b'))).toEqual(['HORNHOOF_PORT=8081', 'HORNHOOF_PEER_PORT=8181']);
    expect(linesOf(c.dotEnv('hornhoof-b'), 'PUBLIC_URL')).toEqual(['PUBLIC_URL=http://localhost:8081']);
  });

  it('gives a company whose folder is gone its ports and its address back', () => {
    const c = computer();
    c.setList([`${c.folder('hornhoof-b')} 8083 8183`]);
    expect(c.run(['--name', 'b']).code).toBe(0);
    expect(portsIn(c.dotEnv('hornhoof-b'))).toEqual(['HORNHOOF_PORT=8083', 'HORNHOOF_PEER_PORT=8183']);
    expect(linesOf(c.dotEnv('hornhoof-b'), 'PUBLIC_URL')).toEqual(['PUBLIC_URL=http://localhost:8083']);
  });

  it('reads a folder with a space in its name from the list', () => {
    const c = computer();
    const spaced = join(c.folder(), 'my company');
    mkdirSync(c.folder());
    c.setList([`${spaced} 8084 8184`, `${c.folder('hornhoof-old')} 8080 8180`]);
    expect(c.run([], { HORNHOOF_SERVER_DIR: spaced, HORNHOOF_DIR: c.folder() }).code).toBe(0);
    expect(linesOf(readFileSync(join(spaced, '.env'), 'utf8'), 'HORNHOOF_PORT')).toEqual(['HORNHOOF_PORT=8084']);
    expect(c.list()).toEqual([`${c.folder('hornhoof-old')} 8080 8180`, `${spaced} 8084 8184`]);
  });

  it("keeps to the ports in other companies' .env files when the list is gone", () => {
    const c = computer();
    c.company('HORNHOOF_SECRET=s\nNODE_KEY=k\nHORNHOOF_PORT=8080\nHORNHOOF_PEER_PORT=8180\n', 'hornhoof-a');
    expect(c.run().code).toBe(0);
    expect(portsIn(c.dotEnv())).toEqual(['HORNHOOF_PORT=8081', 'HORNHOOF_PEER_PORT=8181']);
  });

  it('says what did not start when a step fails for another reason', () => {
    const database = computer().run([], { STUB_UP_FAIL: 'db' });
    expect(database.code).toBe(1);
    expect(database.out).toContain('The database did not start. Run docker compose logs db in ');
    const front = computer().run([], { STUB_UP_FAIL: 'front' });
    expect(front.code).toBe(1);
    expect(front.out).toContain('Hornhoof did not start. Run docker compose logs in ');
    expect(front.calls.filter(call => call.endsWith(' keeper front'))).toHaveLength(1);
    const app = fromUpdater({ HORNHOOF_UPDATER_REV: '2', STUB_UP_FAIL: 'app' });
    expect(app.code).toBe(1);
    expect(app.out).toContain('Hornhoof did not start.');
    expect(app.out).not.toContain('could not bring its database');
    expect(app.out).not.toContain('docker compose logs');
  });

  it('refuses a server name it cannot use as a folder', () => {
    const r = install({ args: ['server', '--name', 'Acme Inc'] });
    expect(r.code).toBe(1);
    expect(r.out).toContain('--name takes lowercase letters, digits and dashes');
  });

  it('keeps everything on --uninstall without a y', () => {
    const r = install({ args: ['--uninstall'], tty: 'n\n', env: { STUB_CONTAINERS: 'hornhoof-claude-1c07dac4' } });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.startsWith('docker rm'))).toBe(false);
  });
});
