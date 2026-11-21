import { createReadStream, statfsSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { DbDoor, composeAllowed } from '../../net/db-door.js';
import { PeerDoor } from '../../net/peer-door.js';
import { PEER_PATHS, PeerServer } from '../../net/peer-server.js';
import type { Target } from '../../net/proxy.js';
import { peerClientFor, peerClientId, type PeerServices } from '../link/peer-client.js';
import type { Route } from '../link/relay.js';
import { holdThroughOneEmptyRead, TunnelKeeper, type Client, type TunnelSettings } from '../link/tunnel.js';
import type { BundleSecrets } from '../backups/bundle.js';
import type { MakerView } from '../backups/types.js';
import { ageKey } from './age-key.js';
import { Beats, type Beat } from './beats.js';
import { CopyMaker, NEXT_DB, type CopyMakerOptions, type CopyReport } from './copy.js';
import { KEEPER_PORTS } from './doors.js';
import type { FollowConfig } from './follow-config.js';
import { Leaving, type LeavingOptions } from './leave.js';
import { LedSaver, type LedSaverOptions } from './led.js';
import type { Clocks } from './lease.js';
import type { Sql } from './lease-store.js';
import { machineKey, reasonOf } from './machine-keys.js';
import { ensureReplica, replicaPassword, replicaReady } from './replica.js';
import type { Taking } from './switch-step.js';
import { pgSubscription, Taker, writeTaking, type TakerOptions } from './taking.js';
import { makeQuestion, Recovery, type Question, type RecoveryOptions } from './question.js';
import { waitForNoCopy } from './promote.js';
import { writeKeeperState } from './state.js';
import { CopyUpdating, type CopyUpdatingOptions } from './updating.js';
import { Watcher, type WatcherOptions } from './watch.js';
import { WorkerKeeper, type KeeperView, type WorkerKeeperOptions, type WorkerStatus } from './worker.js';

/* With no leader in reach for this long, the front door passes to this machine's own app, which reads. */
export const OWN_APP_AFTER_MS = 60_000;
const EVERY_MS = 1000;
const REPLICA_EVERY_MS = 60_000;
const LINK_EVERY_MS = 10_000;
const FRPC_EVERY_MS = 3000;
const FRPC_RESTART_MS = 2000;
const LOOPBACK = '127.0.0.1';
const ANY_ADDRESS = '0.0.0.0';
const COPY_DB = 'hornhoof';
const BACKUPS_PATH = '/api/network/backups';

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
  /* What a test changes in how the machine gives up the data once its owner lost the scope. */
  leaving?: Partial<LeavingOptions>;
  /* What a test changes in how this machine answers a planned switch of the server to it. */
  taker?: Partial<TakerOptions>;
  /* What a test changes in how this machine waits for an update of the machine that leads. */
  updating?: Partial<CopyUpdatingOptions>;
  /* How often it tells the other machines that keep data where it stands; each second unless a test says otherwise. */
  beatEveryMs?: number;
  /* hornhoof.org's relay, which the watch over the leader asks of the company's name; none where a test gives its own. */
  relay?: WatcherOptions['relay'];
  /* A request through the company's link for who answers there; none where a test gives its own. */
  probe?: (nonce: string, url: string) => Promise<{ machine: string; nonce: string } | null>;
  /* What a test changes in the watch over the machine this copy follows. */
  watcher?: Partial<WatcherOptions>;
  /* What a test changes in how the CEO's answer to this copy's question is read. */
  recovery?: Partial<RecoveryOptions>;
  /* The clocks the beats and the watch go by; the machine's own unless a test says otherwise. */
  clocks?: () => Clocks;
  /* The company's secrets as this machine holds them, which go into the backup of a database of its own that led.
     Without them such a database is never touched, and its copy stops. */
  secrets?: () => BundleSecrets;
  /* What a test changes in how a database that led is saved. */
  saver?: Partial<LedSaverOptions>;
  /* Ends this keeper, so that it starts again as another kind; the process ends unless a test says otherwise. */
  exit?: () => void;
  /* What offers this machine to its peers through the relay; frpc unless a test says otherwise. */
  peerClientFor?: (services: PeerServices, clientId: string, local: { data: number; app: number }) => Client;
};

