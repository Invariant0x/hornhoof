import { createPrivateKey, sign, verify, X509Certificate } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
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
import { keyPrint } from '../computer/owner-key.js';
import { certFacts } from '../network/authority.js';
import { joinMessage } from '../network/join-proof.js';
import type { DataMachine, WorkerLink } from '../network/join.js';
import type { CopyOrder, CopyReport } from './copy.js';
import { renewedMessage, renewMessage } from '../network/renewal.js';
import { ownAddresses } from './addresses.js';
import { ageKey } from './age-key.js';
import { answerOf, askApp, type AppAnswer } from './app-call.js';
import { Becoming, REPLICA_FILE } from './become.js';
import { ComputerCarrier, type ComputerCarrierOptions } from './computer.js';
import { CertificateKeeper, type HeldCertificate } from './certificate.js';
import { closeWithin, KEEPER_PORTS, listenOn, maintenanceAnswer, visitorFromFront } from './doors.js';
import { Following } from './following.js';
import { HolderKeeper } from './holder.js';
import { switchAnswer, switchWord, type SwitchWord } from './switch-word.js';
import { WIPE_FILE, WIPED_FILE } from './uploads.js';
import { Hourly, jsonOf, machineKey, readJson, reasonOf, writePrivately, type MachineKey } from './machine-keys.js';
import { Measures, type Internet } from './measures.js';
import { pinKey, readPin } from './owner-pin.js';
import { updaterBusy } from './updater-status.js';
import type { WorkerConfig } from './worker-config.js';
import { disconnectedAnswer, noLeaderAnswer } from './worker-pages.js';

/* The last view of the network, so a worker started with no server in reach still knows where the company is. */
export const PEERS_FILE = 'peers.json';
/* The hash of the last ticket this keeper redeemed, so a ticket is sent once. */
export const TICKET_FILE = 'ticket.json';
const NO_LEADER_PAGE_MS = 60_000;

export type WorkerStatus = {
  role: MachineRole;
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
  /* How often the keeper asks for its machine's computer access; the carrier's own paces unless a test says otherwise. */
  computer?: Pick<ComputerCarrierOptions, 'openEveryMs' | 'closedEveryMs' | 'deafMs'>;
  /* How often the keeper asks which of the company's backups to hold, and tries again for its key for backups. */
  holderEveryMs?: number;
  backupKeyRetryMs?: number;
  /* What the keeper of a machine that keeps a copy changes in the worker's keeper it runs inside it. role: what it
     says it is; a worker's keeper alone takes the steps that make its machine a data machine. visitKind: which service
     of the data machines its visitor reaches through the relay: 'view' is the one with the way to the data while the
     last view, at the start the one it wrote down, carries that secret, and the app's without it. ownApp: this
     machine's own app, which the front door passes to once no leader was in reach for afterMs: it reads. updating:
     whether this machine promised the leader to wait for its update; while it did, the front door never passes to its
     own app, a request that waits is told of the update, and the time with no leader counts from the promise's end.
     extraReport: what goes into each report besides. onView: called with each view of the leader's. */
  role?: MachineRole;
  visitKind?: 'app' | 'view';
  ownApp?: { target: Target; afterMs: number };
  updating?: () => boolean;
  /* What a machine that keeps a copy adds to its word of where the company moves: that its copy is cut off from the
     leader, and that it asks the CEO a question. */
  switchMore?: () => { cut: boolean; question: boolean };
  extraReport?: () => object | Promise<object>;
  /* What measures this machine's connection to the internet; none where a test gives none. */
  internet?: Internet;
  /* How often the keeper times a synced write to its disk; a test's keeper takes its own. copying: whether the
     machine makes its copy of the company's data now, when it times none. */
  sampleMs?: number;
  copying?: () => boolean;
  onView?: (view: KeeperView) => void;
};

/* What a keeper knows of the network from the leader's answers. copy: what the leader says of this machine's copy.
   crlPem: the authority's list of revoked certificates, which a machine that serves a peer link of its own shows. */
export type KeeperView = { machine: string; role: MachineRole; authorityPem: string | null; revoked: string[]; crlPem: string | null; data: DataMachine[]; link: WorkerLink | null; copy: CopyOrder | null };

