import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COPY_STATE } from './copy.js';
import { reasonOf, writePrivately } from './machine-keys.js';
import { RETRY_UPLOAD_MS, UPLOAD_AGAIN_MS, UPLOAD_FILE, UPLOADS_DIR, WIPE_FILE, WIPED_FILE } from './uploads.js';

const PACKED = '.tar.gz';
/* What the keeper's own folder holds of the time this machine kept a copy: how far its copy was, and the settings of
   the clients that reached the other data machines and offered this one to them. */
const KEEPER_FILES = [COPY_STATE, 'frpc-peer.toml', 'frpc-visit.toml'];

export type LeavingOptions = {
  controlDir: string;
  /* The keeper's own folder. */
  dir: string;
  /* Stops this machine's copy from taking anything more from the leader. */
  halt: () => Promise<void>;
  /* Sends one packed upload to the keeper that leads, and gives its answer's status. */
  put: (id: string, file: string, length: number) => Promise<number>;
  /* The address of the company's link, https and its host; null without one. A machine the company was installed on
     reaches the company there once it is wiped, as a worker. */
  server?: () => string | null;
  log: (line: string) => void;
  clock?: () => number;
  /* How long after the leader took an upload it is offered again, and how long after anything else. */
  againMs?: number;
  retryMs?: number;
};

/* What the keeper of a machine does once its owner sees the whole company no more, so that the machine may hold the
   company's data no longer: it stops its copy, asks its updater for everything the copy holds and gives that to the
   leader, and only when the leader says it has that merged and saved asks its updater to wipe the machine. Until then
   nothing the machine holds is removed. */
export class Leaving {
  private halted = false;
  private readonly said = new Set<string>();
  /* The last time an upload was offered to the leader, and what it answered; null while none was. */
  private offered: { id: string; at: number; status: number | null } | null = null;
  /* Since when the updater's word that it could not make the upload was seen. */
  private failedAt: number | null = null;

  constructor(private readonly opts: LeavingOptions) {}

  private clock(): number {
    return this.opts.clock?.() ?? performance.now();
  }

  private sayOnce(what: string, line: string): void {
    if (this.said.has(what)) return;
    this.said.add(what);
    this.opts.log(line);
  }

  /* One step, by what the leader says this machine still owes: what it holds, nothing while the leader reads that, or
     its wipe. */
  async step(owed: 'waiting' | 'received' | 'wipe'): Promise<void> {
    if (!(await this.halt())) return;
    if (owed === 'waiting') return this.give();
    this.dropUpload();
    if (owed === 'wipe') this.askWipe();
  }

  /* Nothing is read from a copy that still changes. */
  private async halt(): Promise<boolean> {
    if (this.halted) return true;
    try {
      await this.opts.halt();
      this.halted = true;
      this.opts.log("This machine's owner does not see the whole company any more: its copy stops, and what it holds goes to the company server.");
    } catch (err) {
      this.sayOnce('halt', `Could not stop this machine's copy yet: ${reasonOf(err)}`);
    }
    return this.halted;
  }

  private uploads(): string {
    return join(this.opts.controlDir, UPLOADS_DIR);
  }

  private names(): string[] {
    return existsSync(this.uploads()) ? readdirSync(this.uploads()) : [];
  }

  /* The upload the updater made is offered to the leader; with none, the updater is asked for one. One it could not
     make is asked for again a minute later. */
  private async give(): Promise<void> {
    const names = this.names();
    const made = names.find(name => name.endsWith('.done') && names.includes(`${name.slice(0, -'.done'.length)}${PACKED}`));
    if (made) return this.offer(made.slice(0, -'.done'.length));
    if (existsSync(join(this.opts.controlDir, UPLOAD_FILE))) return;
    if (names.some(name => name.endsWith('.failed'))) {
      this.failedAt ??= this.clock();
      if (this.clock() - this.failedAt < (this.opts.retryMs ?? UPLOAD_AGAIN_MS)) return;
    }
    this.failedAt = null;
    try {
      for (const name of names) rmSync(join(this.uploads(), name), { recursive: true, force: true });
      writePrivately(join(this.opts.controlDir, UPLOAD_FILE), JSON.stringify({ id: randomUUID() }));
    } catch (err) {
      this.sayOnce('ask', `Could not ask the updater for what this machine holds: ${reasonOf(err)}`);
    }
  }

  /* The same upload is offered until the leader's view says it has it: a leader that took it and could not load it
     takes it again, and one that loaded it answers so and takes nothing twice. */
  private async offer(id: string): Promise<void> {
    const last = this.offered?.id === id ? this.offered : null;
    if (last && this.clock() - last.at < (last.status === 201 ? (this.opts.againMs ?? RETRY_UPLOAD_MS) : (this.opts.retryMs ?? UPLOAD_AGAIN_MS))) return;
    const file = join(this.uploads(), `${id}${PACKED}`);
    let status: number | null = null;
    try {
      status = await this.opts.put(id, file, statSync(file).size);
      if (status === 201) this.sayOnce(`taken ${id}`, 'The company server took what this machine held.');
      else this.sayOnce(`refused ${id} ${status}`, `The company server did not take what this machine holds yet (${status}). It is offered again each minute.`);
    } catch (err) {
      this.sayOnce(`put ${id}`, `Could not send what this machine holds to the company server: ${reasonOf(err)}. It is sent again each minute.`);
    }
    this.offered = { id, at: this.clock(), status };
  }

  /* The leader has it as a database of its own: the packed copy here is of no use any more. */
  private dropUpload(): void {
    try {
      for (const name of this.names()) rmSync(join(this.uploads(), name), { recursive: true, force: true });
      rmSync(join(this.opts.controlDir, UPLOAD_FILE), { force: true });
    } catch (err) {
      this.sayOnce('drop', `Could not remove the upload this machine made: ${reasonOf(err)}`);
    }
  }

  /* The leader keeps everything this machine held, merged and saved: what the keeper's own folder holds of the copy
     goes, and the updater is asked for the rest. Asked once: the updater keeps the request until every step is done. */
  private askWipe(): void {
    const { controlDir, dir } = this.opts;
    if (existsSync(join(controlDir, WIPE_FILE)) || existsSync(join(controlDir, WIPED_FILE))) return;
    try {
      for (const name of KEEPER_FILES) rmSync(join(dir, name), { force: true });
      const server = this.opts.server?.() ?? null;
      writePrivately(join(controlDir, WIPE_FILE), JSON.stringify({ id: randomUUID(), ...(server ? { server } : {}) }));
      this.opts.log("The company server keeps everything this machine held: its database, its dumps and the company's secrets go now.");
    } catch (err) {
      this.sayOnce('wipe', `Could not ask the updater to wipe this machine: ${reasonOf(err)}`);
    }
  }
}