/* Whether the copy is being poured in: made or made again, or not begun yet, as the leader says of a copy that said
   nothing. */
const pouring = (copy: CopyReport | null): boolean => copy === null || copy.state === 'making' || copy.state === 'remaking';

/* The keeper of a machine that keeps a copy of the company's data and does not lead. It is a worker's keeper with a
   database: it reaches the leader as a worker does and serves the company on its own address, and besides that it
   makes this machine's copy and keeps it, opens a door through which its database reaches the leader's, and serves a
   peer link of its own, so the leader can read what this machine holds. It takes no lease and runs no frpc of the
   company's link, so nothing it does can make this machine write the company's tables. Once the leader says its owner
   sees the whole company no more, it stops the copy, gives the leader what it holds, and has the machine wiped. When
   the CEO moves the server here, it answers the keeper that hands the server over, and once that one said go it ends,
   to start again as the keeper that takes the server. While the machine that leads updates, it keeps the promise it
   gave that machine: its app says so and takes no change, its front door waits for the leader, and its copy is
   neither made again nor started. */
export class FollowKeeper {
  private readonly maker: CopyMaker;
  private readonly leaving: Leaving;
  private readonly worker: WorkerKeeper;
  private readonly peerDoor: PeerDoor;
  private readonly door: DbDoor;
  private readonly taker: Taker;
  private readonly updating: CopyUpdating;
  private readonly beating: Beats;
  private readonly watcher: Watcher;
  private readonly recovery: Recovery;
  /* Whether this keeper was given hornhoof.org's relay to ask; a test or an install without one says nothing of it. */
  private readonly asksRelay: boolean;
  private readonly clocks: () => Clocks;
  /* The question to the CEO, while it stands: since when, and when the leader was last heard, by the wall clock. */
  private asking: { since: number; heard: number | null } | null = null;
  /* What saves this machine's database when it led before; none where the keeper holds no secrets to seal it with. */
  private readonly saver: LedSaver | null;
  /* The company's link as this machine's own database holds it, as last read. */
  private linkNow: TunnelSettings | null = null;
  private linkAt: number | null = null;
  private readonly copySql: Closable;
  private ports: Promise<{ data: number; app: number }> = new Promise(() => {});
  private server: PeerServer | null = null;
  private tunnel: TunnelKeeper<PeerServices> | null = null;
  private view: KeeperView | null = null;
  private timer: NodeJS.Timeout | null = null;
  private working: Promise<void> | null = null;
  private replicaAt: number | null = null;
  private replicaFails = false;
  private wordFails = false;
  private updatingFails = false;
  private lookFails = false;
  /* It took the go of a switch, or decided to take the server over, as of its last look: what its beats say. */
  private goingNow = false;
  private stopped = false;
  private waitsForNone = false;

