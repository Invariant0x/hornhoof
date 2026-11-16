import { existsSync, readFileSync } from 'node:fs';
import type http from 'node:http';
import { join } from 'node:path';
import type { Config } from '../../config.js';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { machines } from '../../db/schema.js';
import { firstForwarded, KEEPER_HOLD_MS, passThrough, serve, socketAddress, startingAnswer, type PassOptions, type Refusal, type Target } from '../../net/proxy.js';
import { clientFor, linkClientId, type FrpcLocal } from '../link/client.js';
import { tunnelSettings } from '../link/link.js';
import { Settings, TunnelKeeper, type Client, type TunnelSettings } from '../link/tunnel.js';
import { LINK_TLS_PORT, LinkListener, linkVisitor } from '../tls/listener.js';
import { servedCertificate } from '../tls/store.js';
import { certInfo } from '../tls/x509.js';
import type { Term } from '../../db/net.js';
import { hostFound, ownAddresses } from './addresses.js';
import type { HeldCertificate } from './certificate.js';
import { closeWithin, KEEPER_PORTS, listenOn, maintenanceAnswer, visitorFromFront } from './doors.js';
import { MachineIdentity, type Published } from './identity.js';
import { PEER_PATHS } from '../../net/peer-server.js';
import { PeerLink, type PeerPorts } from './peer-link.js';
import type { PeerServices } from '../link/peer-client.js';
import { Beats, type Beat } from './beats.js';
import { switchAnswer, switchWord, type SwitchWord } from './switch-word.js';
import { Reentry } from './entry.js';
import { LeaseProofs } from './proofs.js';
import type { Poll } from './takeover-step.js';
import { LeaseHolder } from './lease-holder.js';
import type { BundleSecrets } from '../backups/bundle.js';
import { RECOVERY_LINK } from '../backups/types.js';
import { ageKey } from './age-key.js';
import { answerOf, askApp } from './app-call.js';
import { BackupKeeper, type PeerBackups } from './backups.js';
import { ComputerCarrier, type ComputerCarrierOptions } from './computer.js';
import { DataLinks, type DataLinksOptions } from './data-links.js';
import { Throughput } from './throughput.js';
import { UploadTaker } from './uploads.js';
import type { Internet, Measures } from './measures.js';
import { keepSize, KEEP_SIZE_EVERY_MS, SLOTS_EVERY_MS, sweepSlots } from './slots.js';
import { SyncController, type SyncControllerOptions } from './sync.js';
import { KEEPER_DIR, reasonOf } from './machine-keys.js';
import type { LeaseStore, Sql } from './lease-store.js';
import type { Clocks } from './lease.js';
import { writeKeeperState, type KeeperState, type Mode } from './state.js';
import { updaterBusy, updaterRunning } from './updater-status.js';

export { KEEPER_PORTS } from './doors.js';

const DOOR_PORTS = { front: KEEPER_PORTS.front, linkHttp: KEEPER_PORTS.linkHttp, linkTls: LINK_TLS_PORT };

export type KeeperOptions = {
  config: Config;
  /* Where the link and its certificate are read from. Null: no link, as for a keeper with no DATABASE_URL. */
  db: Db | null;
  app: Target;
  /* Null: no socket on the front port is front. */
  frontHost: string | null;
  log: (line: string) => void;
  /* Where the front port listens. */
  host?: string;
  ports?: { front?: number; linkHttp?: number; linkTls?: number; peer?: number; peerApp?: number };
  everyMs?: number;
  /* How often the link and its certificate are read. */
  linkEveryMs?: number;
  /* What runs the link's traffic; frpc unless a test says otherwise. */
  clientFor?: (settings: TunnelSettings, clientId: string, local: FrpcLocal) => Client;
  /* Where this machine's lease is held. Null: it holds none, and the app never leads on its word. */
  lease: LeaseStore | null;
  now?: () => Clocks;
  pruneEveryMs?: number;
  /* How often it tells the other machines that keep data where it stands; each second unless a test says otherwise. */
  beatEveryMs?: number;
  /* What its lease goes by once another machine holds a copy that finished: a lease is then renewed only on a proof,
     and taken only on its copy's promise or through the relay's window. needed: whether another machine holds such a
     copy. probe: a request through the company's link for who answers there. ownTerm: the term this machine's
     database stands under. poll: one look at the company's name and the relay's health. follow: writes down whom this
     machine follows from here on, and ends the keeper, which starts again as one that follows. Without it the keeper
     leads as a machine that keeps the data alone does. */
  proofs?: {
    needed: () => Promise<boolean>;
    probe: (nonce: string, link: OwnLink | null) => Promise<{ machine: string; nonce: string } | null>;
    ownTerm: () => Promise<Term | null>;
    poll: (link: OwnLink) => Promise<Poll>;
    follow: () => Promise<void>;
    everyMs?: number;
  };
  /* For how long a door holds a request while the app is away, and the pause between its tries. 0: it answers at once. */
  holdMs?: number;
  holdEveryMs?: number;
  /* The keeper's own folder, where the machine's key and certificate are kept. */
  dir?: string;
  /* The machine's ports as compose publishes them, to report with its measures. */
  published?: Published;
  reportEveryMs?: number;
  /* The machine's addresses as the installer wrote them down, and its host's name, to report as well. */
  addresses?: string[];
  hostname?: string | null;
  /* What measures this machine's connection to the internet; none where a test gives none. */
  internet?: Internet;
  /* What measures this machine, made by whoever made the keeper's statements go by its disk too; made here
     otherwise. */
  measures?: Measures;
  /* What measures how fast this machine sends to the others; made here unless a test gives one. */
  throughput?: Pick<Throughput, 'start' | 'stop' | 'best'>;
  /* What a test's keeper reports as its place in place of its own. */
  reportAs?: () => { addresses: string[]; peerPort: number; webPort: number };
  /* This machine's database, for peers that keep data: where the peer link's CONNECT db goes. */
  dbTarget?: Target | null;
  /* How often the app is asked what the network holds now: the revoked certificates and what the machine offers. */
  peerEveryMs?: number;
  /* How often the keeper asks whether another machine holds the company's data. */
  guardEveryMs?: number;
  /* How often the keeper asks for its machine's computer access; the carrier's own paces unless a test says otherwise. */
  computer?: Pick<ComputerCarrierOptions, 'openEveryMs' | 'closedEveryMs' | 'deafMs'>;
  /* What offers the machine to its peers through the relay; frpc unless a test says otherwise. */
  peerClientFor?: (services: PeerServices, clientId: string, local: { data: number; app: number }) => Client;
  /* How often the keeper looks after the backups, and tries again for the keys it makes them with. */
  backupsEveryMs?: number;
  backupKeysRetryMs?: number;
  /* What the keeper keeps toward the machines that hold copies: where its doors to their databases listen and who may
     use them, its paces, and the way into its own database for the role copies read with. */
  copies?: Pick<DataLinksOptions, 'dial' | 'sessions' | 'doorHost' | 'allowed' | 'everyMs' | 'replicaEveryMs' | 'visitClientFor' | 'visitPort'> & { replica?: DataLinksOptions['replica'] };
  /* What decides whether a commit waits for a copy, and tells the relay which machine holds the latest changes: the
     leader's own Postgres as the controller asks it, and the relay. Without it this machine keeps the data alone. slots:
     a session for the chores of the copies' slots, with the free room of the database's disk. linkPauseMs: for how long
     the link's frpc stays stopped after a lease ended while another machine holds the data. */
  sync?: Pick<SyncControllerOptions, 'catalog' | 'relay' | 'everyMs' | 'routeEveryMs'> & { slots?: { sql: Sql; diskFree: () => number | null; everyMs?: number }; linkPauseMs?: number };
  /* This keeper's part of a planned switch of the server to this machine, made with what the keeper gives it: the
     link's client to start and stop, whether this keeper leads, and the company's link as its own client logs in, with
     its address. While that part does not lead, the keeper is taking the server over. takingEveryMs: how often it
     looks whether that part leads now. */
  taking?: (parts: { tunnel: { start(): void; stop(): Promise<void> }; appLeads: () => boolean; link: () => OwnLink | null | undefined }) => TakingPart;
  takingEveryMs?: number;
  /* This keeper's part of a planned switch of the server away from this machine. */
  handing?: (parts: HandingParts) => HandingPart;
  /* This keeper's part of an update while other machines keep copies. */
  updating?: (parts: UpdatingParts) => UpdatingPart;
};

