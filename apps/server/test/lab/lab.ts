import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { KEEPER_PORTS } from '../../src/modules/keeper/doors.js';
import { serviceName } from '../../src/modules/link/peer-client.js';
import { VISIT_FIRST_PORT } from '../../src/modules/link/visit-client.js';
import { fakeRelay, type FakeRelay } from '../fake-relay.js';
import { createDelayGate, createPeerRelay, type DelayGate, type PeerRelay } from './network.js';

/* The lab: computers with a Docker of their own, as containers on one network of this computer's Docker. The server is
   installed on one by install.sh and the others join it with the Machines tab's command, from the images this worktree
   builds. Everything the lab makes carries its label, and stop() removes exactly that. */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HERE = fileURLToPath(new URL('./', import.meta.url));
export const LAB_IMAGES = { app: 'hornhoof-lab/app:dev', node: 'hornhoof-lab/node:dev', updater: 'hornhoof-lab/updater:dev' } as const;
const MACHINE_IMAGE = 'hornhoof-lab/machine:dev';

export type Ran = { code: number; out: string };
export type LabMachine = {
  name: string;
  /* The machine's address on the lab's network: nested containers of another machine may not resolve its name. */
  address: string;
  exec(cmd: string, opts?: { env?: Record<string, string>; input?: string }): Promise<Ran>;
};

/* One command, with what it printed on both streams; it takes as long as it takes. */
function run(program: string, args: string[], opts: { input?: string; cwd?: string } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => (out += text));
    child.stderr.setEncoding('utf8').on('data', (text: string) => (out += text));
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, out }));
    child.stdin.end(opts.input ?? '');
  });
}

async function must(program: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const ran = await run(program, args, opts);
  if (ran.code !== 0) throw new Error(`${program} ${args.slice(0, 4).join(' ')} failed:\n${ran.out.slice(-2000)}`);
  return ran.out.trim();
}

/* docker save of the images into the machine's own Docker, through a pipe: nothing of it touches this computer's disk. */
function load(machine: string, images: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const save = spawn('docker', ['save', ...images], { stdio: ['ignore', 'pipe', 'inherit'] });
    const into = spawn('docker', ['exec', '-i', machine, 'docker', 'load'], { stdio: ['pipe', 'ignore', 'inherit'] });
    save.stdout.pipe(into.stdin);
    save.on('error', reject);
    into.on('error', reject);
    into.on('close', code => (code === 0 ? resolve() : reject(new Error(`docker load on ${machine} ended with ${String(code)}`))));
  });
}

/* A network with addresses of its own choosing, so a machine can be put at the address another one had. Docker
   refuses a range another network has, and then another one is tried. */
async function makeNetwork(name: string, label: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    const range = `10.${200 + randomBytes(1)[0]! % 50}.${randomBytes(1)[0]!}.0/24`;
    const made = await run('docker', ['network', 'create', '--label', label, '--subnet', range, name]);
    if (made.code === 0) return;
    if (tries >= 20 || !/overlap/i.test(made.out)) throw new Error(`docker network create failed:\n${made.out.slice(-1000)}`);
  }
}

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/* A command in the keeper's container of a machine, named by the folder its compose runs from: docker exec alone, since
   compose takes a second to start and a keeper waits two for hornhoof.org's answer. */
const inKeeper = (at: { machine: LabMachine; folder: string }, cmd: string): Promise<Ran> =>
  at.machine.exec(`docker exec ${at.folder.split('/').pop()!}-keeper-1 sh -c ${shellQuote(cmd)}`);

