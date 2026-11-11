import { readFileSync } from 'node:fs';
import type http from 'node:http';
import { join } from 'node:path';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { firstForwarded, KEEPER_HOLD_MS, passThrough, serve, socketAddress, startingAnswer, type PassOptions, type Refusal, type Target } from '../../net/proxy.js';
import { clientFor, linkClientId, type FrpcLocal } from '../link/client.js';
import { tunnelSettings } from '../link/link.js';
import { Settings, TunnelKeeper, type Client, type TunnelSettings } from '../link/tunnel.js';
import { LINK_TLS_PORT, LinkListener, linkVisitor } from '../tls/listener.js';
import { servedCertificate } from '../tls/store.js';
import { certInfo } from '../tls/x509.js';
import type { Term } from '../../db/net.js';
import { ownAddresses } from './addresses.js';
import type { HeldCertificate } from './certificate.js';
import { closeWithin, KEEPER_PORTS, listenOn, maintenanceAnswer, visitorFromFront } from './doors.js';
import { MachineIdentity, type Published } from './identity.js';
import { PeerLink, type PeerPorts } from './peer-link.js';
import type { PeerServices } from '../link/peer-client.js';
import { LeaseHolder } from './lease-holder.js';
import type { BundleSecrets } from '../backups/bundle.js';
import { RECOVERY_LINK, REPORTED_BUNDLES } from '../backups/types.js';
import { ageKey } from './age-key.js';
import { answerOf, askApp } from './app-call.js';
import { BackupKeeper, type PeerBackups } from './backups.js';
import { ComputerCarrier, type ComputerCarrierOptions } from './computer.js';
import { KEEPER_DIR, reasonOf } from './machine-keys.js';
import type { LeaseStore } from './lease-store.js';
import type { Clocks } from './lease.js';
import { writeKeeperState, type KeeperState, type Mode } from './state.js';
import { updaterBusy } from './updater-status.js';

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
};

type LinkWord = NonNullable<KeeperState['link']>;
type ToServe = Awaited<ReturnType<typeof servedCertificate>>;

