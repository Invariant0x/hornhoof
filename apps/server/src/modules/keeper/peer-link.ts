import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate, X509Crl } from '@peculiar/x509';
import { z } from 'zod';
import type { Client, TunnelSettings } from '../link/tunnel.js';
import { holdThroughOneEmptyRead, TunnelKeeper } from '../link/tunnel.js';
import { peerClientFor, peerClientId, type PeerServices } from '../link/peer-client.js';
import { PeerDoor } from '../../net/peer-door.js';
import { PeerServer, type PeerServerOptions } from '../../net/peer-server.js';
import type { Target } from '../../net/proxy.js';
import { askApp } from './app-call.js';
import type { PeerBackups } from './backups.js';
import { NETWORK_ID } from '../network/ids.js';
import type { PeerSwitches } from '../../net/peer-server.js';
import type { PeerUploads } from './uploads.js';
import type { HeldCertificate } from './certificate.js';
import type { MachineIdentity } from './identity.js';
import { reasonOf, writePrivately } from './machine-keys.js';
import type { Mode } from './state.js';

export const CRL_FILE = 'crl.json';
const PEER_EVERY_MS = 5000;
const CRL_RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
const FRPC_EVERY_MS = 3000;
const FRPC_RESTART_MS = 2000;
const LOOPBACK = '127.0.0.1';
const NOTHING_SENT: ReadonlyMap<string, number> = new Map();
const READ_FAILED = "The keeper cannot read the network's state from its app: the peer link stays as it is.";

/* What the app says of the network to its keeper. */
const Answer = z.object({
  machine: z.string().nullable(),
  authorityPem: z.string().nullable(),
  revoked: z.array(z.string()),
  crlPem: z.string().nullable(),
  link: z.object({ name: z.string(), appSecret: z.string(), dataSecret: z.string().optional(), visitorKey: z.string().optional() }).nullable(),
  /* The machines that keep data and the doors to open to them, which an app of the build before does not say. */
  data: z.array(z.object({ machine: z.string(), networkId: z.string(), addresses: z.array(z.string()), peerPort: z.number().nullable(), hostname: z.string().nullish(), number: z.number().nullish() })).default([]),
  doors: z.array(z.string()).default([]),
  /* The machines that stopped holding the data and owe what they held, and how large that may be. */
  uploads: z.array(z.object({ machine: z.string(), networkId: z.string().regex(NETWORK_ID), max: z.number().min(0), unpackMax: z.number().min(0) })).default([]),
  /* The leader's slots of tables whose first copy broke off, as the copies named them, for its sweep to drop. */
  leftSlots: z.array(z.string()).default([]),
});
type Answer = z.infer<typeof Answer>;
/* The authority's list as the keeper holds it: the list, and the serials it names. */
const HeldCrl = z.object({ serials: z.array(z.string()), crlPem: z.string() });
type HeldCrl = z.infer<typeof HeldCrl>;
type CrlValidity = { authorityPem: string; from: number; until: number };

export type PeerPorts = { peer: number; peerApp: number };
type PeerLinkOptions = {
  /* The keeper's own folder, where the last list is kept beside the machine's key and certificate. */
  dir: string;
  app: Target;
  /* This machine's database, for peers that keep data; null: nobody reaches it through here. */
  db: Target | null;
  machineId: string;
  commit: string;
  identity: MachineIdentity;
  mode: () => Mode;
  /* An active handover still needs replication after the keeper fences the old leader. */
  keepsPeerTunnel?: () => boolean;
  /* The public link's settings now: null without a link, undefined when they could not be read. */
  settings: () => Promise<TunnelSettings | null | undefined>;
  ports: PeerPorts;
  /* Where the peer port listens. */
  host?: string;
  everyMs?: number;
  holdMs?: number;
  peerClientFor?: (services: PeerServices, clientId: string, local: { data: number; app: number }) => Client;
  /* What this machine serves of backups to its peers; nothing when left out. */
  backups?: PeerBackups;
  /* What takes the uploads of machines that stopped holding the data; none are taken when left out. */
  uploads?: PeerUploads;
  /* What answers another data machine's keeper about a planned switch of the server, and its beats. */
  switches?: PeerSwitches;
  /* What takes the bundle a machine that led sealed of its own database. */
  leds?: PeerServerOptions['leds'];
  /* What the hello says besides who this machine is: its term, the copy its commits wait for, and a move under way. */
  helloMore?: () => Record<string, unknown>;
  log: (line: string) => void;
};

function sameSerials(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((serial, index) => serial === sorted[index]);
}

async function verifyList(held: HeldCrl, authorityPem: string | null): Promise<CrlValidity | null> {
  if (!authorityPem) return null;
  try {
    const authority = new X509Certificate(authorityPem);
    const list = new X509Crl(held.crlPem);
    const from = list.thisUpdate.getTime();
    const until = list.nextUpdate?.getTime();
    if (!until || !(from < until) || list.issuer !== authority.subject) return null;
    if (!sameSerials(held.serials, list.entries.map(entry => entry.serialNumber.toLowerCase()))) return null;
    if (!(await list.verify({ publicKey: authority.publicKey }))) return null;
    return { authorityPem, from, until };
  } catch {
    return null;
  }
}