/* Script run inside a keeper container to bridge its peer doors and visitor loopback ports through the host PeerRelay. */
export function bridgeScript(host: string, relayPort: number, offers: Record<string, number>, visits: Array<{ port: number; service: string }>): string {
  const cfg = JSON.stringify({ host: host.replace(/^\[|\]$/g, ''), relayPort, offers, visits });
  return `const net = require('node:net');
const cfg = ${cfg};
for (const [service, localPort] of Object.entries(cfg.offers)) {
  const connectOffer = () => {
    const ctrl = net.connect({ port: cfg.relayPort, host: cfg.host, noDelay: true }, () => ctrl.write(JSON.stringify({ op: 'offer', service }) + '\\n'));
    let buf = '';
    ctrl.setEncoding('utf8');
    ctrl.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\\n');
      buf = lines.pop();
      for (const line of lines) {
        const { knock } = JSON.parse(line);
        const local = net.connect({ port: localPort, host: '127.0.0.1', noDelay: true });
        const up = net.connect({ port: cfg.relayPort, host: cfg.host, noDelay: true }, () => up.write(JSON.stringify({ op: 'accept', token: knock }) + '\\n'));
        local.on('error', () => up.destroy());
        up.on('error', () => local.destroy());
        local.pipe(up);
        up.pipe(local);
      }
    });
    ctrl.on('error', () => {});
    ctrl.on('close', () => setTimeout(connectOffer, 500));
  };
  connectOffer();
}
for (const { port, service } of cfg.visits) {
  const srv = net.createServer({ noDelay: true }, client => {
    client.setNoDelay(true);
    const up = net.connect({ port: cfg.relayPort, host: cfg.host, noDelay: true }, () => {
      up.write(JSON.stringify({ op: 'visit', service }) + '\\n');
      client.pipe(up);
      up.pipe(client);
    });
    client.on('error', () => up.destroy());
    up.on('error', () => client.destroy());
  });
  srv.on('error', () => process.exit(1));
  srv.listen(port, '127.0.0.1');
}`;
}

/* Builds the netfilter script run inside each lab machine to block or restore direct peer connections on published port
   8180. Because compose publishes 8180 -> keeper:7070 via Docker DNAT in PREROUTING, remote packets traverse FORWARD /
   DOCKER-USER with dport 7070 (ctorigdstport 8180) rather than INPUT; loopback traffic inside containers is untouched. */
export function directPeerBlockScript(blocked: boolean, publishedPort = 8180, containerPort = KEEPER_PORTS.peer): string {
  const inputRule = `INPUT ! -i lo -p tcp --dport ${publishedPort} -j REJECT --reject-with tcp-reset`;
  const forwardRule = `FORWARD ! -i lo -p tcp --dport ${containerPort} -j REJECT --reject-with tcp-reset`;
  const dockerOrigRule = `DOCKER-USER ! -i lo -p tcp -m conntrack --ctorigdstport ${publishedPort} -j REJECT --reject-with tcp-reset`;
  const dockerDestRule = `DOCKER-USER ! -i lo -p tcp --dport ${containerPort} -j REJECT --reject-with tcp-reset`;
  if (!blocked) {
    return [
      `while iptables -D ${dockerOrigRule} 2>/dev/null; do :; done`,
      `while iptables -D ${dockerDestRule} 2>/dev/null; do :; done`,
      `while iptables -D ${forwardRule} 2>/dev/null; do :; done`,
      `while iptables -D ${inputRule} 2>/dev/null; do :; done`,
    ].join('; ');
  }
  return [
    `if iptables -nL DOCKER-USER >/dev/null 2>&1; then (iptables -C ${dockerOrigRule} 2>/dev/null || iptables -I ${dockerOrigRule} 2>/dev/null || true); (iptables -C ${dockerDestRule} 2>/dev/null || iptables -I ${dockerDestRule}); fi`,
    `iptables -C ${forwardRule} 2>/dev/null || iptables -I ${forwardRule}`,
    `iptables -C ${inputRule} 2>/dev/null || iptables -I ${inputRule}`,
  ].join('; ');
}

export function keeperTcpProbeScript(host: string, port: number, timeoutMs = 3000): string {
  const target = JSON.stringify({ host: host.replace(/^\[|\]$/g, ''), port, timeout: timeoutMs });
  return [
    'const net = require("node:net");',
    `const s = net.connect(${target}, () => { console.log("CONNECTED"); s.destroy(); process.exit(0); });`,
    's.on("timeout", () => { console.log("TIMEOUT"); s.destroy(); process.exit(2); });',
    's.on("error", err => { console.log("REJECTED:" + (err.code || err.message)); process.exit(1); });',
  ].join(' ');
}