type View = KeeperView;
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
const BACKUP_KEY_RETRY_MS = 60_000;
const LOOPBACK = '127.0.0.1';
const KEEPER_PATH = '/api/keeper';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const VISIT_WORDS = { carrying: () => "Reaching the company's server through hornhoof.org as well.", waiting: 'No public link: this machine reaches the company server on its local network only.' };
const CUT_OFF = 'This machine was disconnected from the company. The keeper asks nothing more; to connect it again, run a new command from Hornhoof here.';
const TICKET_SPENT = 'its join ticket was used or has expired; get a new command in Hornhoof under Machines and run it here';
const MACHINE_TAKEN = "this computer is in the company under another person's row; it joins once that one is disconnected";

const Data = z.object({
  machine: z.string(), networkId: z.string(), hostname: z.string().nullable(), addresses: z.array(z.string()), peerPort: z.number().nullable(), webPort: z.number().nullable(),
  /* A server of the build before names neither. */
  number: z.number().nullable().default(null), copyName: z.string().nullable().default(null),
});
const Copy = z.object({
  slot: z.enum(['ok', 'lost', 'missing']).nullable(), leaderSize: z.number().nullable(), migrations: z.number().nullable(),
  old: z.enum(['waiting', 'merged', 'done']).nullable().default(null), upload: z.enum(['waiting', 'received', 'wipe']).nullable().default(null),
  lastAttempt: z.number().int().min(1).nullable().default(null),
  /* The leader whose word this is and the slot it made for this machine to join; a server of the build before names
     neither. */
  leader: z.string().optional(), join: z.string().nullable().optional(),
});
/* dataSecret: a server of the build before says none, which reads as none. hidden: one from before hidden names says
   nothing of it. */
const Link = z.object({
  name: z.string(), url: z.string(), serverAddr: z.string(), serverPort: z.number(), appSecret: z.string(), visitorKey: z.string(), dataSecret: z.string().nullable().default(null),
  hidden: z.boolean().optional(),
});
/* A view as an answer gives it, each field by itself: one the answer lacks, or gives as a server of another version
   does, is left out, and what the keeper has of it stays. */
const Answer = z.object({
  machine: z.string().optional().catch(undefined),
  role: z.enum(MACHINE_ROLES).optional().catch(undefined),
  authorityPem: z.string().nullable().optional().catch(undefined),
  revoked: z.array(z.string()).optional().catch(undefined),
  data: z.array(Data).optional().catch(undefined),
  link: Link.nullable().optional().catch(undefined),
  crlPem: z.string().nullable().optional().catch(undefined),
  copy: Copy.nullable().optional().catch(undefined),
});
/* What an answer says of the network, with the fields it lacks left out; null for an answer that is no view at all. */
export function viewIn(answer: unknown): Partial<KeeperView> | null {
  const said = Answer.safeParse(answer);
  if (!said.success) return null;
  return Object.fromEntries(Object.entries(said.data).filter(([, value]) => value !== undefined)) as Partial<KeeperView>;
}

