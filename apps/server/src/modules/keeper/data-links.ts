import { DbDoor, composeAllowed } from '../../net/db-door.js';
import { PeerSessions, type DialTarget, type PeerSessionsOptions } from '../../net/peer-sessions.js';
import { Server } from '../link/client.js';
import { TunnelKeeper, type Client, type TunnelSettings } from '../link/tunnel.js';
import { visitClientFor, VISIT_FIRST_PORT, type VisitSettings } from '../link/visit-client.js';
import type { HeldCertificate } from './certificate.js';
import type { Sql } from './lease-store.js';
import { reasonOf, type MachineKey } from './machine-keys.js';
import { ensurePublication, ensureReplica, replicaReady } from './replica.js';

const EVERY_MS = 1000;
const REPLICA_EVERY_MS = 60_000;
const FRPC_EVERY_MS = 3000;
const FRPC_RESTART_MS = 2000;
const ANY_ADDRESS = '0.0.0.0';
const VISIT_WORDS = { carrying: () => "Reaching the company's copies through hornhoof.org as well.", waiting: 'No copy to reach through hornhoof.org now.' };

type Closable = Sql & { close(): Promise<void> };
type Visit = { link: VisitSettings; targets: string[] };

/* What the app says of the other machines that keep data. doors: the network ids of the machines whose database a merge
   is to read. link: what reaches them through the relay, when the company has a link and the relay gave a visitor key. */
export type DataPeers = {
  machine: string | null;
  data: { machine: string; networkId: string; addresses: string[]; peerPort: number | null }[];
  doors: string[];
  link: { name: string; dataSecret?: string; visitorKey?: string } | null;
};

export type DataLinksOptions = {
  machineId: string;
  /* The keeper's own folder, for the visitor's config. */
  dir: string;
  held: () => HeldCertificate | null;
  key: () => MachineKey | null;
  /* The app's last answer; null before the first. */
  peers: () => DataPeers | null;
  revoked: () => ReadonlySet<string>;
  own: () => string[];
  /* The public link's settings now: null without a link, undefined when they could not be read. */
  settings: () => Promise<TunnelSettings | null | undefined>;
  leads: () => boolean;
  /* A new connection to this machine's database as its owner, and the password of the replica role. Null: the role and
     the publication are not this keeper's to keep, as where it has no database. */
  replica: { connect: () => Closable; password: string } | null;
  log: (line: string) => void;
  /* What dials the other data machines; made here unless a test gives one. */
  dial?: PeerSessions;
  sessions?: Partial<PeerSessionsOptions>;
  /* Where the doors listen, and who may use them. */
  doorHost?: string;
  allowed?: () => Promise<string[]>;
  everyMs?: number;
  replicaEveryMs?: number;
  visitClientFor?: (link: VisitSettings, machineId: string, targets: string[]) => Client;
  visitPort?: number;
};

/* What the keeper of the machine that leads keeps toward the machines that hold copies: a session to each one, direct
   or through the relay; a door to the database of each copy a merge is to read; and, in its own database, the role
   copies read with and the publication they follow. */
export class DataLinks {
  private dial: PeerSessions | null;
  private readonly doorsOpen = new Map<string, { door: DbDoor; port: number | null }>();
  private tunnel: TunnelKeeper<Visit> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private targets: DialTarget[] = [];
  private working: Promise<void> | null = null;
  private replicaAt: number | null = null;
  private replicaMade = false;
  private replicaFails = false;
  private stopped = false;

  constructor(private readonly opts: DataLinksOptions) {
    this.dial = opts.dial ?? null;
  }

  start(): void {
    this.tunnel = new TunnelKeeper<Visit>({ read: () => this.visit(), everyMs: FRPC_EVERY_MS, restartMs: FRPC_RESTART_MS, clientFor: visit => this.visitClient(visit), says: VISIT_WORDS, log: this.opts.log });
    this.tunnel.start();
    this.timer = setInterval(() => this.look(), this.opts.everyMs ?? EVERY_MS);
    this.timer.unref();
    this.look();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.working;
    await Promise.all([this.tunnel?.stop(), this.dial?.close(), ...[...this.doorsOpen.values()].map(open => open.door.close())]);
    this.doorsOpen.clear();
  }

  /* The doors that listen now, each by the network id of the machine whose database it leads to. */
  doors(): Record<string, number> {
    return Object.fromEntries([...this.doorsOpen].flatMap(([id, open]) => (open.port === null ? [] : [[id, open.port]])));
  }

  /* The addresses the other data machines saw this machine come from. */
  seen(): string[] {
    return this.dial?.seen() ?? [];
  }