/* Runs the TCP probe inside the keeper service container (built from root Dockerfile node:22.23.4-alpine, which
   provides node and shares PeerSessions's network namespace) rather than on the outer docker:28.5.2-dind LabMachine
   (machine.Dockerfile: bash, curl, jq, coreutils, iptables, no node). */
export function keeperTcpProbeCommand(folder: string, host: string, port: number, timeoutMs = 3000): string {
  return `cd ${shellQuote(folder)} && docker compose exec -T keeper node -e ${shellQuote(keeperTcpProbeScript(host, port, timeoutMs))}`;
}

export function probeKeeperTcp(
  at: { machine: Pick<LabMachine, 'exec'>; folder: string },
  host: string,
  port: number,
  timeoutMs = 3000,
): Promise<Ran> {
  return at.machine.exec(keeperTcpProbeCommand(at.folder, host, port, timeoutMs));
}

export class Lab {
  private made = 0;
  private relays: { close(): Promise<void> }[] = [];
  /* The machines that are off the lab's network now, by their names. */
  private readonly cuts = new Set<string>();

  private constructor(
    private readonly id: string,
    private readonly machines: (LabMachine | null)[],
  ) {}

  private get label(): string {
    return `hornhoof.lab=${this.id}`;
  }

  /* HH_LAB_BUILT=1: the three images are built already, as by a run before. */
  static async start(opts: { machines: number }): Promise<Lab> {
    const id = randomBytes(4).toString('hex');
    const label = `hornhoof.lab=${id}`;
    if (!process.env.HH_LAB_BUILT) {
      await must('docker', ['build', '-q', '-t', LAB_IMAGES.app, '.'], { cwd: ROOT });
      await must('docker', ['build', '-q', '-t', LAB_IMAGES.updater, '-f', 'apps/updater/Dockerfile', '.'], { cwd: ROOT });
      await must('docker', ['build', '-q', '-t', LAB_IMAGES.node, '-f', 'apps/node/Dockerfile', '.'], { cwd: ROOT });
    }
    await must('docker', ['build', '-q', '-t', MACHINE_IMAGE, '-f', 'machine.Dockerfile', '.'], { cwd: HERE });
    const lab = new Lab(id, []);
    try {
      await makeNetwork(`hh-lab-${id}`, label);
      for (let i = 1; i <= opts.machines; i++) lab.machines.push(await lab.boot(label));
      await Promise.all(lab.machines.map(machine => load(machine!.name, Object.values(LAB_IMAGES))));
      return lab;
    } catch (err) {
      await lab.stop();
      throw err;
    }
  }

  machine(i: number): LabMachine {
    const machine = this.machines[i - 1];
    if (!machine) throw new Error(`The lab has no machine ${i}.`);
    return machine;
  }

  /* Controllable latency and path cuts shared by the lab's relay, link probe and peer relay. */
  network(opts: { oneWayMs?: number; cut?: boolean } = {}): DelayGate {
    const gate = createDelayGate({ ...opts, keep: true });
    this.relays.push(gate);
    return gate;
  }

  /* That machine is gone with everything on it, as a computer that was lost: its container, the Docker inside it and
     its volumes. Its address is free again. */
  async remove(i: number): Promise<void> {
    const { name } = this.machine(i);
    await must('docker', ['rm', '-f', '-v', name]);
    await must('docker', ['volume', 'rm', '-f', `${name}-docker`]);
    this.machines[i - 1] = null;
  }

  /* A new machine on the lab's network, at that address when one is given, with the three images loaded as the first
     ones got them. */
  async add(opts: { ip?: string } = {}): Promise<LabMachine> {
    const machine = await this.boot(this.label, opts.ip);
    this.machines.push(machine);
    await load(machine.name, Object.values(LAB_IMAGES));
    return machine;
  }

