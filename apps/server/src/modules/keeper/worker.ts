import { createPrivateKey, sign, verify, X509Certificate } from 'node:crypto';
import type http from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { hashToken } from '../../crypto/tokens.js';
import { MACHINE_ROLES, type LinkPath, type MachineRole } from '../../db/schema.js';
import { LeaderDoor } from '../../net/leader-door.js';
import { PeerSessions, type DialTarget, type PeerSessionsOptions } from '../../net/peer-sessions.js';
import { KEEPER_HOLD_MS, passThrough, serve, startingAnswer, type Refusal, type Target } from '../../net/proxy.js';
import { TunnelKeeper, type Client } from '../link/tunnel.js';
import { visitClientFor, VISIT_FIRST_PORT, type VisitSettings } from '../link/visit-client.js';
import { certFacts } from '../network/authority.js';
import type { DataMachine, WorkerLink } from '../network/join.js';
import { renewedMessage, renewMessage } from '../network/renewal.js';
import { ownAddresses } from './addresses.js';
import { askApp, type AppAnswer } from './app-call.js';
import { CertificateKeeper, type HeldCertificate } from './certificate.js';
import { closeWithin, KEEPER_PORTS, listenOn, maintenanceAnswer, visitorFromFront } from './doors.js';
import { Following } from './following.js';
import { Hourly, jsonOf, machineKey, readJson, reasonOf, writePrivately, type MachineKey } from './machine-keys.js';
import { Measures } from './measures.js';
import { updaterBusy } from './updater-status.js';
import type { WorkerConfig } from './worker-config.js';
import { disconnectedAnswer, noLeaderAnswer } from './worker-pages.js';

/* The last view of the network, so a worker started with no server in reach still knows where the company is. */
export const PEERS_FILE = 'peers.json';
/* The hash of the last ticket this keeper redeemed, so a ticket is sent once. */
export const TICKET_FILE = 'ticket.json';
export const NO_LEADER_PAGE_MS = 60_000;

export type WorkerStatus = {
  role: 'worker';
  commit: string;
  machine: string | null;
  certificate: boolean;
  leader: { machine: string; hostname: string | null; path: LinkPath } | null;
  disconnected: boolean;
};

export type WorkerKeeperOptions = {
  config: WorkerConfig;
  /* Null: no socket on the front port is front. */
  frontHost: string | null;
  host?: string;
  ports?: { front?: number };
  log: (line: string) => void;
  now?: () => Date;
  fetch?: typeof fetch;
  /* What reaches the data machines through the relay; frpc unless a test says otherwise. */
  visitClientFor?: (link: VisitSettings, machineId: string, targets: string[]) => Client;
  /* The loopback port the visitor opens for the first data machine. */
  visitPort?: number;
  /* How often the keeper looks at its sessions, and how often it asks the leader for its view and reports to it. */
  lookEveryMs?: number;
  viewEveryMs?: number;
  reportEveryMs?: number;
  /* A renewal by the machine's key: after this long with no session, then this often while there is none. */
  renewAfterMs?: number;
  renewEveryMs?: number;
  /* For how long a page waits for a leader before it gets the page that says where the company is. */
  noLeaderPageMs?: number;
  /* For how long the front door holds a request while no leader is in reach. 0: it answers at once. */
  holdMs?: number;
  holdEveryMs?: number;
  certificate?: { retryMs?: number };
  sessions?: Partial<PeerSessionsOptions>;
};

type View = { machine: string; role: MachineRole; authorityPem: string | null; revoked: string[]; data: DataMachine[]; link: WorkerLink | null };
type Visit = { link: VisitSettings; targets: string[] };
type RenewAsk = { machine: string; serial: string; at: string };

const LOOK_EVERY_MS = 1000;
const VIEW_EVERY_MS = 30_000;
const REPORT_EVERY_MS = 20_000;
const RENEW_AFTER_MS = 10_000;
const RENEW_EVERY_MS = 30_000;
const ASK_MS = 10_000;
const FRPC_EVERY_MS = 3000;
const FRPC_RESTART_MS = 2000;
const STOP_GRACE_MS = 5000;
const LOOPBACK = '127.0.0.1';
const KEEPER_PATH = '/api/keeper';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const VISIT_WORDS = { carrying: () => "Reaching the company's server through hornhoof.org as well.", waiting: 'No public link: this machine reaches the company server on its local network only.' };
const CUT_OFF = 'This machine was disconnected from the company. The keeper asks nothing more; to connect it again, run a new command from Hornhoof here.';
const TICKET_SPENT = 'its join ticket was used or has expired; get a new command in Hornhoof under Machines and run it here';
const MACHINE_TAKEN = "this computer is in the company under another person's row; it joins once that one is disconnected";