  constructor(private readonly opts: FollowKeeperOptions) {
    const { config, log } = opts;
    this.clocks = opts.clocks ?? (() => ({ wall: Date.now(), mono: performance.now() }));
    this.asksRelay = Boolean(opts.relay ?? opts.watcher?.relay);
    this.copySql = opts.sql(COPY_DB);
    this.saver = opts.secrets
      ? new LedSaver({
          dir: config.dir,
          controlDir: config.controlDir,
          sql: this.copySql,
          key: machineKey(config.dir),
          held: () => this.worker.parts().certificates.current(),
          age: () => ageKey(config.dir),
          secrets: opts.secrets,
          leader: () => this.leader(),
          /* Whom the company's backups are sealed to, as the leader's app tells a machine that holds the data. */
          view: async () => {
            const answer = await this.worker.fromLeader('GET', `${BACKUPS_PATH}?as=maker`);
            return answer?.status === 200 ? (answer.body as MakerView) : null;
          },
          put: (_networkId, id, bundle) => this.putLed(id, bundle),
          now: opts.now,
          log,
          ...opts.saver,
        })
      : null;
    const saver = this.saver;
    this.maker = new CopyMaker({
      admin: opts.sql('postgres'),
      db: opts.sql,
      controlDir: config.controlDir,
      dir: config.dir,
      networkId: config.machineId,
      password: replicaPassword(config.secret),
      diskFree: () => this.diskFree(),
      updating: () => this.updating.holds(),
      ...(saver ? { saver: { tick: () => saver.tick(), done: () => saver.done(), state: () => saver.state(), forget: () => saver.forget() } } : {}),
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
      visitKind: 'view',
      ownApp: { target: opts.app, afterMs: opts.ownAppAfterMs ?? OWN_APP_AFTER_MS },
      updating: () => this.updating.holds(),
      switchMore: () => ({ cut: this.watcher.cut(), question: this.asking !== null }),
      extraReport: () => this.replicaReport(),
      copying: () => pouring(this.maker.report()),
      onView: view => this.heard(view),
      ...opts.worker,
    });
    this.leaving = new Leaving({
      controlDir: config.controlDir,
      dir: config.dir,
      halt: () => this.maker.halt(),
      put: (id, file, length) => this.put(id, file, length),
      server: () => this.linkOrigin(),
      log,
      ...opts.leaving,
    });
    const subscription = pgSubscription(this.copySql, async () => this.maker.report()?.name ?? null);
    this.updating = new CopyUpdating({
      controlDir: config.controlDir,
      sql: this.copySql,
      leader: () => this.leader()?.networkId ?? null,
      subscription,
      now: opts.now && (() => opts.now!().getTime()),
      log,
      ...opts.updating,
    });
    this.taker = new Taker({
      dir: config.dir,
      sql: this.copySql,
      leader: () => this.leader(),
      copyReady: () => this.maker.report()?.state === 'ready',
      subscription,
      exit: opts.exit ?? (() => process.exit(0)),
      log,
      ...opts.taker,
    });
    this.beating = new Beats({
      self: () => this.beat(),
      peers: () => (this.view?.data ?? []).filter(machine => machine.networkId !== config.machineId).map(({ machine, networkId }) => ({ machine, networkId })),
      ask: (networkId, method, path, body, timeoutMs) => this.worker.parts().link.ask(networkId, method, path, body, timeoutMs),
      /* Every beat it hears, and every answer it gets, tells the watch which term the leader leads under. */
      onHeard: (networkId, beat) => this.watcher.heard(networkId, beat),
      now: opts.clocks,
      everyMs: opts.beatEveryMs,
      log,
    });
    const nobody = { route: async (): Promise<Route> => ({ known: false, why: 'unreachable' }), health: async () => ({ up: false, relayStarted: null }) };
    this.watcher = new Watcher({
      dir: config.dir,
      self: { networkId: config.machineId },
      link: () => (this.linkNow ? { name: this.linkNow.name, key: this.linkNow.key } : null),
      relay: opts.relay ?? nobody,
      probe: async nonce => (this.linkNow && opts.probe ? opts.probe(nonce, this.linkNow.url) : null),
      beats: this.beating,
      beat: () => this.beat(),
      /* The machine its copy was made on or last joined, as the maker wrote it down. */
      leader: () => {
        const networkId = this.maker.leader();
        return networkId ? { networkId } : null;
      },
      ready: () => this.maker.report()?.state === 'ready',
      /* While the leader updates, or a planned switch was offered to this machine, nothing is watched. */
      holds: () => this.updating.holds() || this.taker.offered(),
      reach: () => this.maker.report()?.at ?? null,
      take: taking => this.takeOver(taking),
      /* The question stands in this keeper's word to the app, which shows it; the CEO's answer comes back through the
         control folder. */
      ask: (on, sample) => {
        const now = this.clocks();
        this.asking = on ? { since: now.wall, heard: sample.heard === null ? null : now.wall - (now.mono - sample.heard) } : null;
      },
      ceo: () => this.recovery.go(),
      now: opts.clocks,
      log,
      ...opts.watcher,
    });
    this.recovery = new Recovery({
      controlDir: config.controlDir,
      self: config.machineId,
      reach: () => this.maker.report()?.at ?? null,
      others: () => this.question()?.copies.filter(copy => !copy.self).map(copy => copy.networkId) ?? [],
      host: networkId => this.view?.data.find(machine => machine.networkId === networkId)?.hostname ?? '',
      ask: (networkId, path, body, timeoutMs) => this.worker.parts().link.ask(networkId, 'POST', path, body, timeoutMs),
      now: opts.clocks,
      log,
      ...opts.recovery,
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
    /* Until a leader answers, the network is as this keeper last wrote it down: whose certificates count, which
       machines keep the data, whom it beats with. With no leader in reach, as when the server was handed over and
       never taken or the leader stopped, it would else serve nobody and hear nobody. What that view said of this
       machine's copy was a leader's word of then, and is not taken. */
    const kept = this.worker.known();
    if (!this.view && kept) this.view = { ...kept, copy: null };
    await this.peerDoor.start();
    this.servePeers();
    const door = await this.door.listen(this.opts.ports?.door ?? KEEPER_PORTS.db);
    this.timer = setInterval(() => this.look(), this.opts.everyMs ?? EVERY_MS);
    this.timer.unref();
    this.look();
    this.beating.start();
    this.watcher.start();
    this.recovery.start();
    return { front, door };
  }

  /* The ports this machine's peer link listens on, once it does. */
  peerPorts(): Promise<{ data: number; app: number }> {
    return this.ports;
  }

  /* The machine this keeper's link names as the leader now, as its view lists it. */
  private leader(): { networkId: string; hostname: string } | null {
    const leads = this.worker.parts().link.leader();
    const row = leads && this.view?.data.find(machine => machine.machine === leads.machine);
    return row ? { networkId: row.networkId, hostname: row.hostname ?? '' } : null;
  }

  /* The address of the company's link as this keeper's view names it, when it is https: its scheme and host. None for
     a hidden name, at which only who holds the lease is answered. */
  private linkOrigin(): string | null {
    try {
      if (this.view?.link?.hidden) return null;
      const url = new URL(this.view?.link?.url ?? '');
      return url.protocol === 'https:' ? url.origin : null;
    } catch {
      return null;
    }
  }

  /* What this keeper and the other machines that keep data told each other last. */
  beats(): Beats {
    return this.beating;
  }

  /* Where this keeper stands, as it tells the other machines that keep data each second: it follows, or, once it took
     the go of a switch, it is taking the server. */
  private beat(): Beat {
    const { machineId } = this.opts.config;
    const own = this.view?.data.find(machine => machine.networkId === machineId);
    const copy = this.maker.report();
    return {
      machine: machineId, host: own?.hostname ?? '', stance: this.goingNow ? { kind: 'attempting' } : this.watcher.stance(),
      number: own?.number ?? null, reach: copy?.at ?? null, ready: copy?.state === 'ready', full: false,
    };
  }

  status(): WorkerStatus & { copy: CopyReport | null } {
    return { ...this.worker.status(), copy: this.maker.report() };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.beating.stop();
    this.watcher.stop();
    this.recovery.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.working;
    await Promise.all([this.tunnel?.stop(), this.server?.close().catch(() => undefined), this.door.close(), this.peerDoor.stop(), this.worker.stop(), this.maker.stop()]);
    await this.copySql.close().catch(() => undefined);
  }

  private async replicaReport(): Promise<{ copy?: CopyReport; replicaBytes?: number }> {
    const copy = this.maker.report();
    if (this.goingNow) return copy ? { copy } : {};
    const measured = await this.copySql.query<{ bytes: number }>(
      `SELECT COALESCE(SUM(pg_database_size(oid)), 0)::float8 AS bytes FROM pg_database
       WHERE datname IN ($1, $2) OR datname ~ '^hornhoof_old_[0-9]{8}t[0-9]{6}$'`, [COPY_DB, NEXT_DB],
    ).catch(() => undefined);
    const bytes = measured?.rows[0]?.bytes;
    return { ...(copy ? { copy } : {}), ...(bytes === undefined ? {} : { replicaBytes: bytes }) };
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
      /* A switch, and a word about the leader's update, is answered to a data machine of the company by the id its
         keeper runs under; one this machine's view does not list is nobody it would answer. */
      switches: {
        handle: async (peer, method, path, body) => {
          const from = this.view?.data.find(machine => machine.machine === peer.machine)?.networkId ?? '';
          if (path === PEER_PATHS.beat) return this.beating.handle(peer, body) as { status: number; body: object };
          if (path === PEER_PATHS.promise) return this.watcher.promise(from, body) as { status: number; body: object };
          if (path === PEER_PATHS.goOn) return this.recovery.handle(from, body);
          return path === PEER_PATHS.updating ? this.updating.handle(from, body) : this.taker.handle(from, method, path, body);
        },
      },
      log,
    });
    this.server = server;
    certificates.onChange(() => server.refresh());
    const { ports, host } = this.opts;
    this.ports = Promise.all([server.listen(ports?.peer ?? KEEPER_PORTS.peer, 'peer', host), server.listen(ports?.peerApp ?? KEEPER_PORTS.peerApp, 'app', LOOPBACK)]).then(([data, app]) => ({ data, app }));
    void this.ports
      .then(local => this.offer(local))
      .catch((err: Error) => void (this.stopped || log(`The peer link could not listen: ${err.message}`)));
  }