/* The company's link as this keeper's own frpc logs in at the relay: its name, its key, the id that client goes by,
   and the link's address. */
export type OwnLink = { name: string; key: string; client: string; url: string };

/* What hands the server over for this keeper, made with what the keeper gives it. While it holds, the keeper takes no
   lease, says it does not lead, and keeps its front door shut and its link's client stopped. */
export type HandingPart = { start(): Promise<void>; stop(): Promise<void>; holds(): boolean; to?(): { machine: string; networkId: string } | null };
export type HandingParts = {
  front: { close(): Promise<void>; open(): void };
  tunnel: { start(): void; stop(): Promise<void> };
  lease: { fence(): Promise<void> };
  leads: () => boolean;
  term: () => Term | null;
  sync: SyncController | null;
  /* The keeper of another data machine, by its network id, on this keeper's session to it. */
  peer: (networkId: string) => { request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; body: unknown } | null> };
  updating: () => boolean;
};

/* What this keeper does for an update while other machines keep copies, made with what the keeper gives it. busy: an
   update runs, or it still has one to end. */
export type UpdatingPart = { start(): Promise<void>; stop(): Promise<void>; busy(): boolean };
export type UpdatingParts = {
  sync: SyncController | null;
  peer: HandingParts['peer'];
  /* The name a machine goes by, none for one this database does not hold. */
  hostname: (networkId: string) => Promise<string>;
  /* Whether this keeper leads under a normal lease, and whether its lease is in maintenance. */
  leads: () => boolean;
  maintenance: () => boolean;
};

/* What takes the server over for this keeper: it leads once this machine's database is promoted, or at once where
   no switch is on its way, and answers the paths of a switch to the data machine that asks, named by its network id. */
export type TakingPart = {
  start(): Promise<void>;
  stop(): Promise<void>;
  leads(): boolean;
  /* The machine it takes the server from, and when that began; none while no switch is written down. */
  from?(): { networkId: string; at: number } | null;
  handle(from: string, method: string, path: string, body: unknown): Promise<{ status: number; body: object; after?: () => void }>;
};

type LinkWord = NonNullable<KeeperState['link']>;
type ToServe = Awaited<ReturnType<typeof servedCertificate>>;

const EVERY_MS = 1000;
const LINK_EVERY_MS = 3000;
const GUARD_EVERY_MS = 10_000;
const BACKUP_KEYS_RETRY_MS = 60_000;
const FRPC_RESTART_MS = 2000;
const TAKING_EVERY_MS = 250;
/* How often a keeper whose lease takes proofs asks for one, or looks for its way back to leading. */
const PROVE_EVERY_MS = 1000;
/* How long the copy has to answer an ask for its promise. */
const PROMISE_ASK_MS = 2000;
/* After a lease ended with another data machine listed, the link's frpc stays stopped this long, so the name is free
   for a machine that takes over; then it starts again, so this keeper holds its route and the relay can be told. */
const LINK_PAUSE_MS = 30_000;
const NO_MACHINE_ID = 'The keeper carries no public link: HORNHOOF_MACHINE_ID is not set. Run the install command again.';
const SETTINGS_KEPT = "The keeper cannot read the link's settings from the database: frpc stays as it is.";
const CERTIFICATE_KEPT = "The keeper cannot read or serve the link's certificate: it keeps the one it serves.";
/* Only this keeper's own frpc child reaches the link's doors, which is why they may believe what it sends. */
const LINK_HOST = '127.0.0.1';
/* Docker waits 10 s after its stop signal. A request in flight gets half of that to finish; an open socket, which never
   ends by itself, does not hold the stop up for longer. */
const STOP_GRACE_MS = 5000;

const LEASE_PATH = '/api/network/lease';
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const PROOF_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const BAD_NONCE = JSON.stringify({ error: { code: 'validation', message: 'nonce must be 16 to 128 letters, digits, - or _.' } });
const HIDDEN_NAME: Refusal = { status: 404, headers: PROOF_HEADERS, body: JSON.stringify({ ok: false }) };

/* The nonce of a request for the lease proof, undefined for any other request, null for a nonce this machine would not send. */
function proofNonce(req: http.IncomingMessage): string | null | undefined {
  if (req.method !== 'GET') return undefined;
  const [path, query = ''] = String(req.url).split('?', 2);
  if (path !== LEASE_PATH) return undefined;
  const nonce = new URLSearchParams(query).get('nonce') ?? '';
  return NONCE.test(nonce) ? nonce : null;
}

/* What frps wrote, its first entry being the visitor. Only link traffic is ever marked as https. */
function visitorFromLink(req: http.IncomingMessage): Record<string, string> {
  return { 'x-forwarded-for': firstForwarded(req) || socketAddress(req), 'x-forwarded-proto': 'https' };
}

