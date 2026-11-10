import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Client, TunnelSettings } from '../link/tunnel.js';
import { TunnelKeeper } from '../link/tunnel.js';
import { peerClientFor, peerClientId, type PeerServices } from '../link/peer-client.js';
import { PeerDoor } from '../../net/peer-door.js';
import { PeerServer } from '../../net/peer-server.js';
import type { Target } from '../../net/proxy.js';
import { askApp } from './app-call.js';
import type { HeldCertificate } from './certificate.js';
import type { MachineIdentity } from './identity.js';
import { reasonOf, writePrivately } from './machine-keys.js';
import type { Mode } from './state.js';

export const CRL_FILE = 'crl.json';
const PEER_EVERY_MS = 5000;
const FRPC_EVERY_MS = 3000;
const FRPC_RESTART_MS = 2000;
const LOOPBACK = '127.0.0.1';
const READ_FAILED = "The keeper cannot read the network's state from its app: the peer link stays as it is.";

/* What the app says of the network to its keeper. */
const Answer = z.object({
  machine: z.string().nullable(),
  authorityPem: z.string().nullable(),
  revoked: z.array(z.string()),
  crlPem: z.string().nullable(),
  link: z.object({ name: z.string(), appSecret: z.string(), dataSecret: z.string().optional() }).nullable(),
});
type Answer = z.infer<typeof Answer>;
/* The authority's list as the keeper holds it: the list, and the serials it names. */
const HeldCrl = z.object({ serials: z.array(z.string()), crlPem: z.string() });
type HeldCrl = z.infer<typeof HeldCrl>;

export type PeerPorts = { peer: number; peerApp: number };
export type PeerLinkOptions = {
  /* The keeper's own folder, where the last list is kept beside the machine's key and certificate. */
  dir: string;
  app: Target;
  /* This machine's database, for peers that keep data; null: nobody reaches it through here. */
  db: Target | null;
  machineId: string;
  commit: string;
  identity: MachineIdentity;
  mode: () => Mode;
  /* The public link's settings now: null without a link, undefined when they could not be read. */
  settings: () => Promise<TunnelSettings | null | undefined>;
  ports: PeerPorts;
  /* Where the peer port listens. */
  host?: string;
  everyMs?: number;
  holdMs?: number;
  peerClientFor?: (services: PeerServices, clientId: string, local: { data: number; app: number }) => Client;
  log: (line: string) => void;
};

const sameSerials = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function readHeldCrl(dir: string): HeldCrl | null {
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
  private answer: Answer | null = null;
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
      this.take(Answer.parse(res.json()));
      this.readFails = false;
    } catch {
      if (!this.readFails && !this.stopped) this.opts.log(READ_FAILED);
      this.readFails = true;
    }
  }

  private take(answer: Answer): void {
    if (this.stopped) return;
    this.answer = answer;
    const certificateCurrent = this.checkCertificate(answer);
    const listCurrent = this.checkList(answer);
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

  /* A new list is taken when the serials revoked now differ from the held list's, which only the app that leads signs. */
  private checkList(answer: Answer): boolean {
    if (answer.crlPem && (!this.crl || !sameSerials(this.crl.serials, answer.revoked))) this.keepList({ serials: answer.revoked, crlPem: answer.crlPem });
    return this.crl !== null && sameSerials(this.crl.serials, answer.revoked);
  }

  private keepList(crl: HeldCrl): void {
    this.crl = crl;
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
      revoked: () => new Set(this.answer?.revoked ?? this.crl?.serials ?? []),
      door: this.door,
      db: this.opts.db,
      hello: () => this.hello(),
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
    return { machine: held.machine, role: held.role, lead: this.opts.mode() === 'lead', commit: this.opts.commit };
  }

  /* A second frpc of the keeper offers the two doors through hornhoof.org, while the app leads and the company has a
     link with both secrets. */
  private offer(ports: PeerPorts): void {
    const local = { data: ports.peer, app: ports.peerApp };
    const { machineId } = this.opts;
    this.tunnel = new TunnelKeeper<PeerServices>({
      read: () => this.services(),
      everyMs: FRPC_EVERY_MS,
      restartMs: FRPC_RESTART_MS,
      clientFor: services => (this.opts.peerClientFor ? this.opts.peerClientFor(services, peerClientId(services.settings.name, machineId), local) : peerClientFor(services, { machineId, local })),
      says: { carrying: services => `Offering this machine to its peers through ${services.settings.url}.`, waiting: 'No public link: this machine is not offered to its peers through it.' },
      log: this.opts.log,
    });
    this.tunnel.start();
  }

  /* Null: no link or no secrets, and the client stops. Undefined: not known now, and the client it runs stays. */
  private async services(): Promise<PeerServices | null | undefined> {
    if (!this.answer) return undefined;
    if (this.opts.mode() !== 'lead') return null;
    const settings = await this.opts.settings();
    if (settings === undefined) return undefined;
    const link = this.answer.link;
    if (!settings || !link?.dataSecret) return null;
    return { settings, secrets: { data: link.dataSecret, app: link.appSecret } };
  }
}