const Data = z.object({ machine: z.string(), networkId: z.string(), hostname: z.string().nullable(), addresses: z.array(z.string()), peerPort: z.number().nullable(), webPort: z.number().nullable() });
const Link = z.object({ name: z.string(), url: z.string(), serverAddr: z.string(), serverPort: z.number(), appSecret: z.string(), visitorKey: z.string() });
/* A view as an answer gives it, each field by itself: one the answer lacks, or gives as a server of another version
   does, is left out, and what the keeper has of it stays. */
const Answer = z.object({
  machine: z.string().optional().catch(undefined),
  role: z.enum(MACHINE_ROLES).optional().catch(undefined),
  authorityPem: z.string().nullable().optional().catch(undefined),
  revoked: z.array(z.string()).optional().catch(undefined),
  data: z.array(Data).optional().catch(undefined),
  link: Link.nullable().optional().catch(undefined),
});
/* The server's build and this machine's turn to install it, as the leader's view names them; none when it names none. */
const Build = z.object({ version: z.string(), tag: z.string(), digest: z.string(), nodeDigest: z.string(), updaterDigest: z.string(), commit: z.string() });
const Follow = z.object({ build: Build.nullable().catch(null).default(null), go: z.object({ commit: z.string(), until: z.string() }).nullable().catch(null).default(null) });
const SignedShape = z.object({ payload: z.string(), signature: z.string() });
const Renewed = z.object({ authorityPem: z.string(), role: z.enum(MACHINE_ROLES), certPem: z.string().nullable(), until: z.string().nullable(), view: z.unknown() });

/* Why the server refused, as its errors say it. */
function reasonIn(body: unknown): string | null {
  const reason = (body as { error?: { reason?: unknown } } | null)?.error?.reason;
  return typeof reason === 'string' ? reason : null;
}

function reasonOfAnswer(res: AppAnswer): string | null {
  try {
    return reasonIn(res.json());
  } catch {
    return null;
  }
}

/* A request that a person's browser sends for a page, and not a program for data. */
function wantsPage(req: http.IncomingMessage): boolean {
  const page = startingAnswer(req).headers['Content-Type'] !== 'application/json';
  return page && (req.method === 'GET' || req.method === 'HEAD') && String(req.headers.accept ?? '').includes('text/html');
}

/* The keeper of a machine that keeps none of the company's data. It joins once with the ticket its join command brought,
   holds the machine's key and its certificate, keeps sessions to the machines that keep the data, and serves the company
   on this machine's own address by carrying every request to the app of the one that leads. With none in reach it says
   where the company can be opened. It holds no secret of the company, no lease and no database, and nothing it does or
   fails to do changes what the server's machine runs. */
export class WorkerKeeper {
  private key!: MachineKey;
  private certificates!: CertificateKeeper;
  private sessions!: PeerSessions;
  private tunnel: TunnelKeeper<Visit> | null = null;
  private readonly measures: Measures;
  private readonly following: Following;
  private readonly door: LeaderDoor;
  /* Where the door to the leader's app listens. The front door reads it at each request, so a door that had to take
     another port is found there. */
  private readonly doorTarget: Target = { host: LOOPBACK, port: 0 };
  private doorWork: Promise<unknown> = Promise.resolve();
  private doorOpen = false;
  private front: http.Server | null = null;
  private timers: NodeJS.Timeout[] = [];
  private view: View | null = null;
  private readonly revoked = new Set<string>();
  private disconnected = false;
  private stopped = false;
  private hadLeader = false;
  private noLeaderSince: number | null = null;
  private noSessionSince: number | null = null;
  private renewTriedAt: number | null = null;
  private renewing = false;
  private lastMoment = 0;
  private readonly hourly = new Hourly();
  /* Ends what the keeper has asked the server for when it stops. */
  private readonly stopping = new AbortController();

