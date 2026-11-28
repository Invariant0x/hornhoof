import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, matchesGlob, relative, resolve, sep } from 'node:path';
import type { Command } from '@hornhoof/protocol';
import type { JobUser } from './isolation.js';
import { declaringRepository, readWarmServices, servicesNeeded, type WarmService } from './warm-declaration.js';

/* The test services repositories declare, kept warm once for the machine, and a piece of each for one run (#2091). The
   machine keeps a folder for each service, as its declaration names it; whichever node finds it down starts it, and the one
   that started it starts it again when it ends. A piece is named for the run's own and recorded with the process that owns
   it; a sweep drops those whose process is gone, on start and on a timer. */

export type WarmPiece = { env: Record<string, string>; drop(): Promise<void> };
export type WarmOptions = { root: string; user: JobUser | null; sweepMs?: number; readyMs?: number; log?: (line: string) => void };

const READY_MS = 60_000;
const STEP_MS = 30_000;
const BUILD_MS = 15 * 60_000;
const SWEEP_MS = 5 * 60_000;
const PROBE_MS = 100;
const RESTART_MS = 500;
const STOP_MS = 5_000;
const PIECE = /^hh_[0-9a-f]{12}$/;
const OUTPUT_BYTES = 64 * 1024;

type Ran = { code: number | null; stdout: string; stderr: string };
/* Where a service is kept on the machine: home, the node's own records of it, and state within it, the service's own folder,
   which its commands write as the agent's user; and the repository its commands run in, the one that asked for it last. */
type Kept = { service: WarmService; home: string; state: string; repository: string };
type Started = { child: ChildProcess; stopping: boolean; since: number };

const RESTART_MAX_MS = 30_000;
const digestOf = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const keyOf = (service: WarmService) => digestOf(JSON.stringify({ start: service.start ?? null, ready: service.ready ?? null, build: service.build ?? null, piece: service.piece })).slice(0, 12);
const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

const withPlaces = (args: readonly string[], places: Record<string, string>) => args.map(arg => arg.replace(/\{(state|digest|piece)\}/g, (all, name: string) => places[name] ?? all));

/* A file no other process may take while its owner lives, or null while one does. */
function claim(path: string): boolean {
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, String(process.pid)); closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(readFileSync(path, 'utf8').trim());
      if (owner && alive(owner)) return false;
      rmSync(path, { force: true });
    }
  }
  return false;
}

/* The files of the build's inputs, by their path in the repository: a glob is read only below the folders before it, and
   one that names a file with no pattern is that file. */