/* The listener read it from the PROXY header. Only this keeper's frpc reaches that port, and only link traffic is https. */
function visitorFromTls(req: http.IncomingMessage): Record<string, string> {
  return { 'x-forwarded-for': linkVisitor(req.socket) ?? socketAddress(req), 'x-forwarded-proto': 'https' };
}

/* What the app is told the listener holds. A stand-in has no fingerprint: the app asks for one only by the row's certificate. */
function linkWordOf(toServe: ToServe): LinkWord {
  return { host: toServe?.host ?? null, fingerprint256: toServe?.cert ? certInfo(toServe.cert.certPem).fingerprint256 : null };
}

const sameWord = (a: LinkWord, b: KeeperState['link']): boolean => a.host === b?.host && a.fingerprint256 === b.fingerprint256;

/* What fails here answers undefined, which keeps what the keeper runs. It is said once an outage, with no detail, since a
   query's error can quote its values. */
function keepingOnFailure<T>(work: () => Promise<T>, say: () => void): () => Promise<T | undefined> {
  let failing = false;
  return async () => {
    try {
      const value = await work();
      failing = false;
      return value;
    } catch {
      if (!failing) say();
      failing = true;
      return undefined;
    }
  };
}

/* What a backup carries besides the database: the three settings without which the database cannot be read or the
   company reached. The node key comes under a name of the keeper's own, since compose passes NODE_KEY empty to a
   machine that has none. */
export function bundleSecrets(config: Config, env: NodeJS.ProcessEnv = process.env): BundleSecrets {
  return { HORNHOOF_SECRET: config.secret.toString('base64'), NODE_KEY: env.HORNHOOF_NODE_KEY ?? '', RELAY_URL: config.relayUrl };
}

/* A read may outlast the pause between reads, and an older answer must not land after a newer one. The work never throws. */
function oneAtATime(work: () => Promise<unknown>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    await work();
    running = false;
  };
}

/* Holds this machine's lease and sets the app's mode by it, runs the public link's frpc as its child, ends the link's TLS,
   and carries what comes in from front and the link to the app. A keeper that is taking the server over in a planned
   switch serves its peers and the link's doors as any other, but takes no lease, tells its app to stay off and keeps its
   front door closed until its database is promoted; from then on it leads as any other. */
export class Keeper {
  private readonly holder: LeaseHolder;
  private readonly identity: MachineIdentity | null;
  /* Carries this machine's computer access from its app to its updater. */
  private readonly carrier: ComputerCarrier | null;
  /* Makes the company's backups, once the machine has its key and its key for backups. */
  private backups: BackupKeeper | null = null;
  private backupsTimer: NodeJS.Timeout | null = null;
  private backupKeysSaid = false;
  private stopped = false;
  private peers: PeerLink | null = null;
  private links: DataLinks | null = null;
  /* Reads what the peer server sent each machine, ten times a second, for as long as the keeper runs. */
  private readonly throughput: Pick<Throughput, 'start' | 'stop' | 'best'>;
  private readonly sync: SyncController | null;
  private readonly taker: TakingPart | null;
  private readonly hander: HandingPart | null;
  private readonly updater: UpdatingPart | null;
  private readonly beating: Beats;
  /* What the lease is renewed on, and the way back to leading, where a lease takes proofs. */
  private readonly leaseProofs: LeaseProofs | null;
  private readonly reentry: Reentry | null;
  /* Whether another machine holds a copy that finished, as last read; null before the first read. */
  private neededNow: boolean | null;
  /* The way back to leading wants the link's client to run, to take the company's name. */
  private entryTunnel = false;
  /* The generation of the company's name at which this keeper's own client last held it. */
  private heldGeneration: number | null = null;
  private proofsTimer: NodeJS.Timeout | null = null;
  /* The front door, and where it listens, so that a switch may shut it and open it again. */
  private frontDoor: http.Server | null = null;
  private frontAt: { port: number; host: string } | null = null;
  /* Taking the server over: no lease yet, and the app off. */
  private taking = false;
  private takingTimer: NodeJS.Timeout | null = null;
  /* The link's frpc stays stopped while this is set. */
  private linkHeld = false;
  /* The link's settings as last read, for the controller, and until when the link's frpc stays stopped. */
  private settingsNow: TunnelSettings | null | undefined = undefined;
  private emptyLinkWhy = 'Stopping the public link: the database holds no public link.';
  /* Whether hornhoof.org answered this keeper's last look at it, which it takes only while it holds no lease; null
     before the first, and again once it leads. */
  private relayUp: boolean | null = null;
  /* Whether the link this keeper last read is a hidden name. */
  private hiddenName = false;
  private linkPausedUntil = 0;
  private slotsTimer: NodeJS.Timeout | null = null;
  private keptSizeAt: number | null = null;
  private readonly syncSlotsIdle = new Map<string, number>();
  private slotsFail = false;
  private guardTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private fencesTimer: NodeJS.Timeout | null = null;
  private certificateTimer: NodeJS.Timeout | null = null;
  private doors: http.Server[] = [];
  /* A word that cannot be written is said once in the log, not once a second. */
  private wordFails = false;
  private readonly listener: LinkListener;
  private tunnel: TunnelKeeper | null = null;
  /* What keeper.json says the listener holds. Null until the first read of the link. */
  private link: KeeperState['link'] = null;