const EVERY_MS = 1000;
const LINK_EVERY_MS = 3000;
const GUARD_EVERY_MS = 10_000;
const BACKUP_KEYS_RETRY_MS = 60_000;
const FRPC_RESTART_MS = 2000;
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
   and carries what comes in from front and the link to the app. */
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
    const log = { warn: (_detail: unknown, message?: string) => opts.log(String(message)) };
    this.listener = new LinkListener({ server: this.door(visitorFromTls, { link: true }), log });
    this.holder = new LeaseHolder({ lease: opts.lease, updaterBusy: () => updaterBusy(opts.config.controlDir), now: opts.now, pruneEveryMs: opts.pruneEveryMs, log: opts.log });
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
          addresses: () => ownAddresses({ controlDir: opts.config.controlDir, env: opts.addresses ?? [], seen: [] }),
          hostname: opts.hostname,
          reportAs: opts.reportAs,
          os: opts.config.hostOs,
          ownerKey: opts.config.ownerKey,
          backups: () => (this.backups ? { ageKey: this.backups.ageRecipient(), heldBackups: this.backups.held().slice(0, REPORTED_BUNDLES) } : null),
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

  mode(): Mode {
    return this.holder.mode();
  }

  /* The term this machine holds, while its lease stands. */
  term(): Term | null {
    return this.holder.term();
  }

  async start(): Promise<{ front: number; linkHttp: number; linkTls: number }> {
    const { host = '0.0.0.0', ports, frontHost, everyMs = EVERY_MS, linkEveryMs = LINK_EVERY_MS, db } = this.opts;
    const at = { ...DOOR_PORTS, ...ports };
    /* The lease and the fences come before the first word, so a healthy machine leads from it. */
    const tick = oneAtATime(() => this.holder.tick().then(() => this.giveWord()));
    await this.holder.tick();
    await this.holder.look();
    this.giveWord();
    const front = await listenOn(this.door(visitorFromFront(frontHost)), at.front, host);
    const linkHttp = await listenOn(this.door(visitorFromLink, { link: true }), at.linkHttp, LINK_HOST);
    const linkTls = await this.listener.listen(at.linkTls);
    this.timer = setInterval(() => void tick(), everyMs);
    this.fencesTimer = setInterval(() => void this.holder.look(), linkEveryMs);
    /* One reader of the link's settings for both frpc children, so an outage of the database is said once. */
    const settings = db ? keepingOnFailure(() => this.linkSettings(db), () => this.opts.log(SETTINGS_KEPT)) : null;
    if (db && settings) this.carryLink(db, settings, { http: { ip: LINK_HOST, port: linkHttp }, https: { ip: LINK_HOST, port: linkTls } });
    /* After the doors, the lease and the link: none of them waits for the machine's key or its certificate. */
    this.identity?.start();
    this.carrier?.start();
    if (this.identity) void this.takeBackups();
    this.guardTimer = setInterval(() => void this.holder.guard(), this.opts.guardEveryMs ?? GUARD_EVERY_MS);
    this.guardTimer.unref();
    if (settings) await this.servePeers(settings, { peer: at.peer ?? KEEPER_PORTS.peer, peerApp: at.peerApp ?? KEEPER_PORTS.peerApp }, host);
    return { front, linkHttp, linkTls };
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.certificateTimer) clearInterval(this.certificateTimer);
    if (this.fencesTimer) clearInterval(this.fencesTimer);
    if (this.guardTimer) clearInterval(this.guardTimer);
    this.timer = this.certificateTimer = this.fencesTimer = this.guardTimer = null;
    this.stopped = true;
    if (this.backupsTimer) clearTimeout(this.backupsTimer);
    await Promise.all([this.backups?.stop(), this.carrier?.stop(), this.peers?.stop(), this.identity?.stop(), this.tunnel?.stop(), this.listener.close(STOP_GRACE_MS), ...this.doors.map(door => closeWithin(door, STOP_GRACE_MS))]);
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
      log,
    });
    await this.peers.start().catch((err: Error) => log(`The peer link could not start: ${err.message}`));
  }

  /* The link's settings: the database's own; and while it has none, on a server that is being restored from a recovery
     file, the link of that file, so the machines that survived find this server under the company's name. In http: the
     link's certificate comes back with the restored database. */
  private async linkSettings(db: Db): Promise<TunnelSettings | null> {
    const own = await tunnelSettings(db, this.opts.config);
    if (own) return own;
    try {
      const said = Settings.safeParse({ ...(JSON.parse(readFileSync(join(this.opts.config.controlDir, RECOVERY_LINK), 'utf8')) as object), mode: 'http' });
      return said.success ? said.data : null;
    } catch {
      return null;
    }
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
        ask: (method, path, body) => askApp(app, method, path, body).then(answerOf),
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

  /* What the peer link serves of backups, also before the keeper of backups is there: nothing yet. */
  private peerBackups(): PeerBackups {
    return {
      get: (peer, id) => this.backups?.peer().get(peer, id) ?? { status: 404 },
      put: async (peer, id, body) => (this.backups ? this.backups.peer().put(peer, id, body) : 403),
    };
  }

  /* The app goes by this word and keeps its mode while the word is stale, so a word that fails must stop no door. */
  private giveWord(): void {
    const dir = this.opts.config.controlDir;
    try {
      writeKeeperState(dir, { mode: this.mode(), at: new Date().toISOString(), link: this.link });
      this.wordFails = false;
    } catch (err) {
      if (!this.wordFails) this.opts.log(`The keeper could not write its word to the app: ${err instanceof Error ? err.message : String(err)}`);
      this.wordFails = true;
    }
  }

  /* A door of the link also answers who holds the lease here; on the front door that path is the app's, like any other. */
  private door(headers: PassOptions['headers'], opts: { link?: boolean } = {}): http.Server {
    const own = opts.link ? (req: http.IncomingMessage) => this.leaseProof(req) : undefined;
    /* While the app restarts a request is held for it. An update takes minutes, so in maintenance it is answered at once. */
    const holding = (req: http.IncomingMessage) => (this.mode() === 'maintenance' ? maintenanceAnswer(req) : null);
    const door = serve(passThrough({ target: this.opts.app, headers, unreachable: req => this.appIsDown(req), own, holdMs: this.opts.holdMs ?? KEEPER_HOLD_MS, holdEveryMs: this.opts.holdEveryMs, holding }));
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
    this.tunnel = new TunnelKeeper({ read, everyMs, restartMs: FRPC_RESTART_MS, clientFor: settings => this.frpc(settings, local), log });
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
