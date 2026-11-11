import { statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { checkHead } from '../backups/bundle.js';
import { BundleStore } from '../backups/store.js';
import type { HolderView } from '../backups/types.js';
import { BUNDLES_DIR } from './backups.js';
import type { HeldCertificate } from './certificate.js';
import { Hourly, reasonOf } from './machine-keys.js';

export const HOLD_EVERY_MS = 60_000;
/* A bundle is fetched only with this many times its size free. */
export const ROOM = 3;

const BACKUPS_PATH = '/api/network/backups';
const BUNDLE_PATH = '/peer/backups/';
const View = z.object({
  keeps: z.boolean(),
  hold: z.array(z.object({ id: z.uuid(), size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  want: z.array(z.uuid()),
});

/* The leader as a machine that keeps bundles reaches it: whether one is in reach, a request to its app, and a stream
   of its own on the session to it, which carries a bundle. */
export type HolderLink = {
  leader(): unknown;
  request(method: 'GET', path: string): Promise<{ status: number; body: unknown }>;
  stream(method: 'GET' | 'PUT', path: string, body?: Readable): Promise<{ status: number; length: number | null; body: Readable }>;
};
export type HolderKeeperOptions = {
  /* The keeper's own folder; the bundles lie in a folder of it. */
  dir: string;
  link: HolderLink;
  held: () => HeldCertificate | null;
  log: (line: string) => void;
  /* The free disk of the keeper's folder, as its measures read it. */
  diskFree?: () => number;
  everyMs?: number;
};

/* A machine that keeps none of the company's data keeps its backups instead: it asks its leader which bundles to
   hold, fetches what it lacks and checks each against the company's authority and the leader's record. It cannot open
   one. It deletes a bundle only once newer ones the leader names are here whole, or when its owner said it keeps none:
   with no answer, or an answer that names nothing, everything stays, so the bundles outlive the loss of the server. */
export class HolderKeeper {
  private readonly bundles: BundleStore;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly hourly = new Hourly();

  constructor(private readonly opts: HolderKeeperOptions) {
    this.bundles = new BundleStore(join(opts.dir, BUNDLES_DIR));
  }

  start(): void {
    const look = () => void this.round().catch(err => this.say('round', `The keeper could not look after the backups it holds: ${reasonOf(err)}`));
    this.timer = setInterval(look, this.opts.everyMs ?? HOLD_EVERY_MS);
    this.timer.unref();
    look();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /* One look. A round that still runs is the one a second caller waits for. */
  round(): Promise<void> {
    this.running ??= this.look().finally(() => { this.running = null; });
    return this.running;
  }

  /* The bundles this machine holds, newest first. */
  held(): string[] {
    return this.bundles.list().map(bundle => bundle.id);
  }

  store(): BundleStore {
    return this.bundles;
  }

  /* One line an hour at most for what lasts. */
  private say(what: string, line: string): void {
    if (this.hourly.due(what)) this.opts.log(line);
  }

  private free(): number {
    if (this.opts.diskFree) return this.opts.diskFree();
    const { bavail, bsize } = statfsSync(this.opts.dir);
    return bavail * bsize;
  }

  /* The leader's word, or nothing: a leader of an older build, one that fails and one that says something else all
     change nothing here. */
  private async view(): Promise<HolderView | null> {
    try {
      const answer = await this.opts.link.request('GET', BACKUPS_PATH);
      const said = answer.status === 200 ? View.safeParse(answer.body) : null;
      return said?.success ? said.data : null;
    } catch {
      return null;
    }
  }

  private async look(): Promise<void> {
    const held = this.opts.held();
    if (!held || !this.opts.link.leader()) return;
    const view = await this.view();
    if (!view) return;
    if (!view.keeps) return this.bundles.keepOnly([]);
    for (const entry of view.hold) {
      if (!this.bundles.has(entry.id)) await this.fetch(entry, held);
    }
    this.letGo(view);
    for (const id of view.want) await this.send(id);
  }

  /* A bundle is taken only when it holds against the company's authority, and kept only when it is the very one the
     leader's record names. */
  private async fetch(entry: HolderView['hold'][number], held: HeldCertificate): Promise<void> {
    if (this.free() < ROOM * entry.size) return this.say('room', 'There is too little free disk here to keep a backup of the company: it needs three times its size.');
    let body: Readable | null = null;
    try {
      const answer = await this.opts.link.stream('GET', `${BUNDLE_PATH}${entry.id}`);
      body = answer.body;
      if (answer.status !== 200) return;
      const taken = await this.bundles.take(body, head => checkHead(head, { authorityPem: held.authorityPem, company: null }), { id: entry.id, free: () => this.free() });
      if (taken.manifest.sha256 !== entry.sha256 || taken.manifest.size !== entry.size) {
        this.bundles.remove(entry.id);
        this.say('record', "A backup the company's server sent is not the one its record names, so it was not kept.");
      }
    } catch (err) {
      this.say('fetch', `Could not fetch a backup of the company: ${reasonOf(err)}`);
    } finally {
      body?.destroy();
    }
  }

  /* Only once every bundle the leader names is here whole, and then only what is not named and older than the newest
     of them. */
  private letGo(view: HolderView): void {
    const here = this.bundles.list();
    const named = here.filter(bundle => view.hold.some(entry => entry.id === bundle.id));
    if (view.hold.length === 0 || named.length < view.hold.length) return;
    const newest = Math.max(...named.map(bundle => Date.parse(bundle.manifest.madeAt)));
    for (const bundle of here) {
      if (!named.includes(bundle) && Date.parse(bundle.manifest.madeAt) < newest) this.bundles.remove(bundle.id);
    }
  }

  /* The leader lost its own copy of a bundle and asks for this machine's. */
  private async send(id: string): Promise<void> {
    const bundle = this.bundles.open(id);
    if (!bundle) return;
    const body = bundle.stream();
    try {
      const answer = await this.opts.link.stream('PUT', `${BUNDLE_PATH}${id}`, body);
      answer.body.destroy();
    } catch (err) {
      this.say('send', `Could not send a backup to the company's server: ${reasonOf(err)}`);
    } finally {
      body.destroy();
    }
  }
}