  constructor(private readonly opts: KeeperOptions) {
    this.throughput = opts.throughput ?? new Throughput({ dir: opts.dir ?? KEEPER_DIR, sent: () => this.peers?.sentBytes() ?? new Map<string, number>() });
    const log = { warn: (_detail: unknown, message?: string) => opts.log(String(message)) };
    this.listener = new LinkListener({ server: this.door(visitorFromTls, { link: true }), log });
    this.sync =
      opts.sync && opts.config.machineId
        ? new SyncController({
            catalog: opts.sync.catalog,
            relay: opts.sync.relay,
            everyMs: opts.sync.everyMs,
            routeEveryMs: opts.sync.routeEveryMs,
            link: async () => this.ownLink(),
            dbBytes: machine => this.peers?.dbBytes(machine) ?? 0,
            leads: () => this.mode() === 'lead',
            log: opts.log,
          })
        : null;
    this.taker = opts.taking
      ? opts.taking({ tunnel: { start: () => void (this.linkHeld = false), stop: async () => void (this.linkHeld = true) }, appLeads: () => this.mode() === 'lead', link: () => this.ownLink() })
      : null;
    const peer: HandingParts['peer'] = networkId => ({ request: (method, path, body, timeoutMs) => this.links?.ask(networkId, method, path, body, timeoutMs) ?? Promise.resolve(null) });
    /* Made before the sync controller's first look: one that starts in the middle of an update names no copy. */
    this.updater = opts.updating
      ? opts.updating({ sync: this.sync, peer, hostname: networkId => this.hostnameOf(networkId), leads: () => this.mode() === 'lead', maintenance: () => this.mode() === 'maintenance' })
      : null;
    this.hander = opts.handing
      ? opts.handing({
          front: { close: () => this.shutFront(), open: () => this.openFront() },
          /* The name goes with the server. Should the server stay after all, the way back in takes the name again
             itself and notes at which registration: a client started on the word of an earlier way in would hold
             the name at one the way back never noted, which it must take for another machine's and let go. */
          tunnel: { start: () => void (this.linkHeld = false), stop: async () => void ((this.linkHeld = true), (this.entryTunnel = false)) },
          lease: { fence: async () => void (await opts.lease?.fence()) },
          leads: () => this.mode() === 'lead',
          term: () => this.term(),
          sync: this.sync,
          peer,
          /* No server is moved while an update runs, in whatever step, or while its keeper still has one to end. */
          updating: () => updaterRunning(opts.config.controlDir) || (this.updater?.busy() ?? false),
        })
      : null;
    this.beating = new Beats({
      self: () => this.beat(),
      peers: () => this.otherData(),
      ask: (networkId, method, path, body, timeoutMs) => this.links?.ask(networkId, method, path, body, timeoutMs) ?? Promise.resolve(null),
      now: opts.now,
      everyMs: opts.beatEveryMs,
      log: opts.log,
    });
    const { proofs } = opts;
    this.neededNow = proofs ? null : false;
    this.leaseProofs = proofs
      ? new LeaseProofs({ probe: nonce => proofs.probe(nonce, this.ownLink() ?? null), beats: this.beating, self: opts.config.machineId ?? '', term: () => this.holder.term(), b: () => this.syncNamed(), now: opts.now, everyMs: proofs.everyMs })
      : null;
    this.reentry = proofs
      ? new Reentry({
          self: opts.config.machineId ?? '',
          needed: () => this.neededNow,
          /* With a lease, in the middle of a switch either way, there is nothing to come back to. */
          idle: () => this.holder.standing() !== null || this.taking || (this.hander?.holds() ?? false),
          ownTerm: proofs.ownTerm,
          beats: this.beating,
          b: () => this.recordNamed(),
          ask: (networkId, term) => this.links?.ask(networkId, 'POST', PEER_PATHS.promise, { term }, PROMISE_ASK_MS) ?? Promise.resolve(null),
          poll: async () => {
            const link = this.ownLink();
            const looked = link ? await proofs.poll(link) : null;
            if (looked) this.relayUp = looked.health.up;
            return looked;
          },
          client: () => this.ownLink()?.client ?? null,
          made: () => this.sync?.lastHeld() ?? null,
          tunnel: { start: () => void (this.entryTunnel = true), stop: () => void (this.entryTunnel = false), runs: () => this.entryTunnel },
          flag: () => (this.sync ? this.sync.flag() !== null : true),
          clientOf: networkId => {
            const link = this.ownLink();
            return link ? linkClientId(link.name, networkId) : null;
          },
          follow: proofs.follow,
          now: opts.now,
          log: opts.log,
        })
      : null;
    this.holder = new LeaseHolder({
      lease: opts.lease, updaterBusy: () => updaterBusy(opts.config.controlDir), now: opts.now, pruneEveryMs: opts.pruneEveryMs, log: opts.log,
      sync: this.sync ?? undefined,
      onEnd: () => this.leaseEnded(),
      hold: () => this.hander?.holds() ?? false,
      fsyncP99: () => this.identity?.fsyncP99() ?? null,
      sole: () => this.sole(),
      proofs: this.leaseProofs && this.reentry
        ? {
            needed: () => this.neededNow,
            proof: () => this.leaseProofs!.proof(),
            ended: () => this.leaseProofs!.ended(),
            entry: () => this.reentry!.entry(),
            clear: () => {
              this.leaseProofs!.clear();
              this.reentry!.taken();
            },
          }
        : undefined,
    });
    /* A machine without an id is none of the company's network, as it carries no public link. */
    this.identity = opts.config.machineId
      ? new MachineIdentity({
          dir: opts.dir ?? KEEPER_DIR,
          app: opts.app,
          commit: opts.config.commit,
          published: opts.published ?? { web: null, peer: null },
          leading: () => this.mode() === 'lead',
          log: opts.log,
          reportEveryMs: opts.reportEveryMs,
          internet: opts.internet,
          measures: opts.measures,
          /* The addresses the copies saw this machine come from count too, so a machine that moved is found again. */
          addresses: () => ownAddresses({ controlDir: opts.config.controlDir, env: opts.addresses ?? [], seen: this.links?.seen() ?? [] }),
          hostname: opts.hostname,
          reportAs: opts.reportAs,
          os: opts.config.hostOs,
          found: () => hostFound(opts.config.controlDir),
          ownerKey: opts.config.ownerKey,
          backups: () => (this.backups ? { ageKey: this.backups.ageRecipient(), heldBackups: this.backups.reported() } : null),
        })
      : null;
    /* The server's own keeper takes its app's word while it holds no key of its owner: the database is its own. */
    this.carrier = opts.config.machineId
      ? new ComputerCarrier({
          controlDir: opts.config.controlDir,
          dir: opts.dir ?? KEEPER_DIR,
          machine: opts.config.machineId,
          ask: (method, path, body, signal) => askApp(opts.app, method, path, body, signal).then(answerOf),
          pin: () => opts.config.ownerKey,
          trustApp: true,
          log: opts.log,
          ...opts.computer,
        })
      : null;
  }

  /* The ports the peer link listens on, once the keeper has checked its certificate and its list with the app. It never
     resolves on a machine that serves none: one without an id or without a database. */
  peerPorts(): Promise<PeerPorts> {
    return this.peers?.ports() ?? new Promise<PeerPorts>(() => {});
  }

  /* The certificate this machine holds in the company's network, once its app gave it one. */
  certificate(): HeldCertificate | null {
    return this.identity?.certificate() ?? null;
  }

  /* While it hands the server over it leads no more, from the moment it stopped. */
  mode(): Mode {
    return this.hander?.holds() ? 'read' : this.holder.mode();
  }

  /* The term this machine holds, while its lease stands. */
  term(): Term | null {
    return this.hander?.holds() ? null : this.holder.term();
  }

  /* What this keeper and the other machines that keep data told each other last. */
  beats(): Beats {
    return this.beating;
  }

