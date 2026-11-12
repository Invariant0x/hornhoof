import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { fakeRelay, type FakeRelay } from '../fake-relay.js';

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

/* A command in the keeper's container of a machine, named by the folder its compose runs from: docker exec alone, since
   compose takes a second to start and a keeper waits two for hornhoof.org's answer. */
const inKeeper = (at: { machine: LabMachine; folder: string }, cmd: string): Promise<Ran> =>
  at.machine.exec(`docker exec ${at.folder.split('/').pop()!}-keeper-1 sh -c '${cmd.replaceAll("'", `'\\''`)}'`);

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

  /* A stand-in for the relay at hornhoof.org, served by this test on every interface of this computer. url: where the
     lab's machines reach it, by the address they know this computer by: the containers inside a machine do not have
     its name. No frps runs in the lab, so the test registers a link's client itself, as frps would. */
  async relay(): Promise<{ url: string; fake: FakeRelay }> {
    const fake = await fakeRelay({ keep: true, host: '0.0.0.0' });
    this.relays.push(fake);
    return { url: `http://${await this.hostAddress()}:${new URL(fake.url).port}`, fake };
  }

  /* The address the lab's machines know this computer by, as it goes into a web address: its IPv4 one where it has
     one, since a Docker that knows the computer by both names the IPv6 one first, and an IPv6 one in brackets. */
  private async hostAddress(): Promise<string> {
    const found = await this.machine(1).exec('getent ahostsv4 host.docker.internal || getent hosts host.docker.internal');
    const address = found.out.trim().split(/\s+/)[0];
    if (found.code !== 0 || !address) throw new Error(`The lab's machine does not know this computer's address: ${found.out}`);
    return address.includes(':') ? `[${address}]` : address;
  }

  /* A stand-in for hornhoof.org's part when a machine asks, through the company's public name, who answers there: it
     looks up which client the fake relay's route for that name is held by, finds the machine whose link client has
     that id, and passes the question on to that machine's keeper, at the door its link client carries the name to.
     No machine holds the name, or the one that does is cut off or its keeper is stopped: 502. It plays the edge and
     frps in the probe, as register plays frps's plugin. */
  async edge(fake: FakeRelay, name: string, machines: { machine: LabMachine; folder: string }[]): Promise<{ url: string; close(): Promise<void> }> {
    /* Which machine's link client has which id, looked up every two seconds beside the questions: a question is
       answered within the two seconds a keeper waits only when it takes one command on one machine. */
    const holders = new Map<string, { machine: LabMachine; folder: string }>();
    let going = true;
    const looking = (async () => {
      while (going) {
        await Promise.all(
          machines.map(async at => {
            const settings = await inKeeper(at, 'cat /tmp/frpc.toml 2> /dev/null').catch(() => null);
            const client = settings && settings.code === 0 ? /clientID = "([^"]+)"/.exec(settings.out)?.[1] : undefined;
            if (client) holders.set(client, at);
          }),
        );
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    })();
    const answer = async (req: http.IncomingMessage): Promise<{ status: number; body: string }> => {
      const url = new URL(String(req.url), 'http://edge');
      const nonce = url.searchParams.get('nonce') ?? '';
      if (req.method !== 'GET' || url.pathname !== '/api/network/lease' || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) return { status: 404, body: '' };
      const route = fake.routes.get(name);
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
    const close = async () => {
      going = false;
      await looking;
      await new Promise<void>(resolve => (server.closeAllConnections(), server.close(() => resolve())));
    };
    this.relays.push({ close });
    return { url: `http://${await this.hostAddress()}:${(server.address() as AddressInfo).port}`, close };
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
