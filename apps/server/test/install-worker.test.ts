import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODE, SERVER, SUB_A, install } from './install-script-helpers.js';

/* What the server answers a join of the installer that asks for the core. */
const TICKET = 'T'.repeat(43);
const COMPANY = '0f0f0f0f-0000-4000-8000-00000000000a';
const APP = 'ghcr.io/invariant0x/hornhoof';
const BUILD = `build ${'b'.repeat(40)} ${APP}@sha256:${'1'.repeat(64)} ${APP}-node@sha256:${'2'.repeat(64)} ${APP}-updater@sha256:${'3'.repeat(64)}`;
const CORE = `core hornhoof-qwerty ${TICKET} 8080 ${COMPANY}`;
const MACHINE = `${SUB_A} machine node-key-aaaaaaaaaaaaaaaa`;
const body = (...lines: string[]) => lines.map(line => `${line}\\n`).join('');
const UNREADABLE = 'Hornhoof sent a line this installer cannot read. Update Hornhoof and get a new command.';

const home = (dir: string) => join(dir, 'home');
const dotEnv = (dir: string, folder = 'hornhoof-qwerty') => readFileSync(join(home(dir), folder, '.env'), 'utf8');
const valueOf = (text: string, key: string) => text.split('\n').filter(line => line.startsWith(`${key}=`)).map(line => line.slice(key.length + 1));
const folders = (dir: string) => readdirSync(home(dir)).filter(name => name.startsWith('hornhoof-')).sort();
const up = (calls: string[]) => calls.filter(call => /^docker compose .*\bup\b/.test(call));