  /* A frpc of the keeper's own offers the two doors through hornhoof.org, while the company has a link and the leader
     gave this machine both secrets. */
  private offer(local: { data: number; app: number }): void {
    if (this.stopped) return;
    const { machineId, dir } = this.opts.config;
    this.tunnel = new TunnelKeeper<PeerServices>({
      read: holdThroughOneEmptyRead(() => this.services()),
      everyMs: FRPC_EVERY_MS,
      restartMs: FRPC_RESTART_MS,
      clientFor: services => (this.opts.peerClientFor ? this.opts.peerClientFor(services, peerClientId(services.settings.name, machineId), local) : peerClientFor(services, { machineId, local, dir })),
      says: { carrying: services => `Offering this machine to its peers through ${services.settings.url}.`, waiting: 'No public link: this machine is not offered to its peers through it.' },
      why: () => this.whyNoServices(),
      log: this.opts.log,
    });
    this.tunnel.start();
  }

  /* The copy takes the server over, by itself or as the CEO chose: written down first, then its subscription stopped,
     then the keeper ends, and starts again as the one that takes the server, as after the go of a planned switch. */
  private async takeOver(taking: Taking): Promise<void> {
    const leader = this.view?.data.find(machine => machine.networkId === taking.from.networkId)?.hostname || 'the machine that led';
    const since = taking.heard == null ? 'this keeper started' : new Date(taking.heard).toISOString();
    writeTaking(this.opts.config.dir, { ...taking, from: { ...taking.from, hostname: leader } });
    this.opts.log(taking.kind === 'ceo' ? `Going on from ${taking.reach ?? 'what this copy holds'} as the CEO chose.` : `Taking the server over from ${leader}: it has not answered since ${since}.`);
    this.goingNow = true;
    await this.taker.takenOver();
  }

