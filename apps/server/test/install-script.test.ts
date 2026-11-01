import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
const TOOLS = ['bash', 'sh', 'env', 'cat', 'od', 'tr', 'head', 'base64', 'sleep', 'mkdir', 'rm', 'chmod', 'grep', 'sed', 'cut', 'cp', 'mv', 'touch', 'basename', 'dirname', 'wc', 'mktemp', 'date', 'sort', 'kill', 'printf', 'tail', 'awk', 'sha256sum', 'shasum'];
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
      HORNHOOF_DOCKER_SCRIPT_SHA256: sha256('_docker-install.sh'),
      HORNHOOF_BREW_SCRIPT_SHA256: sha256('_brew-install.sh'),
      ...env,
    },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { code: res.status, out: res.stdout + res.stderr, calls, dir, docker: calls.filter(c => /^(sudo )?docker /.test(c)) };
}

const indexOf = (calls: string[], start: string) => calls.findIndex(c => c.startsWith(start));

describe('install.sh', () => {
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
    const r = install({ tty: 'typed-answer\n' });
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
    expect(r.calls.filter(c => c.startsWith('docker exec -it') && c.endsWith('login'))).toHaveLength(2);
    expect(r.out).toMatch(/Claude.*ready/);
    expect(r.out).toMatch(/Codex.*ready/);
    expect(existsSync(join(r.dir, 'home', '.hornhoof', 'machine'))).toBe(true);
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
    const r = install({ env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_LOGIN_URL: 'https://claude.ai/oauth/authorize?code=1', STUB_LOGIN_SLEEP: '1.5' } });
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
      const r = install({ env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_LOGIN_URL: link, STUB_LOGIN_SLEEP: '1.5' } });
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

  it('sets up the server with fresh secrets and the address typed on the terminal', () => {
    const r = install({ args: ['server'], tty: 'https://hornhoof.my.test\n' });
    expect(r.code).toBe(0);
    const env = readFileSync(join(r.dir, 'home', 'hornhoof', '.env'), 'utf8');
    expect(env).toMatch(/^HORNHOOF_SECRET=[A-Za-z0-9+/=]{44}$/m);
    expect(env).toMatch(/^NODE_KEY=[A-Za-z0-9+/=]{44}$/m);
    expect(env).toContain('PUBLIC_URL=https://hornhoof.my.test');
    /* It goes into the database address, so it keeps to characters an address takes as they are. */
    expect(env).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]{48}$/m);
    /* compose starts the images .env names; set up by hand, they are the build's tag. */
    expect(env).toMatch(/^HORNHOOF_APP_REF=ghcr\.io\/invariant0x\/hornhoof:latest$/m);
    expect(env).toMatch(/^HORNHOOF_NODE_REF=ghcr\.io\/invariant0x\/hornhoof-node:latest$/m);
    expect(env).toMatch(/^HORNHOOF_UPDATER_REF=ghcr\.io\/invariant0x\/hornhoof-updater:latest$/m);
    expect(existsSync(join(r.dir, 'home', 'hornhoof', 'compose.yaml'))).toBe(true);
    expect(r.calls).toContain('docker compose pull');
    expect(r.calls).toContain('docker compose up -d --no-build');
    expect(r.out).toContain('https://hornhoof.my.test');
  });

  it("tells the built-in node of a server on a Mac the Mac's processor, cores and memory, through .env", () => {
    const r = install({ args: ['server'], tty: '\n', env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_NCPU: '10', STUB_MEMSIZE: String(32 * 1024 ** 3), STUB_CPU_BRAND: 'Apple M5' } });
    expect(r.code).toBe(0);
    const env = readFileSync(join(r.dir, 'home', 'hornhoof', '.env'), 'utf8');
    expect(env).toMatch(/^HORNHOOF_HOST_CPU=Apple M5$/m);
    expect(env).toMatch(/^HORNHOOF_HOST_CPUS=10$/m);
    expect(env).toMatch(new RegExp(`^HORNHOOF_HOST_MEMORY=${32 * 1024 ** 3}$`, 'm'));
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
    /* Its database was made with the password compose gives when .env names none. */
    expect(env).not.toContain('POSTGRES_PASSWORD');
    const compose = readFileSync(fileURLToPath(new URL('../../../compose.yaml', import.meta.url)), 'utf8');
    expect(compose.match(/\$\{POSTGRES_PASSWORD:-hornhoof\}/g)).toHaveLength(2);
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
    const r = install({ args: ['server', '--name', 'acme'], tty: 'https://hornhoof.my.test\n', env: { STUB_SETUP_LINK: link } });
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

  it('takes localhost when Enter is pressed for the address', () => {
    const r = install({ args: ['server'], tty: '\n' });
    expect(readFileSync(join(r.dir, 'home', 'hornhoof', '.env'), 'utf8')).toContain('PUBLIC_URL=http://localhost:8080');
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
    writeFileSync(join(dir, '.env'), 'HORNHOOF_SECRET=keep-me\nNODE_KEY=k\nPUBLIC_URL=http://localhost:8080\nCOMPOSE_PROJECT_NAME=hornhoof\nHORNHOOF_VERSION=0.4.0\n');
    const compose = join(dir, 'brought.yaml');
    writeFileSync(compose, 'services: {app: {}}\n');
    const r = install({
      args: ['server'],
      tty: '',
      env: {
        HORNHOOF_FROM_UPDATER: '1',
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
    /* compose starts exactly the images the updater checked. */
    expect(env).toMatch(new RegExp(`^HORNHOOF_APP_REF=ghcr\\.io/invariant0x/hornhoof@sha256:${'b'.repeat(64)}$`, 'm'));
    expect(env).toMatch(new RegExp(`^HORNHOOF_NODE_REF=ghcr\\.io/invariant0x/hornhoof-node@sha256:${'d'.repeat(64)}$`, 'm'));
    expect(env).toMatch(new RegExp(`^HORNHOOF_UPDATER_REF=ghcr\\.io/invariant0x/hornhoof-updater@sha256:${'f'.repeat(64)}$`, 'm'));
    expect(r.calls.some(c => c.startsWith('curl'))).toBe(false);
    expect(r.calls.some(c => c.startsWith('docker create') || c.startsWith('docker info'))).toBe(false);
    /* The updater downloaded every image before it saved the database, so this only starts them. */
    expect(r.calls.some(c => c.startsWith('docker pull') || c.startsWith('docker compose pull'))).toBe(false);
    expect(r.calls).toContain('docker compose up -d --no-build db app node tunnel');
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
    const r = install({ args: ['server'], tty: '', env: { HORNHOOF_FROM_UPDATER: '1', HORNHOOF_SERVER_DIR: dir, HORNHOOF_VERSION: '0.4.1', HORNHOOF_COMPOSE_FILE: compose } });
    expect(r.code).toBe(0);
    expect(indexOf(r.calls, 'docker compose pull')).toBeGreaterThanOrEqual(0);
    expect(indexOf(r.calls, 'docker compose pull')).toBeLessThan(indexOf(r.calls, 'docker compose up -d --no-build db app node tunnel'));
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
        HORNHOOF_FROM_UPDATER: '1',
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
        HORNHOOF_FROM_UPDATER: '1',
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
        HORNHOOF_FROM_UPDATER: '1',
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
