import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAddressOf } from '../../auth/tunnel.js';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { firstForwarded, KEEPER_HOLD_MS, passThrough, serve, socketAddress, startingAnswer, type PassOptions, type Refusal, type Target } from '../../net/proxy.js';
import { clientFor, linkClientId, type FrpcLocal } from '../link/client.js';
import { tunnelSettings } from '../link/link.js';
import { TunnelKeeper, type Client, type TunnelSettings } from '../link/tunnel.js';
import { LINK_TLS_PORT, LinkListener, linkVisitor } from '../tls/listener.js';
import { servedCertificate } from '../tls/store.js';
import { certInfo } from '../tls/x509.js';
import type { Term } from '../../db/net.js';
import type { HeldCertificate } from './certificate.js';
import { MachineIdentity, type Published } from './identity.js';
import { LeaseHolder } from './lease-holder.js';
import { KEEPER_DIR } from './machine-keys.js';
import type { LeaseStore } from './lease-store.js';
import type { Clocks } from './lease.js';
import { writeKeeperState, type KeeperState, type Mode } from './state.js';
import { updaterBusy } from './updater-status.js';

export const KEEPER_PORTS = { peer: 7070, front: 7080, linkHttp: 7081 } as const;

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
  ports?: { front?: number; linkHttp?: number; linkTls?: number };
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
};

type LinkWord = NonNullable<KeeperState['link']>;
type ToServe = Awaited<ReturnType<typeof servedCertificate>>;

const EVERY_MS = 1000;
const LINK_EVERY_MS = 3000;
const FRPC_RESTART_MS = 2000;
const NO_MACHINE_ID = 'The keeper carries no public link: HORNHOOF_MACHINE_ID is not set. Run the install command again.';
const SETTINGS_KEPT = "The keeper cannot read the link's settings from the database: frpc stays as it is.";
const CERTIFICATE_KEPT = "The keeper cannot read or serve the link's certificate: it keeps the one it serves.";
/* Only this keeper's own frpc child reaches the link's doors, which is why they may believe what it sends. */
const LINK_HOST = '127.0.0.1';
/* Docker waits 10 s after its stop signal. A request in flight gets half of that to finish; an open socket, which never
   ends by itself, does not hold the stop up for longer. */
const STOP_GRACE_MS = 5000;

const MAINTENANCE_JSON = JSON.stringify({
  error: { code: 'unavailable', message: 'Hornhoof is installing an update and takes no changes until it ends.', reason: 'maintenance' },
});
const MAINTENANCE_TEXT = 'Hornhoof is installing an update. Try again in a few minutes.\nHornhoof ставит обновление. Попробуйте через несколько минут.\n';

/* startingAnswer already decides who gets JSON and who gets a page, so the two answers cannot split differently. */
function maintenanceAnswer(req: http.IncomingMessage): Refusal {
  const contentType = startingAnswer(req).headers['Content-Type']!;
  const body = contentType === 'application/json' ? MAINTENANCE_JSON : MAINTENANCE_TEXT;
  return { status: 503, headers: { 'Content-Type': contentType, 'Retry-After': '10' }, body };
}

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

const INVOCATION = 'x-hornhoof-invocation';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* The id front stamped a tool call with, when the request has one. */
function invocationOf(req: http.IncomingMessage): Record<string, string> {
  const id = String(req.headers[INVOCATION] ?? '').toLowerCase();
  return UUID.test(id) ? { [INVOCATION]: id } : {};
}

/* Anyone on the default network can reach the front port and write a header, so what it says counts only from front:
   the visitor's address, and the id of a tool call. */
const visitorFromFront =
  (frontHost: string | null) =>
  async (req: http.IncomingMessage): Promise<Record<string, string>> => {
    if (!(await isAddressOf(frontHost, socketAddress(req)))) return { 'x-forwarded-for': socketAddress(req) };
    return { 'x-forwarded-for': firstForwarded(req) || socketAddress(req), ...invocationOf(req) };
  };

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

function listenOn(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    /* It stays on: after the start an error is one failed accept, and the next visitor should still get through. */
    server.on('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

function closeWithin(server: http.Server, ms: number): Promise<void> {
  return new Promise(resolve => {
    const giveUp = setTimeout(resolve, ms);
    server.close(() => {
      clearTimeout(giveUp);
      resolve();
    });
  });
}

/* Holds this machine's lease and sets the app's mode by it, runs the public link's frpc as its child, ends the link's TLS,
   and carries what comes in from front and the link to the app. */
export class Keeper {
  private readonly holder: LeaseHolder;
  private readonly identity: MachineIdentity | null;
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
        })
      : null;
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
    if (db) this.carryLink(db, { http: { ip: LINK_HOST, port: linkHttp }, https: { ip: LINK_HOST, port: linkTls } });
    /* After the doors, the lease and the link: none of them waits for the machine's key or its certificate. */
    this.identity?.start();
    return { front, linkHttp, linkTls };
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.certificateTimer) clearInterval(this.certificateTimer);
    if (this.fencesTimer) clearInterval(this.fencesTimer);
    this.timer = this.certificateTimer = this.fencesTimer = null;
    await Promise.all([this.identity?.stop(), this.tunnel?.stop(), this.listener.close(STOP_GRACE_MS), ...this.doors.map(door => closeWithin(door, STOP_GRACE_MS))]);
    await this.opts.lease?.close().catch(() => undefined);
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
  private carryLink(db: Db, local: FrpcLocal): void {
    const { config, log, linkEveryMs } = this.opts;
    const everyMs = linkEveryMs ?? LINK_EVERY_MS;
    const follow = oneAtATime(keepingOnFailure(() => this.serveCertificate(db), () => log(CERTIFICATE_KEPT)));
    this.certificateTimer = setInterval(() => void follow(), everyMs);
    void follow();
    if (!config.machineId) return log(NO_MACHINE_ID);
    const read = keepingOnFailure(() => tunnelSettings(db, config), () => log(SETTINGS_KEPT));
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