describe('install.sh on a machine that joins', () => {
  it("starts the company's core alone, and its node at the machine's own front", () => {
    const r = install({ env: { STUB_JOIN_BODY: body(CORE, MACHINE) } });
    expect(r.out).not.toContain(UNREADABLE);
    expect(r.code).toBe(0);
    /* The join asks for the core. */
    expect(r.calls.find(call => call.startsWith('curl-data'))).toContain('"core":true');
    const env = dotEnv(r.dir);
    expect(valueOf(env, 'COMPOSE_PROJECT_NAME')).toEqual(['hornhoof-qwerty']);
    expect(valueOf(env, 'COMPOSE_FILE')).toEqual(['compose.yaml:compose.worker.yaml']);
    expect(valueOf(env, 'HORNHOOF_SERVER_DIR')).toEqual([join(home(r.dir), 'hornhoof-qwerty')]);
    expect(valueOf(env, 'HORNHOOF_ROLE')).toEqual(['worker']);
    expect(valueOf(env, 'HORNHOOF_COMPANY')).toEqual([COMPANY]);
    expect(valueOf(env, 'HORNHOOF_JOIN_SERVER')).toEqual([SERVER]);
    expect(valueOf(env, 'HORNHOOF_JOIN_TICKET')).toEqual([TICKET]);
    expect(valueOf(env, 'HORNHOOF_MACHINE_ID')[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(valueOf(env, 'HORNHOOF_HOSTNAME')).toEqual(['test-box']);
    expect(valueOf(env, 'HORNHOOF_HOST_OS')).toEqual(['linux']);
    expect(valueOf(env, 'HORNHOOF_HEALTH_URL')).toEqual(['http://keeper:7080/api/keeper']);
    expect(valueOf(env, 'HORNHOOF_PORT')).toEqual(['8080']);
    expect(valueOf(env, 'HORNHOOF_PEER_PORT')).toEqual(['8180']);
    expect(valueOf(env, 'HORNHOOF_APP_REF')).toEqual([`${APP}:latest`]);
    expect(statSync(join(home(r.dir), 'hornhoof-qwerty', '.env')).mode & 0o777).toBe(0o600);
    /* It holds no secret of the company, and nothing turns the data services on. */
    for (const key of ['HORNHOOF_SECRET', 'NODE_KEY', 'POSTGRES_PASSWORD', 'PUBLIC_URL', 'COMPOSE_PROFILES']) expect(valueOf(env, key), key).toEqual([]);
    for (const file of ['compose.yaml', 'compose.worker.yaml']) expect(existsSync(join(home(r.dir), 'hornhoof-qwerty', file)), file).toBe(true);
    expect(readFileSync(join(r.dir, 'registry'), 'utf8')).toBe(`${join(home(r.dir), 'hornhoof-qwerty')} 8080 8180\n`);
    expect(up(r.calls)).toEqual(['docker compose up -d --no-build keeper front', 'docker compose up -d --no-build']);
    expect(r.calls.some(call => call.startsWith('curl') && call.includes('http://localhost:8080/api/keeper'))).toBe(true);
    /* The node goes to the core's front, as a container reaches its host, and keeps the company's address on its label. */
    expect(r.calls).toContain(`stdin http://host.docker.internal:8080 ${SUB_A} machine node-key-aaaaaaaaaaaaaaaa`);
    const started = r.calls.find(call => call.startsWith('docker run -d'))!;
    expect(started).toContain('--add-host host.docker.internal:host-gateway');
    expect(started).toContain(`--label hornhoof.server=${SERVER}`);
  });

  it("lets the core's updater move the nodes from now on", () => {
    const r = install({ env: { STUB_JOIN_BODY: body(CORE, MACHINE), STUB_NODES_UPDATER: 'nodes-updater-1' } });
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toContain('docker rm -f nodes-updater-1');
    expect(r.calls.some(call => call.includes('start-nodes'))).toBe(false);
  });

  it('takes a core line alone, with or without the build, and starts no node', () => {
    for (const lines of [[CORE], [BUILD, CORE]]) {
      const r = install({ env: { STUB_JOIN_BODY: body(...lines) } });
      expect(r.code, r.out).toBe(0);
      expect(r.calls.some(call => call.startsWith('docker run -d'))).toBe(false);
      expect(r.out).toContain("The company's core is on this machine now.");
      expect(folders(r.dir)).toEqual(['hornhoof-qwerty']);
    }
  });

  it.each([
    ['a ticket of 42 characters', `core hornhoof-qwerty ${'T'.repeat(42)} 8080 ${COMPANY}`],
    ['a folder outside the home folder', `core ../etc ${TICKET} 8080 ${COMPANY}`],
    ['a port that is no port', `core hornhoof-qwerty ${TICKET} 80 ${COMPANY}`],
    ['a company that is no id', `core hornhoof-qwerty ${TICKET} 8080 acme`],
    ['a word too many', `${CORE} more`],
    ['an image of another repository', BUILD.replace(`${APP}-node@`, 'ghcr.io/acme/other@')],
    ['an image by a tag', BUILD.replace(`${APP}@sha256:${'1'.repeat(64)}`, `${APP}:latest`)],
    ['a core-here with no port', 'core-here'],
  ])('refuses %s, and starts nothing', (_name, line) => {
    const r = install({ env: { STUB_JOIN_BODY: body(line, MACHINE) } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(UNREADABLE);
    expect(folders(r.dir)).toEqual([]);
    expect(r.calls.some(call => call.startsWith('docker run -d') || /^docker compose .*\bup\b/.test(call))).toBe(false);
  });

  it('takes the build the server runs', () => {
    const r = install({ env: { STUB_JOIN_BODY: body(BUILD, CORE, MACHINE) } });
    expect(r.code, r.out).toBe(0);
    const env = dotEnv(r.dir);
    expect(valueOf(env, 'HORNHOOF_VERSION')).toEqual(['b'.repeat(40)]);
    expect(valueOf(env, 'HORNHOOF_APP_REF')).toEqual([`${APP}@sha256:${'1'.repeat(64)}`]);
    expect(valueOf(env, 'HORNHOOF_NODE_REF')).toEqual([`${APP}-node@sha256:${'2'.repeat(64)}`]);
    expect(valueOf(env, 'HORNHOOF_UPDATER_REF')).toEqual([`${APP}-updater@sha256:${'3'.repeat(64)}`]);
    /* The compose files come from that very image, and the node runs that very node image. */
    expect(r.calls).toContain(`docker create ${APP}@sha256:${'1'.repeat(64)}`);
    expect(r.calls.some(call => call.startsWith('docker create') && call.endsWith(':latest'))).toBe(false);
    expect(r.calls).toContain(`docker pull ${APP}-node@sha256:${'2'.repeat(64)}`);
    expect(r.calls.find(call => call.startsWith('docker run -d'))).toContain(`${APP}-node@sha256:${'2'.repeat(64)}`);
  });

  it('downloads nothing when the images are here already', () => {
    const r = install({ env: { STUB_JOIN_BODY: body(CORE), HORNHOOF_PULLED: '1', HORNHOOF_APP_REF: `${APP}@sha256:${'9'.repeat(64)}` } });
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toContain(`docker create ${APP}@sha256:${'9'.repeat(64)}`);
    expect(r.calls.filter(call => call.startsWith('docker pull') && !call.includes('hornhoof-node'))).toEqual([]);
    expect(r.calls.some(call => /^docker compose .*pull/.test(call))).toBe(false);
  });

  it('goes on when the place in the company is late', () => {
    const r = install({ env: { STUB_JOIN_BODY: body(CORE, MACHINE), STUB_KEEPER: '{"certificate":false}', HORNHOOF_CORE_WAIT: '2' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("This machine's core started, and keeps trying to reach the company server. See docker compose logs keeper in");
    expect(r.calls.some(call => call.startsWith('docker run -d'))).toBe(true);
  });

  it("takes the next port when the server's is taken here", () => {
    const r = install({ env: { STUB_JOIN_BODY: body(CORE, MACHINE), STUB_BOUND_PORTS: '8080' } });
    expect(r.code, r.out).toBe(0);
    expect(valueOf(dotEnv(r.dir), 'HORNHOOF_PORT')).toEqual(['8081']);
    expect(r.calls).toContain(`stdin http://host.docker.internal:8081 ${SUB_A} machine node-key-aaaaaaaaaaaaaaaa`);
    /* A port other than the first, which the server has and nothing holds here, is taken as it is. */
    const other = install({ env: { STUB_JOIN_BODY: body(CORE.replace(' 8080 ', ' 9090 '), MACHINE) } });
    expect(valueOf(dotEnv(other.dir), 'HORNHOOF_PORT')).toEqual(['9090']);
  });

  /* The core's updater keeps every node of the company on the core's own build, so a node on the server's newer one would
     be made anew on the older within minutes, under a sign-in that is going on. */
  it("starts a node that joins later on the build its machine's core runs", () => {
    const first = install({ env: { STUB_JOIN_BODY: body(BUILD, CORE) } });
    expect(first.code, first.out).toBe(0);
    const before = dotEnv(first.dir);
    const NEWER = `build ${'c'.repeat(40)} ${APP}@sha256:${'7'.repeat(64)} ${APP}-node@sha256:${'8'.repeat(64)} ${APP}-updater@sha256:${'9'.repeat(64)}`;
    const second = install({
      env: { STUB_JOIN_BODY: body(NEWER, `core hornhoof-qwerty ${'U'.repeat(43)} 8080 ${COMPANY}`, MACHINE), HOME: home(first.dir), HORNHOOF_HOME: join(home(first.dir), '.hornhoof'), HORNHOOF_DIR: join(home(first.dir), 'hornhoof'), STUB_PORTS_DIR: first.dir },
    });
    expect(second.code, second.out).toBe(0);
    expect(second.calls.find(call => call.startsWith('docker run -d'))).toContain(`${APP}-node@sha256:${'2'.repeat(64)}`);
    expect(second.calls.some(call => call.includes(`${APP}-node@sha256:${'8'.repeat(64)}`))).toBe(false);
    const kept = (text: string) => text.split('\n').filter(line => line && !line.startsWith('HORNHOOF_JOIN_TICKET=')).sort();
    expect(kept(dotEnv(first.dir))).toEqual(kept(before));
  });

  it("finds this company's folder again, and leaves another company's alone", () => {
    const first = install({ env: { STUB_JOIN_BODY: body(CORE) } });
    const again = (lines: string[], env: Record<string, string> = {}) =>
      install({ env: { STUB_JOIN_BODY: body(...lines), HOME: home(first.dir), HORNHOOF_HOME: join(home(first.dir), '.hornhoof'), HORNHOOF_DIR: join(home(first.dir), 'hornhoof'), STUB_PORTS_DIR: first.dir, ...env } });
    const before = dotEnv(first.dir);
    /* The same company, with a new ticket and under another name the server gives its folder now. */
    const second = again([`core hornhoof-acme ${'U'.repeat(43)} 8080 ${COMPANY}`]);
    expect(second.code, second.out).toBe(0);
    expect(folders(first.dir)).toEqual(['hornhoof-qwerty']);
    expect(valueOf(dotEnv(first.dir), 'HORNHOOF_JOIN_TICKET')).toEqual(['U'.repeat(43)]);
    /* Nothing else of its settings changed: its ports, its images, its id. */
    const kept = (text: string) => text.split('\n').filter(line => line && !line.startsWith('HORNHOOF_JOIN_TICKET=')).sort();
    expect(kept(dotEnv(first.dir))).toEqual(kept(before));
    /* Another company whose server names the same folder gets one beside it, with ports of its own. */
    const other = again([`core hornhoof-qwerty ${TICKET} 8080 0f0f0f0f-0000-4000-8000-00000000000b`]);
    expect(other.code, other.out).toBe(0);
    expect(folders(first.dir)).toEqual(['hornhoof-qwerty', 'hornhoof-qwerty-2']);
    expect(valueOf(dotEnv(first.dir, 'hornhoof-qwerty-2'), 'HORNHOOF_PORT')).toEqual(['8081']);
    expect(valueOf(dotEnv(first.dir, 'hornhoof-qwerty-2'), 'COMPOSE_PROJECT_NAME')).toEqual(['hornhoof-qwerty-2']);
  });

  it('says so when there is no room for one more folder', () => {
    const first = install({ env: { STUB_JOIN_BODY: body(CORE) } });
    for (let n = 2; n <= 9; n++) mkdirSync(join(home(first.dir), `hornhoof-qwerty-${n}`));
    const r = install({ env: { STUB_JOIN_BODY: body(`core hornhoof-qwerty ${TICKET} 8080 0f0f0f0f-0000-4000-8000-00000000000c`), HOME: home(first.dir), HORNHOOF_HOME: join(home(first.dir), '.hornhoof'), HORNHOOF_DIR: join(home(first.dir), 'hornhoof') } });
    expect(r.out).toContain('There are 9 Hornhoof folders here already. Remove one you do not use.');
    expect(r.out).toContain("The company's core could not be set up on this machine");
    expect(folders(first.dir)).toHaveLength(9);
  });

  it("points nodes at the server's own front on its computer, and makes no folder", () => {
    const r = install({ env: { STUB_JOIN_BODY: body('core-here 8090', MACHINE) } });
    expect(r.code, r.out).toBe(0);
    expect(folders(r.dir)).toEqual([]);
    expect(up(r.calls)).toEqual([]);
    expect(r.calls).toContain(`stdin http://host.docker.internal:8090 ${SUB_A} machine node-key-aaaaaaaaaaaaaaaa`);
    expect(r.calls.find(call => call.startsWith('docker run -d'))).toContain('--add-host host.docker.internal:host-gateway');
  });

  it("carries the owner's key into the core, and nowhere else", () => {
    const key = 'Ab-_'.repeat(30) + 'Zz';
    const first = install({ args: ['--join', CODE, '--owner-key', key], env: { STUB_JOIN_BODY: body(CORE) } });
    expect(first.code, first.out).toBe(0);
    expect(valueOf(dotEnv(first.dir), 'HORNHOOF_OWNER_KEY')).toEqual([key]);
    /* The server never hears it. */
    expect(first.calls.filter(call => call.includes(key))).toEqual([]);
    const again = (args: string[], lines = [CORE]) =>
      install({ args, env: { STUB_JOIN_BODY: body(...lines), HOME: home(first.dir), HORNHOOF_HOME: join(home(first.dir), '.hornhoof'), HORNHOOF_DIR: join(home(first.dir), 'hornhoof'), STUB_PORTS_DIR: first.dir } });
    /* A command without the key keeps the one the core has; one with another key brings that one. */
    again(['--join', CODE]);
    expect(valueOf(dotEnv(first.dir), 'HORNHOOF_OWNER_KEY')).toEqual([key]);
    const other = key.replace('Zz', 'Yy');
    again(['--join', CODE, '--owner-key', other]);
    expect(valueOf(dotEnv(first.dir), 'HORNHOOF_OWNER_KEY')).toEqual([other]);

    /* With no core in the answer there is nowhere to keep it. */
    const nodeOnly = install({ args: ['--join', CODE, '--owner-key', key], env: { STUB_JOIN_BODY: body(MACHINE) } });
    expect(nodeOnly.code).toBe(0);
    expect(folders(nodeOnly.dir)).toEqual([]);
    /* A key that cannot be one stops the command before anything is asked. */
    for (const bad of [`${key}$`, 'short', `${key} more`]) {
      const refused = install({ args: ['--join', CODE, '--owner-key', bad], env: { STUB_JOIN_BODY: body(CORE) } });
      expect(refused.code, bad).toBe(1);
      expect(refused.out).toContain("This command's owner key cannot be read. Get a new command in Hornhoof.");
      expect(refused.calls).toEqual([]);
    }
  });

  it("writes a Mac's addresses down, since Docker there cannot see them", () => {
    const r = install({ env: { STUB_JOIN_BODY: body(CORE), STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_IPCONFIG: 'en0=192.168.1.20 en1=10.0.0.4' } });
    expect(r.code, r.out).toBe(0);
    expect(valueOf(dotEnv(r.dir), 'HORNHOOF_HOST_OS')).toEqual(['darwin']);
    expect(valueOf(dotEnv(r.dir), 'HORNHOOF_ADDRESSES')).toEqual(['192.168.1.20,10.0.0.4']);
    const none = install({ env: { STUB_JOIN_BODY: body(CORE), STUB_OS: 'Darwin', STUB_ARCH: 'arm64' } });
    expect(valueOf(dotEnv(none.dir), 'HORNHOOF_ADDRESSES')).toEqual([]);
  });

  /* The join used the command up by then, so the node it brought must not be lost with the core. */
  it('starts the joined node all the same when the core cannot be set up, and says so', () => {
    const failures: Record<string, string>[] = [{ STUB_NO_OVERLAY: '1' }, { STUB_UP_FAIL: 'keeper' }, { STUB_REGISTRY: 'unreadable' }];
    for (const env of failures) {
      const r = install({ env: { STUB_JOIN_BODY: body(CORE, MACHINE), ...env } });
      expect(r.code, JSON.stringify(env)).toBe(0);
      expect(r.out).toContain("The company's core could not be set up on this machine, so what this command connects reaches the company directly for now.");
      /* The node reaches the company at the address the command came from. */
      expect(r.calls).toContain(`stdin ${SERVER} ${SUB_A} machine node-key-aaaaaaaaaaaaaaaa`);
      expect(r.calls.some(call => call.startsWith('docker run -d'))).toBe(true);
    }
    const old = install({ env: { STUB_JOIN_BODY: body(CORE, MACHINE), STUB_NO_OVERLAY: '1' } });
    expect(old.out).toContain('is a build from before machines had the company\'s core. Update Hornhoof, then get a new command.');
  });

  it('chooses ports for a folder a run left half made', () => {
    const first = install({ env: { STUB_JOIN_BODY: body(CORE), STUB_UP_FAIL: 'keeper' } });
    expect(valueOf(dotEnv(first.dir), 'HORNHOOF_PORT')).toEqual(['8080']);
    /* A run that stopped before the ports: the line is there and empty, and something took 8080 meanwhile. */
    const stopped = install({ env: { STUB_JOIN_BODY: body(CORE), STUB_REGISTRY: 'unreadable' } });
    expect(valueOf(dotEnv(stopped.dir), 'HORNHOOF_PORT')).toEqual(['']);
    const again = install({ env: { STUB_JOIN_BODY: body(CORE), HOME: home(stopped.dir), HORNHOOF_HOME: join(home(stopped.dir), '.hornhoof'), HORNHOOF_DIR: join(home(stopped.dir), 'hornhoof'), STUB_PORTS_DIR: stopped.dir, STUB_BOUND_PORTS: '8080' } });
    expect(again.code, again.out).toBe(0);
    expect(valueOf(dotEnv(stopped.dir), 'HORNHOOF_PORT')).toEqual(['8081']);
  });

  it('says so when Docker Compose is too old for the compose file', () => {
    for (const version of ['2.19.1', 'v2.17.0', '1.29.2']) {
      const r = install({ args: ['server'], tty: '\n', env: { STUB_COMPOSE_VERSION: version } });
      expect(r.code, version).toBe(1);
      expect(r.out).toContain('is too old for this Hornhoof, which needs 2.20 or newer. Update Docker, then run this command again.');
      expect(up(r.calls)).toEqual([]);
    }
    for (const version of ['2.20.0', 'v2.39.4', '5.0.1', 'unknown']) expect(install({ args: ['server'], tty: '\n', env: { STUB_COMPOSE_VERSION: version } }).code, version).toBe(0);
  });
});

describe('install.sh on a machine that has the core', () => {
  const NODE = 'hornhoof-claude-1c07dac4';
  /* A machine whose core for this server is set up, with a node from before it that names the company's own address. */
  function withCore(nodeEnv: Record<string, string> = {}) {
    const first = install({ env: { STUB_JOIN_BODY: body(CORE) } });
    const shared = { HOME: home(first.dir), HORNHOOF_HOME: join(home(first.dir), '.hornhoof'), HORNHOOF_DIR: join(home(first.dir), 'hornhoof'), STUB_PORTS_DIR: first.dir };
    return { first, shared: { ...shared, STUB_CONTAINERS: `${NODE}=${SERVER}`, STUB_NODE_SERVERS: `${NODE}=${SERVER}`, ...nodeEnv } };
  }

  it("moves an old node to its machine's front when it restarts it anyway", () => {
    const { shared } = withCore();
    const r = install({ args: [], env: shared });
    expect(r.code, r.out).toBe(0);
    const moved = r.calls.findIndex(call => call.startsWith('docker run --rm -i') && call.endsWith(' set-server'));
    expect(moved).toBeGreaterThanOrEqual(0);
    expect(r.calls[moved]).toContain(`-v ${NODE}:/data`);
    expect(r.calls[moved]).toContain('--network none');
    expect(r.calls[moved + 1]).toBe('stdin http://host.docker.internal:8080');
    expect(moved).toBeLessThan(r.calls.findIndex(call => call.startsWith('docker run -d')));
    /* One that is there already is not moved again, and one that cannot be moved goes on as it was. */
    const there = install({ args: [], env: { ...shared, STUB_NODE_SERVERS: `${NODE}=http://host.docker.internal:8080` } });
    expect(there.calls.some(call => call.endsWith(' set-server'))).toBe(false);
    const stuck = install({ args: [], env: { ...shared, STUB_SET_SERVER: 'fail' } });
    expect(stuck.code).toBe(0);
    expect(stuck.out).toContain(`Could not point ${NODE} at this machine's own address, so it goes on through ${SERVER}.`);
    expect(stuck.calls.some(call => call.startsWith('docker run -d'))).toBe(true);
  });

  it('leaves the nodes of a machine with no core where they are', () => {
    const r = install({ args: [], env: { STUB_CONTAINERS: `${NODE}=${SERVER}`, STUB_NODE_SERVERS: `${NODE}=${SERVER}` } });
    expect(r.code).toBe(0);
    expect(r.calls.some(call => call.endsWith(' set-server'))).toBe(false);
  });

  it('updates a worker from the updater: its keeper and front, and a node only when its image changed', () => {
    const { first, shared } = withCore();
    const core = join(home(first.dir), 'hornhoof-qwerty');
    const brought = join(first.dir, 'brought');
    mkdirSync(brought);
    for (const file of ['compose.yaml', 'compose.worker.yaml']) writeFileSync(join(brought, file), `# the build's ${file}\nservices: {}\n`);
    const refs = { HORNHOOF_APP_REF: `${APP}@sha256:${'4'.repeat(64)}`, HORNHOOF_NODE_REF: `${APP}-node@sha256:${'5'.repeat(64)}`, HORNHOOF_UPDATER_REF: `${APP}-updater@sha256:${'6'.repeat(64)}` };
    const fromUpdater = { ...shared, ...refs, HORNHOOF_FROM_UPDATER: '1', HORNHOOF_UPDATER_REV: '2', HORNHOOF_SERVER_DIR: core, HORNHOOF_VERSION: '0.19.0', HORNHOOF_COMPOSE_FILE: join(brought, 'compose.yaml'), HORNHOOF_PULLED: '1', HORNHOOF_SERVER: '' };
    const r = install({ args: ['worker'], env: fromUpdater, tty: '' });
    expect(r.code, r.out).toBe(0);
    expect(up(r.calls)).toEqual(['docker compose up -d --no-build keeper front']);
    expect(readFileSync(join(core, 'compose.worker.yaml'), 'utf8')).toContain("the build's compose.worker.yaml");
    const env = readFileSync(join(core, '.env'), 'utf8');
    expect(valueOf(env, 'HORNHOOF_VERSION')).toEqual(['0.19.0']);
    expect(valueOf(env, 'HORNHOOF_APP_REF')).toEqual([refs.HORNHOOF_APP_REF]);
    expect(valueOf(env, 'HORNHOOF_JOIN_TICKET')).toEqual([TICKET]);
    expect(r.calls.some(call => call.startsWith('docker pull') || / pull$/.test(call))).toBe(false);
    /* The node runs another image: it is moved to the front and started on the build's node image. */
    const started = r.calls.find(call => call.startsWith('docker run -d'))!;
    expect(started).toContain(refs.HORNHOOF_NODE_REF);
    expect(started).toContain(`--label hornhoof.server=${SERVER}`);
    expect(r.calls).toContain('stdin http://host.docker.internal:8080');
    /* One that runs that image already is left alone. */
    const same = install({ args: ['worker'], env: { ...fromUpdater, STUB_NODE_IMAGES: `${NODE}=${refs.HORNHOOF_NODE_REF}` }, tty: '' });
    expect(same.code).toBe(0);
    expect(same.calls.some(call => call.startsWith('docker run -d') || call.startsWith('docker stop'))).toBe(false);
  });

  it('updates a machine that keeps a copy as a joined machine, with its database and its app', () => {
    const { first, shared } = withCore();
    const core = join(home(first.dir), 'hornhoof-qwerty');
    const brought = join(first.dir, 'brought');
    mkdirSync(brought);
    for (const file of ['compose.yaml', 'compose.worker.yaml']) writeFileSync(join(brought, file), `# the build's ${file}\nservices: {}\n`);
    /* Its updater made it a data machine since it joined. */
    const env = readFileSync(join(core, '.env'), 'utf8');
    writeFileSync(join(core, '.env'), `${env.replace('HORNHOOF_ROLE=worker', 'HORNHOOF_ROLE=data')}COMPOSE_PROFILES=data\n`);
    const fromUpdater = { ...shared, HORNHOOF_FROM_UPDATER: '1', HORNHOOF_UPDATER_REV: '2', HORNHOOF_SERVER_DIR: core, HORNHOOF_VERSION: '0.19.0', HORNHOOF_COMPOSE_FILE: join(brought, 'compose.yaml'), HORNHOOF_PULLED: '1', STUB_SERVICES: 'front keeper db migrate app updater' };
    const r = install({ args: ['worker'], env: fromUpdater, tty: '' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("is a server's folder");
    expect(up(r.calls)).toEqual(['docker compose up -d --no-build front keeper db migrate app']);
    /* With its built-in node turned on, that starts too; the updater never does, since it is replaced after them. */
    writeFileSync(join(core, '.env'), readFileSync(join(core, '.env'), 'utf8').replace('COMPOSE_PROFILES=data\n', 'COMPOSE_PROFILES=data,builtin\n'));
    const builtin = install({ args: ['worker'], env: { ...fromUpdater, STUB_SERVICES: 'front keeper db migrate app node updater' }, tty: '' });
    expect(builtin.code, builtin.out).toBe(0);
    expect(up(builtin.calls)).toEqual(['docker compose up -d --no-build front keeper db migrate app node']);
    writeFileSync(join(core, '.env'), readFileSync(join(core, '.env'), 'utf8').replace('COMPOSE_PROFILES=data,builtin\n', 'COMPOSE_PROFILES=data\n'));
    const after = readFileSync(join(core, '.env'), 'utf8');
    expect(valueOf(after, 'HORNHOOF_ROLE')).toEqual(['data']);
    expect(valueOf(after, 'COMPOSE_PROFILES')).toEqual(['data']);
    expect(valueOf(after, 'HORNHOOF_VERSION')).toEqual(['0.19.0']);
    /* A server's own folder is still refused. */
    writeFileSync(join(core, '.env'), after.split('\n').filter(line => !line.startsWith('COMPOSE_FILE=')).join('\n'));
    const server = install({ args: ['worker'], env: fromUpdater, tty: '' });
    expect(server.code).toBe(1);
    expect(server.out).toContain("is a server's folder: run install.sh server there.");
  });

  it("knows the company by every address it was joined through", () => {
    const { first, shared } = withCore();
    const core = join(home(first.dir), 'hornhoof-qwerty');
    const LINK = 'https://acme.hornhoof.test';
    const LINKED = 'hornhoof-codex-9f1e2d3c';
    /* A second command, copied from the company's public link, on the same machine. */
    const second = install({ env: { ...shared, HORNHOOF_SERVER: LINK, STUB_JOIN_BODY: body(`core hornhoof-acme ${'U'.repeat(43)} 8080 ${COMPANY}`), STUB_CONTAINERS: '' } });
    expect(second.code, second.out).toBe(0);
    const env = readFileSync(join(core, '.env'), 'utf8');
    /* The keeper redeems the new ticket where this command came from, and both addresses are the company's. */
    expect(valueOf(env, 'HORNHOOF_JOIN_SERVER')).toEqual([LINK]);
    expect(valueOf(env, 'HORNHOOF_SERVERS')).toEqual([`${SERVER},${LINK}`]);
    /* A core from before it kept the list knows the address it first joined through all the same. */
    writeFileSync(join(core, '.env'), env.split('\n').filter(line => !line.startsWith('HORNHOOF_SERVERS=')).join('\n').replace(`HORNHOOF_JOIN_SERVER=${LINK}`, `HORNHOOF_JOIN_SERVER=${SERVER}`));
    const third = install({ env: { ...shared, HORNHOOF_SERVER: LINK, STUB_JOIN_BODY: body(`core hornhoof-acme ${'V'.repeat(43)} 8080 ${COMPANY}`), STUB_CONTAINERS: '' } });
    expect(third.code, third.out).toBe(0);
    expect(valueOf(readFileSync(join(core, '.env'), 'utf8'), 'HORNHOOF_SERVERS')).toEqual([`${SERVER},${LINK}`]);
    writeFileSync(join(core, '.env'), env);
    /* The updater moves the nodes of both, and the nodes of no other company. */
    const refs = { HORNHOOF_APP_REF: `${APP}@sha256:${'4'.repeat(64)}`, HORNHOOF_NODE_REF: `${APP}-node@sha256:${'5'.repeat(64)}`, HORNHOOF_UPDATER_REF: `${APP}-updater@sha256:${'6'.repeat(64)}` };
    const containers = `${NODE}=${SERVER} ${LINKED}=${LINK} hornhoof-kimi-aaaaaaaa=https://other.example.test`;
    const r = install({ args: ['worker'], tty: '', env: { ...shared, ...refs, HORNHOOF_FROM_UPDATER: '1', HORNHOOF_UPDATER_REV: '2', HORNHOOF_SERVER_DIR: core, HORNHOOF_VERSION: '0.19.0', HORNHOOF_PULLED: '1', HORNHOOF_WORKER_NODES: '1', HORNHOOF_SERVER: '', STUB_CONTAINERS: containers } });
    expect(r.code, r.out).toBe(0);
    const started = r.calls.filter(call => call.startsWith('docker run -d')).map(call => call.match(/--name (\S+)/)![1]);
    expect(started.sort()).toEqual([NODE, LINKED].sort());
    /* Asked for the nodes alone, it leaves the core as it runs. */
    expect(up(r.calls)).toEqual([]);
    expect(readFileSync(join(core, '.env'), 'utf8')).toBe(env);
    /* An uninstall asked for from either address takes the core and the nodes of both. */
    const gone = install({ args: ['--uninstall'], tty: 'y\nn\n', env: { ...shared, HORNHOOF_SERVER: LINK, STUB_CONTAINERS: containers } });
    expect(gone.code, gone.out).toBe(0);
    expect(gone.calls).toContain(`docker rm -f ${NODE}`);
    expect(gone.calls).toContain(`docker rm -f ${LINKED}`);
    expect(gone.calls).not.toContain('docker rm -f hornhoof-kimi-aaaaaaaa');
    expect(existsSync(core)).toBe(false);
  });

  it('runs as a worker only in the folder of a core', () => {
    const r = install({ args: ['worker'], env: { HORNHOOF_FROM_UPDATER: '1' }, tty: '' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('There is no core of a company to update here.');
  });

  it("takes a worker's core down on uninstall, with its folder and its ports", () => {
    const { first, shared } = withCore();
    const core = join(home(first.dir), 'hornhoof-qwerty');
    const kept = install({ args: ['--uninstall'], env: shared, tty: 'n\n' });
    expect(kept.out).toContain(`The company's core on this machine, in ${core}, goes with them.`);
    expect(existsSync(core)).toBe(true);
    const r = install({ args: ['--uninstall'], env: shared, tty: 'y\nn\n' });
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toContain('docker compose down -v');
    expect(existsSync(core)).toBe(false);
    expect(readFileSync(join(first.dir, 'registry'), 'utf8')).toBe('');
    expect(r.calls).toContain(`docker rm -f ${NODE}`);
    /* With no node left, the core alone is asked about. */
    const alone = withCore();
    const only = install({ args: ['--uninstall'], env: { ...alone.shared, STUB_CONTAINERS: '' }, tty: 'y\n' });
    expect(only.code, only.out).toBe(0);
    expect(existsSync(join(home(alone.first.dir), 'hornhoof-qwerty'))).toBe(false);
  });
});

describe('install.sh on Windows, in the run install.ps1 starts', () => {
  const NODE = 'hornhoof-claude-1c07dac4';
  /* Each run is a new container with a home of its own, which goes with it. What install.sh keeps is in the volume
     install.ps1 mounts, the same for every run, as are the ports Docker keeps in a volume of their own. */
  function windowsComputer() {
    const volume = mkdtempSync(join(tmpdir(), 'hh-windows-volume-'));
    const ports = mkdtempSync(join(tmpdir(), 'hh-windows-ports-'));
    const kept = { HORNHOOF_FROM_WINDOWS: '1', HORNHOOF_DIR: join(volume, 'hornhoof'), HORNHOOF_HOME: join(volume, '.hornhoof'), HORNHOOF_LINK_FILE: join(ports, 'open-url'), STUB_PORTS_DIR: ports };
    return { volume, ports, kept, run: (args: string[] | undefined, env: Record<string, string>, tty?: string) => install({ args, tty, env: { ...kept, ...env } }) };
  }

  it('keeps the core in the volume, where the next run and a removal find it from a new container', () => {
    const w = windowsComputer();
    const core = join(w.volume, 'hornhoof-qwerty');
    const joined = w.run(undefined, { STUB_JOIN_BODY: body(CORE, MACHINE) });
    expect(joined.code, joined.out).toBe(0);
    expect(valueOf(readFileSync(join(core, '.env'), 'utf8'), 'HORNHOOF_SERVER_DIR')).toEqual([core]);
    for (const file of ['compose.yaml', 'compose.worker.yaml']) expect(existsSync(join(core, file)), file).toBe(true);
    expect(existsSync(join(home(joined.dir), 'hornhoof-qwerty'))).toBe(false);

    /* The next run, in a new container, finds the core and keeps the node at its front. */
    const nodes = { STUB_CONTAINERS: `${NODE}=${SERVER}`, STUB_NODE_SERVERS: `${NODE}=${SERVER}` };
    const update = w.run([], nodes);
    expect(update.code, update.out).toBe(0);
    expect(update.calls).toContain('stdin http://host.docker.internal:8080');
    expect(update.calls.find(call => call.startsWith('docker run -d'))).toContain('--add-host host.docker.internal:host-gateway');
    expect(readdirSync(w.volume).filter(name => name.startsWith('hornhoof-'))).toEqual(['hornhoof-qwerty']);

    /* A run whose folders went with its container, as before, finds no core: the node is not moved to the front. */
    const lost = install({ args: [], env: { HORNHOOF_FROM_WINDOWS: '1', STUB_PORTS_DIR: w.ports, ...nodes } });
    expect(lost.code, lost.out).toBe(0);
    expect(lost.calls.some(call => call.endsWith(' set-server'))).toBe(false);
    expect(lost.calls.find(call => call.startsWith('docker run -d'))).not.toContain('--add-host');

    /* A removal, in a new container too, takes the core down with its folder and its ports. */
    const gone = w.run(['--uninstall'], nodes, 'y\nn\n');
    expect(gone.code, gone.out).toBe(0);
    expect(gone.out).toContain(`The company's core on this machine, in ${core}, goes with them.`);
    expect(gone.calls).toContain('docker compose down -v');
    expect(existsSync(core)).toBe(false);
    expect(readFileSync(join(w.ports, 'registry'), 'utf8')).toBe('');
  });
});

describe('install.sh server', () => {
  it("writes the computer's name and system down, and names no worker's compose file", () => {
    const r = install({ args: ['server'], tty: '\n', env: { STUB_HOSTNAME: 'debian box!' } });
    expect(r.code, r.out).toBe(0);
    const env = readFileSync(join(home(r.dir), 'hornhoof', '.env'), 'utf8');
    expect(valueOf(env, 'HORNHOOF_HOSTNAME')).toEqual(['debianbox']);
    expect(valueOf(env, 'HORNHOOF_HOST_OS')).toEqual(['linux']);
    expect(valueOf(env, 'COMPOSE_FILE')).toEqual([]);
    expect(existsSync(join(home(r.dir), 'hornhoof', 'compose.worker.yaml'))).toBe(false);
  });

  it('keeps those lines when the updater runs it, whose container is not the computer', () => {
    const r = install({ args: ['server'], tty: '\n' });
    const folder = join(home(r.dir), 'hornhoof');
    const before = readFileSync(join(folder, '.env'), 'utf8');
    const again = install({
      args: ['server'], tty: '',
      env: { HOME: home(r.dir), HORNHOOF_DIR: folder, HORNHOOF_HOME: join(home(r.dir), '.hornhoof'), STUB_PORTS_DIR: r.dir, HORNHOOF_FROM_UPDATER: '1', HORNHOOF_UPDATER_REV: '2', HORNHOOF_SERVER_DIR: folder, STUB_HOSTNAME: 'updater-container', STUB_OS: 'Linux' },
    });
    expect(again.code, again.out).toBe(0);
    const after = readFileSync(join(folder, '.env'), 'utf8');
    expect(valueOf(after, 'HORNHOOF_HOSTNAME')).toEqual(valueOf(before, 'HORNHOOF_HOSTNAME'));
    expect(valueOf(after, 'HORNHOOF_HOST_OS')).toEqual(['linux']);
  });
});

/* The code of a join is never part of what a test prints. */
void CODE;