  /* Null: no link or no secrets, and the client stops. Undefined: not known now, and the client it runs stays. */
  private async services(): Promise<PeerServices | null | undefined> {
    if (!this.view) return undefined;
    const link = this.view.link;
    if (!link?.dataSecret) return null;
    const settings = await this.opts.settings().catch(() => undefined);
    if (settings === undefined) return undefined;
    return settings ? { settings, secrets: { data: link.dataSecret, app: link.appSecret } } : null;
  }

  private whyNoServices(): string {
    if (!this.view?.link?.dataSecret) return 'Stopping the peer tunnel: the company server reported no public link or data secret.';
    return "Stopping the peer tunnel: this machine's database holds no public link.";
  }

  /* One look at a time, each second: the copy's next step, the word to the app, and the role a merge reads with. */
  private look(): void {
    if (this.working || this.stopped) return;
    this.working = this.lookOnce()
      .then(
        () => void (this.lookFails = false),
        (err: unknown) => {
          /* A look that failed is said once an outage, and the next one tries again. */
          if (!this.lookFails) this.opts.log(`The keeper could not look after its copy: ${reasonOf(err)}`);
          this.lookFails = true;
        },
      )
      .finally(() => { this.working = null; });
  }

  /* A database that follows waits for no copy. One that led keeps, in its setting, the name of the copy its commits
     waited for; nothing clears it when the lease just ends, as on a machine that was cut off, and whatever writes
     there afterwards, this keeper or its updater, would wait for that copy for good. Done once, when it works. */
  private async waitForNone(): Promise<void> {
    if (this.waitsForNone) return;
    /* Asked of the server's own database, which is always there: the copy's is not while it changes places with a
       new one, and a keeper that started then would never get to the step that puts it back. */
    const admin = this.opts.sql('postgres');
    try {
      await waitForNoCopy(admin);
    } finally {
      await admin.close().catch(() => undefined);
    }
    this.waitsForNone = true;
  }

