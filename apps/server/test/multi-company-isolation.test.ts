import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql as raw } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { encryptSecret } from '../src/crypto/secrets.js';
import { companies, machines, peerSecrets, people, publicLinks } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { REPLICA_FILE } from '../src/modules/keeper/become.js';
import { COPY_STATE } from '../src/modules/keeper/copy.js';
import { Hander, readHanding } from '../src/modules/keeper/handing.js';
import { handoverOf, recordHandover, termOf, writeTerm } from '../src/modules/keeper/promote.js';
import { SWITCH_MS, type TakeState } from '../src/modules/keeper/switch-step.js';
import { Promoter, readTaking, Taker, type OwnSubscription } from '../src/modules/keeper/taking.js';
import { linkClientId } from '../src/modules/link/client.js';
import { PublicLinks } from '../src/modules/link/link.js';
import { peerClientId, peerConfigFor, serviceName } from '../src/modules/link/peer-client.js';
import type { Bound, SyncRecord } from '../src/modules/link/relay.js';
import { visitClientId, visitConfigFor } from '../src/modules/link/visit-client.js';
import { createTestSql, ownDatabases, TEST_SECRET } from './helpers.js';
import { CODE, install, SUB_A } from './install-script-helpers.js';
import { ask, runOnce, stand } from './updater-fixture.js';

/* Multi-company leader/copy/switch tests write net_local terms directly, so each test gets isolated databases. */
ownDatabases();

const COMPOSE_PATH = fileURLToPath(new URL('../../../compose.yaml', import.meta.url));
const WORKER_COMPOSE_PATH = fileURLToPath(new URL('../../../compose.worker.yaml', import.meta.url));
const INSTALL_GUIDE_PATH = fileURLToPath(new URL('../../../guide/install.md', import.meta.url));

const LAN_ADDR_A = [
  '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
  '2: eth0    inet 192.168.1.10/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever preferred_lft forever',
].join('\n');
const LAN_ROUTE_A = ['default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.10 metric 100', '192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.10 metric 100'].join('\n');

const LAN_ADDR_B = [
  '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
  '2: eth0    inet 192.168.1.20/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever preferred_lft forever',
].join('\n');
const LAN_ROUTE_B = ['default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.20 metric 100', '192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.20 metric 100'].join('\n');

type CidrRange = { cidr: string; start: number; end: number; prefix: number };

function ipToNum(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!);
}

function parseCidr(cidr: string): CidrRange {
  const [ip, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!ip || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ipToNum(ip) / size) * size;
  return { cidr, start, end: start + size - 1, prefix };
}

function cidrsOverlap(a: string, b: string): boolean {
  const ra = parseCidr(a);
  const rb = parseCidr(b);
  return ra.start <= rb.end && rb.start <= ra.end;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const n = ipToNum(ip);
  const r = parseCidr(cidr);
  return n >= r.start && n <= r.end;
}

function envMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

type NetworkRow = { id: string; name: string; project: string; subnet: string; internal: boolean };

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeComputer(ipAddr: string, ipRoute: string) {
  const root = tempDir('hh-machine-');
  const home = join(root, 'home');
  const portsDir = join(root, 'ports');
  mkdirSync(home, { recursive: true });
  mkdirSync(portsDir, { recursive: true });
  const baseEnv = {
    HOME: home,
    HORNHOOF_HOME: join(home, '.hornhoof'),
    HORNHOOF_DIR: join(home, 'hornhoof'),
    STUB_PORTS_DIR: portsDir,
    STUB_REAL_COMPOSE: '1',
    STUB_IP_ADDR: ipAddr,
    STUB_IP_ROUTE: ipRoute,
  };
  return {
    root,
    home,
    portsDir,
    folder: (name = 'hornhoof', userHome = home) => join(userHome, name),
    dotEnv: (name = 'hornhoof', userHome = home) => envMap(readFileSync(join(userHome, name, '.env'), 'utf8')),
    registry: () => (existsSync(join(portsDir, 'registry')) ? readFileSync(join(portsDir, 'registry'), 'utf8').trim().split('\n').filter(Boolean) : []),
    subnets: () => (existsSync(join(portsDir, 'subnets')) ? readFileSync(join(portsDir, 'subnets'), 'utf8').trim().split('\n').filter(Boolean) : []),
    networks: (): NetworkRow[] => {
      if (!existsSync(join(portsDir, 'networks'))) return [];
      return readFileSync(join(portsDir, 'networks'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [id = '', name = '', project = '', subnet = '', internal = 'false'] = line.split('|');
          return { id, name, project, subnet: subnet.replace(/,.*$/, ''), internal: internal === 'true' };
        });
    },
    runServer: (args: string[] = [], env: Record<string, string> = {}, tty = '\n') =>
      install({ args: ['server', ...args], tty, env: { ...baseEnv, ...env } }),
    runJoin: (args: string[] = [], env: Record<string, string> = {}, tty = '\n') =>
      install({ args: ['--join', CODE, ...args], tty, env: { ...baseEnv, ...env } }),
  };
}

const SILENT_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => SILENT_LOG,
} as unknown as FastifyBaseLogger;

