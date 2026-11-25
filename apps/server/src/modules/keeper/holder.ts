import { statfsSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { RECOVERY_PROOF } from '../../net/proxy.js';
import { z } from 'zod';
import { answerProof, checkHead, makeChallenge, uploadProof } from '../backups/bundle.js';
import { BundleStore, IDLE_MS, type StoredBundle } from '../backups/store.js';
import { ROOM, type HolderView } from '../backups/types.js';
import { BUNDLES_DIR } from './backups.js';
import type { HeldCertificate } from './certificate.js';
import { Hourly, reasonOf } from './machine-keys.js';

export const HOLD_EVERY_MS = 60_000;
/* A bundle is fetched only with this many times its size free. */
export { ROOM } from '../backups/types.js';

/* A machine with no leader for this long looks for a server that is being restored from the recovery file. */
export const SURVIVOR_MS = 600_000;
/* A server that answered is sent what is new without another challenge for this long, and then asked again. */
export const SENT_FOR_MS = 3_000_000;
const CHALLENGE_MS = 10_000;
const CHALLENGE_PATH = '/api/recovery/challenge';
const RECOVERY_BUNDLE_PATH = '/api/recovery/bundles/';

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
/* What a machine that lost its leader goes by to find a server restored in its place: its last view of the network,
   and the address it once joined at. */
type SurvivorOptions = {
  view: () => { data: { addresses: string[]; webPort: number | null }[]; link: { url: string } | null } | null;
  joinServer: string;
  fetch?: typeof fetch;
  /* How long with no leader before it looks; it looks every half of that. */
  afterMs?: number;
  /* A send on which no byte moves for this long is cut. */
  idleMs?: number;
  now?: () => number;
};
/* The server a recovery key's bundles went to: the number of the challenge it answered, when, and what it has. */
type Sent = { target: string; nonce: string; at: number; ids: Set<string> };

type HolderKeeperOptions = {
  /* The keeper's own folder; the bundles lie in a folder of it. */
  dir: string;
  bundles?: BundleStore;
  link: HolderLink;
  held: () => HeldCertificate | null;
  log: (line: string) => void;
  /* The free disk of the keeper's folder, as its measures read it. */
  diskFree?: () => number;
  everyMs?: number;
  /* Left out: this machine sends its bundles nowhere by itself. */
  survivor?: SurvivorOptions;
};

/* A machine that keeps none of the company's data keeps its backups instead: it asks its leader which bundles to
   hold, fetches what it lacks and checks each against the company's authority and the leader's record. It cannot open
   one. It deletes a bundle only once newer ones the leader names are here whole, or when its owner said it keeps none:
   with no answer, or an answer that names nothing, everything stays, so the bundles outlive the loss of the server.

   When its leader stays away, it looks for a server that is being restored from the company's recovery file: it sends
   a challenge only that file opens to the company's link, to the address it joined at and to the data machines' old
   addresses, and sends its bundles to the one that answers with the right proof. What it sends is sealed, and the
   proof of each bundle is made for that bundle alone, so whoever carries the traffic can read nothing and reuse
   nothing. */
export class HolderKeeper {
  private readonly bundles: BundleStore;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly hourly = new Hourly();
  private survivorTimer: NodeJS.Timeout | null = null;
  private surviving: Promise<void> | null = null;
  /* Since when there has been no leader; counted from this keeper's start too. */
  private leaderlessSince: number | null;
  private readonly sentTo = new Map<string, Sent>();

  constructor(private readonly opts: HolderKeeperOptions) {
    this.bundles = opts.bundles ?? new BundleStore(join(opts.dir, BUNDLES_DIR));
    this.leaderlessSince = this.clock();
  }

  start(): void {
    const look = () => void this.round().catch(err => this.say('round', `The keeper could not look after the backups it holds: ${reasonOf(err)}`));
    this.timer = setInterval(look, this.opts.everyMs ?? HOLD_EVERY_MS);
    this.timer.unref();
    look();
    const { survivor } = this.opts;
    if (!survivor) return;
    this.survivorTimer = setInterval(() => void this.survive().catch(err => this.say('survive', `The keeper could not look for a restored server: ${reasonOf(err)}`)), (survivor.afterMs ?? SURVIVOR_MS) / 2);
    this.survivorTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.survivorTimer) clearInterval(this.survivorTimer);
    this.timer = this.survivorTimer = null;
    await Promise.all([this.running?.catch(() => undefined), this.surviving?.catch(() => undefined)]);
  }

  /* One look for a restored server, when this machine has been without a leader long enough. A look that still runs
     is the one a second caller waits for. */
  survive(): Promise<void> {
    this.surviving ??= this.lookForServer().finally(() => { this.surviving = null; });
    return this.surviving;
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

  private clock(): number {
    return this.opts.survivor?.now?.() ?? Date.now();
  }

  /* For how long there has been no leader, and none when there is one. */
  private leaderless(): number | null {
    if (this.opts.link.leader()) return (this.leaderlessSince = null);
    this.leaderlessSince ??= this.clock();
    return this.clock() - this.leaderlessSince;
  }

  private async lookForServer(): Promise<void> {
    const { survivor } = this.opts;
    const without = this.leaderless();
    /* A machine with no certificate, or one that was disconnected, looks for nobody. */
    if (!survivor || !this.opts.held() || without === null || without < (survivor.afterMs ?? SURVIVOR_MS)) return;
    const held = this.bundles.list();
    /* The newest bundle a recovery file opens says which key, and under which link the company was reached. */
    const newest = held.find(bundle => bundle.manifest.recovery);
    const key = newest?.manifest.recovery;
    if (!newest || !key) return;
    const mine = held.filter(bundle => bundle.manifest.recovery === key);
    /* The server that took them before gets what is new, with no other asked. */
    const known = this.sentTo.get(key);
    if (known && this.clock() - known.at < SENT_FOR_MS) {
      if (await this.sendAll(known, mine)) return;
      this.sentTo.delete(key);
    }
    const link = newest.manifest.recoveryLink;
    for (const target of this.targets(survivor, link?.url)) {
      const nonce = await this.challenged(survivor, target, key, link?.name ?? '');
      if (!nonce) continue;
      const sent: Sent = { target, nonce, at: this.clock(), ids: new Set() };
      if (!(await this.sendAll(sent, mine))) continue;
      this.sentTo.set(key, sent);
      return;
    }
  }

  /* Where a restored server may be, in the order it is looked for: the company's link as the recovery file has it, the
     link this machine was last told, the address it joined at, and the data machines' own addresses. */
  private targets(survivor: SurvivorOptions, linkUrl: string | undefined): string[] {
    const view = survivor.view();
    const secure = (url: string | undefined) => (url?.startsWith('https://') ? [url] : []);
    const old = (view?.data ?? []).flatMap(machine => (machine.webPort ? machine.addresses.map(address => `http://${address}:${machine.webPort}`) : []));
    const all = [...secure(linkUrl), ...secure(view?.link?.url), survivor.joinServer, ...old].map(url => url.replace(/\/+$/, '')).filter(url => /^https?:\/\//.test(url));
    return [...new Set(all)];
  }

  /* The number of a challenge this server answered with the right proof, which only the recovery file's holder can;
     nothing for any other answer. One line each, which holds neither the number nor a proof. */
  private async challenged(survivor: SurvivorOptions, target: string, key: string, linkName: string): Promise<string | null> {
    const { file, nonce } = await makeChallenge(key, linkName);
    let outcome: 'answered' | 'refused' | 'unreachable' = 'unreachable';
    try {
      const res = await (survivor.fetch ?? fetch)(`${target}${CHALLENGE_PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(file), signal: AbortSignal.timeout(CHALLENGE_MS), redirect: 'error',
      });
      const said = res.status === 200 ? ((await res.json().catch(() => null)) as { proof?: unknown } | null) : null;
      outcome = said?.proof === answerProof(nonce) ? 'answered' : 'refused';
    } catch {
      /* Nothing there, or nothing in time. */
    }
    this.opts.log(`survivor: ${new URL(target).origin} ${outcome}`);
    return outcome === 'answered' ? nonce : null;
  }

  /* Every bundle this server does not have yet, newest first. False when one did not get there: this server is given
     up for the round. */
  private async sendAll(sent: Sent, bundles: StoredBundle[]): Promise<boolean> {
    for (const bundle of bundles) {
      if (sent.ids.has(bundle.id)) continue;
      if (!(await this.sendOne(sent, bundle.id))) return false;
      sent.ids.add(bundle.id);
    }
    return true;
  }

  /* One bundle, streamed from its file, cut when no byte of it moves for a while. Taken, or there already, counts. */
  private async sendOne(sent: Sent, id: string): Promise<boolean> {
    const { survivor } = this.opts;
    const bundle = this.bundles.open(id);
    if (!survivor || !bundle) return true;
    const cut = new AbortController();
    const idleMs = survivor.idleMs ?? IDLE_MS;
    let idle = setTimeout(() => cut.abort(), idleMs);
    const moved = () => {
      clearTimeout(idle);
      idle = setTimeout(() => cut.abort(), idleMs);
    };
    const source = bundle.stream();
    const watched = source.pipe(new Transform({ transform: (chunk, _encoding, done) => (moved(), done(null, chunk)) }));
    try {
      const res = await (survivor.fetch ?? fetch)(`${sent.target}${RECOVERY_BUNDLE_PATH}${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(bundle.length), [RECOVERY_PROOF]: uploadProof(sent.nonce, id) },
        body: Readable.toWeb(watched) as ReadableStream<Uint8Array>,
        duplex: 'half',
        signal: cut.signal,
        redirect: 'error',
      } as RequestInit);
      return res.status === 201 || res.status === 409;
    } catch {
      return false;
    } finally {
      clearTimeout(idle);
      source.destroy();
      watched.destroy();
    }
  }

  private async look(): Promise<void> {
    /* First, whatever else is there or not: what a fetch that died left would else stay for good. */
    this.bundles.tidy();
    this.leaderless();
    const held = this.opts.held();
    if (!held || !this.opts.link.leader()) return;
    const view = await this.view();
    if (!view) return;
    /* A data machine keeps its own backups and fork bundles, never worker holder slots: it only sends what a restore wants. */
    if (held.role === 'data') return this.sendWanted(view.want);
    if (!view.keeps) return this.bundles.keepOnly([]);
    for (const entry of view.hold) {
      if (!this.bundles.has(entry.id)) await this.fetch(entry, held);
    }
    this.letGo(view);
    await this.sendWanted(view.want);
  }

  private async sendWanted(want: string[]): Promise<void> {
    for (const id of want) await this.send(id);
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
