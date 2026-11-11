import { statfsSync } from 'node:fs';
import { DbDoor, composeAllowed } from '../../net/db-door.js';
import { PeerDoor } from '../../net/peer-door.js';
import { PeerServer } from '../../net/peer-server.js';
import type { Target } from '../../net/proxy.js';
import { peerClientFor, peerClientId, type PeerServices } from '../link/peer-client.js';
import { TunnelKeeper, type Client, type TunnelSettings } from '../link/tunnel.js';
import { CopyMaker, type CopyMakerOptions, type CopyReport } from './copy.js';
import { KEEPER_PORTS } from './doors.js';
import type { FollowConfig } from './follow-config.js';
import type { Sql } from './lease-store.js';
import { machineKey, reasonOf } from './machine-keys.js';
import { ensureReplica, replicaPassword, replicaReady } from './replica.js';
import { writeKeeperState } from './state.js';
import { WorkerKeeper, type KeeperView, type WorkerKeeperOptions, type WorkerStatus } from './worker.js';

/* With no leader in reach for this long, the front door passes to this machine's own app, which reads. */
export const OWN_APP_AFTER_MS = 60_000;
const EVERY_MS = 1000;
const REPLICA_EVERY_MS = 60_000;
const FRPC_EVERY_MS = 3000;
const FRPC_RESTART_MS = 2000;
const LOOPBACK = '127.0.0.1';
const ANY_ADDRESS = '0.0.0.0';
const COPY_DB = 'hornhoof';

type Closable = Sql & { close(): Promise<void> };

export type FollowKeeperOptions = {
  config: FollowConfig;
  /* Null: no socket on the front port is front. */
  frontHost: string | null;
  /* This machine's own app and database. */
  app: Target;
  db: Target;
  /* A new connection of the owner's to a database of this machine. */
  sql: (database: string) => Closable;
  /* The public link's settings as this machine's own database holds them: null without a link, undefined when they
     cannot be read, as while the copy is being made. */
  settings: () => Promise<TunnelSettings | null | undefined>;
  log: (line: string) => void;
  now?: () => Date;
  /* What a test changes in the worker's keeper inside it. */
  worker?: Partial<WorkerKeeperOptions>;
  ownAppAfterMs?: number;
  host?: string;
  ports?: { door?: number; peer?: number; peerApp?: number };
  /* Where the door to the leader's database listens, and who may use it. */
  doorHost?: string;
  allowed?: () => Promise<string[]>;
  everyMs?: number;
  replicaEveryMs?: number;
  maker?: Partial<CopyMakerOptions>;
  /* What offers this machine to its peers through the relay; frpc unless a test says otherwise. */
  peerClientFor?: (services: PeerServices, clientId: string, local: { data: number; app: number }) => Client;
};

/* The keeper of a machine that keeps a copy of the company's data and does not lead. It is a worker's keeper with a
   database: it reaches the leader as a worker does and serves the company on its own address, and besides that it
   makes this machine's copy and keeps it, opens a door through which its database reaches the leader's, and serves a
   peer link of its own, so the leader can read what this machine holds. It takes no lease and runs no frpc of the
   company's link, so nothing it does can make this machine write the company's tables. */
export class FollowKeeper {
  private readonly maker: CopyMaker;
  private readonly worker: WorkerKeeper;
  private readonly peerDoor: PeerDoor;
  private readonly door: DbDoor;
  private server: PeerServer | null = null;
  private tunnel: TunnelKeeper<PeerServices> | null = null;
  private view: KeeperView | null = null;
  private timer: NodeJS.Timeout | null = null;
  private working: Promise<void> | null = null;
  private replicaAt: number | null = null;
  private replicaFails = false;
  private wordFails = false;
  private stopped = false;

  constructor(private readonly opts: FollowKeeperOptions) {
    const { config, log } = opts;
    this.maker = new CopyMaker({
      admin: opts.sql('postgres'),
      db: opts.sql,
      controlDir: config.controlDir,
      dir: config.dir,
      networkId: config.machineId,
      password: replicaPassword(config.secret),
      diskFree: () => this.diskFree(),
      log,
      now: opts.now,
      ...opts.maker,
    });
    this.worker = new WorkerKeeper({
      config,
      frontHost: opts.frontHost,
      host: opts.host,
      log,
      now: opts.now,
      role: 'data',
      visitKind: 'data',
      ownApp: { target: opts.app, afterMs: opts.ownAppAfterMs ?? OWN_APP_AFTER_MS },
      extraReport: () => ({ copy: this.maker.report() }),
      onView: view => this.heard(view),
      ...opts.worker,
    });
    this.peerDoor = new PeerDoor({ app: opts.app });
    this.door = new DbDoor({
      connect: () => this.worker.parts().link.connectDb(),
      allowed: opts.allowed ?? composeAllowed(),
      log,
      host: opts.doorHost ?? ANY_ADDRESS,
    });
  }

  /* The front door and the door to the leader's database, once both listen. */
  async start(): Promise<{ front: number; door: number }> {
    const { front } = await this.worker.start();
    await this.peerDoor.start();
    this.servePeers();
    const door = await this.door.listen(this.opts.ports?.door ?? KEEPER_PORTS.db);
    this.timer = setInterval(() => this.look(), this.opts.everyMs ?? EVERY_MS);
    this.timer.unref();
    this.look();
    return { front, door };
  }