describe('Docker subnet selection outside host networks and multi-project isolation', () => {
  it('configures explicit default and internal subnets in compose.yaml while keeping internal isolation', () => {
    const compose = readFileSync(COMPOSE_PATH, 'utf8');
    const workerCompose = readFileSync(WORKER_COMPOSE_PATH, 'utf8');
    expect(compose).toMatch(/^\s*default:\s*\n\s*ipam:\s*\n\s*config:\s*\n\s*-\s*subnet:\s*\$\{HORNHOOF_SUBNET:-10\.200\.0\.0\/24\}/m);
    expect(compose).toMatch(/^\s*internal:\s*\n\s*internal:\s*true\s*\n\s*ipam:\s*\n\s*config:\s*\n\s*-\s*subnet:\s*\$\{HORNHOOF_INTERNAL_SUBNET:-10\.200\.1\.0\/24\}/m);
    expect(workerCompose).not.toMatch(/^networks:/m);
  });

  it('assigns non-overlapping subnets when the computer address falls inside the next Docker pool or default pool', () => {
    /* Host address 192.168.1.20/24 sits inside Docker's next 192.168.0.0/20 pool, and host/Docker routes also cover
       10.200.0.0/24 and 10.200.1.0/24, so the installer must pick non-overlapping subnets outside all of them. */
    const hostAddr = [
      LAN_ADDR_B,
      '3: wg0    inet 10.200.0.5/24 scope global wg0\\       valid_lft forever preferred_lft forever',
    ].join('\n');
    const hostRoute = [
      LAN_ROUTE_B,
      '10.200.0.0/24 dev wg0 proto kernel scope link src 10.200.0.5',
    ].join('\n');
    const otherDockerNet = 'ext000000000001|corp_net|corp|10.200.1.0/24|false|';
    const machine = makeComputer(hostAddr, hostRoute);

    const first = machine.runServer([], { STUB_DOCKER_NETWORKS: otherDockerNet });
    expect(first.code).toBe(0);
    const env = machine.dotEnv();
    expect(env.HORNHOOF_SUBNET).toMatch(/^\d+\.\d+\.\d+\.\d+\/24$/);
    expect(env.HORNHOOF_INTERNAL_SUBNET).toMatch(/^\d+\.\d+\.\d+\.\d+\/24$/);
    expect(cidrsOverlap(env.HORNHOOF_SUBNET!, env.HORNHOOF_INTERNAL_SUBNET!)).toBe(false);
    for (const blocked of ['192.168.1.0/24', '10.200.0.0/24', '10.200.1.0/24']) {
      expect(cidrsOverlap(env.HORNHOOF_SUBNET!, blocked)).toBe(false);
      expect(cidrsOverlap(env.HORNHOOF_INTERNAL_SUBNET!, blocked)).toBe(false);
    }
    expect(machine.registry()).toEqual([`${machine.folder()} 8080 8180`]);
    expect(machine.subnets()).toEqual([`${machine.folder()} ${env.HORNHOOF_SUBNET} ${env.HORNHOOF_INTERNAL_SUBNET}`]);

    /* Created Compose networks use the explicit subnets, not Docker's 192.168.0.0/20 pool. */
    const created = machine.networks().filter(n => n.project === 'hornhoof');
    expect(created).toEqual([
      expect.objectContaining({ name: 'hornhoof_default', subnet: env.HORNHOOF_SUBNET, internal: false }),
      expect.objectContaining({ name: 'hornhoof_internal', subnet: env.HORNHOOF_INTERNAL_SUBNET, internal: true }),
    ]);

    /* Re-running install.sh and updater runs keep the exact same subnets. */
    const again = machine.runServer([], { STUB_DOCKER_NETWORKS: otherDockerNet });
    expect(again.code).toBe(0);
    expect(machine.dotEnv().HORNHOOF_SUBNET).toBe(env.HORNHOOF_SUBNET);
    expect(machine.dotEnv().HORNHOOF_INTERNAL_SUBNET).toBe(env.HORNHOOF_INTERNAL_SUBNET);

    const fromUpdater = machine.runServer([], {
      STUB_DOCKER_NETWORKS: otherDockerNet,
      HORNHOOF_FROM_UPDATER: '1',
      HORNHOOF_UPDATER_REV: '2',
      HORNHOOF_SERVER_DIR: machine.folder(),
      STUB_HOSTNAME: 'updater-cid',
    });
    expect(fromUpdater.code).toBe(0);
    expect(machine.dotEnv().HORNHOOF_SUBNET).toBe(env.HORNHOOF_SUBNET);
    expect(machine.dotEnv().HORNHOOF_INTERNAL_SUBNET).toBe(env.HORNHOOF_INTERNAL_SUBNET);
  }, 60_000);

  it('reads macOS ifconfig and netstat samples, falls back across RFC 1918 pools, and fails clearly when none is free', () => {
    const ifconfigOut = [
      'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384',
      '\tinet 127.0.0.1 netmask 0xff000000',
      'en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500',
      '\tinet 192.168.1.45 netmask 0xffffff00 broadcast 192.168.1.255',
      'utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1380',
      '\tinet 10.44.0.9 --> 10.44.0.1 netmask 0xff000000',
    ].join('\n');
    const netstatOut = [
      'Routing tables',
      'Internet:',
      'Destination        Gateway            Flags               Netif Expire',
      'default            192.168.1.1        UGScg                 en0',
      '10/8               utun4              USc                 utun4',
      '172.29/16          172.29.0.1         UGSc                utun5',
      '192.168.1          link#14            UCS                   en0',
    ].join('\n');

    const mac = makeComputer('', '');
    const ok = mac.runServer([], {
      STUB_OS: 'Darwin',
      STUB_IFCONFIG: ifconfigOut,
      STUB_NETSTAT: netstatOut,
    });
    expect(ok.code).toBe(0);
    const macEnv = mac.dotEnv();
    /* 10.0.0.0/8 and 172.29.0.0/16 are routed on the Mac, so the installer lands in 172.30.0.0/24 and 172.30.1.0/24. */
    expect(macEnv.HORNHOOF_SUBNET).toBe('172.30.0.0/24');
    expect(macEnv.HORNHOOF_INTERNAL_SUBNET).toBe('172.30.1.0/24');

    /* When all three private ranges are routed on the host, the installer stops clearly before starting containers. */
    const full = makeComputer(
      LAN_ADDR_A,
      ['default via 192.168.1.1 dev eth0', '10.0.0.0/8 dev eth0', '172.16.0.0/12 dev eth0', '192.168.0.0/16 dev eth0'].join('\n'),
    );
    const refused = full.runServer();
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/No free Docker subnet/i);
    expect(refused.calls.some(c => c.startsWith('docker compose up'))).toBe(false);
  }, 60_000);

  it('makes the networks of a server from before subnets again with the subnets they have, once, before it starts anything', () => {
    const machine = makeComputer(LAN_ADDR_B, LAN_ROUTE_B);
    mkdirSync(machine.folder(), { recursive: true });
    writeFileSync(join(machine.folder(), '.env'), 'COMPOSE_PROJECT_NAME=hornhoof\nHORNHOOF_SECRET=s\nNODE_KEY=k\nHORNHOOF_PORT=8080\nHORNHOOF_PEER_PORT=8180\n');
    const live = { STUB_DOCKER_NETWORKS: 'n-def|hornhoof_default|hornhoof|172.18.0.0/16|false| n-int|hornhoof_internal|hornhoof|172.19.0.0/16|true|' };
    const first = machine.runServer([], live);
    expect(first.code).toBe(0);
    const down = first.calls.indexOf('docker compose down --remove-orphans');
    expect(down).toBeGreaterThan(-1);
    expect(first.calls.findIndex(c => c.startsWith('docker compose up'))).toBeGreaterThan(down);
    expect(machine.dotEnv()).toMatchObject({ HORNHOOF_SUBNET: '172.18.0.0/16', HORNHOOF_INTERNAL_SUBNET: '172.19.0.0/16' });
    const again = machine.runServer([], live);
    expect(again.code).toBe(0);
    expect(again.calls.some(c => c.startsWith('docker compose down'))).toBe(false);
  }, 60_000);

  /* A server of 0.23 by hand: networks compose made with no subnets named, and its services running on them, the
     built-in node, the updater and the tunnel 0.24 names no more among them. */
  const PLAIN_NETS = 'n-def|hornhoof_default|hornhoof|172.18.0.0/16|false||plain n-int|hornhoof_internal|hornhoof|172.19.0.0/16|true||plain';
  const OLD_RUNNING = { STUB_RUNNING_SERVICES: 'db app node updater tunnel', STUB_NODE_RUNNING: 'ghcr.io/invariant0x/hornhoof-node:0.23.3' };
  const OLD_ENV = 'COMPOSE_PROJECT_NAME=hornhoof\nHORNHOOF_SECRET=s\nNODE_KEY=k\nHORNHOOF_PORT=8080\nHORNHOOF_PEER_PORT=8180\n';
  /* As an install by hand of 0.24.0 left it on a-host: the settings name the subnets the networks have. */
  const NAMED_ENV = `${OLD_ENV}HORNHOOF_SUBNET=172.18.0.0/16\nHORNHOOF_INTERNAL_SUBNET=172.19.0.0/16\n`;
  const PREPARE = 'docker exec nodecid node /app/apps/node/dist/main.js prepare-stop hornhoof_update';
  const DOWN = 'docker compose down --remove-orphans';
  const marks = (rows: string[]) => rows.map(line => line.split('|')).map(f => `${f[1]} ${f[3]} ${f[6]}`);
  const netLines = (machine: ReturnType<typeof makeComputer>) => readFileSync(join(machine.portsDir, 'networks'), 'utf8').trim().split('\n');

  /* With no subnets in the settings it knows before it starts anything; with them, only once compose refused. */
  it.each([
    ['name no subnets', OLD_ENV, []],
    ['name the subnets the networks have already', NAMED_ENV, ['network hornhoof_default held by node updater tunnel']],
  ])('makes the networks of a server from 0.23 again once, with the node told and every container off them, when its settings %s', (_, dotEnv, held) => {
    const machine = makeComputer(LAN_ADDR_B, LAN_ROUTE_B);
    mkdirSync(machine.folder(), { recursive: true });
    writeFileSync(join(machine.folder(), '.env'), dotEnv);
    const run = machine.runServer([], { STUB_DOCKER_NETWORKS: PLAIN_NETS, ...OLD_RUNNING });
    expect(run.code, run.out).toBe(0);
    expect(run.calls.filter(c => c === DOWN)).toHaveLength(1);
    const down = run.calls.indexOf(DOWN);
    expect(run.calls.indexOf(PREPARE)).toBeGreaterThan(-1);
    expect(run.calls.indexOf(PREPARE)).toBeLessThan(down);
    expect(run.calls.indexOf('docker stop --time 5 nodecid')).toBeLessThan(down);
    expect(run.calls.filter(c => c.includes(' held by '))).toEqual(held);
    expect(run.calls.findLastIndex(c => c.includes(' held by '))).toBeLessThan(down);
    expect(run.calls.slice(down).some(c => c.startsWith('docker compose up'))).toBe(true);
    expect(machine.dotEnv()).toMatchObject({ HORNHOOF_SUBNET: '172.18.0.0/16', HORNHOOF_INTERNAL_SUBNET: '172.19.0.0/16' });
    expect(marks(netLines(machine)).sort()).toEqual(['hornhoof_default 172.18.0.0/16, subnets', 'hornhoof_internal 172.19.0.0/16, subnets']);
    expect(readFileSync(join(run.dir, 'running'), 'utf8').split('\n')).not.toContain('tunnel');
  }, 60_000);

  it('says why compose refused, and makes the networks again only once, when containers outside the server stay on them', () => {
    const machine = makeComputer(LAN_ADDR_B, LAN_ROUTE_B);
    mkdirSync(machine.folder(), { recursive: true });
    writeFileSync(join(machine.folder(), '.env'), NAMED_ENV);
    const run = machine.runServer([], { STUB_DOCKER_NETWORKS: PLAIN_NETS, ...OLD_RUNNING, STUB_STAYS_ON: 'visitor' });
    expect(run.code).toBe(1);
    expect(run.calls.filter(c => c === DOWN)).toHaveLength(1);
    expect(run.out).toContain('Hornhoof stops for a moment and makes them again.');
    expect(run.out).toContain(
      'Hornhoof did not start: Docker would not make the networks of this server again, as containers outside it are still on them. Stop the containers on the networks hornhoof_default and hornhoof_internal, then run this command again.',
    );
  }, 60_000);

  it('leaves networks made with the subnets the settings name as they are, and the built-in node runs on', () => {
    const machine = makeComputer(LAN_ADDR_B, LAN_ROUTE_B);
    mkdirSync(machine.folder(), { recursive: true });
    writeFileSync(join(machine.folder(), '.env'), NAMED_ENV);
    const made = 'n-def|hornhoof_default|hornhoof|172.18.0.0/16,|false||subnets n-int|hornhoof_internal|hornhoof|172.19.0.0/16,|true||subnets';
    const run = machine.runServer([], {
      STUB_DOCKER_NETWORKS: made,
      STUB_RUNNING_SERVICES: 'db app keeper front node updater',
      STUB_NODE_RUNNING: 'ghcr.io/invariant0x/hornhoof-node:latest',
    });
    expect(run.code, run.out).toBe(0);
    expect(run.calls.some(c => c.startsWith('docker compose down'))).toBe(false);
    expect(run.calls).not.toContain(PREPARE);
    expect(run.calls.some(c => c.startsWith('network '))).toBe(false);
    expect(marks(netLines(machine)).sort()).toEqual(['hornhoof_default 172.18.0.0/16, subnets', 'hornhoof_internal 172.19.0.0/16, subnets']);
  }, 60_000);

  it('recreates an existing overlapping project network, retries on daemon pool overlap, and cleans subnets on remove', () => {
    const machine = makeComputer(LAN_ADDR_B, LAN_ROUTE_B);
    mkdirSync(machine.folder(), { recursive: true });
    writeFileSync(join(machine.folder(), '.env'), 'COMPOSE_PROJECT_NAME=hornhoof\nHORNHOOF_SECRET=s\nNODE_KEY=k\nHORNHOOF_PORT=8080\nHORNHOOF_PEER_PORT=8180\n');

    /* Simulate an existing hornhoof_default network that covers 192.168.0.0/20
       with no daemon Pool overlaps error, so SUBNET_MOVED alone must trigger docker compose down before up. */
    const healed = machine.runServer([], {
      STUB_DOCKER_NETWORKS: 'oldnet000000001|hornhoof_default|hornhoof|192.168.0.0/20|false|',
    });
    expect(healed.code).toBe(0);
    expect(healed.calls).toContain('docker compose down --remove-orphans');
    const healedEnv = machine.dotEnv();
    expect(cidrsOverlap(healedEnv.HORNHOOF_SUBNET!, '192.168.0.0/20')).toBe(false);
    expect(machine.networks().some(n => n.id === 'oldnet000000001')).toBe(false);
    expect(machine.networks().every(n => !cidrsOverlap(n.subnet, '192.168.1.0/24'))).toBe(true);

    /* Separately verify retry_subnet_overlap when the Docker daemon rejects a chosen pool with Pool overlaps. */
    const retried = machine.runServer(['--name', 'retry'], {
      STUB_SUBNET_OVERLAP: '10.200.2.0/24',
    });
    expect(retried.code).toBe(0);
    const retriedEnv = machine.dotEnv('hornhoof-retry');
    expect(retriedEnv.HORNHOOF_SUBNET).not.toBe('10.200.2.0/24');

    /* Removing a joined core cleans both /ports/registry and /ports/subnets. */
    const joinLine = `core hornhoof-temp ${'T'.repeat(43)} 8080 ${randomUUID()}`;
    const joined = machine.runJoin([], {
      STUB_JOIN_BODY: `${joinLine}\n${SUB_A} claude node-key-aaaaaaaaaaaaaaaa\n`,
    });
    expect(joined.code).toBe(0);
    expect(machine.subnets().some(line => line.startsWith(`${machine.folder('hornhoof-temp')} `))).toBe(true);

    const removed = install({
      args: ['--uninstall'],
      tty: 'y\nn\n',
      env: {
        HOME: machine.home,
        HORNHOOF_HOME: join(machine.home, '.hornhoof'),
        HORNHOOF_DIR: join(machine.home, 'hornhoof'),
        STUB_PORTS_DIR: machine.portsDir,
      },
    });
    expect(removed.code).toBe(0);
    expect(machine.subnets().some(line => line.startsWith(`${machine.folder('hornhoof-temp')} `))).toBe(false);
  }, 60_000);

  it('keeps four Hornhoof projects on one computer disjoint, filters custom Docker bridges in updater, and documents recovery', async () => {
    const machine = makeComputer(LAN_ADDR_A, LAN_ROUTE_A);
    /* Another Linux user on the same machine already has a stopped/pruned project named hornhoof-gamma in /ports/registry
       and a Docker volume for hornhoof-delta. */
    writeFileSync(join(machine.portsDir, 'registry'), '/home/other/hornhoof-gamma 8080 8180\n');
    writeFileSync(join(machine.portsDir, 'subnets'), '/home/other/hornhoof-gamma 10.200.0.0/24 10.200.1.0/24\n');

    expect(machine.runServer(['--name', 'alpha']).code).toBe(0);
    expect(machine.runServer(['--name', 'beta']).code).toBe(0);

    /* Joining a company whose suggested CORE_FOLDER is hornhoof-gamma and another whose suggested CORE_FOLDER is
       hornhoof-delta must avoid the other user's Compose project names and pick hornhoof-gamma-2 / hornhoof-delta-2. */
    const joinGamma = machine.runJoin(['--server', 'https://gamma.hornhoof.test'], {
      STUB_JOIN_BODY: `core hornhoof-gamma ${'G'.repeat(43)} 8080 ${randomUUID()}\n${SUB_A} claude node-key-aaaaaaaaaaaaaaaa\n`,
    });
    expect(joinGamma.code).toBe(0);
    const joinDelta = machine.runJoin(['--server', 'https://delta.hornhoof.test'], {
      STUB_PROJECT_VOLUMES: 'hornhoof-delta',
      STUB_JOIN_BODY: `core hornhoof-delta ${'D'.repeat(43)} 8080 ${randomUUID()}\n${SUB_A} claude node-key-bbbbbbbbbbbbbbbb\n`,
    });
    expect(joinDelta.code).toBe(0);

    const folders = ['hornhoof-alpha', 'hornhoof-beta', 'hornhoof-gamma-2', 'hornhoof-delta-2'];
    const envs = folders.map(f => machine.dotEnv(f));
    const projects = envs.map(e => e.COMPOSE_PROJECT_NAME!);
    expect(new Set(projects).size).toBe(4);
    expect(projects).toEqual(['hornhoof-alpha', 'hornhoof-beta', 'hornhoof-gamma-2', 'hornhoof-delta-2']);

    const allPorts = envs.flatMap(e => [e.HORNHOOF_PORT!, e.HORNHOOF_PEER_PORT!]);
    expect(new Set(allPorts).size).toBe(8);
    expect(allPorts).not.toContain('8080');
    expect(allPorts).not.toContain('8180');

    const allCidrs = ['192.168.1.0/24', '10.200.0.0/24', '10.200.1.0/24', ...envs.flatMap(e => [e.HORNHOOF_SUBNET!, e.HORNHOOF_INTERNAL_SUBNET!])];
    for (let i = 0; i < allCidrs.length; i++) {
      for (let j = i + 1; j < allCidrs.length; j++) {
        expect(cidrsOverlap(allCidrs[i]!, allCidrs[j]!)).toBe(false);
      }
    }

    /* updater.sh write_addresses excludes custom Docker network bridge names and Docker network gateway IPs. */
    const s = stand();
    const ipSample = [
      '2: eth0    inet 192.168.1.10/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever preferred_lft forever',
      '5: hhcustom0    inet 10.200.4.1/24 brd 10.200.4.255 scope global hhcustom0\\       valid_lft forever preferred_lft forever',
      '6: podman0    inet 10.88.0.1/16 brd 10.88.255.255 scope global podman0\\       valid_lft forever preferred_lft forever',
      '7: eth0:docker    inet 10.200.6.1/24 scope global eth0:docker\\       valid_lft forever preferred_lft forever',
    ].join('\n');
    const customNets = [
      'aa11bb22cc330001|alpha_default|hornhoof-alpha|10.200.4.0/24|false|hhcustom0',
      'aa11bb22cc330002|beta_default|hornhoof-beta|10.200.6.0/24|false|',
    ].join(' ');
    const upd = await runOnce(s, null, {
      HORNHOOF_HOST_OS: 'linux',
      STUB_IP: ipSample,
      STUB_DOCKER_NETWORKS: customNets,
    });
    expect(upd.code).toBe(0);
    const written = JSON.parse(readFileSync(join(s.control, 'addresses.json'), 'utf8')) as { addresses: string[] };
    expect(written.addresses).toEqual(['192.168.1.10']);

    /* guide/install.md explains multi-project subnet reservations in hornhoof-ports and LAN shadow recovery. */
    const guide = readFileSync(INSTALL_GUIDE_PATH, 'utf8');
    expect(guide).toContain('HORNHOOF_SUBNET');
    expect(guide).toContain('hornhoof-ports');
    expect(guide).toContain('docker network ls');
  }, 60_000);

  it('matches interface and bridge names containing regex metacharacters as literal strings', () => {
    const hostAddr = [
      LAN_ADDR_B,
      '3: br[own    inet 10.200.0.1/24 scope global br[own\\       valid_lft forever preferred_lft forever',
      '4: wg[x    inet 10.200.1.5/24 scope global wg[x\\       valid_lft forever preferred_lft forever',
      '5: tun(1)    inet 10.200.2.5/24 scope global tun(1)\\       valid_lft forever preferred_lft forever',
    ].join('\n');
    const hostRoute = [
      LAN_ROUTE_B,
      '10.200.0.0/24 dev br[own proto kernel scope link src 10.200.0.1',
      '10.200.3.0/24 dev wg[x proto kernel scope link src 10.200.1.5',
      '10.200.4.0/24 dev eth0 proto static via 192.168.1.1',
    ].join('\n');
    const linux = makeComputer(hostAddr, hostRoute);
    mkdirSync(linux.folder(), { recursive: true });
    writeFileSync(join(linux.folder(), '.env'), 'COMPOSE_PROJECT_NAME=hornhoof\nHORNHOOF_SECRET=s\nNODE_KEY=k\nHORNHOOF_PORT=8080\nHORNHOOF_PEER_PORT=8180\n');

    const res = linux.runServer([], {
      STUB_DOCKER_NETWORKS: 'ownnet000000001|hornhoof_default|hornhoof|10.200.0.0/24|false|br[own',
    });
    expect(res.code).toBe(0);
    const linuxEnv = linux.dotEnv();
    expect(linuxEnv.HORNHOOF_SUBNET).toBe('10.200.0.0/24');
    expect(linuxEnv.HORNHOOF_INTERNAL_SUBNET).toBe('10.200.5.0/24');

    const ifconfigOut = [
      'wg[x: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1420',
      '\tinet 10.200.0.5 netmask 0xffffff00',
      'en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500',
      '\tinet 10.200.1.5 netmask 0xffffff00 broadcast 10.200.1.255',
    ].join('\n');
    const netstatOut = [
      'Routing tables',
      'Internet:',
      'Destination        Gateway            Flags               Netif Expire',
      '10.200.2/24        link#19            UCS                 wg[x',
      '10.200.3/24        link#14            UCS                  en0',
    ].join('\n');
    const mac = makeComputer('', '');
    const macRes = mac.runServer([], {
      STUB_OS: 'Darwin',
      STUB_IFCONFIG: ifconfigOut,
      STUB_NETSTAT: netstatOut,
    });
    expect(macRes.code).toBe(0);
    expect(mac.dotEnv().HORNHOOF_SUBNET).toBe('10.200.4.0/24');
    expect(mac.dotEnv().HORNHOOF_INTERNAL_SUBNET).toBe('10.200.5.0/24');
  }, 60_000);

  it('keeps existing subnet reservations untouched and logs an error when remove_core cannot read /ports/subnets', () => {
    const machine = makeComputer(LAN_ADDR_B, LAN_ROUTE_B);
    writeFileSync(join(machine.portsDir, 'registry'), '/home/other/hornhoof-gamma 8080 8180\n');
    writeFileSync(join(machine.portsDir, 'subnets'), '/home/other/hornhoof-gamma 10.200.0.0/24 10.200.1.0/24\n');

    const joined = machine.runJoin([], {
      STUB_JOIN_BODY: `core hornhoof-temp ${'T'.repeat(43)} 8080 ${randomUUID()}\n${SUB_A} claude node-key-aaaaaaaaaaaaaaaa\n`,
    });
    expect(joined.code).toBe(0);
    const beforeSubnets = machine.subnets();
    expect(beforeSubnets).toHaveLength(2);

    const removed = install({
      args: ['--uninstall'],
      tty: 'y\nn\n',
      env: {
        HOME: machine.home,
        HORNHOOF_HOME: join(machine.home, '.hornhoof'),
        HORNHOOF_DIR: join(machine.home, 'hornhoof'),
        STUB_PORTS_DIR: machine.portsDir,
        STUB_SUBNETS: 'unreadable',
      },
    });
    expect(removed.code).toBe(0);
    expect(removed.calls.some(c => c.includes('cat > /ports/subnets.new'))).toBe(false);
    expect(machine.subnets()).toEqual(beforeSubnets);
    expect(removed.out).toMatch(/Could not read the list of Hornhoof's subnets on this computer/);
  }, 60_000);

  it('keeps the live network safe during automatic updates and warns clearly in the update log when it overlaps the home network', async () => {
    const machine = makeComputer(LAN_ADDR_B, LAN_ROUTE_B);
    mkdirSync(machine.folder(), { recursive: true });
    writeFileSync(join(machine.folder(), '.env'), 'COMPOSE_PROJECT_NAME=hornhoof\nHORNHOOF_SECRET=s\nNODE_KEY=k\nHORNHOOF_PORT=8080\nHORNHOOF_PEER_PORT=8180\n');

    const fromUpdater = machine.runServer([], {
      STUB_DOCKER_NETWORKS: 'oldnet000000001|hornhoof_default|hornhoof|192.168.0.0/20|false|',
      HORNHOOF_FROM_UPDATER: '1',
      HORNHOOF_UPDATER_REV: '2',
      HORNHOOF_SERVER_DIR: machine.folder(),
      STUB_HOSTNAME: 'updater-cid',
    });
    expect(fromUpdater.code).toBe(0);
    expect(fromUpdater.calls.some(c => c.startsWith('docker compose down'))).toBe(false);
    expect(machine.dotEnv().HORNHOOF_SUBNET).toBe('192.168.0.0/20');
    expect(cidrsOverlap(machine.dotEnv().HORNHOOF_INTERNAL_SUBNET!, '192.168.0.0/20')).toBe(false);
    expect(fromUpdater.out).toContain('192.168.0.0/20');
    expect(fromUpdater.out).toContain("overlaps this computer's network");
    expect(fromUpdater.out).toContain('install.sh server');

    const s = stand('HORNHOOF_SECRET=s\nHORNHOOF_VERSION=0.4.0\nCOMPOSE_PROJECT_NAME=hornhoof\n');
    const upd = await runOnce(s, ask('u-overlap'), {
      HORNHOOF_HOST_OS: 'linux',
      STUB_IP: LAN_ADDR_B,
      STUB_DOCKER_NETWORKS: 'oldnet000000001|hornhoof_default|hornhoof|192.168.0.0/20|false|',
    });
    expect(upd.code).toBe(0);
    expect(upd.status?.state).toBe('done');
    expect(upd.status?.log).toContain('192.168.0.0/20');
    expect(upd.status?.log).toContain("overlaps this computer's network");
    expect(upd.status?.log).toContain('install.sh server');

    const sClean = stand('HORNHOOF_SECRET=s\nHORNHOOF_VERSION=0.4.0\nCOMPOSE_PROJECT_NAME=hornhoof\nHORNHOOF_ADDRESSES=192.168.1.20\n');
    const cleanUpd = await runOnce(sClean, ask('u-clean'), {
      HORNHOOF_HOST_OS: 'linux',
      STUB_IP: [
        '2: eth0    inet 192.168.1.20/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever preferred_lft forever',
        '9: hhbr0    inet 10.200.0.1/24 brd 10.200.0.255 scope global hhbr0\\       valid_lft forever preferred_lft forever',
      ].join('\n'),
      /* Custom Compose subnet without an explicit Gateway entry in IPAM.Config, as Docker Engine stores it. */
      STUB_DOCKER_NETWORKS: 'oknet0000000001|hornhoof_default|hornhoof|10.200.0.0/24,|false|hhbr0 okint0000000001|hornhoof_internal|hornhoof|10.200.1.0/24,|true|hhbr1',
    });
    expect(cleanUpd.code).toBe(0);
    expect(cleanUpd.status?.state).toBe('done');
    expect(cleanUpd.status?.log).not.toContain("overlaps this computer's network");
    const savedAddrs = JSON.parse(readFileSync(join(sClean.control, 'addresses.json'), 'utf8')) as { addresses: string[] };
    expect(savedAddrs.addresses).toEqual(['192.168.1.20']);

    /* Inside the updater container on Linux, ip addr shows the updater container's own eth0 on the live Compose subnet
       (10.200.2.2/24), while Docker Engine's IPAM.Config map has Subnet without Gateway. Must not emit a false overlap warning. */
    const containerView = makeComputer(
      '134: eth0    inet 10.200.2.2/24 brd 10.200.2.255 scope global eth0\\       valid_lft forever preferred_lft forever',
      '10.200.2.0/24 dev eth0 proto kernel scope link src 10.200.2.2',
    );
    mkdirSync(containerView.folder('hornhoof-two'), { recursive: true });
    writeFileSync(
      join(containerView.folder('hornhoof-two'), '.env'),
      'COMPOSE_PROJECT_NAME=hornhoof-two\nHORNHOOF_SECRET=s\nNODE_KEY=k\nHORNHOOF_PORT=8081\nHORNHOOF_PEER_PORT=8181\nHORNHOOF_SUBNET=10.200.2.0/24\nHORNHOOF_INTERNAL_SUBNET=10.200.3.0/24\nHORNHOOF_ADDRESSES=192.168.10.20\n',
    );
    const cleanFromContainer = containerView.runServer([], {
      STUB_OS: 'Linux',
      STUB_DOCKER_NETWORKS:
        '091192985c054ce1|hornhoof-two_default|hornhoof-two|10.200.2.0/24,|false| 2ba1f8a529740306|hornhoof-two_internal|hornhoof-two|10.200.3.0/24,|true|',
      HORNHOOF_FROM_UPDATER: '1',
      HORNHOOF_UPDATER_REV: '2',
      HORNHOOF_SERVER_DIR: containerView.folder('hornhoof-two'),
      STUB_HOSTNAME: 'updater-cid',
    });
    expect(cleanFromContainer.code).toBe(0);
    expect(cleanFromContainer.out).not.toContain("overlaps this computer's network");
  }, 60_000);
});