  /* The other live machines that keep the company's data, as the app named them last. */
  private otherData(): { machine: string; networkId: string }[] {
    const own = this.opts.config.machineId;
    return (this.peers?.current()?.data ?? []).filter(machine => machine.networkId !== own).map(({ machine, networkId }) => ({ machine, networkId }));
  }

  /* The copy the relay's record names as the one commits wait for, at the generation this keeper's own client holds
     the route at; none while it names none, or was stored at another generation. */
  private syncNamed(): string | null {
    const record = this.sync?.record();
    /* The generation this keeper's own client last held the name at. A relay that cannot be asked now says nothing
       new of it: the record this keeper stored at that generation is still its own word, so the copy it names can
       vouch for the lease exactly while hornhoof.org is out of reach. */
    const generation = this.sync?.generation();
    if (generation !== null && generation !== undefined) this.heldGeneration = generation;
    return record?.state === 'on' && record.copy && record.generation === this.heldGeneration ? record.copy : null;
  }

  /* The copy the relay's record names as the one that holds every change, whichever generation it was stored at: the
     one a keeper that holds no lease asks for its promise. */
  private recordNamed(): string | null {
    const record = this.sync?.record();
    return record?.state === 'on' ? record.copy : null;
  }

  /* Whether the link's client may run now. While a lease takes proofs, it runs only under a lease that stands or once
     the way back in takes the name: a keeper that holds no lease holds no name either. Else as before: stopped for a
     while after a lease ended with another machine listed. */
  linkWanted(): boolean {
    if (this.linkHeld) return false;
    /* A keeper that is taking the server over registers the name as its taking part says. */
    if (this.taking) return true;
    /* Not known yet counts as needed: no name is taken on a guess. */
    if (this.neededNow !== false) return this.holder.standing() !== null || this.entryTunnel;
    return performance.now() >= this.linkPausedUntil;
  }

  /* Whether another machine holds a copy that finished, read anew; an answer that cannot be had keeps the last one. */
  private async readNeeded(): Promise<void> {
    const { proofs } = this.opts;
    if (!proofs) return;
    const needed = await proofs.needed().catch(() => null);
    if (needed === null) return;
    const began = needed && this.neededNow === false;
    this.neededNow = needed;
    if (!began) return;
    this.opts.log('Another machine holds a copy of the data: this machine leads only while hornhoof.org or that copy vouches for it.');
    if (this.holder.standing()) this.leaseProofs!.begin();
    this.prove();
  }

  /* Each second: a proof for the lease that stands, or a look for the way back to leading. */
  private prove(): void {
    if (this.stopped || !this.neededNow) return;
    const standing = this.holder.standing();
    if (!standing) return void this.reentry!.tick();
    this.leaseProofs!.reportMissing(standing.until, this.opts.log);
    void this.leaseProofs!.tick();
  }

  /* Where this keeper stands, as it tells the other machines that keep data each second: handing the server over,
     taking it, leading under its lease, or holding none. */
  private beat(): Beat {
    const own = this.peers?.current()?.data.find(machine => machine.networkId === this.opts.config.machineId);
    const to = this.hander?.to?.() ?? null;
    const lease = this.hander?.holds() ? null : this.holder.standing();
    const stance: Beat['stance'] = to
      ? { kind: 'handing', to: to.networkId }
      : this.taking
        ? { kind: 'attempting' }
        : lease
          ? { kind: 'lead', term: lease.term, lease: lease.kind, sync: this.syncNamed(), until: lease.until }
          : { kind: 'idle', term: this.holder.lastTerm() };
    return { machine: this.opts.config.machineId ?? '', host: this.opts.hostname ?? own?.hostname ?? '', stance, number: own?.number ?? null, reach: new Date().toISOString(), ready: true, full: this.holder.full() };
  }

  /* What its hello says besides who it is: the term it leads under, the machine its commits wait for, and the machine
     a planned switch hands the server to. */
  private helloMore(): Record<string, unknown> {
    const named = this.syncNamed();
    const data = this.peers?.current()?.data ?? [];
    return { term: this.term(), sync: (named && data.find(machine => machine.networkId === named)?.machine) ?? null, moving: this.hander?.to?.()?.machine ?? null };
  }

  /* The front door takes nobody new, and what is on its way gets a moment to end. */
  private async shutFront(): Promise<void> {
    const door = this.frontDoor;
    if (!door?.listening) return;
    await closeWithin(door, STOP_GRACE_MS);
    door.closeAllConnections();
  }

  private openFront(): void {
    const [door, at] = [this.frontDoor, this.frontAt];
    if (!door || !at || door.listening || this.stopped) return;
    void listenOn(door, at.port, at.host).catch((err: unknown) => this.opts.log(`The keeper could not open its front door: ${reasonOf(err)}`));
  }