function inputFiles(repository: string, globs: readonly string[]): string[] {
  const found = new Set<string>();
  const take = (path: string) => {
    const rel = relative(repository, path).split(sep).join('/');
    if (globs.some(glob => matchesGlob(rel, glob))) found.add(rel);
  };
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    if (!statSync(dir).isDirectory()) { take(dir); return; }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) take(path);
    }
  };
  for (const base of new Set(globs.map(glob => glob.split('/').filter((_p, i, all) => !all.slice(0, i + 1).some(part => /[*?[{]/.test(part))).join('/')))) walk(join(repository, base));
  return [...found].sort();
}


export class WarmServices {
  private readonly started = new Map<string, Started>();
  private readonly backoff = new Map<string, number>();
  private readonly ups = new Map<string, Promise<void>>();
  private readonly builds = new Map<string, Promise<void>>();
  /* The pieces this process owns, by the run they are for. */
  private readonly owned = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  private readonly serviceUser: JobUser | null;

  constructor(readonly options: WarmOptions) {
    this.serviceUser = options.user?.uid === process.getuid?.() ? null : options.user;
  }

  async start(): Promise<void> {
    await this.sweep().catch(error => this.log(`warm services: sweep failed: ${String(error)}`));
    const every = this.options.sweepMs ?? SWEEP_MS;
    if (every > 0 && !this.timer) {
      this.timer = setInterval(() => { void this.sweep().catch(error => this.log(`warm services: sweep failed: ${String(error)}`)); }, every);
      this.timer.unref();
    }
  }

  /* The pieces a check in cwd of this command gets, one of each service it needs, and their variables; null when it needs none. */
  async pieceFor(cwd: string, command: readonly string[], owner: string, signal: AbortSignal): Promise<WarmPiece | null> {
    const repository = declaringRepository(cwd);
    if (!repository) return null;
    const needed = servicesNeeded(readWarmServices(repository), repository, cwd, command);
    if (!needed.length) return null;
    const made: { kept: Kept; piece: string }[] = [];
    const drop = async () => {
      const errors: unknown[] = [];
      for (const { kept, piece } of made.splice(0).reverse()) await this.dropPiece(kept, piece, owner).catch(error => errors.push(error));
      if (errors.length) throw new AggregateError(errors, 'A piece of a warm service could not be dropped; the next sweep drops it.');
    };
    try {
      const env: Record<string, string> = {};
      for (const service of needed) {
        const kept = this.keep(service, repository);
        await this.up(kept, signal);
        const digest = await this.built(kept, signal);
        const piece = `hh_${randomBytes(6).toString('hex')}`;
        this.own(kept, piece, owner);
        made.push({ kept, piece });
        Object.assign(env, await this.create(kept, digest, piece, signal));
      }
      return { env, drop };
    } catch (error) {
      await drop().catch(() => {});
      throw error;
    }
  }

  /* Drops each piece no live process owns, of every service kept on the machine; the number it dropped. */
  async sweep(): Promise<number> {
    if (!existsSync(this.options.root)) return 0;
    let dropped = 0;
    for (const name of readdirSync(this.options.root)) {
      const kept = this.read(join(this.options.root, name));
      if (!kept) continue;
      const listed = await this.run(kept, kept.service.piece.list, {}, STEP_MS);
      if (listed.code !== 0) continue;
      const pieces = new Set(listed.stdout.split('\n').map(line => line.trim()).filter(line => PIECE.test(line)));
      const owners = join(kept.home, 'owners');
      for (const piece of pieces) {
        if (this.ownerLives(kept, piece)) continue;
        const ran = await this.run(kept, kept.service.piece.drop, { piece }, STEP_MS);
        if (ran.code === 0) { rmSync(join(owners, piece), { force: true }); dropped++; }
      }
      if (existsSync(owners)) for (const piece of readdirSync(owners)) if (!pieces.has(piece) && !this.ownerLives(kept, piece)) rmSync(join(owners, piece), { force: true });
    }
    return dropped;
  }

  /* Stops sweeping; stopServices: also the services this process started, as a node that leaves the machine does. */
  async close({ stopServices }: { stopServices: boolean }): Promise<void> {
    this.closed = true;
    clearInterval(this.timer); this.timer = undefined;
    /* Left up, it is no longer this process's to start again: whichever node finds it down next starts it. */
    if (!stopServices) {
      for (const [home, started] of this.started) { started.stopping = true; started.child.unref(); rmSync(join(home, 'supervisor'), { force: true }); }
      this.started.clear();
      return;
    }
    await Promise.all([...this.started.keys()].map(home => this.stopService(home)));
  }

  private async stopService(home: string): Promise<void> {
    const started = this.started.get(home);
    if (!started) return;
    this.started.delete(home);
    started.stopping = true;
    const { child } = started;
    const ended = new Promise(done => { if (child.exitCode !== null || child.signalCode !== null) done(null); else child.once('exit', done); });
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* It ended. */ }
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* It ended. */ } }, STOP_MS);
    await ended; clearTimeout(timer);
    rmSync(join(home, 'supervisor'), { force: true });
  }

  private log(line: string): void { this.options.log?.(line); }

  /* The service's folder on the machine, and the repository its commands run in from now. */
  private keep(service: WarmService, repository: string): Kept {
    const user = this.options.user;
    const home = join(this.options.root, `${service.id}-${keyOf(service)}-${user?.uid ?? process.getuid?.() ?? 0}`), state = join(home, 'service');
    mkdirSync(join(home, 'owners'), { recursive: true, mode: 0o700 });
    if (!existsSync(state)) {
      mkdirSync(state, { mode: 0o700 });
      if (this.serviceUser) chownSync(state, this.serviceUser.uid, this.serviceUser.gid);
    }
    const record = join(home, `service.${process.pid}.json`);
    writeFileSync(record, JSON.stringify({ service, repository }), { mode: 0o600 });
    renameSync(record, join(home, 'service.json'));
    this.allowStateAccess(home);
    return { service, home, state, repository };
  }

  private allowStateAccess(home: string): void {
    const user = this.serviceUser;
    if (!user) return;
    // Older nodes created the record with the default file mode.
    chmodSync(join(home, 'service.json'), 0o600);
    for (const dir of [this.options.root, home]) {
      chownSync(dir, -1, user.gid);
      chmodSync(dir, 0o710);
    }
  }

  private read(home: string): Kept | null {
    try {
      const { service, repository } = JSON.parse(readFileSync(join(home, 'service.json'), 'utf8')) as Pick<Kept, 'service' | 'repository'>;
      if (!existsSync(repository)) return null;
      this.allowStateAccess(home);
      return { service, home, state: join(home, 'service'), repository };
    } catch { return null; }
  }

  private own(kept: Kept, piece: string, owner: string): void {
    writeFileSync(join(kept.home, 'owners', piece), JSON.stringify({ pid: process.pid, owner }));
    const pieces = this.owned.get(owner) ?? new Set<string>();
    pieces.add(`${kept.home}\0${piece}`); this.owned.set(owner, pieces);
  }

  private ownerLives(kept: Kept, piece: string): boolean {
    try {
      const { pid, owner } = JSON.parse(readFileSync(join(kept.home, 'owners', piece), 'utf8')) as { pid: number; owner: string };
      if (pid !== process.pid) return alive(pid);
      return this.owned.get(owner)?.has(`${kept.home}\0${piece}`) ?? false;
    } catch { return false; }
  }

  private async dropPiece(kept: Kept, piece: string, owner: string): Promise<void> {
    const pieces = this.owned.get(owner);
    pieces?.delete(`${kept.home}\0${piece}`);
    if (pieces && !pieces.size) this.owned.delete(owner);
    const ran = await this.run(kept, kept.service.piece.drop, { piece }, STEP_MS);
    if (ran.code !== 0) throw new Error(`${kept.service.id} could not drop ${piece}: ${ran.stderr.trim().slice(-500) || `exit ${ran.code}`}.`);
    rmSync(join(kept.home, 'owners', piece), { force: true });
  }

  private async create(kept: Kept, digest: string, piece: string, signal: AbortSignal): Promise<Record<string, string>> {
    const ran = await this.run(kept, kept.service.piece.create, { digest, piece }, STEP_MS, signal);
    if (ran.code !== 0) throw new Error(`${kept.service.id} could not make a piece: ${ran.stderr.trim().slice(-500) || `exit ${ran.code}`}.`);
    const env: Record<string, string> = {};
    for (const line of ran.stdout.split('\n').filter(Boolean)) {
      const at = line.indexOf('='), name = line.slice(0, at);
      if (at < 1 || !kept.service.piece.env.includes(name)) throw new Error(`${name || line.slice(0, 64)} is not a variable ${kept.service.id} declares.`);
      env[name] = line.slice(at + 1);
    }
    return env;
  }

  /* Up for the machine: answering, or started by this process, or by another one still alive, and answering in time. */
  private up(kept: Kept, signal: AbortSignal): Promise<void> {
    const pending = this.ups.get(kept.home);
    if (pending) return pending;
    const going = this.bringUp(kept, signal).finally(() => this.ups.delete(kept.home));
    this.ups.set(kept.home, going);
    return going;
  }

  private async bringUp(kept: Kept, signal: AbortSignal): Promise<void> {
    if (!kept.service.start || await this.answers(kept)) return;
    const launched = !this.started.has(kept.home) && claim(join(kept.home, 'supervisor'));
    if (launched) this.launch(kept);
    const readyMs = this.options.readyMs ?? READY_MS, until = Date.now() + readyMs;
    while (Date.now() < until) {
      signal.throwIfAborted();
      if (await this.answers(kept)) return;
      await pause(PROBE_MS);
    }
    /* One that never answers is not left running for nothing: the next run starts it again. */
    if (launched) await this.stopService(kept.home);
    throw new Error(`${kept.service.id} did not answer within ${readyMs / 1000} s.`);
  }

  private async answers(kept: Kept): Promise<boolean> {
    return (await this.run(kept, kept.service.ready!, {}, STEP_MS)).code === 0;
  }

  /* Starts the service for the machine and starts it again whenever it ends, until this process closes. */
  private launch(kept: Kept): void {
    const start = kept.service.start!;
    const log = openSync(join(kept.home, 'service.log'), 'a', 0o600);
    const child = spawn(start.program, withPlaces(start.args, { state: kept.state }), { ...this.spawnOptions(kept, start), detached: true, stdio: ['ignore', log, log] });
    closeSync(log);
    const started: Started = { child, stopping: false, since: Date.now() };
    this.started.set(kept.home, started);
    child.once('error', error => this.log(`warm services: ${kept.service.id} could not start: ${error.message}`));
    child.once('exit', () => {
      if (started.stopping || this.closed) return;
      /* One that keeps ending at once is started again less and less often, up to twice a minute. */
      const wait = Date.now() - started.since > 60_000 ? RESTART_MS : Math.min(RESTART_MAX_MS, (this.backoff.get(kept.home) ?? RESTART_MS / 2) * 2);
      this.backoff.set(kept.home, wait);
      this.log(`warm services: ${kept.service.id} ended; starting it again in ${wait / 1000} s.`);
      setTimeout(() => { if (!this.closed && this.started.get(kept.home) === started) this.launch(kept); }, wait).unref();
    });
  }

  /* The digest of the build's inputs in the run's repository, built once for the machine. */
  private async built(kept: Kept, signal: AbortSignal): Promise<string> {
    const build = kept.service.build;
    if (!build) return '';
    const files = inputFiles(kept.repository, build.inputs);
    const digest = digestOf(files.map(file => `${file}\0${digestOf(readFileSync(join(kept.repository, file)))}`).join('\0'));
    const key = `${kept.home}\0${digest}`;
    let pending = this.builds.get(key);
    if (!pending) {
      pending = this.buildOnce(kept, digest, signal).finally(() => this.builds.delete(key));
      this.builds.set(key, pending);
    }
    await pending;
    return digest;
  }

  private async buildOnce(kept: Kept, digest: string, signal: AbortSignal): Promise<void> {
    const dir = join(kept.home, 'builds'), done = join(dir, `${digest}.done`), lock = join(dir, `${digest}.lock`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const until = Date.now() + BUILD_MS; !existsSync(done); await pause(PROBE_MS)) {
      signal.throwIfAborted();
      if (Date.now() > until) throw new Error(`${kept.service.id} was not built within ${BUILD_MS / 60_000} min.`);
      if (!claim(lock)) continue;
      try {
        const ran = await this.run(kept, kept.service.build!.command, { digest }, BUILD_MS, signal);
        if (ran.code !== 0) throw new Error(`${kept.service.id} could not be built: ${ran.stderr.trim().slice(-500) || `exit ${ran.code}`}.`);
        writeFileSync(done, '');
      } finally { rmSync(lock, { force: true }); }
    }
  }

  private spawnOptions(kept: Kept, command: Command) {
    const cwd = resolve(kept.repository, command.cwd);
    if (relative(kept.repository, cwd).startsWith('..')) throw new Error(`A command of ${kept.service.id} runs outside its repository.`);
    const as = this.serviceUser ?? {};
    return { cwd, env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, ...as };
  }

  /* A declared command to its end, or until ms or the run's signal stop it. */
  private run(kept: Kept, command: Command, places: Record<string, string>, ms: number, signal?: AbortSignal): Promise<Ran> {
    return new Promise((done, fail) => {
      const child = spawn(command.program, withPlaces(command.args, { ...places, state: kept.state }), { ...this.spawnOptions(kept, command), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { if (stdout.length < OUTPUT_BYTES) stdout += String(chunk); });
      child.stderr.on('data', chunk => { if (stderr.length < OUTPUT_BYTES) stderr += String(chunk); });
      const stop = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* It ended. */ } };
      const timer = setTimeout(stop, ms);
      signal?.addEventListener('abort', stop, { once: true });
      child.once('error', error => { clearTimeout(timer); fail(error); });
      child.once('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', stop); done({ code, stdout, stderr }); });
    });
  }
}