describe('Two companies on the same two computers lead, copy, and switch leader without interfering', () => {
  it('isolates subnets, ports, folders, Compose projects, hornhoof.org names, and peer client ids across lead, copy, and switch', async () => {
    /* Physical Machine A (192.168.1.10/24) and Machine B (192.168.1.20/24). Both companies share the exact same two
       physical machines and even see the same physical machine id on each host if derived from host identity. */
    const SHARED_HOST_A_ID = 'a0'.repeat(16);
    const SHARED_HOST_B_ID = 'b0'.repeat(16);

    const machineA = makeComputer(LAN_ADDR_A, LAN_ROUTE_A);
    const machineB = makeComputer(LAN_ADDR_B, LAN_ROUTE_B);

    /* Install Company 1 (alpha), Company 2 (beta), and a 3rd project (gamma) on Machine A. */
    expect(machineA.runServer(['--name', 'alpha']).code).toBe(0);
    expect(machineA.runServer(['--name', 'beta']).code).toBe(0);
    expect(machineA.runServer(['--name', 'gamma']).code).toBe(0);

    const alphaA = machineA.dotEnv('hornhoof-alpha');
    const betaA = machineA.dotEnv('hornhoof-beta');
    const gammaA = machineA.dotEnv('hornhoof-gamma');

    /* Join Machine B to Company 1 (alpha) and Company 2 (beta) as data-keeping copies, including a second OS user home
       on Machine B where a sibling hornhoof-alpha project already exists on the same Docker engine. */
    const user2Home = join(machineB.root, 'home-bob');
    mkdirSync(user2Home, { recursive: true });

    const alphaJoinBody = [
      `core hornhoof-alpha ${'A'.repeat(43)} ${alphaA.HORNHOOF_PORT} ${randomUUID()}`,
      `${SUB_A} claude node-key-alpha00000000000`,
    ].join('\n');
    expect(machineB.runJoin(['--server', `http://192.168.1.10:${alphaA.HORNHOOF_PORT}`], { STUB_JOIN_BODY: `${alphaJoinBody}\n` }).code).toBe(0);
    const alphaBDir = machineB.folder('hornhoof-alpha');
    const alphaB = machineB.dotEnv('hornhoof-alpha');

    /* Suppose Company 2 also suggests hornhoof-alpha (or its own hornhoof-beta) on Machine B while user 1's hornhoof-alpha
       keeper is running in Docker: installing under user2Home must never collide on Compose project name or subnet! */
    const betaJoinBody = [
      `core hornhoof-alpha ${'B'.repeat(43)} ${betaA.HORNHOOF_PORT} ${randomUUID()}`,
      `${SUB_A} claude node-key-beta000000000000`,
    ].join('\n');
    const betaJoinRes = machineB.runJoin(['--server', `http://192.168.1.10:${betaA.HORNHOOF_PORT}`], {
      HOME: user2Home,
      HORNHOOF_HOME: join(user2Home, '.hornhoof'),
      HORNHOOF_DIR: join(user2Home, 'hornhoof'),
      STUB_CORES: `${alphaB.COMPOSE_PROJECT_NAME}:${alphaBDir}:${alphaB.HORNHOOF_PORT}`,
      STUB_JOIN_BODY: `${betaJoinBody}\n`,
    });
    expect(betaJoinRes.code).toBe(0);
    const betaBDir = machineB.folder('hornhoof-alpha-2', user2Home);
    const betaB = envMap(readFileSync(join(betaBDir, '.env'), 'utf8'));

    /* 1. Working folders, Compose project names, ports, and Docker subnets are strictly isolated on both computers. */
    expect(new Set([machineA.folder('hornhoof-alpha'), machineA.folder('hornhoof-beta'), machineA.folder('hornhoof-gamma')]).size).toBe(3);
    expect(new Set([alphaBDir, betaBDir]).size).toBe(2);
    expect(new Set([alphaA.COMPOSE_PROJECT_NAME, betaA.COMPOSE_PROJECT_NAME, gammaA.COMPOSE_PROJECT_NAME]).size).toBe(3);
    expect(new Set([alphaB.COMPOSE_PROJECT_NAME, betaB.COMPOSE_PROJECT_NAME]).size).toBe(2);
    expect(betaB.COMPOSE_PROJECT_NAME).toBe('hornhoof-alpha-2');

    expect(new Set([alphaA.HORNHOOF_PORT, alphaA.HORNHOOF_PEER_PORT, betaA.HORNHOOF_PORT, betaA.HORNHOOF_PEER_PORT, gammaA.HORNHOOF_PORT, gammaA.HORNHOOF_PEER_PORT]).size).toBe(6);
    expect(new Set([alphaB.HORNHOOF_PORT, alphaB.HORNHOOF_PEER_PORT, betaB.HORNHOOF_PORT, betaB.HORNHOOF_PEER_PORT]).size).toBe(4);

    for (const machine of [machineA, machineB]) {
      const nets = machine.networks();
      expect(nets.length).toBeGreaterThanOrEqual(4);
      for (let i = 0; i < nets.length; i++) {
        expect(cidrsOverlap(nets[i]!.subnet, '192.168.1.0/24')).toBe(false);
        for (let j = i + 1; j < nets.length; j++) {
          expect(cidrsOverlap(nets[i]!.subnet, nets[j]!.subnet)).toBe(false);
        }
      }
    }

    /* Simulated container routing check: a container on Machine B or Machine A reaches the peer host IP directly on LAN
       only if NONE of the host's Docker networks shadows that peer IP. */
    const canRouteOnLan = (fromMachine: ReturnType<typeof makeComputer>, targetHostIp: string): boolean =>
      fromMachine.networks().every(net => !ipInCidr(targetHostIp, net.subnet));
    expect(canRouteOnLan(machineB, '192.168.1.10')).toBe(true);
    expect(canRouteOnLan(machineA, '192.168.1.20')).toBe(true);

    /* 2. Shared in-memory hornhoof.org relay: link names and frpc client/service IDs never collide across companies,
       even when both companies run on hosts with the exact same machineId! */
    const relayTaken = new Map<string, { key: string; holder: string | null; generation: number; sync: SyncRecord }>();
    let hiddenSeq = 0;
    function attachSharedRelay(links: PublicLinks) {
      vi.spyOn(links.relay, 'bind').mockImplementation(async (requested?: string): Promise<Bound> => {
        const name = requested ?? `auto-company-${++hiddenSeq}`;
        if (relayTaken.has(name)) throw new Error(`Relay name ${name} is already taken`);
        const key = randomBytes(24).toString('base64url');
        relayTaken.set(name, { key, holder: null, generation: 0, sync: { state: 'off', copy: null, epoch: 0, generation: 0, at: null } });
        return {
          name,
          url: `https://${name}.hornhoof.org`,
          key,
          tunnel: { serverAddr: 'relay.hornhoof.org', serverPort: 443, protocol: 'wss' },
        };
      });
      vi.spyOn(links.relay, 'unbind').mockImplementation(async (name: string, key: string) => {
        const entry = relayTaken.get(name);
        if (entry?.key === key) relayTaken.delete(name);
      });
    }

    /* Spin up full CompanyRuntime (Machine A leader + Machine B copy + Hander/Taker/Promoter) for both companies. */
    async function createCompanyRuntime(label: string, desiredLinkName?: string) {
      const secret = Buffer.from(TEST_SECRET, 'base64');
      const [dirA, controlA, dirB, controlB] = [
        tempDir(`hh-${label}-a-dir-`),
        tempDir(`hh-${label}-a-ctl-`),
        tempDir(`hh-${label}-b-dir-`),
        tempDir(`hh-${label}-b-ctl-`),
      ];
      const dbA = await createTestSql();
      const dbB = await createTestSql();
      /* Initial term 1 on Machine A; Machine B starts as a synced ready copy following Machine A. */
      await dbA.sql.query(
        'UPDATE net_local.state SET term_number = 1, term_machine = $1, machine = $1, term_split = false, handed_to = NULL, handed_lsn = NULL, handed_at = NULL',
        [SHARED_HOST_A_ID],
      );
      await dbA.sql.query('UPDATE net_local.lease SET term_number = 1, term_machine = $1, term_split = false', [SHARED_HOST_A_ID]);
      await dbB.sql.query(
        "SET session_replication_role = replica; DELETE FROM net_local.lease; DELETE FROM net_local.state; SET session_replication_role = origin; SET hornhoof.fenced = 'off'",
      );

      const [comp] = await dbA.db.insert(companies).values({ name: `Company ${label}` }).returning();
      const [owner] = await dbA.db
        .insert(people)
        .values({ companyId: comp!.id, name: `Owner ${label}`, email: `owner@${label}.test`, status: 'active', scopeKind: 'company', isOwner: true })
        .returning();

      const slotOnAForB = `copy_${SHARED_HOST_B_ID.slice(0, 16)}_2`;
      const slotOnBForA = `copy_${SHARED_HOST_A_ID.slice(0, 16)}_1`;

      const [rowA] = await dbA.db
        .insert(machines)
        .values({ companyId: comp!.id, personId: owner!.id, machineKey: `key-${label}-a`, hostname: 'machine-a', role: 'data', networkId: SHARED_HOST_A_ID, serverOrder: 1 })
        .returning();
      const [rowB] = await dbA.db
        .insert(machines)
        .values({
          companyId: comp!.id,
          personId: owner!.id,
          machineKey: `key-${label}-b`,
          hostname: 'machine-b',
          role: 'data',
          networkId: SHARED_HOST_B_ID,
          serverOrder: 2,
          copyName: slotOnAForB,
          copyState: 'ready',
        })
        .returning();

      /* Replicate the leader's rows onto Machine B's copy database, as logical replication applies them on B. */
      await dbB.sql.query('SET session_replication_role = replica');
      await dbB.db.insert(companies).values(comp!);
      await dbB.db.insert(people).values(owner!);
      await dbB.db.insert(machines).values([rowA!, rowB!]);
      await dbB.sql.query('SET session_replication_role = origin');

      const configA = { secret, controlDir: controlA, relayUrl: 'https://hornhoof.org', publicUrl: `http://localhost:8080`, machineId: SHARED_HOST_A_ID } as unknown as Config;
      const links = new PublicLinks({ db: dbA.db, config: configA, log: SILENT_LOG });
      attachSharedRelay(links);
      if (desiredLinkName) {
        await links.set(comp!.id, desiredLinkName);
      } else {
        expect(await links.ensureHidden(comp!.id)).toBe(true);
      }
      const [linkRow] = await dbA.db.select().from(publicLinks);
      const linkName = linkRow!.name;

      await dbA.db.insert(peerSecrets).values([
        { kind: 'app', secretEnc: encryptSecret(`${label}-app-secret`, secret) },
        { kind: 'data', secretEnc: encryptSecret(`${label}-data-secret`, secret) },
        { kind: 'visit', secretEnc: encryptSecret(JSON.stringify({ name: linkName, key: `${label}-visitor-key-0123456789` }), secret) },
      ]);

      const relayEntry = relayTaken.get(linkName)!;
      relayEntry.holder = linkClientId(linkName, SHARED_HOST_A_ID);
      relayEntry.generation = 1;
      relayEntry.sync = { state: 'on', copy: SHARED_HOST_B_ID, epoch: 1, generation: 1, at: 1_000 };

      let now = 1_000_000;
      const stateA = { leads: true, fenced: false, tunnelRunning: true, frontOpen: true, exited: 0 };
      const stateB = { subEnabled: true, subApplying: true, copyReady: true, takerExited: 0, promoterLeads: false, appLeads: false };
      const peerLog: string[] = [];

      const subB: OwnSubscription = {
        enabled: async () => stateB.subEnabled,
        applying: async () => stateB.subEnabled && stateB.subApplying,
        disable: async () => {
          stateB.subEnabled = false;
        },
        enable: async () => {
          stateB.subEnabled = true;
        },
      };

      let promoterB: Promoter | null = null;
      const takerB = new Taker({
        dir: dirB,
        sql: dbB.sql,
        leader: () => (stateA.fenced ? null : { networkId: SHARED_HOST_A_ID, hostname: 'machine-a' }),
        copyReady: () => stateB.copyReady,
        subscription: subB,
        exit: () => {
          stateB.takerExited += 1;
        },
        now: () => now,
        log: () => {},
      });

      const handerA = new Hander({
        dir: dirA,
        controlDir: controlA,
        sql: dbA.sql,
        secret,
        lease: {
          fence: async () => {
            stateA.fenced = true;
            stateA.leads = false;
          },
        },
        term: () => (stateA.leads ? { number: 1, machine: SHARED_HOST_A_ID, split: false } : null),
        sync: {
          named: () => SHARED_HOST_B_ID,
          record: () => relayEntry.sync,
          generation: () => relayEntry.generation,
          copies: () => [{ name: slotOnAForB, networkId: SHARED_HOST_B_ID, state: 'sync' as const }],
        },
        peer: networkId => ({
          request: async (method, path, body) => {
            if (!canRouteOnLan(machineA, '192.168.1.20') || !canRouteOnLan(machineB, '192.168.1.10')) {
              throw new Error(`LAN peer route shadowed by overlapping Docker subnet for ${label}`);
            }
            peerLog.push(`${label}:${networkId}:${method}:${path.split('?')[0]}`);
            if (path.startsWith('/peer/switch/state') && promoterB?.leads()) {
              const sw = path.split('=')[1] ?? '';
              const promotedState: TakeState = {
                state: 'leading',
                switch: sw,
                term: { number: 2, machine: SHARED_HOST_B_ID, split: false },
                slots: { [SHARED_HOST_A_ID]: slotOnBForA },
              };
              return { status: 200, body: promotedState };
            }
            const res = await takerB.handle(SHARED_HOST_A_ID, method, path, body);
            res.after?.();
            return { status: res.status, body: res.body };
          },
        }),
        front: {
          close: async () => {
            stateA.frontOpen = false;
          },
          open: () => {
            stateA.frontOpen = true;
          },
        },
        tunnel: {
          start: () => {
            stateA.tunnelRunning = true;
          },
          stop: async () => {
            stateA.tunnelRunning = false;
            if (relayEntry.holder === linkClientId(linkName, SHARED_HOST_A_ID)) relayEntry.holder = null;
          },
        },
        leads: () => stateA.leads,
        updating: () => false,
        machine: { networkId: SHARED_HOST_A_ID },
        exit: () => {
          stateA.exited += 1;
        },
        wal: {
          position: async () => '0/4000000',
          slots: async () => [{ name: slotOnAForB, read: true, atW: true }],
        },
        now: () => now,
        log: () => {},
      });

      async function requestMoveToB(): Promise<string> {
        await dbA.db.execute(raw`DELETE FROM net.move`);
        await dbA.db.execute(raw`INSERT INTO net.move (machine_id, from_machine_id, asked_by, asked_at, state) VALUES (${rowB!.id}, ${rowA!.id}, ${owner!.id}, clock_timestamp(), 'preparing')`);
        const rows = (await dbA.db.execute(raw`SELECT request::text, state FROM net.move`) as unknown as { rows: { request: string; state: string }[] }).rows;
        const req = rows[0]!.request;
        if (stateB.subEnabled) {
          await dbB.sql.query('SET session_replication_role = replica');
          await dbB.sql.query('DELETE FROM net.move');
          await dbB.sql.query(
            `INSERT INTO net.move (request, machine_id, from_machine_id, asked_by, asked_at, state) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, clock_timestamp(), 'switching')`,
            [req, rowB!.id, rowA!.id, owner!.id],
          );
          await dbB.sql.query('SET session_replication_role = origin');
        }
        return req;
      }

      async function switchLeaderFromAToB(): Promise<string> {
        const req = await requestMoveToB();
        /* Hander on A offers switch to Taker on B, fences A, sends go, and stops A's link tunnel. */
        for (let i = 0; i < 6 && stateB.takerExited === 0; i++) {
          now += 250;
          await handerA.look();
        }
        expect(readTaking(dirB)?.phase).toBe('go');
        expect(stateB.subEnabled).toBe(false);

        /* Taker exited so B restarts as Promoter, takes the company's own link name at the relay, probes its nonce, and promotes to term 2. */
        writeFileSync(join(controlB, REPLICA_FILE), '{}');
        writeFileSync(join(dirB, COPY_STATE), '{}');
        promoterB = new Promoter({
          dir: dirB,
          controlDir: controlB,
          sql: dbB.sql,
          machine: { networkId: SHARED_HOST_B_ID },
          registered: async () => relayEntry.holder === linkClientId(linkName, SHARED_HOST_B_ID),
          name: async () => null,
          probe: async nonce => ({ machine: SHARED_HOST_B_ID, nonce }),
          tunnel: {
            start: () => {
              relayEntry.holder = linkClientId(linkName, SHARED_HOST_B_ID);
              relayEntry.generation += 1;
            },
            stop: async () => {},
          },
          subscription: subB,
          appLeads: () => stateB.appLeads,
          exit: () => {},
          promote: async t => {
            const slots = { [SHARED_HOST_A_ID]: slotOnBForA };
            await writeTerm(dbB.sql, { above: t.term.number, machine: SHARED_HOST_B_ID });
            await recordHandover(dbB.sql, {
              id: t.switch,
              from: rowA!.id,
              term: t.term,
              applied: t.w ?? '0/4000000',
              to: rowB!.id,
              at: new Date(now),
              slots,
            });
            stateB.promoterLeads = true;
            return slots;
          },
          now: () => now,
          log: () => {},
        });

        for (let i = 0; i < 10 && !promoterB.leads(); i++) {
          now += 250;
          await promoterB.look();
        }
        expect(promoterB.leads()).toBe(true);
        stateB.appLeads = true;
        now += 250;
        await promoterB.look();

        /* Hander on A observes B's leading state, writes A's replica.json to follow B under term 2, and finishes the move. */
        for (let i = 0; i < 6 && stateA.exited === 0; i++) {
          now += 250;
          await handerA.look();
        }
        return req;
      }

      const copiedNamesOnB = async () => (await dbB.db.select(only(companies, 'name')).from(companies)).map(r => r.name);
      const pendingMovesOnB = async () => (await dbB.sql.query('SELECT 1 FROM net.move')).rows;

      return {
        label,
        comp: comp!,
        rowAId: rowA!.id,
        slotOnBForA,
        links,
        linkName,
        dirA,
        controlA,
        dirB,
        controlB,
        dbA,
        dbB,
        stateA,
        stateB,
        peerLog,
        relayEntry,
        switchLeaderFromAToB,
        copiedNamesOnB,
        pendingMovesOnB,
        handoverOnB: (id: string) => handoverOf(dbB.sql, id),
        termOnA: () => termOf(dbA.sql),
        termOnB: () => termOf(dbB.sql),
      };
    }

    const company1 = await createCompanyRuntime('alpha', 'alpha-co');
    const company2 = await createCompanyRuntime('beta');

    /* Company 2 cannot steal Company 1's hornhoof.org name, and its auto-assigned hidden name is distinct. */
    await expect(company2.links.set(company2.comp.id, 'alpha-co')).rejects.toThrow(/taken/);
    expect(company1.linkName).toBe('alpha-co');
    expect(company2.linkName).toBe('auto-company-1');
    expect(company1.linkName).not.toBe(company2.linkName);

    /* Every frpc client ID and STCP service name on Machine A and Machine B is disjoint between the two companies,
       even though Machine A has SHARED_HOST_A_ID in both companies and Machine B has SHARED_HOST_B_ID in both! */
    const idsCompany1 = [
      linkClientId(company1.linkName, SHARED_HOST_A_ID),
      linkClientId(company1.linkName, SHARED_HOST_B_ID),
      peerClientId(company1.linkName, SHARED_HOST_A_ID),
      peerClientId(company1.linkName, SHARED_HOST_B_ID),
      visitClientId(company1.linkName, SHARED_HOST_A_ID),
      visitClientId(company1.linkName, SHARED_HOST_B_ID),
      serviceName(company1.linkName, SHARED_HOST_A_ID, 'data'),
      serviceName(company1.linkName, SHARED_HOST_A_ID, 'app'),
      serviceName(company1.linkName, SHARED_HOST_B_ID, 'data'),
      serviceName(company1.linkName, SHARED_HOST_B_ID, 'app'),
    ];
    const idsCompany2 = [
      linkClientId(company2.linkName, SHARED_HOST_A_ID),
      linkClientId(company2.linkName, SHARED_HOST_B_ID),
      peerClientId(company2.linkName, SHARED_HOST_A_ID),
      peerClientId(company2.linkName, SHARED_HOST_B_ID),
      visitClientId(company2.linkName, SHARED_HOST_A_ID),
      visitClientId(company2.linkName, SHARED_HOST_B_ID),
      serviceName(company2.linkName, SHARED_HOST_A_ID, 'data'),
      serviceName(company2.linkName, SHARED_HOST_A_ID, 'app'),
      serviceName(company2.linkName, SHARED_HOST_B_ID, 'data'),
      serviceName(company2.linkName, SHARED_HOST_B_ID, 'app'),
    ];
    for (const id of idsCompany1) expect(idsCompany2).not.toContain(id);

    const peerToml1 = peerConfigFor(
      {
        settings: { url: `https://${company1.linkName}.hornhoof.org`, name: company1.linkName, key: 'k'.repeat(20), tunnel: { serverAddr: 'relay.hornhoof.org', serverPort: 443, protocol: 'wss' }, mode: 'http', hidden: false },
        secrets: { data: 'd1', app: 'a1' },
      },
      { machineId: SHARED_HOST_A_ID, local: { data: 7081, app: 7080 } },
    );
    const peerToml2 = peerConfigFor(
      {
        settings: { url: `https://${company2.linkName}.hornhoof.org`, name: company2.linkName, key: 'm'.repeat(20), tunnel: { serverAddr: 'relay.hornhoof.org', serverPort: 443, protocol: 'wss' }, mode: 'http', hidden: true },
        secrets: { data: 'd2', app: 'a2' },
      },
      { machineId: SHARED_HOST_A_ID, local: { data: 7081, app: 7080 } },
    );
    expect(peerToml1).toContain(`clientID = "${peerClientId(company1.linkName, SHARED_HOST_A_ID)}"`);
    expect(peerToml2).toContain(`clientID = "${peerClientId(company2.linkName, SHARED_HOST_A_ID)}"`);
    expect(peerToml1).not.toContain(company2.linkName);

    const visitToml1 = visitConfigFor(
      { name: company1.linkName, serverAddr: 'relay.hornhoof.org', serverPort: 443, visitorKey: 'v1'.repeat(10), appSecret: 'a1', dataSecret: 'd1' },
      { machineId: SHARED_HOST_B_ID, targets: [SHARED_HOST_A_ID], kind: 'data' },
    );
    const visitToml2 = visitConfigFor(
      { name: company2.linkName, serverAddr: 'relay.hornhoof.org', serverPort: 443, visitorKey: 'v2'.repeat(10), appSecret: 'a2', dataSecret: 'd2' },
      { machineId: SHARED_HOST_B_ID, targets: [SHARED_HOST_A_ID], kind: 'data' },
    );
    expect(visitToml1).toContain(`clientID = "${visitClientId(company1.linkName, SHARED_HOST_B_ID)}"`);
    expect(visitToml2).toContain(`clientID = "${visitClientId(company2.linkName, SHARED_HOST_B_ID)}"`);
    expect(visitToml1).not.toContain(company2.linkName);

    /* Both companies initially lead on Machine A (term 1) and replicate only their own company data to Machine B. */
    expect(await company1.termOnA()).toMatchObject({ number: 1, machine: SHARED_HOST_A_ID, split: false });
    expect(await company2.termOnA()).toMatchObject({ number: 1, machine: SHARED_HOST_A_ID, split: false });
    expect(await company1.termOnB()).toBeNull();
    expect(await company2.termOnB()).toBeNull();
    expect(await company1.copiedNamesOnB()).toEqual(['Company alpha']);
    expect(await company2.copiedNamesOnB()).toEqual(['Company beta']);

    /* 3. Switch Company 1's leader from Machine A to Machine B. Company 2 must stay completely untouched on Machine A! */
    const switch1Id = await company1.switchLeaderFromAToB();

    expect(await company1.termOnB()).toMatchObject({ number: 2, machine: SHARED_HOST_B_ID, split: false });
    expect(await company1.pendingMovesOnB()).toEqual([]);
    expect(await company1.handoverOnB(switch1Id)).toEqual({
      from: company1.rowAId,
      term: { number: 1, machine: SHARED_HOST_A_ID, split: false },
      slots: { [SHARED_HOST_A_ID]: company1.slotOnBForA },
    });
    expect(readHanding(company1.dirA)).toBeNull();
    expect(company1.stateA.exited).toBe(1);
    expect(existsSync(join(company1.controlA, REPLICA_FILE))).toBe(true);
    expect(company1.relayEntry.holder).toBe(linkClientId(company1.linkName, SHARED_HOST_B_ID));

    /* Verify Company 2 experienced ZERO side effects while Company 1 switched on the same two machines. */
    expect(company2.stateA.leads).toBe(true);
    expect(company2.stateA.fenced).toBe(false);
    expect(company2.stateA.tunnelRunning).toBe(true);
    expect(company2.stateB.subEnabled).toBe(true);
    expect(company2.stateB.takerExited).toBe(0);
    expect(await company2.termOnA()).toMatchObject({ number: 1, machine: SHARED_HOST_A_ID, split: false });
    expect(await company2.termOnB()).toBeNull();
    expect(await company2.copiedNamesOnB()).toEqual(['Company beta']);
    expect(existsSync(join(company2.controlA, REPLICA_FILE))).toBe(false);
    expect(company2.relayEntry.holder).toBe(linkClientId(company2.linkName, SHARED_HOST_A_ID));
    expect(company2.peerLog).toEqual([]);

    /* 4. Now switch Company 2's leader from Machine A to Machine B. Company 1 on Machine B stays untouched! */
    const c1PeerCallsBefore = [...company1.peerLog];
    const c1RelayGenBefore = company1.relayEntry.generation;

    const switch2Id = await company2.switchLeaderFromAToB();

    expect(await company2.termOnB()).toMatchObject({ number: 2, machine: SHARED_HOST_B_ID, split: false });
    expect(await company2.pendingMovesOnB()).toEqual([]);
    expect(await company2.handoverOnB(switch2Id)).toEqual({
      from: company2.rowAId,
      term: { number: 1, machine: SHARED_HOST_A_ID, split: false },
      slots: { [SHARED_HOST_A_ID]: company2.slotOnBForA },
    });
    expect(readHanding(company2.dirA)).toBeNull();
    expect(company2.stateA.exited).toBe(1);
    expect(existsSync(join(company2.controlA, REPLICA_FILE))).toBe(true);
    expect(company2.relayEntry.holder).toBe(linkClientId(company2.linkName, SHARED_HOST_B_ID));

    /* Company 1 remains untouched on Machine B under term 2. */
    expect(await company1.termOnB()).toMatchObject({ number: 2, machine: SHARED_HOST_B_ID, split: false });
    expect(await company1.copiedNamesOnB()).toEqual(['Company alpha']);
    expect(company1.relayEntry.holder).toBe(linkClientId(company1.linkName, SHARED_HOST_B_ID));
    expect(company1.relayEntry.generation).toBe(c1RelayGenBefore);
    expect(company1.peerLog).toEqual(c1PeerCallsBefore);
    expect(basename(alphaBDir)).not.toBe(basename(betaBDir));
    void SWITCH_MS;
  }, 90_000);
});