  async start(): Promise<{ front: number; linkHttp: number; linkTls: number }> {
    const { host = '0.0.0.0', ports, frontHost, everyMs = EVERY_MS, linkEveryMs = LINK_EVERY_MS, db } = this.opts;
    const at = { ...DOOR_PORTS, ...ports };
    const read = db ? this.settingsReader(db) : null;
    /* A switch of the server to this machine that is on its way: until its part leads, the link's frpc runs only once
       that part starts it. */
    if (this.taker) {
      this.linkHeld = true;
      await this.taker.start();
      this.taking = !this.taker.leads();
      if (!this.taking) this.linkHeld = false;
    }
    const tick = oneAtATime(() => this.holder.tick().then(() => this.giveWord()));
    const lead = async (): Promise<void> => {
      /* Whether another machine holds the data, and the controller's first look, come before the first lease: a
         machine with copies leads only under the flag the controller gives. */
      if (this.sync) {
        await read?.();
        await this.holder.guard();
        await this.sync.start();
      }
      /* So does whether a lease takes a proof: before that is known, none is taken. */
      await this.readNeeded();
      /* The lease and the fences come before the first word, so a healthy machine leads from it. */
      await this.holder.tick();
      await this.holder.look();
      this.giveWord();
    };
    const leaseTimers = (): void => {
      this.timer = setInterval(() => void tick(), everyMs);
      this.fencesTimer = setInterval(() => void this.holder.look().then(() => this.readNeeded()), linkEveryMs);
      if (this.opts.proofs) {
        this.proofsTimer = setInterval(() => this.prove(), this.opts.proofs.everyMs ?? PROVE_EVERY_MS);
        this.proofsTimer.unref();
      }
    };
    const afterLead = (): void => {
      this.guardTimer = setInterval(() => void this.holder.guard(), this.opts.guardEveryMs ?? GUARD_EVERY_MS);
      this.guardTimer.unref();
      if (this.opts.sync?.slots) {
        this.slotsTimer = setInterval(() => void this.keepSlots(), this.opts.sync.slots.everyMs ?? SLOTS_EVERY_MS);
        this.slotsTimer.unref();
        void this.keepSlots();
      }
    };
    const frontDoor = this.door(visitorFromFront(frontHost));
    this.frontDoor = frontDoor;
    this.frontAt = { port: at.front, host };
    const takingNow = this.taking;
    /* A keeper that starts in the middle of handing the server over: its door stays shut and its link's client
       stopped, until the switch is over. */
    const holdsNow = this.hander?.holds() ?? false;
    if (holdsNow) this.linkHeld = true;
    let front = at.front;
    if (takingNow) this.giveWord();
    else {
      await lead();
      if (!holdsNow) front = await listenOn(frontDoor, at.front, host);
    }
    const linkHttp = await listenOn(this.door(visitorFromLink, { link: true }), at.linkHttp, LINK_HOST);
    const linkTls = await this.listener.listen(at.linkTls);
    if (!takingNow) leaseTimers();
    if (db && read) this.carryLink(db, () => this.linkUnlessPaused(read), { http: { ip: LINK_HOST, port: linkHttp }, https: { ip: LINK_HOST, port: linkTls } });
    /* After the doors, the lease and the link: none of them waits for the machine's key or its certificate. */
    this.identity?.start();
    this.throughput.start();
    this.carrier?.start();
    if (this.identity) void this.takeBackups();
    if (read) await this.servePeers(read, { peer: at.peer ?? KEEPER_PORTS.peer, peerApp: at.peerApp ?? KEEPER_PORTS.peerApp }, host);
    await this.updater?.start();
    await this.hander?.start();
    if (!takingNow) afterLead();
    else {
      /* Once its database is promoted this keeper leads as any other: the lease, the word, the front door, and the
         rest of what a leader runs, once. */
      const takeOver = oneAtATime(async () => {
        if (!this.taking || this.stopped || !this.taker?.leads()) return;
        this.taking = false;
        if (this.takingTimer) clearInterval(this.takingTimer);
        this.takingTimer = null;
        /* Where a lease takes proofs, the promotion is this keeper's proof for its first one. */
        await this.reentry?.promoted().catch((err: unknown) => this.opts.log(`The keeper could not note that it took the server over: ${reasonOf(err)}`));
        await lead();
        await listenOn(frontDoor, at.front, host).catch((err: unknown) => this.opts.log(`The keeper could not open its front door: ${reasonOf(err)}`));
        if (this.stopped) return;
        leaseTimers();
        afterLead();
      });
      this.takingTimer = setInterval(() => void takeOver(), this.opts.takingEveryMs ?? TAKING_EVERY_MS);
    }
    return { front, linkHttp, linkTls };
  }

  async stop(): Promise<void> {
    this.throughput.stop();
    if (this.timer) clearInterval(this.timer);
    if (this.certificateTimer) clearInterval(this.certificateTimer);
    if (this.fencesTimer) clearInterval(this.fencesTimer);
    if (this.guardTimer) clearInterval(this.guardTimer);
    if (this.slotsTimer) clearInterval(this.slotsTimer);
    if (this.takingTimer) clearInterval(this.takingTimer);
    if (this.proofsTimer) clearInterval(this.proofsTimer);
    this.timer = this.certificateTimer = this.fencesTimer = this.guardTimer = this.slotsTimer = this.proofsTimer = null;
    this.stopped = true;
    this.beating.stop();
    this.leaseProofs?.stop();
    await this.taker?.stop();
    await this.hander?.stop();
    await this.updater?.stop();
    await this.sync?.stop();
    if (this.backupsTimer) clearTimeout(this.backupsTimer);
    await Promise.all([this.backups?.stop(), this.carrier?.stop(), this.links?.stop(), this.peers?.stop(), this.identity?.stop(), this.tunnel?.stop(), this.listener.close(STOP_GRACE_MS), ...this.doors.map(door => closeWithin(door, STOP_GRACE_MS))]);
    await this.opts.lease?.close().catch(() => undefined);
  }

  /* A machine with an id and a database keeps data, and serves the peer link. One that cannot start it serves the rest. */
  private async servePeers(settings: () => Promise<TunnelSettings | null | undefined>, ports: PeerPorts, host: string): Promise<void> {
    const { config, log } = this.opts;
    if (!this.identity || !config.machineId) return;
    this.peers = new PeerLink({
      dir: this.opts.dir ?? KEEPER_DIR,
      app: this.opts.app,
      db: this.opts.dbTarget ?? null,
      machineId: config.machineId,
      commit: config.commit,
      identity: this.identity,
      mode: () => this.mode(),
      settings,
      ports,
      host,
      everyMs: this.opts.peerEveryMs,
      holdMs: this.opts.holdMs,
      peerClientFor: this.opts.peerClientFor,
      backups: this.peerBackups(),
      uploads: this.uploads().peer(),
      /* A beat is answered by the keeper itself. A switch is answered to a data machine of the company, by the id its
         keeper runs under, where this keeper takes part in one. */
      switches: {
        handle: async (peer, method, path, body) => {
          if (path === PEER_PATHS.beat) return this.beating.handle(peer, body) as { status: number; body: object };
          /* A keeper that asks this one for the next term hears where this one stands: it leads, or would. */
          if (path === PEER_PATHS.promise) return { status: 200, body: this.beat() };
          if (!this.taker) return { status: 404, body: { ok: false } };
          return this.taker.handle(await this.networkIdOf(peer.machine), method, path, body);
        },
      },
      helloMore: () => this.helloMore(),
      /* A machine that led gives what its database held to the keeper that leads now. */
      leds: { put: async (peer, id, body) => (this.backups ? this.backups.takeLed(peer, id, body) : 404) },
      log,
    });
    await this.peers.start().catch((err: Error) => log(`The peer link could not start: ${err.message}`));
    const peers = this.peers;
    const identity = this.identity;
    this.links = new DataLinks({
      machineId: config.machineId,
      dir: this.opts.dir ?? KEEPER_DIR,
      held: () => identity.certificate(),
      key: () => identity.machineKey(),
      peers: () => peers.current(),
      revoked: () => peers.revoked(),
      own: () => this.opts.addresses ?? [],
      settings,
      leads: () => this.mode() === 'lead',
      replica: null,
      log,
      ...this.opts.copies,
    });
    this.links.start();
    this.beating.start();
  }

