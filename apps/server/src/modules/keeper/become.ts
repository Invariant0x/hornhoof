import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Decrypter } from 'age-encryption';
import { z } from 'zod';
import type { MachineRole } from '../../db/schema.js';
import type { BundleSecrets } from '../backups/bundle.js';
import { reasonOf, writePrivately } from './machine-keys.js';

/* In the control folder. replica.json: this machine keeps a copy, so its schema comes from the company server and its
   own migrations stay away. role.json: the secrets for the updater, which writes them into the settings and starts the
   database; it removes the file. role.failed: one line from the updater when it could not. */
export const REPLICA_FILE = 'replica.json';

/* The mark of a machine that keeps a copy, in the control folder: written whole and then moved, for any reader, since
   it holds no secret. Its updater and its app read it too. */
export function writeReplicaMarker(controlDir: string, now: number = Date.now()): void {
  const path = join(controlDir, REPLICA_FILE);
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify({ since: new Date(now).toISOString() }));
  chmodSync(partial, 0o644);
  renameSync(partial, path);
}
export const ROLE_FILE = 'role.json';
export const ROLE_FAILED = 'role.failed';
export const ROLE_RETRY_MS = 3_600_000;

/* The three settings as they may stand in the settings file, which is how the updater checks them too. A server with
   no node key says an empty one. */
const Secrets = z.strictObject({
  HORNHOOF_SECRET: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  NODE_KEY: z.string().regex(/^([A-Za-z0-9+/=_-]{32,200})?$/),
  RELAY_URL: z.string().regex(/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/),
});
const Answer = z.object({ sealed: z.string().min(1) });

type BecomingOptions = {
  controlDir: string;
  /* A request of the keeper's own to the leader's app. */
  ask: (method: 'POST', path: string) => Promise<{ status: number; body: unknown }>;
  /* The role the certificate this machine holds names; null with none. */
  heldRole: () => MachineRole | null;
  /* Asks for a new certificate now. */
  renew: () => void;
  /* The machine's own key for backups, which the secrets come sealed to. */
  age: () => Promise<{ identity: string }>;
  log: (line: string) => void;
  now?: () => Date;
  retryMs?: number;
};

/* What a worker's keeper does once the server gave its machine the data: it gets a certificate that says so, asks for
   the company's secrets, opens them with the machine's own key, and hands them to its updater. Only a worker's keeper
   runs this, and nothing of it once the machine keeps a copy. */
export class Becoming {
  private failedLine: string | null = null;
  /* This keeper wrote a request, which the updater may have taken since. */
  private asked = false;
  private failedAt = 0;

  constructor(private readonly opts: BecomingOptions) {}

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  private file(name: string): string {
    return join(this.opts.controlDir, name);
  }

  /* The updater's line while this machine could not become a data machine, until the next try. */
  failure(): string | null {
    return this.failedLine;
  }

  /* One step, with each view of the network the keeper reads. renewing: a certificate of the new role is asked for.
     asked: the secrets are with the updater. failed: the updater could not write them, and an hour passes first. */
  async step(view: { role: MachineRole }): Promise<'idle' | 'renewing' | 'asked' | 'failed'> {
    if (view.role !== 'data' || existsSync(this.file(ROLE_FILE))) return 'idle';
    /* The marker with no request: the updater works on the one this keeper wrote. A worker's keeper that finds the
       marker without having asked follows a keeper that stopped between the two files, and asks anew. */
    if (existsSync(this.file(REPLICA_FILE)) && this.asked) return 'idle';
    if (this.readFailure()) return 'failed';
    if (this.opts.heldRole() !== 'data') {
      this.opts.renew();
      return 'renewing';
    }
    try {
      const secrets = await this.secrets();
      this.writeMarker();
      writePrivately(this.file(ROLE_FILE), JSON.stringify({ id: randomUUID(), secrets }));
      this.asked = true;
      return 'asked';
    } catch (err) {
      this.opts.log(`Could not get the company's settings for this machine yet: ${reasonOf(err)}`);
      return 'idle';
    }
  }

  /* True while the last failure holds the next try back. */
  private readFailure(): boolean {
    const path = this.file(ROLE_FAILED);
    if (existsSync(path)) {
      this.failedLine = readFileSync(path, 'utf8').trim() || 'This machine could not become a data machine.';
      this.failedAt = this.now();
      rmSync(path, { force: true });
      return true;
    }
    if (this.failedLine === null) return false;
    if (this.now() - this.failedAt < (this.opts.retryMs ?? ROLE_RETRY_MS)) return true;
    this.failedLine = null;
    return false;
  }

  /* What the library says of a file it cannot open may quote it: nothing of it is passed on. */
  private async secrets(): Promise<BundleSecrets> {
    const res = await this.opts.ask('POST', '/api/network/secrets');
    if (res.status !== 200) throw new Error(`the server answered ${res.status}`);
    const answer = Answer.safeParse(res.body);
    if (!answer.success) throw new Error('the answer holds no settings');
    const { identity } = await this.opts.age();
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    const text = await decrypter.decrypt(Buffer.from(answer.data.sealed, 'base64'), 'text').catch(() => {
      throw new Error("the settings do not open with this machine's key");
    });
    const secrets = Secrets.safeParse(JSON.parse(text));
    if (!secrets.success) throw new Error('the settings cannot stand in this machine as they came');
    return secrets.data;
  }

  /* It comes before the request, so the updater never starts a database here whose schema the machine's own
     migrations could reach. */
  private writeMarker(): void {
    writeReplicaMarker(this.opts.controlDir, this.now());
  }
}