/* The server's build and this machine's turn to install it, as the leader's view names them; none when it names none. */
const Build = z.object({ version: z.string(), tag: z.string(), digest: z.string(), nodeDigest: z.string(), updaterDigest: z.string(), commit: z.string() });
const Follow = z.object({ build: Build.nullable().catch(null).default(null), go: z.object({ commit: z.string(), until: z.string(), leftMs: z.number().min(0) }).nullable().catch(null).default(null) });
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
  /* Where the front door passes what comes in: the door to the leader, or this machine's own app while no leader was in
     reach for long enough, on a machine that has one. */
  private readonly frontTarget: Target = { host: LOOPBACK, port: 0 };
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
  /* The machine that led and the copy its commits waited for, as the last hello of a leader named them, and when that
     leader was lost, by the wall clock; null while one is named. */
  private lastLed: { leader: string; sync: string | null } | null = null;
  private lostAt: number | null = null;
  private noSessionSince: number | null = null;
  private renewTriedAt: number | null = null;
  private renewing = false;
  private lastMoment = 0;
  private readonly hourly = new Hourly();
  /* Carries this machine's computer access from the leader to its updater. */
  private readonly carrier: ComputerCarrier;
  private reporting: Promise<void> | null = null;
  /* Keeps the company's backups this machine was picked to hold. */
  private readonly holder: HolderKeeper;
  /* The public half of this machine's key for backups, once its folder keeps one. */
  private ageRecipient: string | null = null;
  /* What makes this machine a data machine once the server gives it the data; one step at a time. */
  private becoming: Becoming | null = null;
  private stepping = false;
  private ageTimer: NodeJS.Timeout | null = null;
  private ageSaid = false;
  /* The ticket that let this machine in and whose owner's key is not kept yet. */
  private owed: string | null = null;
  /* Ends what the keeper has asked the server for when it stops. */
  private readonly stopping = new AbortController();

  constructor(private readonly opts: WorkerKeeperOptions) {
    this.measures = new Measures({ dir: opts.config.dir, sampleMs: opts.sampleMs, internet: opts.internet, copying: opts.copying });
    this.following = new Following({ dir: opts.config.dir, controlDir: opts.config.controlDir, commit: opts.config.commit, now: opts.now, log: opts.log });
    this.carrier = new ComputerCarrier({
      dir: opts.config.dir,
      machine: opts.config.machineId,
      ask: (method, path, body, signal) => this.askComputer(method, path, body, signal),
      pin: () => readPin(opts.config.dir),
      trustApp: false,
      log: opts.log,
      now: opts.now,
      ...opts.computer,
    });
    this.door = new LeaderDoor({ connect: () => this.sessions.connectApp() });
    this.holder = new HolderKeeper({
      dir: opts.config.dir,
      link: {
        leader: () => this.leader(),
        request: async (method, path) => {
          const res = await this.askLeader(method, path);
          if (!res) throw new Error('no leader of the company is in reach');
          return answerOf(res);
        },
        stream: (method, path, body) => this.sessions.stream(method, path, body),
      },
      held: () => (this.disconnected ? null : (this.certificates?.current() ?? null)),
      log: opts.log,
      everyMs: opts.holderEveryMs,
      survivor: { view: () => this.view, joinServer: opts.config.joinServer, fetch: opts.fetch, afterMs: opts.config.survivorMs },
    });
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
    this.carrier.start();
    this.holder.start();
    void this.takeAgeKey();
    this.every(this.opts.lookEveryMs ?? LOOK_EVERY_MS, () => this.look());
    this.every(this.opts.viewEveryMs ?? VIEW_EVERY_MS, () => void this.readView());
    this.every(this.opts.reportEveryMs ?? REPORT_EVERY_MS, () => this.reportUnlessBusy());
    return { front };
  }

  /* What this keeper knows of the network: the leader's last answer, or, until one comes, what it kept of one before
     it started. */
  known(): KeeperView | null {
    return this.view;
  }

  status(): WorkerStatus {
    const held = this.certificates?.current() ?? null;
    const leader = this.leader();
    const hostname = leader ? (this.view?.data.find(machine => machine.machine === leader.machine)?.hostname ?? null) : null;
    return {
      role: this.opts.role ?? 'worker',
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
    if (this.ageTimer) clearTimeout(this.ageTimer);
    this.certificates?.stop();
    this.measures.stop();
    await Promise.all([this.reporting, this.holder.stop(), this.carrier.stop(), this.tunnel?.stop(), this.sessions?.close(), this.door.stop(), this.front ? closeWithin(this.front, STOP_GRACE_MS) : null]);
  }

  /* The machine's own key for backups, which the company seals to once this machine holds its data. A folder that
     cannot keep it is said once and tried again each minute. */
  private async takeAgeKey(): Promise<void> {
    if (this.stopped) return;
    try {
      this.ageRecipient = (await ageKey(this.opts.config.dir)).recipient;
    } catch (err) {
      if (!this.ageSaid) this.opts.log(`The keeper cannot keep this machine's key for backups in ${this.opts.config.dir}: ${reasonOf(err)}. It tries again each minute.`);
      this.ageSaid = true;
      this.ageTimer = setTimeout(() => void this.takeAgeKey(), this.opts.backupKeyRetryMs ?? BACKUP_KEY_RETRY_MS);
      this.ageTimer.unref();
    }
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

  /* Which service of the data machines this keeper's visitor reaches through the relay. A keeper that keeps a copy
     reaches the one with the way to the data while the leader gives it that secret, and the app's, as a worker does,
     once it gives none: a machine that stopped holding the data still has to give the leader what it holds. */
  private visitKind(): 'app' | 'data' {
    return this.opts.visitKind === 'view' && this.view?.link?.dataSecret ? 'data' : 'app';
  }

  /* The data machines of the view, each with the loopback port the visitor opens to it while there is a link. */
  private targets(): DialTarget[] {
    if (this.disconnected || !this.view) return [];
    const first = this.opts.visitPort ?? VISIT_FIRST_PORT;
    const { link } = this.view;
    /* A machine that keeps a copy is among the data machines itself, and dials the others. */
    const data = this.view.data.filter(machine => machine.networkId !== this.opts.config.machineId);
    const through = Boolean(link);
    return data.map((machine, i) => ({ machine: machine.machine, networkId: machine.networkId, addresses: machine.addresses, peerPort: machine.peerPort, relayPort: through ? first + i : null }));
  }

  /* An answer is merged into what the keeper has field by field, and the list of revoked certificates never shrinks:
     a path that hides a field, or a server of another version that lacks one, takes nothing away. */
  private mergeView(answer: unknown, keep = true): void {
    const given = viewIn(answer);
    if (!given || Object.keys(given).length === 0) return;
    for (const serial of given.revoked ?? []) this.revoked.add(serial);
    const before: View = this.view ?? { machine: '', role: 'worker', authorityPem: null, revoked: [], crlPem: null, data: [], link: null, copy: null };
    /* A list of revoked certificates that is signed stays until a newer one comes: an answer of a server that does not
       lead says none. */
    this.view = { ...before, ...given, crlPem: given.crlPem ?? before.crlPem, revoked: [...this.revoked] };
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
    const { name, serverAddr, serverPort, visitorKey, appSecret, dataSecret } = link;
    /* A machine that keeps a copy visits the service with the way to the data, and never itself. */
    const others = data.filter(machine => machine.networkId !== this.opts.config.machineId);
    if (others.length === 0) return null;
    if (this.visitKind() === 'data' && dataSecret) return { link: { name, serverAddr, serverPort, visitorKey, appSecret, dataSecret }, targets: others.map(machine => machine.networkId) };
    return { link: { name, serverAddr, serverPort, visitorKey, appSecret }, targets: others.map(machine => machine.networkId) };
  }

  /* A link with the secret of the data service is the one that reaches it. */
  private visitClient({ link, targets }: Visit): Client {
    const { machineId, dir } = this.opts.config;
    return this.opts.visitClientFor?.(link, machineId, targets) ?? visitClientFor(link, { machineId, targets, dir, kind: link.dataSecret ? 'data' : 'app' });
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

  /* The owner's key is pinned from the command they ran here, and only once that command's ticket let this machine in:
     a join that was refused pins nothing, and no answer of a server ever does. Whether nothing is left to pin. */
  private pinOwner(): boolean {
    const { ownerKey, dir } = this.opts.config;
    if (!ownerKey) return true;
    try {
      pinKey(dir, ownerKey);
      return true;
    } catch (err) {
      this.sayHourly('pin', `Could not keep the owner's key in the keeper's folder: ${reasonOf(err)}`);
      return false;
    }
  }

  /* Pin the owner's key after the ticket lets this machine in. A failed pin stays owed and is tried at every look. */
  private settle(ticket: string): void {
    this.owed = this.pinOwner() ? null : ticket;
    if (!this.owed) this.spend(ticket);
  }

  private pinPrint(): string | null {
    const pinned = readPin(this.opts.config.dir);
    return pinned ? keyPrint(pinned) : null;
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
    const signature = sign(null, Buffer.from(joinMessage(ticket, machineId)), createPrivateKey(this.key.privatePem)).toString('base64');
    const res = await this.post(`${joinServer}/api/network/join`, { ticket, networkId: machineId, signKey, signature });
    if (res.status === 200) {
      this.settle(ticket);
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
    const leads = this.leader();
    const has = Boolean(leads);
    if (leads) this.lastLed = { leader: leads.machine, sync: leads.hello.sync ?? null };
    /* A machine that was disconnected, or that waits for the leader's update, lost no leader: nothing moves then. */
    const quiet = this.disconnected || this.opts.updating?.() === true;
    this.lostAt = leads || !this.lastLed || quiet ? null : (this.lostAt ?? Date.now());
    this.noLeaderSince = has || this.opts.updating?.() ? null : (this.noLeaderSince ?? now);
    this.setDoor(has);
    this.aimFront();
    /* A leader just found is asked at once for the view and told where this machine is, once the door to it is open. */
    if (has && !this.hadLeader) void this.doorWork.then(() => this.readView()).then(() => this.report());
    this.hadLeader = has;
    if (this.renewDue(now)) void this.renew();
    if (this.owed) this.settle(this.owed);
  }

  /* The front door leads to the leader; on a machine with an app of its own, to that app once no leader was in reach
     for long enough, so the company can still be read there. */
  private aimFront(): void {
    const own = this.opts.ownApp;
    const alone = own && !this.disconnected && this.noLeaderSince !== null && this.clock() - this.noLeaderSince >= own.afterMs;
    Object.assign(this.frontTarget, alone ? own.target : this.doorTarget);
  }

  /* The session keeper and the certificate keeper this keeper runs, the same on every call after its start. */
  parts(): { link: PeerSessions; certificates: CertificateKeeper } {
    return { link: this.sessions, certificates: this.certificates };
  }

  /* One change of the door after another. A door that could not open is tried again at the next look. */
  private setDoor(open: boolean): void {
    if (open === this.doorOpen) return;
    this.doorOpen = open;
    this.doorWork = this.doorWork
      .then(() => (open ? this.door.open() : this.door.shut()))
      .then(() => {
        this.doorTarget.port = this.door.port();
        this.aimFront();
      })
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

  /* The address of the company's link, for what people and machines reach the company's pages at; none for a hidden
     name, at which only who holds the lease is answered. */
  private openLink(): string | null {
    const link = this.view?.link;
    return link && !link.hidden ? link.url : null;
  }

  /* Where a renewal is posted, in order: where the machine joined, the company's link when it is another address and
     speaks TLS, and the web port of each data machine. */
  private renewPlaces(): string[] {
    const { joinServer } = this.opts.config;
    const link = this.openLink();
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
    /* Nobody can close this machine through a company it is no part of, so it closes now and asks no more. */
    void this.carrier.stop();
    this.certificates.stop();
    this.sessions.use([]);
    this.look();
  }

  /* The carrier's asks go to the leader as the keeper's own, through the door that is open only while there is one. With
     none there is no answer, and a minute of that closes the machine. */
  private async askComputer(method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    if (!this.leader()) throw new Error('no machine of the company answers now');
    return answerOf(await askApp(this.doorTarget, method, path, body, signal));
  }

  /* One question to the app of the machine that leads, through the peer link: its status and what it said, or
     nothing while no leader is in reach. */
  async fromLeader(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
    const res = await this.askLeader(method, path, body);
    return res ? answerOf(res) : null;
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
    if (this.view) this.opts.onView?.(this.view);
    if ((this.opts.role ?? 'worker') === 'worker') void this.become();
    /* A keeper that keeps a copy needs the certificate that says so: with a worker's, no data machine opens its
       database to it. */
    else if (this.view?.role === 'data' && this.certificates.current()?.role === 'worker') this.certificates.renewNow();
  }

  /* With each view of the leader's: when it says this machine holds the data now, the next step toward that. */
  private async become(): Promise<void> {
    if (this.stepping || this.stopped || this.disconnected || !this.view) return;
    this.stepping = true;
    try {
      const { controlDir, dir } = this.opts.config;
      this.becoming ??= new Becoming({
        controlDir,
        ask: async (method, path) => {
          const res = await this.askLeader(method, path);
          if (!res) throw new Error('no leader of the company is in reach');
          return answerOf(res);
        },
        heldRole: () => this.certificates.current()?.role ?? null,
        renew: () => this.certificates.renewNow(),
        age: () => ageKey(dir),
        log: this.opts.log,
        now: this.opts.now,
      });
      await this.becoming.step({ role: this.view.role });
    } finally {
      this.stepping = false;
    }
  }

  /* One report at a time: a leader that is slow to answer never collects a pile of them, and none overtakes another. */
  private reportUnlessBusy(): void {
    if (this.reporting) return;
    this.reporting = this.report().finally(() => { this.reporting = null; });
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
        pin: this.pinPrint(),
        ...(this.opts.config.hostOs ? { os: this.opts.config.hostOs } : {}),
      };
      /* What only a build that knows copies takes: a machine that could not become a data machine says so as a copy
         that stopped, and a keeper that keeps a copy says how it does. */
      const setup: CopyReport = { state: 'stopped', progress: null, error: 'setup', at: null, name: null, old: null };
      const wiped = this.wiped();
      /* And what the server order is scored on: the day's round trip of its hellos to the leader, and its way to the
         internet. */
      const rtt = this.sessions.linkRttMs();
      const network = { ...this.measures.network(), ...(rtt === null ? {} : { linkRttMs: rtt }) };
      const backups = { ...(this.ageRecipient ? { ageKey: this.ageRecipient } : {}), heldBackups: this.holder.store().reported(), ...(this.becoming?.failure() ? { copy: setup } : {}), ...await this.opts.extraReport?.(), ...(wiped ? { wiped } : {}) };
      /* A leader an update took back to a build before refuses words it does not know: the report goes again at once
         without the newest of them, the measures, and then without any, so what an older leader does take is not lost
         with what it does not. */
      const tries = [{ ...body, ...backups, ...network }, ...(Object.keys(network).length > 0 ? [{ ...body, ...backups }] : []), body];
      let res: AppAnswer | null = null;
      for (const words of tries) {
        res = await this.askLeader('POST', '/api/network/report', words);
        /* The leader heard that this machine holds nothing any more: the updater's word of it has done its work. */
        if (res?.ok && wiped && 'wiped' in words) rmSync(join(this.opts.config.controlDir, WIPED_FILE), { force: true });
        if (res?.status !== 400) break;
      }
      if (res && !res.ok && !this.disconnected) throw new Error(`the company server answered ${res.status}`);
    } catch (err) {
      if (!this.stopped) this.sayHourly('report', `Could not report this machine to the company server: ${reasonOf(err)}`);
    }
  }

  /* Whether this machine holds nothing of the company's data any more, though the leader still counts on it for what
     it held: its updater said it wiped it, or it never held any, as a worker's keeper with no copy and no wipe going on. */
  private wiped(): boolean {
    const { controlDir } = this.opts.config;
    if (existsSync(join(controlDir, WIPED_FILE))) return true;
    if ((this.opts.role ?? 'worker') !== 'worker' || !this.view?.copy?.upload) return false;
    return !existsSync(join(controlDir, WIPE_FILE)) && !existsSync(join(controlDir, REPLICA_FILE));
  }

  private noLeader(req: http.IncomingMessage): Refusal {
    return noLeaderAnswer(req, { data: this.view?.data ?? [], linkUrl: this.openLink() });
  }

  /* Where the company's server is going, as this machine knows it: for a while after it lost the leader, to the copy
     the leader's commits waited for. */
  switchWord(): SwitchWord {
    const more = this.opts.switchMore?.() ?? { cut: false, question: false };
    return switchWord({
      now: Date.now(), kind: this.opts.role === 'data' ? 'follow' : 'worker', self: this.view?.machine ?? '', handingTo: null, leads: false,
      leader: this.leader()?.machine ?? null, lastLeader: this.lastLed?.leader ?? null, lastSync: this.lastLed?.sync ?? null, lostSince: this.lostAt, ...more,
    });
  }

  /* The keeper's own word on itself and on where the company moves, which is never passed on. */
  private ownAnswer(req: http.IncomingMessage): Refusal | null {
    const moving = switchAnswer(req, () => this.switchWord());
    if (moving) return moving;
    if (req.method !== 'GET' || String(req.url).split('?')[0] !== KEEPER_PATH) return null;
    return { status: 200, headers: JSON_HEADERS, body: JSON.stringify(this.status()) };
  }

  /* Asked while a request waits for a leader. A machine that was cut off and one that installs an update say so at
     once; a person's page gets, after a minute with no leader, the page that says where the company is, and a
     program's call waits out the hold. */
  private holding(req: http.IncomingMessage): Refusal | null {
    if (this.disconnected) return disconnectedAnswer(req);
    if (updaterBusy(this.opts.config.controlDir) || this.opts.updating?.()) return maintenanceAnswer(req);
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
        target: this.frontTarget,
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