  /* The name the machine of that network id goes by; none for one this database does not hold. */
  private async hostnameOf(networkId: string): Promise<string> {
    if (!this.opts.db) return '';
    const [row] = await this.opts.db.select({ hostname: machines.hostname }).from(machines).where(eq(machines.networkId, networkId));
    return row?.hostname ?? '';
  }

  /* The id the keeper of that machine runs under; none for a row this database does not hold. */
  private async networkIdOf(machine: string): Promise<string> {
    if (!this.opts.db) return '';
    const [row] = await this.opts.db.select({ networkId: machines.networkId }).from(machines).where(eq(machines.id, machine));
    return row?.networkId ?? '';
  }

  /* One reader of the link's settings for both frpc children, the data links and the sync controller: concurrent asks
     share the read in flight, an outage is said once, and a failed read never clears the last known settings. */
  private settingsReader(db: Db): () => Promise<TunnelSettings | null | undefined> {
    const settings = keepingOnFailure(() => this.linkSettings(db), () => this.opts.log(SETTINGS_KEPT));
    let reading: Promise<TunnelSettings | null | undefined> | null = null;
    return () => {
      reading ??= settings()
        .then(now => {
          if (now !== undefined) {
            this.settingsNow = now;
            /* A read that failed says nothing: the door of a hidden name stays shut on what was last known. */
            this.hiddenName = now?.hidden === true;
          }
          return now;
        })
        .finally(() => { reading = null; });
      return reading;
    };
  }

  private recoverySettings(): TunnelSettings | null {
    const file = join(this.opts.config.controlDir, RECOVERY_LINK);
    if (!existsSync(file)) {
      this.emptyLinkWhy = 'Stopping the public link: the database holds no public link.';
      return null;
    }
    try {
      const said = Settings.safeParse({ ...(JSON.parse(readFileSync(file, 'utf8')) as object), mode: 'http' });
      if (said.success) return said.data;
    } catch {
      /* Unreadable or malformed recovery-link.json falls through without quoting its contents. */
    }
    this.emptyLinkWhy = 'Stopping the public link: the database holds no public link, and recovery-link.json has no valid link settings.';
    return null;
  }

  /* The link's settings: the database's own; and while it has none, on a server that is being restored from a recovery
     file, the link of that file, so the machines that survived find this server under the company's name. In http: the
     link's certificate comes back with the restored database. */
  private async linkSettings(db: Db): Promise<TunnelSettings | null> {
    return (await tunnelSettings(db, this.opts.config)) ?? this.recoverySettings();
  }

  private whyLinkStopped(): string {
    if (this.settingsNow === null) return this.emptyLinkWhy;
    if (this.linkHeld) return 'Stopping the public link while a server switch holds the company name.';
    return 'Stopping the public link while this keeper holds no lease or waits after a lease ended.';
  }

  /* The backups wait for the machine's key and for its key for backups, both kept in the keeper's folder. A folder
     that cannot keep them is said once and tried again each minute, with everything else running on. */
  private async takeBackups(): Promise<void> {
    if (this.stopped || this.backups) return;
    const { config, log, app } = this.opts;
    const dir = this.opts.dir ?? KEEPER_DIR;
    try {
      const key = this.identity?.machineKey();
      if (!key) throw new Error("the machine's key is not there yet");
      const age = await ageKey(dir);
      if (this.stopped) return;
      this.backups = new BackupKeeper({
        dir,
        controlDir: config.controlDir,
        key,
        held: () => this.certificate(),
        age,
        secrets: () => bundleSecrets(config),
        ask: (method, path, body, stop) => askApp(app, method, path, body, stop).then(answerOf),
        leads: () => this.mode() === 'lead',
        log,
        everyMs: this.opts.backupsEveryMs,
      });
      this.backups.start();
    } catch (err) {
      if (!this.backupKeysSaid) log(`The keeper cannot make backups yet: ${reasonOf(err)}. It tries again each minute.`);
      this.backupKeysSaid = true;
      this.backupsTimer = setTimeout(() => void this.takeBackups(), this.opts.backupKeysRetryMs ?? BACKUP_KEYS_RETRY_MS);
      this.backupsTimer.unref();
    }
  }

  /* What takes the uploads of the machines that stopped holding the data: only while this keeper leads, and only from
     the machines its app's last answer names. */
  private uploads(): UploadTaker {
    const taker = new UploadTaker({
      controlDir: this.opts.config.controlDir,
      allowed: () => (this.mode() === 'lead' ? (this.peers?.current()?.uploads ?? []) : []),
      log: this.opts.log,
    });
    taker.start();
    return taker;
  }

  /* What the peer link serves of backups, also before the keeper of backups is there: nothing yet. */
  private peerBackups(): PeerBackups {
    return {
      get: (peer, id) => this.backups?.peer().get(peer, id) ?? { status: 404 },
      put: async (peer, id, body) => (this.backups ? this.backups.peer().put(peer, id, body) : 403),
    };
  }

  /* The company's link as this keeper's own frpc logs in at the relay, for the sync controller: null without a link,
     undefined before the settings were read. */
  private ownLink(): OwnLink | null | undefined {
    const settings = this.settingsNow;
    if (!settings) return settings;
    return { name: settings.name, key: settings.key, client: linkClientId(settings.name, this.opts.config.machineId!), url: settings.url };
  }

  /* Whether no other machine could lead now: none holds a copy that finished, as the last read found, or, where this
     keeper reads no such thing, none holds the data at all. Not known yet counts as another could. */
  private sole(): boolean {
    return this.opts.proofs ? this.neededNow === false : (this.sync?.listed() ?? 0) === 0;
  }

  /* A lease of this machine ended. With another machine holding the data, the link's frpc stops for a while: the
     machine that holds the latest changes may take the company's name over meanwhile. Where none could, the company
     stays reached here while this machine takes its next term. */
  private leaseEnded(): void {
    /* Where a lease takes proofs, the link's client stops with the lease and stays stopped until the way back in. */
    this.entryTunnel = false;
    if (!this.sole() && (this.sync?.listed() ?? 0) > 0) this.linkPausedUntil = performance.now() + (this.opts.sync?.linkPauseMs ?? LINK_PAUSE_MS);
  }

  /* The link's settings for its frpc: none while the frpc is to stay stopped, so the tunnel keeper ends it, and the
     settings again after that, so it starts anew, holds its route, and the relay can be told what is true now. */
  private async linkUnlessPaused(read: () => Promise<TunnelSettings | null | undefined>): Promise<TunnelSettings | null | undefined> {
    const settings = await read();
    return settings && !this.linkWanted() ? null : settings;
  }