  constructor(private readonly opts: WorkerKeeperOptions) {
    this.measures = new Measures({ dir: opts.config.dir });
    this.following = new Following({ dir: opts.config.dir, controlDir: opts.config.controlDir, now: opts.now, log: opts.log });
    this.door = new LeaderDoor({ connect: () => this.sessions.connectApp() });
  }

  async start(): Promise<{ front: number }> {
    const { config, log } = this.opts;
    this.key = machineKey(config.dir);
    this.mergeView(readJson(join(config.dir, PEERS_FILE)), false);
    this.certificates = new CertificateKeeper({ dir: config.dir, key: this.key, ask: signKey => this.ask(signKey), now: this.opts.now, retryMs: this.opts.certificate?.retryMs, log });
    this.sessions = new PeerSessions({
      held: () => (this.disconnected ? null : this.certificates.current()),
      key: this.key,
      revoked: () => this.revoked,
      own: () => this.own(),
      log,
      changed: () => this.look(),
      ...this.opts.sessions,
    });
    /* A new certificate is shown to the data machines at once, not at the next look. */
    this.certificates.onChange(() => this.sessions.use(this.targets()));
    this.doorTarget.port = await this.door.start();
    await this.door.shut();
    this.front = this.frontDoor();
    const front = await listenOn(this.front, this.opts.ports?.front ?? KEEPER_PORTS.front, this.opts.host ?? '0.0.0.0');
    this.measures.start();
    this.tunnel = new TunnelKeeper<Visit>({ read: async () => this.visit(), everyMs: FRPC_EVERY_MS, restartMs: FRPC_RESTART_MS, clientFor: visit => this.visitClient(visit), says: VISIT_WORDS, log });
    this.tunnel.start();
    /* A ticket it has not sent yet is sent whatever it holds: a command run here again brings a fresh certificate. */
    if (this.unredeemed() && this.certificates.current()) this.certificates.renewNow();
    else this.certificates.start();
    this.sessions.use(this.targets());
    this.every(this.opts.lookEveryMs ?? LOOK_EVERY_MS, () => this.look());
    this.every(this.opts.viewEveryMs ?? VIEW_EVERY_MS, () => void this.readView());
    this.every(this.opts.reportEveryMs ?? REPORT_EVERY_MS, () => void this.report());
    return { front };
  }

