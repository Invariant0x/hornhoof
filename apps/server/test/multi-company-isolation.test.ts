import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { install, SUB_A } from './install-script-helpers.js';
import { ask, runOnce, stand } from './updater-fixture.js';
import { cidrsOverlap, LAN_ADDR_A, LAN_ADDR_B, LAN_ROUTE_A, LAN_ROUTE_B, makeComputer } from './multi-company-computers.js';

const COMPOSE_PATH = fileURLToPath(new URL('../../../compose.yaml', import.meta.url));
const WORKER_COMPOSE_PATH = fileURLToPath(new URL('../../../compose.worker.yaml', import.meta.url));
const INSTALL_GUIDE_PATH = fileURLToPath(new URL('../../../guide/install.md', import.meta.url));

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });
});