  /* That machine is off the lab's network, as a computer whose cable was pulled: what runs on it goes on and reaches
     nothing outside it. The lab's stand-ins for hornhoof.org count it as gone, since docker exec still reaches it. */
  async cut(machine: LabMachine): Promise<void> {
    await must('docker', ['network', 'disconnect', `hh-lab-${this.id}`, machine.name]);
    this.cuts.add(machine.name);
  }

  /* And on it again, at the address it had. */
  async mend(machine: LabMachine): Promise<void> {
    await must('docker', ['network', 'connect', '--ip', machine.address, `hh-lab-${this.id}`, machine.name]);
    this.cuts.delete(machine.name);
  }

  /* A stand-in for the relay at hornhoof.org, served by this test on every interface of this computer, optionally
     behind a DelayGate so every route, sync and health request crosses 2 * oneWayMs. */
  async relay(opts: { gate?: DelayGate } = {}): Promise<{ url: string; fake: FakeRelay }> {
    const fake = await fakeRelay({ keep: true, host: '0.0.0.0' });
    this.relays.push(fake);
    const port = opts.gate ? (await opts.gate.httpProxy(fake.url, { host: '0.0.0.0' })).port : new URL(fake.url).port;
    return { url: `http://${await this.hostAddress()}:${port}`, fake };
  }

  /* The address the lab's machines know this computer by, as it goes into a web address: its IPv4 one where it has
     one, since a Docker that knows the computer by both names the IPv6 one first, and an IPv6 one in brackets. */
  private async hostAddress(): Promise<string> {
    const found = await this.machine(1).exec('getent ahostsv4 host.docker.internal || getent hosts host.docker.internal');
    const address = found.out.trim().split(/\s+/)[0];
    if (found.code !== 0 || !address) throw new Error(`The lab's machine does not know this computer's address: ${found.out}`);
    return address.includes(':') ? `[${address}]` : address;
  }