  status(): WorkerStatus {
    const held = this.certificates?.current() ?? null;
    const leader = this.leader();
    const hostname = leader ? (this.view?.data.find(machine => machine.machine === leader.machine)?.hostname ?? null) : null;
    return {
      role: 'worker',
      commit: this.opts.config.commit,
      machine: held?.machine ?? null,
      certificate: Boolean(held),
      leader: leader ? { machine: leader.machine, hostname, path: leader.path } : null,
      disconnected: this.disconnected,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping.abort();
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    this.certificates?.stop();
    this.measures.stop();
    await Promise.all([this.tunnel?.stop(), this.sessions?.close(), this.door.stop(), this.front ? closeWithin(this.front, STOP_GRACE_MS) : null]);
  }

  private every(ms: number, work: () => void): void {
    const timer = setInterval(work, ms);
    timer.unref();
    this.timers.push(timer);
  }

  private clock(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  private leader(): ReturnType<PeerSessions['leader']> {
    return this.disconnected ? null : (this.sessions?.leader() ?? null);
  }

  private own(): string[] {
    return ownAddresses({ controlDir: this.opts.config.controlDir, env: this.opts.config.addresses, seen: this.sessions?.seen() ?? [] });
  }

  /* One line an hour at most for a failure that lasts. */
  private sayHourly(what: string, line: string): void {
    if (this.hourly.due(what)) this.opts.log(line);
  }

  /* The data machines of the view, each with the loopback port the visitor opens to it while there is a link. */
  private targets(): DialTarget[] {
    if (this.disconnected || !this.view) return [];
    const first = this.opts.visitPort ?? VISIT_FIRST_PORT;
    const { data, link } = this.view;
    return data.map((machine, i) => ({ machine: machine.machine, networkId: machine.networkId, addresses: machine.addresses, peerPort: machine.peerPort, relayPort: link ? first + i : null }));
  }

  /* An answer is merged into what the keeper has field by field, and the list of revoked certificates never shrinks:
     a path that hides a field, or a server of another version that lacks one, takes nothing away. */
  private mergeView(answer: unknown, keep = true): void {
    const said = Answer.safeParse(answer);
    if (!said.success) return;
    const given = Object.fromEntries(Object.entries(said.data).filter(([, value]) => value !== undefined)) as Partial<View>;
    if (Object.keys(given).length === 0) return;
    for (const serial of given.revoked ?? []) this.revoked.add(serial);
    const before: View = this.view ?? { machine: '', role: 'worker', authorityPem: null, revoked: [], data: [], link: null };
    this.view = { ...before, ...given, revoked: [...this.revoked] };
    if (!keep) return;
    try {
      writePrivately(join(this.opts.config.dir, PEERS_FILE), JSON.stringify(this.view));
    } catch (err) {
      this.sayHourly('peers', `Could not keep this machine's view of the network in its folder: ${reasonOf(err)}`);
    }
    this.sessions?.use(this.targets());
  }

  /* The visitor frpc's settings: none without a link, and not known before the first view. */
  private visit(): Visit | null | undefined {
    if (this.disconnected) return null;
    if (!this.view) return undefined;
    const { link, data } = this.view;
    if (!link || data.length === 0) return null;
    const { name, serverAddr, serverPort, visitorKey, appSecret } = link;
    return { link: { name, serverAddr, serverPort, visitorKey, appSecret }, targets: data.map(machine => machine.networkId) };
  }

  private visitClient({ link, targets }: Visit): Client {
    const { machineId, dir } = this.opts.config;
    return this.opts.visitClientFor?.(link, machineId, targets) ?? visitClientFor(link, { machineId, targets, dir });
  }

  private unredeemed(): string | null {
    const { ticket, dir } = this.opts.config;
    if (!ticket) return null;
    const sent = (readJson(join(dir, TICKET_FILE)) as { hash?: unknown } | null)?.hash;
    return sent === hashToken(ticket) ? null : ticket;
  }

  private spend(ticket: string): void {
    try {
      writePrivately(join(this.opts.config.dir, TICKET_FILE), JSON.stringify({ hash: hashToken(ticket) }));
    } catch (err) {
      this.opts.log(`Could not note in the keeper's folder that the join ticket was used: ${reasonOf(err)}`);
    }
  }

  private async post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(ASK_MS)]);
    const res = await (this.opts.fetch ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error' });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /* What the certificate keeper asks with: the ticket once, at the address the join command came from, and after that
     the leader, through the peer link, as any machine of the network renews. */
  private async ask(signKey: string): Promise<HeldCertificate> {
    if (this.disconnected) throw new Error('this machine was disconnected from the company');
    const ticket = this.unredeemed();
    if (ticket) return this.join(ticket, signKey);
    const res = await askApp(this.doorTarget, 'POST', '/api/network/certificate', { signKey }, this.stopping.signal);
    if (res.status === 404 && reasonOfAnswer(res) === 'not_a_machine') this.cutOff();
    if (!res.ok) throw new Error(`the company server answered ${res.status}`);
    return res.json() as HeldCertificate;
  }

  private async join(ticket: string, signKey: string): Promise<HeldCertificate> {
    const { joinServer, machineId } = this.opts.config;
    const res = await this.post(`${joinServer}/api/network/join`, { ticket, networkId: machineId, signKey });
    if (res.status === 200) {
      this.spend(ticket);
      this.mergeView((res.body as { view?: unknown } | null)?.view);
      return res.body as HeldCertificate;
    }
    if (res.status === 410) {
      /* A ticket that is spent is not sent again. With a certificate nothing changes; with none this machine has no way in. */
      this.spend(ticket);
      if (!this.certificates.current()) {
        this.opts.log(`This machine could not join the company: ${TICKET_SPENT}.`);
        this.cutOff();
      }
      throw new Error(TICKET_SPENT);
    }
    if (res.status === 409 && reasonIn(res.body) === 'machine_taken') throw new Error(MACHINE_TAKEN);
    throw new Error(`the company server answered ${res.status}`);
  }

  /* Looked at each second, and at once when a session came or went: whether the door to the leader is open, and whether
     a renewal is due. */
  private look(): void {
    if (this.stopped) return;
    const now = this.clock();
    const has = Boolean(this.leader());
    this.noLeaderSince = has ? null : (this.noLeaderSince ?? now);
    this.setDoor(has);
    /* A leader just found is asked at once for the view and told where this machine is, once the door to it is open. */
    if (has && !this.hadLeader) void this.doorWork.then(() => this.readView()).then(() => this.report());
    this.hadLeader = has;
    if (this.renewDue(now)) void this.renew();
  }

  /* One change of the door after another. A door that could not open is tried again at the next look. */
  private setDoor(open: boolean): void {
    if (open === this.doorOpen) return;
    this.doorOpen = open;
    this.doorWork = this.doorWork
      .then(() => (open ? this.door.open() : this.door.shut()))
      .then(() => void (this.doorTarget.port = this.door.port()))
      .catch((err: unknown) => {
        this.doorOpen = false;
        this.sayHourly('door', `The keeper's door to the company server could not open: ${reasonOf(err)}`);
      });
  }

  /* At once when a data machine did not take the certificate or the certificate has ended, after a while with no session
     to any data machine, and then now and again while there is none. */
  private renewDue(now: number): boolean {
    const held = this.certificates.current();
    if (this.disconnected || this.renewing || !held) return false;
    const state = this.sessions.state();
    if (state.path) {
      this.noSessionSince = this.renewTriedAt = null;
      return false;
    }
    this.noSessionSince ??= now;
    if (this.renewTriedAt !== null) return now - this.renewTriedAt >= (this.opts.renewEveryMs ?? RENEW_EVERY_MS);
    return state.refused || Date.parse(held.until) <= now || now - this.noSessionSince >= (this.opts.renewAfterMs ?? RENEW_AFTER_MS);
  }

  /* Where a renewal is posted, in order: where the machine joined, the company's link when it is another address and
     speaks TLS, and the web port of each data machine. */
  private renewPlaces(): string[] {
    const { joinServer } = this.opts.config;
    const link = this.view?.link?.url;
    const viaLink = link?.startsWith('https://') && new URL(link).origin !== joinServer ? [new URL(link).origin] : [];
    const direct = (this.view?.data ?? []).flatMap(machine => (machine.webPort ? machine.addresses.map(address => `http://${address}:${machine.webPort}`) : []));
    return [...new Set([joinServer, ...viaLink, ...direct])];
  }

  private async renew(): Promise<void> {
    this.renewing = true;
    this.renewTriedAt = this.clock();
    try {
      for (const place of this.renewPlaces()) {
        if (this.stopped || (await this.renewAt(place))) return;
      }
      this.sayHourly('renew', "Could not renew this machine's place in the company: no address of the company's server gave an answer with the company's signature.");
    } finally {
      this.renewing = false;
    }
  }

  /* Each request names a later moment than the one before, since the server takes a moment once. */
  private nextMoment(): string {
    this.lastMoment = Math.max(this.clock(), this.lastMoment + 1);
    return new Date(this.lastMoment).toISOString();
  }

  private signedByAuthority(held: HeldCertificate, ask: RenewAsk, answer: { payload: string; signature: string }): boolean {
    try {
      const message = Buffer.from(renewedMessage(ask.machine, ask.serial, ask.at, answer.payload));
      return verify(null, message, new X509Certificate(held.authorityPem).publicKey, Buffer.from(answer.signature, 'base64'));
    } catch {
      return false;
    }
  }

  /* One signed request at one address. Whether it ended the round: an answer counts only with the signature of the
     authority this machine holds, so a path that changes an answer only makes the renewal fail. */
  private async renewAt(place: string): Promise<boolean> {
    const held = this.certificates.current();
    if (!held) return true;
    const ask: RenewAsk = { machine: held.machine, serial: certFacts(held.certPem).serial, at: this.nextMoment() };
    const signature = sign(null, Buffer.from(renewMessage(ask.machine, ask.serial, ask.at)), createPrivateKey(this.key.privatePem)).toString('base64');
    const res = await this.post(`${place}/api/network/renew`, { ...ask, signature }).catch(() => null);
    const signed = SignedShape.safeParse(res?.body);
    if (!res || !signed.success || !this.signedByAuthority(held, ask, signed.data)) return false;
    const payload = jsonOf(signed.data.payload);
    if (res.status === 410 && (payload as { disconnected?: unknown } | null)?.disconnected === true) {
      this.cutOff();
      return true;
    }
    const renewed = Renewed.safeParse(payload);
    if (res.status !== 200 || !renewed.success || renewed.data.authorityPem !== held.authorityPem) return false;
    const { certPem, until, role, view } = renewed.data;
    if (certPem) this.certificates.accept({ machine: held.machine, role, certPem, authorityPem: held.authorityPem, until });
    this.mergeView(view);
    return true;
  }

  /* The company cut this machine off: it lets go of its sessions and its visitor, and asks nothing more until it is
     started again. */
  private cutOff(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.opts.log(CUT_OFF);
    this.certificates.stop();
    this.sessions.use([]);
    this.look();
  }

  /* Through the peer link, from the leader, while there is one. */
  private async askLeader(method: 'GET' | 'POST', path: string, body?: unknown): Promise<AppAnswer | null> {
    if (this.stopped || !this.leader()) return null;
    const res = await askApp(this.doorTarget, method, path, body, this.stopping.signal);
    if (res.status === 404 && reasonOfAnswer(res) === 'not_a_machine') this.cutOff();
    return res;
  }

  private async readView(): Promise<void> {
    try {
      const res = await this.askLeader('GET', '/api/network/peers');
      if (res?.ok) this.takeView(res.json());
      else if (res && !this.disconnected) throw new Error(`the company server answered ${res.status}`);
    } catch (err) {
      if (!this.stopped) this.sayHourly('view', `Could not read the network's state from the company server: ${reasonOf(err)}`);
    }
  }

  /* The leader's view, which alone also says what build the server runs and whether this machine may install it now. */
  private takeView(answer: unknown): void {
    this.mergeView(answer);
    const follow = Follow.safeParse(answer);
    if (follow.success) this.following.heard(follow.data.build, follow.data.go);
  }

  private async report(): Promise<void> {
    try {
      const { commit, ports } = this.opts.config;
      const state = this.sessions.state();
      const body = {
        ...this.measures.snapshot(),
        commit: commit.slice(0, 64),
        ...(ports.web ? { webPort: ports.web } : {}),
        ...(ports.peer ? { peerPort: ports.peer } : {}),
        addresses: this.own(),
        path: state.path,
        directFails: state.directFails,
        update: this.following.update(),
      };
      const res = await this.askLeader('POST', '/api/network/report', body);
      if (res && !res.ok && !this.disconnected) throw new Error(`the company server answered ${res.status}`);
    } catch (err) {
      if (!this.stopped) this.sayHourly('report', `Could not report this machine to the company server: ${reasonOf(err)}`);
    }
  }

  private noLeader(req: http.IncomingMessage): Refusal {
    return noLeaderAnswer(req, { data: this.view?.data ?? [], linkUrl: this.view?.link?.url ?? null });
  }

  /* The keeper's own word on itself, which is never passed on. */
  private ownAnswer(req: http.IncomingMessage): Refusal | null {
    if (req.method !== 'GET' || String(req.url).split('?')[0] !== KEEPER_PATH) return null;
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(this.status()) };
  }