  status(): WorkerStatus & { copy: CopyReport } {
    return { ...this.worker.status(), copy: this.maker.report() };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.working;
    await Promise.all([this.tunnel?.stop(), this.server?.close().catch(() => undefined), this.door.close(), this.peerDoor.stop(), this.worker.stop(), this.maker.stop()]);
  }

  private diskFree(): number | null {
    try {
      const { bavail, bsize } = statfsSync(this.opts.config.dir);
      return bavail * bsize;
    } catch {
      return null;
    }
  }

  private heard(view: KeeperView): void {
    this.view = view;
    this.server?.refresh();
  }

  /* The peer link of this machine, as a machine that keeps data serves it: to the certificates of the company, with
     the list of revoked ones the leader signed. It says it does not lead, and carries what comes for its app and its
     database to its own. It listens once the machine holds its certificate and that list. */
  private servePeers(): void {
    const { config, log } = this.opts;
    const { certificates } = this.worker.parts();
    const server = new PeerServer({
      held: () => certificates.current(),
      key: machineKey(config.dir),
      crl: () => this.view?.crlPem ?? null,
      revoked: () => new Set(this.view?.revoked ?? []),
      door: this.peerDoor,
      db: this.opts.db,
      hello: () => ({ machine: certificates.current()?.machine ?? '', role: 'data', lead: false, commit: config.commit }),
      log,
    });
    this.server = server;
    certificates.onChange(() => server.refresh());
    const { ports, host } = this.opts;
    void Promise.all([server.listen(ports?.peer ?? KEEPER_PORTS.peer, 'peer', host), server.listen(ports?.peerApp ?? KEEPER_PORTS.peerApp, 'app', LOOPBACK)])
      .then(([data, app]) => this.offer({ data, app }))
      .catch((err: Error) => void (this.stopped || log(`The peer link could not listen: ${err.message}`)));
  }

  /* A frpc of the keeper's own offers the two doors through hornhoof.org, while the company has a link and the leader
     gave this machine both secrets. */
  private offer(local: { data: number; app: number }): void {
    if (this.stopped) return;
    const { machineId, dir } = this.opts.config;
    this.tunnel = new TunnelKeeper<PeerServices>({
      read: () => this.services(),
      everyMs: FRPC_EVERY_MS,
      restartMs: FRPC_RESTART_MS,
      clientFor: services => (this.opts.peerClientFor ? this.opts.peerClientFor(services, peerClientId(services.settings.name, machineId), local) : peerClientFor(services, { machineId, local, dir })),
      says: { carrying: services => `Offering this machine to its peers through ${services.settings.url}.`, waiting: 'No public link: this machine is not offered to its peers through it.' },
      log: this.opts.log,
    });
    this.tunnel.start();
  }

  /* Null: no link or no secrets, and the client stops. Undefined: not known now, and the client it runs stays. */
  private async services(): Promise<PeerServices | null | undefined> {
    if (!this.view) return undefined;
    const link = this.view.link;
    if (!link?.dataSecret) return null;
    const settings = await this.opts.settings();
    if (settings === undefined) return undefined;
    return settings ? { settings, secrets: { data: link.dataSecret, app: link.appSecret } } : null;
  }

  /* One look at a time, each second: the copy's next step, the word to the app, and the role a merge reads with. */
  private look(): void {
    if (this.working || this.stopped) return;
    this.working = this.lookOnce().finally(() => { this.working = null; });
  }

  private async lookOnce(): Promise<void> {
    await this.maker.tick(this.view?.copy ?? null);
    this.giveWord();
    await this.keepReplica();
  }

  /* The app reads once the copy holds every table, and is off until then; it never leads on this keeper's word. */
  private giveWord(): void {
    try {
      writeKeeperState(this.opts.config.controlDir, { mode: this.maker.mode(), at: new Date().toISOString(), link: null });
      this.wordFails = false;
    } catch (err) {
      if (!this.wordFails) this.opts.log(`The keeper could not write its word to the app: ${reasonOf(err)}`);
      this.wordFails = true;
    }
  }

  /* The role the leader reads this machine's database with for a merge: made at the start, and again whenever a look,
     one a minute, finds it gone or without its rights. A failure is said once. */
  private async keepReplica(): Promise<void> {
    const now = performance.now();
    if (this.replicaAt !== null && now - this.replicaAt < (this.opts.replicaEveryMs ?? REPLICA_EVERY_MS)) return;
    this.replicaAt = now;
    const sql = this.opts.sql(COPY_DB);
    try {
      if (!(await replicaReady(sql))) await ensureReplica(() => this.opts.sql(COPY_DB), replicaPassword(this.opts.config.secret));
      this.replicaFails = false;
    } catch (err) {
      if (!this.replicaFails) this.opts.log(`Could not prepare this machine's database for the company server to read: ${reasonOf(err)}`);
      this.replicaFails = true;
    } finally {
      await sql.close().catch(() => undefined);
    }
  }
}