  /* A stand-in for hornhoof.org's part when a machine asks, through the company's public name, who answers there. When
     a DelayGate is passed, each probe crosses two round trips (machine -> edge and edge -> tunnel -> holder keeper). */
  async edge(
    fake: FakeRelay,
    name: string,
    machines: { machine: LabMachine; folder: string }[],
    opts: { gate?: DelayGate } = {},
  ): Promise<{ url: string; close(): Promise<void> }> {
    const holders = new Map<string, { machine: LabMachine; folder: string }>();
    const refreshHolders = async (): Promise<void> => {
      await Promise.all(
        machines.map(async at => {
          const settings = await inKeeper(at, 'cat /tmp/frpc.toml 2> /dev/null').catch(() => null);
          const client = settings && settings.code === 0 ? /clientID = "([^"]+)"/.exec(settings.out)?.[1] : undefined;
          if (client) holders.set(client, at);
        }),
      );
    };
    let going = true;
    const looking = (async () => {
      while (going) {
        await refreshHolders();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    })();
    const answer = async (req: http.IncomingMessage): Promise<{ status: number; body: string }> => {
      const url = new URL(String(req.url), 'http://edge');
      const nonce = url.searchParams.get('nonce') ?? '';
      if (req.method !== 'GET' || url.pathname !== '/api/network/lease' || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) return { status: 404, body: '' };
      const route = fake.routes.get(name);
      if (route?.state === 'held' && route.client && !holders.has(route.client)) await refreshHolders();
      const at = route?.state === 'held' && route.client ? holders.get(route.client) : undefined;
      if (!at || this.cuts.has(at.machine.name)) return { status: 502, body: '' };
      const asked = await inKeeper(at, `node -e "fetch('http://127.0.0.1:7081/api/network/lease?nonce=${nonce}').then(async r => console.log(JSON.stringify({ status: r.status, body: await r.text() })))"`);
      try {
        return JSON.parse(asked.out.trim().split('\n').pop() ?? '') as { status: number; body: string };
      } catch {
        return { status: 502, body: '' };
      }
    };
    const server = http.createServer((req, res) => {
      void answer(req)
        .catch(() => ({ status: 502, body: '' }))
        .then(({ status, body }) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body));
    });
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '0.0.0.0', resolve));
    const rawPort = (server.address() as AddressInfo).port;
    const port = opts.gate ? (await opts.gate.httpProxy(`http://127.0.0.1:${rawPort}`, { hops: 2, host: '0.0.0.0' })).port : rawPort;
    const close = async () => {
      going = false;
      await looking;
      await new Promise<void>(resolve => (server.closeAllConnections(), server.close(() => resolve())));
    };
    this.relays.push({ close });
    return { url: `http://${await this.hostAddress()}:${port}`, close };
  }

  /* Stand-in for frps's stcp peer relay between machines in the Docker lab, with optional TCP-RST blocking of direct
     LAN port 8180 so PeerSessions switches onto the delayed relay path (path = 'relay', directFails = true). */
  async peerRelay(
    linkName: string,
    places: { machine: LabMachine; folder: string; network: string }[],
    opts: { gate?: DelayGate; blockDirect?: boolean } = {},
  ): Promise<{ relay: PeerRelay; blockDirect(blocked: boolean): Promise<void>; stop(): Promise<void> }> {
    const gate = opts.gate ?? this.network({ oneWayMs: 0 });
    const relay = await createPeerRelay(gate, { host: '0.0.0.0', keep: true });
    const host = await this.hostAddress();
    let directBlocked = false;
    const blockDirect = async (blocked: boolean): Promise<void> => {
      const cmd = directPeerBlockScript(blocked);
      const results = await Promise.all(places.map(at => at.machine.exec(cmd)));
      const failed = results.find(ran => ran.code !== 0);
      if (blocked && failed) throw new Error(`directPeerBlockScript failed (${failed.code}):\n${failed.out}`);
      directBlocked = blocked;
    };
    if (opts.blockDirect) await blockDirect(true);
    let going = true;
    const loop = (async () => {
      const signatures = new Map<string, string>();
      while (going) {
        await Promise.all(
          places.map(async at => {
            if (this.cuts.has(at.machine.name)) {
              await inKeeper(at, 'pkill -f hh-lab-peer-bridge || true').catch(() => null);
              signatures.delete(at.machine.name);
              return;
            }
            const others = places.filter(p => p.network !== at.network);
            const visits = others.map((p, idx) => ({ port: VISIT_FIRST_PORT + idx, service: serviceName(linkName, p.network, 'data') }));
            const sig = `${at.network}:${visits.map(v => `${v.port}=${v.service}`).join(',')}`;
            const alive = await inKeeper(at, 'ps -o args | grep -q "[h]h-lab-peer-bridge"').catch(() => null);
            if (signatures.get(at.machine.name) === sig && alive?.code === 0) return;
            const offers = { [serviceName(linkName, at.network, 'data')]: KEEPER_PORTS.peer, [serviceName(linkName, at.network, 'app')]: KEEPER_PORTS.peerApp };
            const code = bridgeScript(host, relay.port, offers, visits).replaceAll("'", `'\\''`);
            await inKeeper(at, `pkill -f "frpc -c .*frpc-visit.toml" || true; pkill -f hh-lab-peer-bridge || true; nohup node -e '${code}' -- hh-lab-peer-bridge >/tmp/hh-peer-bridge.log 2>&1 &`).catch(() => null);
            signatures.set(at.machine.name, sig);
          }),
        );
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    })();
    const stop = async (): Promise<void> => {
      going = false;
      await loop;
      if (directBlocked) await blockDirect(false).catch(() => undefined);
      await relay.close();
    };
    this.relays.push({ close: stop });
    return { relay, blockDirect, stop };
  }

  /* Plays frps for the company's name, as hornhoof.org's relay does for as long as a scenario runs: each second it
     looks which machine's keeper runs the link's client, lets the name go once the client that holds it has run no
     more for two looks, and registers the client that runs when the name is free. A keeper that lost its lease stops
     its client, sees the name free, starts the client again and finds it registered one generation on, which is how it
     leads again. A machine that is cut off counts as one whose client runs no more. machines: looked at as they are
     when each look is taken, so a scenario may add to the list. */
  frps(fake: FakeRelay, name: string, machines: { machine: LabMachine; folder: string }[]): { stop(): Promise<void> } {
    const running = async (): Promise<string[]> => {
      const found = await Promise.all(
        machines.map(async at => {
          if (this.cuts.has(at.machine.name)) return null;
          const said = await inKeeper(at, 'ps -o args | grep -q "[f]rpc -c /tmp/frpc.toml" && cat /tmp/frpc.toml').catch(() => null);
          return said && said.code === 0 ? (/clientID = "([^"]+)"/.exec(said.out)?.[1] ?? null) : null;
        }),
      );
      return found.filter((client): client is string => client !== null);
    };
    let going = true;
    let gone = 0;
    const loop = (async () => {
      while (going) {
        const clients = await running().catch(() => [] as string[]);
        const route = fake.routes.get(name);
        if (route?.state === 'held') {
          gone = route.client && clients.includes(route.client) ? 0 : gone + 1;
          if (gone >= 2) {
            fake.drop(name);
            gone = 0;
          }
        } else if (clients[0]) fake.register(name, clients[0]);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    })();
    const stop = async () => {
      going = false;
      await loop;
    };
    this.relays.push({ close: stop });
    return { stop };
  }

  /* Removes exactly what carries the lab's label: its machines with the Docker inside them, its volumes, its network. */
  async stop(): Promise<void> {
    await Promise.all(this.relays.splice(0).map(relay => relay.close().catch(() => undefined)));
    const filter = ['--filter', `label=hornhoof.lab=${this.id}`];
    const ids = async (...what: string[]) => (await run('docker', [...what, ...filter, '-q'])).out.split('\n').filter(Boolean);
    const containers = await ids('ps', '-a');
    if (containers.length) await run('docker', ['rm', '-f', '-v', ...containers]);
    const volumes = await ids('volume', 'ls');
    if (volumes.length) await run('docker', ['volume', 'rm', '-f', ...volumes]);
    const networks = await ids('network', 'ls');
    if (networks.length) await run('docker', ['network', 'rm', ...networks]);
  }

  private async boot(label: string, ip?: string): Promise<LabMachine> {
    const i = ++this.made;
    const name = `hh-lab-${this.id}-m${i}`;
    /* The machine's own Docker keeps its images in a volume of the lab's, which goes with the lab. */
    await must('docker', ['volume', 'create', '--label', label, `${name}-docker`]);
    /* HH_LAB_MEMORY and HH_LAB_CPUS, as docker run takes them: what one machine of the lab may use at most, on a
       computer that does other work too. */
    const limits = [...(process.env.HH_LAB_MEMORY ? ['--memory', process.env.HH_LAB_MEMORY] : []), ...(process.env.HH_LAB_CPUS ? ['--cpus', process.env.HH_LAB_CPUS] : [])];
    /* host.docker.internal names this computer, on a Linux Docker as Docker Desktop gives it. */
    await must('docker', ['run', '-d', '--privileged', ...limits, '--name', name, '--hostname', `m${i}`, '--add-host', 'host.docker.internal:host-gateway', '--network', `hh-lab-${this.id}`, ...(ip ? ['--ip', ip] : []), '--label', label, '-v', `${name}-docker:/var/lib/docker`, MACHINE_IMAGE]);
    for (;;) {
      if ((await run('docker', ['exec', name, 'docker', 'info'])).code === 0) break;
      if ((await must('docker', ['inspect', '--format', '{{.State.Running}}', name])) !== 'true') throw new Error(`${name} stopped: ${(await run('docker', ['logs', '--tail', '30', name])).out}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const address = await must('docker', ['inspect', '--format', `{{(index .NetworkSettings.Networks "hh-lab-${this.id}").IPAddress}}`, name]);
    const exec: LabMachine['exec'] = (cmd, opts = {}) => {
      const env = Object.entries(opts.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
      return run('docker', ['exec', '-i', ...env, name, 'bash', '-c', cmd], { input: opts.input });
    };
    return { name, address, exec };
  }
}