function currentAt(list: CrlValidity | null, now: number): list is CrlValidity {
  return list !== null && list.from <= now && now < list.until;
}

export function readHeldCrl(dir: string): HeldCrl | null {
  try {
    const parsed = HeldCrl.safeParse(JSON.parse(readFileSync(join(dir, CRL_FILE), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/* The machine's link to its peers, served by its keeper: HTTP/2 over mutual TLS on the peer port, and through
   hornhoof.org as two secret services where the company has a public link. It opens only once the keeper has checked,
   in this run, its certificate and its list of revoked certificates with the app: a keeper whose volume kept a
   certificate of an authority the database no longer has, or a list that misses a serial revoked since, lets nobody in
   on them. Until then nothing listens, and the lease, the front door and the public link wait for none of it. */
export class PeerLink {
  private readonly door: PeerDoor;
  private server: PeerServer | null = null;
  private tunnel: TunnelKeeper<PeerServices> | null = null;
  private crl: HeldCrl | null;
  private verifiedList: CrlValidity | null = null;
  private readonly reportedRevoked = new Set<string>();
  private answer: Answer | null = null;
  private lastSettings: TunnelSettings | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reading: Promise<void> | null = null;
  private opened = false;
  private stopped = false;
  private readFails = false;
  private readonly stopping = new AbortController();
  private listening: PeerPorts | null = null;
  private readonly waiting: Array<(ports: PeerPorts) => void> = [];

  constructor(private readonly opts: PeerLinkOptions) {
    this.door = new PeerDoor({ app: opts.app, holdMs: opts.holdMs });
    this.crl = readHeldCrl(opts.dir);
  }

  async start(): Promise<void> {
    await this.door.start();
    this.opts.identity.onCertificate(() => this.server?.refresh());
    this.timer = setInterval(() => this.read(), this.opts.everyMs ?? PEER_EVERY_MS);
    this.timer.unref();
    this.read();
  }

  /* What the app last said of the network; null before its first answer. */
  current(): Answer | null {
    return this.answer;
  }

  /* Refuse the held serials and any reported since, until a verified list takes their place. */
  revoked(): ReadonlySet<string> {
    return new Set([...(this.crl?.serials ?? []), ...this.reportedRevoked]);
  }

  /* Every byte its peer server wrote to each machine's streams so far; none before it listens. */
  sentBytes(): ReadonlyMap<string, number> {
    return this.server?.sentBytes() ?? NOTHING_SENT;
  }

  /* The bytes this machine's database sent that machine over the peer link. */
  dbBytes(machine: string): number {
    return this.server?.dbBytes(machine) ?? 0;
  }

  /* The ports the peer link listens on, once it does. */
  ports(): Promise<PeerPorts> {
    return this.listening ? Promise.resolve(this.listening) : new Promise(resolve => this.waiting.push(resolve));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    /* A read on its way is given up and ends first, so nothing of this still asks the app once it has stopped. */
    this.stopping.abort();
    await this.reading;
    await Promise.all([this.tunnel?.stop(), this.server?.close().catch(() => undefined), this.door.stop()]);
  }

  /* One read at a time. */
  private read(): void {
    if (this.reading || this.stopped) return;
    this.reading = this.readOnce().finally(() => { this.reading = null; });
  }

  /* A read that fails keeps the last answer, and is said once an outage. */
  private async readOnce(): Promise<void> {
    try {
      const res = await askApp(this.opts.app, 'GET', '/api/network/peers', undefined, this.stopping.signal);
      if (!res.ok) throw new Error(`the app answered ${res.status}`);
      await this.take(Answer.parse(res.json()));
      this.readFails = false;
    } catch {
      if (!this.readFails && !this.stopped) this.opts.log(READ_FAILED);
      this.readFails = true;
    }
  }

  private async take(answer: Answer): Promise<void> {
    if (this.stopped) return;
    this.answer = answer;
    for (const serial of answer.revoked) this.reportedRevoked.add(serial);
    const certificateCurrent = this.checkCertificate(answer);
    const listCurrent = await this.checkList(answer);
    if (this.stopped) return;
    if (certificateCurrent && listCurrent) this.open();
    this.server?.refresh();
  }

  /* The certificate is the database's when it names the machine the app knows this one as, under the authority the
     database holds. One that is not is asked for again; the one held stays until the new one comes. */
  private checkCertificate(answer: Answer): boolean {
    const held = this.opts.identity.certificate();
    if (!held) return false;
    if (held.machine === answer.machine && held.authorityPem === answer.authorityPem) return true;
    /* Also when the database knows no machine or no authority at all, as one restored to before either was made: the
       ask is what makes them. */
    this.opts.identity.renewNow();
    return false;
  }

  /* Each read gets a freshly signed list from the leading app. Renew the held list early even when no serial changed. */
  private async checkList(answer: Answer): Promise<boolean> {
    if (this.crl && this.verifiedList?.authorityPem !== answer.authorityPem) {
      this.verifiedList = await verifyList(this.crl, answer.authorityPem);
    }
    const now = Date.now();
    const held = this.verifiedList;
    const same = this.crl !== null && sameSerials(this.crl.serials, answer.revoked);
    if (answer.crlPem && (!same || !currentAt(held, now) || held.until - now <= CRL_RENEW_BEFORE_MS)) {
      const incoming = { serials: answer.revoked, crlPem: answer.crlPem };
      const checked = await verifyList(incoming, answer.authorityPem);
      if (this.stopped) return false;
      if (currentAt(checked, Date.now()) && (!held || (checked.from >= held.from && (!same || checked.until > held.until)))) {
        this.keepList(incoming, checked);
        return true;
      }
    }
    return same && currentAt(held, Date.now());
  }

  private keepList(crl: HeldCrl, verified: CrlValidity): void {
    this.crl = crl;
    this.verifiedList = verified;
    this.reportedRevoked.clear();
    try {
      writePrivately(join(this.opts.dir, CRL_FILE), JSON.stringify(crl));
    } catch (err) {
      this.opts.log(`Could not keep the list of revoked certificates in the keeper's folder: ${reasonOf(err)}`);
    }
  }

  /* Once in a run. Later mismatches keep it listening: the server itself refuses what the app has named revoked since. */
  private open(): void {
    const key = this.opts.identity.machineKey();
    if (this.opened || !key) return;
    this.opened = true;
    const server = new PeerServer({
      held: () => this.opts.identity.certificate(),
      key,
      crl: () => this.crl?.crlPem ?? null,
      revoked: () => this.revoked(),
      door: this.door,
      db: this.opts.db,
      hello: () => this.hello(),
      backups: this.opts.backups,
      uploads: this.opts.uploads,
      switches: this.opts.switches,
      leds: this.opts.leds,
      log: this.opts.log,
    });
    this.server = server;
    void Promise.all([server.listen(this.opts.ports.peer, 'peer', this.opts.host), server.listen(this.opts.ports.peerApp, 'app', LOOPBACK)])
      .then(([peer, peerApp]) => this.listen({ peer, peerApp }))
      .catch((err: Error) => this.opts.log(`The peer link could not listen: ${err.message}`));
  }

  private listen(ports: PeerPorts): void {
    if (this.stopped) return;
    this.listening = ports;
    for (const resolve of this.waiting.splice(0)) resolve(ports);
    this.offer(ports);
  }

  private hello(): Record<string, unknown> {
    const held = this.opts.identity.certificate() as HeldCertificate;
    return { machine: held.machine, role: held.role, lead: this.opts.mode() === 'lead', commit: this.opts.commit, ...this.opts.helloMore?.() };
  }

  /* A second frpc of the keeper offers the two doors through hornhoof.org while leading or handing the server over,
     with both secrets for the company's link. */
  private offer(ports: PeerPorts): void {
    const local = { data: ports.peer, app: ports.peerApp };
    const { machineId } = this.opts;
    this.tunnel = new TunnelKeeper<PeerServices>({
      read: holdThroughOneEmptyRead(() => this.services()),
      everyMs: FRPC_EVERY_MS,
      restartMs: FRPC_RESTART_MS,
      clientFor: services => (this.opts.peerClientFor ? this.opts.peerClientFor(services, peerClientId(services.settings.name, machineId), local) : peerClientFor(services, { machineId, local })),
      says: { carrying: services => `Offering this machine to its peers through ${services.settings.url}.`, waiting: 'No public link: this machine is not offered to its peers through it.' },
      why: () => this.whyNoServices(),
      log: this.opts.log,
    });
    this.tunnel.start();
  }

  /* Null stops the client. Undefined keeps it while the link settings cannot be read. */
  private async services(): Promise<PeerServices | null | undefined> {
    if (!this.answer) return undefined;
    const settings = await this.opts.settings().catch(() => undefined);
    if (settings !== undefined) this.lastSettings = settings;
    if (this.opts.mode() !== 'lead' && !this.opts.keepsPeerTunnel?.()) return null;
    return settings === undefined ? undefined : this.servicesFor(settings);
  }

  private servicesFor(settings: TunnelSettings | null): PeerServices | null {
    const link = this.answer?.link;
    if (!settings || !link?.dataSecret) return null;
    return { settings, secrets: { data: link.dataSecret, app: link.appSecret } };
  }

  private whyNoServices(): string {
    if (!this.lastSettings) return 'Stopping the peer tunnel: the database holds no public link.';
    if (!this.answer?.link?.dataSecret) return 'Stopping the peer tunnel: the app reported no public link or peer secrets.';
    return 'Stopping the peer tunnel: this keeper no longer leads.';
  }
}