  /* One look at a time: the sessions and the doors by the app's last answer, and the role and the publication. */
  private look(): void {
    if (this.working || this.stopped) return;
    this.working = this.lookOnce().finally(() => { this.working = null; });
  }

  private async lookOnce(): Promise<void> {
    const peers = this.opts.peers();
    if (peers) {
      this.follow(peers);
      await this.keepDoors(peers.doors);
    }
    await this.keepReplica();
  }

  /* The other data machines, each with the loopback port the visitor opens to it while there is a way through the
     relay. The dialer is made once the machine has its key. */
  private follow(peers: DataPeers): void {
    const first = this.opts.visitPort ?? VISIT_FIRST_PORT;
    const through = Boolean(peers.link?.dataSecret && peers.link.visitorKey);
    this.targets = peers.data
      .filter(machine => machine.machine !== peers.machine && machine.networkId !== this.opts.machineId)
      .map((machine, at) => ({ machine: machine.machine, networkId: machine.networkId, addresses: machine.addresses, peerPort: machine.peerPort, relayPort: through ? first + at : null }));
    const key = this.opts.key();
    if (!this.dial && key) this.dial = new PeerSessions({ held: this.opts.held, key, revoked: this.opts.revoked, own: this.opts.own, log: this.opts.log, ...this.opts.sessions });
    this.dial?.use(this.targets);
  }

  /* One door for each machine the app names, and none for a machine it names no more. */
  private async keepDoors(wanted: string[]): Promise<void> {
    for (const [id, open] of this.doorsOpen) {
      if (wanted.includes(id)) continue;
      this.doorsOpen.delete(id);
      await open.door.close();
    }
    for (const id of wanted) {
      if (this.doorsOpen.has(id)) continue;
      const door = new DbDoor({ connect: () => this.connectDb(id), allowed: this.opts.allowed ?? composeAllowed(), log: this.opts.log, host: this.opts.doorHost ?? ANY_ADDRESS });
      const open = { door, port: null as number | null };
      this.doorsOpen.set(id, open);
      try {
        open.port = await door.listen(0);
      } catch (err) {
        this.doorsOpen.delete(id);
        this.opts.log(`Could not open a door to another machine's database: ${reasonOf(err)}`);
      }
    }
  }

  private connectDb(networkId: string) {
    const target = this.targets.find(found => found.networkId === networkId);
    if (!this.dial || !target) return Promise.reject(new Error('the machine is not among those that keep data'));
    return this.dial.connectDb(target.machine);
  }

  /* While this machine leads: the role and the publication at its first lead, and after that the role again whenever a
     look, one a minute, finds it gone or without its rights. A failure is said once, and the next minute tries again. */
  private async keepReplica(): Promise<void> {
    const { replica } = this.opts;
    if (!replica || !this.opts.leads()) return;
    const now = performance.now();
    if (this.replicaAt !== null && now - this.replicaAt < (this.opts.replicaEveryMs ?? REPLICA_EVERY_MS)) return;
    this.replicaAt = now;
    const sql = replica.connect();
    try {
      if (!this.replicaMade || !(await replicaReady(sql))) await ensureReplica(replica.connect, replica.password);
      await ensurePublication(sql);
      this.replicaMade = true;
      this.replicaFails = false;
    } catch (err) {
      if (!this.replicaFails) this.opts.log(`Could not prepare the database for the machines that keep copies: ${reasonOf(err)}`);
      this.replicaFails = true;
    } finally {
      await sql.close().catch(() => undefined);
    }
  }

  /* The visitor frpc's settings: none without a link, its secrets or anyone to reach, and not known before the app's
     first answer or while the link's settings cannot be read. */
  private async visit(): Promise<Visit | null | undefined> {
    const peers = this.opts.peers();
    if (!peers) return undefined;
    const { link } = peers;
    if (!link?.dataSecret || !link.visitorKey || this.targets.length === 0) return null;
    const settings = await this.opts.settings();
    if (settings === undefined) return undefined;
    const server = Server.safeParse(settings?.tunnel);
    if (!settings || !server.success) return null;
    const { serverAddr, serverPort } = server.data;
    /* The app's secret is not this visitor's to use: it reaches only the way to the data. */
    return { link: { name: link.name, serverAddr, serverPort, visitorKey: link.visitorKey, appSecret: '', dataSecret: link.dataSecret }, targets: this.targets.map(target => target.networkId) };
  }

  private visitClient({ link, targets }: Visit): Client {
    const { machineId, dir } = this.opts;
    return this.opts.visitClientFor?.(link, machineId, targets) ?? visitClientFor(link, { machineId, targets, dir, kind: 'data' });
  }
}
