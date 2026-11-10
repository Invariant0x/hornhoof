import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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

export class Lab {
  private constructor(
    private readonly id: string,
    private readonly machines: LabMachine[],
  ) {}

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
      await must('docker', ['network', 'create', '--label', label, `hh-lab-${id}`]);
      for (let i = 1; i <= opts.machines; i++) lab.machines.push(await lab.boot(i, label));
      await Promise.all(lab.machines.map(machine => load(machine.name, Object.values(LAB_IMAGES))));
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

  /* Removes exactly what carries the lab's label: its machines with the Docker inside them, its volumes, its network. */
  async stop(): Promise<void> {
    const filter = ['--filter', `label=hornhoof.lab=${this.id}`];
    const ids = async (...what: string[]) => (await run('docker', [...what, ...filter, '-q'])).out.split('\n').filter(Boolean);
    const containers = await ids('ps', '-a');
    if (containers.length) await run('docker', ['rm', '-f', '-v', ...containers]);
    const volumes = await ids('volume', 'ls');
    if (volumes.length) await run('docker', ['volume', 'rm', '-f', ...volumes]);
    const networks = await ids('network', 'ls');
    if (networks.length) await run('docker', ['network', 'rm', ...networks]);
  }

  private async boot(i: number, label: string): Promise<LabMachine> {
    const name = `hh-lab-${this.id}-m${i}`;
    /* The machine's own Docker keeps its images in a volume of the lab's, which goes with the lab. */
    await must('docker', ['volume', 'create', '--label', label, `${name}-docker`]);
    await must('docker', ['run', '-d', '--privileged', '--name', name, '--hostname', `m${i}`, '--network', `hh-lab-${this.id}`, '--label', label, '-v', `${name}-docker:/var/lib/docker`, MACHINE_IMAGE]);
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