  private async lookOnce(): Promise<void> {
    /* A machine that stops holding the data makes no copy any more, and its app is off: what it holds is the leader's
       to read, and nobody else's. */
    const owed = this.view?.copy?.upload ?? null;
    if (owed) {
      this.giveWord('off');
      await this.leaving.step(owed);
      return;
    }
    await this.waitForNone();
    await this.keepPromise();
    await this.keepLink();
    await this.taker.tick();
    /* Once it took the go of a switch, its subscription stays stopped and this keeper ends: the copy's maker, which
       starts a stopped subscription again, takes no step. */
    this.goingNow = this.taker.going();
    if (this.goingNow) return;
    await this.maker.tick(this.view?.copy ?? null);
    /* While the leader updates, an app that reads says so; one with no copy to read stays off. */
    const mode = this.maker.mode();
    this.giveWord(mode === 'read' && this.updating.holds() ? 'maintenance' : mode);
    await this.keepReplica();
  }

  /* The bundle of this machine's database that led goes to the keeper that leads, as it travels, with its length said
     first; the status that keeper answered. */
  private async putLed(id: string, bundle: { length: number; stream(): Readable }): Promise<number> {
    const body = bundle.stream();
    try {
      const answer = await this.worker.parts().link.stream('PUT', `${PEER_PATHS.led}${id}`, body, bundle.length);
      answer.body.destroy();
      return answer.status;
    } finally {
      body.destroy();
    }
  }

  /* What this machine holds goes to the keeper that leads, on a stream of its own, with its length said first. */
  private async put(id: string, file: string, length: number): Promise<number> {
    const body = createReadStream(file);
    try {
      const answer = await this.worker.parts().link.stream('PUT', `${PEER_PATHS.upload}${id}`, body, length);
      answer.body.destroy();
      return answer.status;
    } finally {
      body.destroy();
    }
  }

  /* The company's link as this machine's own database holds it, read anew every ten seconds: the watch over the
     leader asks hornhoof.org of it. A read that fails keeps the last one. */
  private async keepLink(): Promise<void> {
    const now = performance.now();
    if (this.linkAt !== null && now - this.linkAt < LINK_EVERY_MS) return;
    this.linkAt = now;
    const settings = await this.opts.settings().catch(() => undefined);
    if (settings !== undefined) this.linkNow = settings;
  }

  /* What this machine promised the leader for its update: a promise past its time goes, and a stop that a restart cut
     is finished. A failure is said once. */
  private async keepPromise(): Promise<void> {
    try {
      await this.updating.tick();
      this.updatingFails = false;
    } catch (err) {
      if (!this.updatingFails) this.opts.log(`The keeper could not keep its promise to wait for an update: ${reasonOf(err)}`);
      this.updatingFails = true;
    }
  }

  /* The question to the CEO as of now, while this copy asks one: the leader it watched, each copy that is up, and
     until when the CEO chose to wait. */
  private question(): Question | null {
    const leader = this.maker.leader();
    if (!this.asking || !leader) return null;
    const host = this.view?.data.find(machine => machine.networkId === leader)?.hostname || this.beating.last(leader)?.beat.host || '';
    const { since, heard } = this.asking;
    return makeQuestion({ since, leader: { networkId: leader, host }, heard, self: this.beat(), beats: this.beating.all(), now: this.clocks().mono, waiting: this.recovery.waiting() });
  }

  /* The app reads once the copy holds every table, and is off until then; it never leads on this keeper's word. With
     it goes the question to the CEO, while one stands. */
  private giveWord(mode: 'off' | 'read' | 'maintenance'): void {
    try {
      const question = this.question();
      /* A machine that does not reach hornhoof.org is cut off: its app tells the agents so. Said only where this
         keeper has a relay to ask. */
      const cut = this.asksRelay && this.watcher.relayUp() === false ? { internet: false } : {};
      writeKeeperState(this.opts.config.controlDir, { mode, at: new Date().toISOString(), link: null, ...cut, ...(question ? { question } : {}) });
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