  /* The chores of the copies' slots, while this machine leads: how much of the log a copy that fell behind is kept,
     set at the first lead and then each hour, and the slots nobody will read again dropped. A chore that fails is one
     line, and the next round tries again. */
  private async keepSlots(): Promise<void> {
    const slots = this.opts.sync?.slots;
    if (!slots || this.stopped || this.mode() !== 'lead') return;
    try {
      const now = performance.now();
      const free = slots.diskFree();
      if (free !== null && (this.keptSizeAt === null || now - this.keptSizeAt >= KEEP_SIZE_EVERY_MS)) {
        await slots.sql.query(`ALTER SYSTEM SET max_slot_wal_keep_size = '${keepSize(free)}MB'`);
        await slots.sql.query('SELECT pg_reload_conf()');
        this.keptSizeAt = now;
      }
      await sweepSlots(slots.sql, this.opts.log, this.syncSlotsIdle, now, this.leftSlots());
      this.slotsFail = false;
    } catch (err) {
      if (!this.slotsFail) this.opts.log(`Could not look after the copies' slots: ${reasonOf(err)}`);
      this.slotsFail = true;
    }
  }

  /* The slots of tables whose first copy broke off, as the copies named them to the app. */
  private leftSlots(): string[] {
    return this.peers?.current()?.leftSlots ?? [];
  }

  /* The app goes by this word and keeps its mode while the word is stale, so a word that fails must stop no door. */
  private giveWord(): void {
    const dir = this.opts.config.controlDir;
    try {
      const mode = this.taking ? 'off' : this.mode();
      if (mode === 'lead') this.relayUp = null;
      writeKeeperState(dir, {
        mode, at: new Date().toISOString(), link: this.link, doors: this.links?.doors() ?? {}, copies: this.sync?.copies() ?? [],
        /* A machine that holds no lease and does not reach hornhoof.org is cut off: its app tells the agents so. */
        ...(this.relayUp === false ? { internet: false } : {}),
        /* How fast this machine sent to each of the others at its best in the last day, for the server order. */
        throughput: this.throughput.best(Date.now()),
      });
      this.wordFails = false;
    } catch (err) {
      if (!this.wordFails) this.opts.log(`The keeper could not write its word to the app: ${err instanceof Error ? err.message : String(err)}`);
      this.wordFails = true;
    }
  }

  /* Where the company's server is going, as this keeper knows it: to the machine it hands the server to, or here while
     it takes the server and does not lead yet. */
  private switchWord(): SwitchWord {
    const data = this.peers?.current()?.data ?? [];
    const machineOf = (networkId: string | null | undefined): string | null => (networkId && data.find(machine => machine.networkId === networkId)?.machine) || null;
    const to = this.hander?.to?.() ?? null;
    const taking = this.taking ? (this.taker?.from?.() ?? null) : null;
    return switchWord({
      now: Date.now(), kind: to ? 'handing' : this.taking ? 'taking' : 'lead', self: machineOf(this.opts.config.machineId) ?? '', handingTo: to?.machine ?? null, leads: !this.taking,
      leader: null, lastLeader: machineOf(taking?.networkId), lastSync: null, lostSince: null, since: taking?.at ?? null, cut: false, question: false,
    });
  }

  /* Every door answers by itself where the company moves, so a page that waits through a switch hears it also while
     the app is down. A door of the link also answers who holds the lease here; on the front door that path is the
     app's, like any other. */
  private door(headers: PassOptions['headers'], opts: { link?: boolean } = {}): http.Server {
    const own = (req: http.IncomingMessage) => (opts.link ? this.leaseProof(req) : null) ?? switchAnswer(req, () => this.switchWord());
    /* A hidden name is the machines' alone: at its door the keeper says who holds the lease, and nothing else is
       answered or passed on, a socket no more than a page. */
    const closed = opts.link ? (req: http.IncomingMessage) => (this.hiddenName && (proofNonce(req) === undefined || req.headers.upgrade !== undefined) ? HIDDEN_NAME : null) : undefined;
    /* While the app restarts a request is held for it. An update takes minutes, so in maintenance it is answered at once. */
    const holding = (req: http.IncomingMessage) => (this.mode() === 'maintenance' ? maintenanceAnswer(req) : null);
    const door = serve(passThrough({ target: this.opts.app, headers, unreachable: req => this.appIsDown(req), own, closed, holdMs: this.opts.holdMs ?? KEEPER_HOLD_MS, holdEveryMs: this.opts.holdEveryMs, holding }));
    this.doors.push(door);
    return door;
  }

  /* Whoever reaches this machine by the company's public name learns from the keeper itself, not from the app, which
     machine it is and under which term it leads. The nonce comes back, so an answer kept from before proves nothing. */
  private leaseProof(req: http.IncomingMessage): Refusal | null {
    const nonce = proofNonce(req);
    if (nonce === undefined) return null;
    if (nonce === null) return { status: 400, headers: PROOF_HEADERS, body: BAD_NONCE };
    return { status: 200, headers: PROOF_HEADERS, body: JSON.stringify({ machine: this.opts.config.machineId, term: this.term(), nonce }) };
  }

  private appIsDown(req: http.IncomingMessage): Refusal {
    return this.mode() === 'maintenance' ? maintenanceAnswer(req) : startingAnswer(req);
  }

  /* The certificate is followed also without a machine id: the app goes by the keeper's word on it either way. */
  private carryLink(db: Db, read: () => Promise<TunnelSettings | null | undefined>, local: FrpcLocal): void {
    const { config, log, linkEveryMs } = this.opts;
    const everyMs = linkEveryMs ?? LINK_EVERY_MS;
    const follow = oneAtATime(keepingOnFailure(() => this.serveCertificate(db), () => log(CERTIFICATE_KEPT)));
    this.certificateTimer = setInterval(() => void follow(), everyMs);
    void follow();
    if (!config.machineId) return log(NO_MACHINE_ID);
    this.tunnel = new TunnelKeeper({ read, everyMs, restartMs: FRPC_RESTART_MS, clientFor: settings => this.frpc(settings, local), why: () => this.whyLinkStopped(), log });
    this.tunnel.start();
  }

  private frpc(settings: TunnelSettings, local: FrpcLocal): Client {
    const clientId = linkClientId(settings.name, this.opts.config.machineId!);
    return this.opts.clientFor ? this.opts.clientFor(settings, clientId, local) : clientFor(settings, { clientId, local });
  }

  /* The word comes only after the listener took the certificate, since the app moves the link to https on it. */
  private async serveCertificate(db: Db): Promise<void> {
    const toServe = await servedCertificate(db, this.opts.config);
    const word = linkWordOf(toServe);
    if (sameWord(word, this.link)) return;
    await this.listener.use(word.host, toServe?.cert ?? null);
    this.link = word;
  }
}