  /* Asked while a request waits for a leader. A machine that was cut off and one that installs an update say so at
     once; a person's page gets, after a minute with no leader, the page that says where the company is, and a
     program's call waits out the hold. */
  private holding(req: http.IncomingMessage): Refusal | null {
    if (this.disconnected) return disconnectedAnswer(req);
    if (updaterBusy(this.opts.config.controlDir)) return maintenanceAnswer(req);
    const since = this.noLeaderSince;
    const long = since !== null && this.clock() - since >= (this.opts.noLeaderPageMs ?? NO_LEADER_PAGE_MS);
    return long && wantsPage(req) ? this.noLeader(req) : null;
  }

  private away(req: http.IncomingMessage): Refusal {
    if (this.disconnected) return disconnectedAnswer(req);
    return this.leader() ? startingAnswer(req) : this.noLeader(req);
  }

  /* The door the machine's own address leads to, through front: everything goes to the leader's app, held while there
     is none. Front's word on the visitor is taken as the data keeper's front door takes it. */
  private frontDoor(): http.Server {
    return serve(
      passThrough({
        target: this.doorTarget,
        headers: visitorFromFront(this.opts.frontHost),
        unreachable: req => this.away(req),
        own: req => this.ownAnswer(req),
        holdMs: this.opts.holdMs ?? KEEPER_HOLD_MS,
        holdEveryMs: this.opts.holdEveryMs,
        holding: req => this.holding(req),
        held: req => (this.disconnected ? disconnectedAnswer(req) : this.noLeader(req)),
      }),
    );
  }
}
