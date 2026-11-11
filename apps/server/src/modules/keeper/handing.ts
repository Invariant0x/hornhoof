import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Term } from '../../db/net.js';
import { claimMove } from '../copies/move.js';
import type { SyncRecord } from '../link/relay.js';
import { REPLICA_FILE } from './become.js';
import { COPY_STATE } from './copy.js';
import type { Sql } from './lease-store.js';
import { reasonOf, writePrivately } from './machine-keys.js';
import { dropSlots, markHanded } from './promote.js';
import { HANDING_FILE } from './role.js';
import { seedView } from './seed-view.js';
import { nextHandStep, OFFER_WAIT_MS, SWITCH_MS, type HandAction, type Handing, type HandSample, type MoveReason, type TakeState } from './switch-step.js';
import type { CopyView } from './sync.js';
import { SWITCH_PATH } from './taking.js';
import { PEERS_FILE } from './worker.js';

export { HANDING_FILE } from './role.js';

/* How the machine that leads hands the server to the machine the CEO named: once that machine's copy is the one
   commits wait for, it offers the switch, stops writing, tells the target where its log ended, and follows the target
   once that one says it leads. Until it sent go it may call the switch off by itself; after that only the target's
   word counts. */

const EVERY_MS = 250;
const GO_EVERY_MS = 1000;
const GO_WAIT_MS = 1000;
const WAITING_SAID_MS = 60_000;
const FOLLOW_DB = 'hornhoof';

const TermShape = z.object({ number: z.number().int(), machine: z.string(), split: z.boolean() });
const HandingShape = z.object({
  switch: z.uuid(),
  to: z.object({ machine: z.string(), networkId: z.string(), hostname: z.string() }),
  term: TermShape,
  at: z.number(),
  deadline: z.number(),
  phase: z.enum(['offered', 'stopped', 'go', 'followed', 'aborted']),
  fenced: z.boolean(),
  w: z.string().nullable(),
  copies: z.array(z.string()).nullable(),
  slot: z.string().nullable(),
  reason: z.enum(['no_answer', 'not_ready', 'behind', 'no_link', 'expired', 'left']).nullable(),
});
const TakeStateShape = z.union([
  z.object({ state: z.literal('none') }),
  z.object({ state: z.enum(['offered', 'go']), switch: z.string() }),
  z.object({ state: z.literal('leading'), switch: z.string(), term: TermShape, slots: z.record(z.string(), z.string()) }),
  z.object({ state: z.literal('aborted'), switch: z.string(), follow: TermShape, why: z.literal('no_link').nullable() }),
]);

/* What this keeper wrote down of a switch it hands the server over in; null when there is none, or none it can read. */
export function readHanding(dir: string, log?: (line: string) => void): Handing | null {
  let text: string;
  try {
    text = readFileSync(join(dir, HANDING_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log?.(`The keeper could not read what it wrote down of handing the server over: ${reasonOf(err)}`);
    return null;
  }
  try {
    return HandingShape.parse(JSON.parse(text));
  } catch (err) {
    log?.(`The keeper could not read what it wrote down of handing the server over: ${reasonOf(err)}`);
    return null;
  }
}

/* Written whole and then moved, so a keeper that starts again never reads half of it. */
export function writeHanding(dir: string, handing: Handing): void {
  writePrivately(join(dir, HANDING_FILE), JSON.stringify(handing));
}

/* Why the server stayed, as the keeper's log says it. */
function staysBecause(reason: MoveReason, host: string): string {
  if (reason === 'not_ready') return `${host} was not ready to take it`;
  if (reason === 'behind') return `${host} did not hold everything this machine wrote in time`;
  if (reason === 'no_link') return `hornhoof.org did not give ${host} the company's name in time`;
  if (reason === 'expired') return `the copy on ${host} was not up to date within a day`;
  if (reason === 'left') return `${host} cannot take the server any more`;
  return `${host} did not answer`;
}

export type HanderOptions = {
  /* The keeper's own folder, and the control folder it shares with the updater. */
  dir: string;
  controlDir: string;
  sql: Sql;
  /* The company's secret, which opens what the view of the network holds sealed. */
  secret: Buffer;
  lease: { fence(): Promise<void> };
  /* The term this machine leads under, while it does. */
  term: () => Term | null;
  sync: { named(): string | null; record(): SyncRecord | null; generation(): number | null; copies(): CopyView[] };
  /* The keeper of a data machine, by its network id, on this keeper's session to it; none when nothing whole came back. */
  peer: (networkId: string) => { request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; body: unknown } | null> };
  front: { close(): Promise<void>; open(): void };
  tunnel: { start(): void; stop(): Promise<void> };
  leads: () => boolean;
  updating: () => boolean;
  machine: { networkId: string };
  /* Ends this keeper, so that it starts again as one that follows. */
  exit: () => void;
  /* Where this database's log ends, and its slots with whether each is read now and holds that position; the
     database's own unless a test says otherwise. */
  wal?: { position(): Promise<string>; slots(w: string): Promise<{ name: string; read: boolean; atW: boolean }[]> };
  now?: () => number;
  log: (line: string) => void;
  everyMs?: number;
};

type Move = { request: string; machine: string; networkId: string | null; hostname: string; state: 'preparing' | 'switching' | 'failed'; askedAt: number; endedAt: number | null; numbered: boolean; data: boolean; live: boolean };

export class Hander {
  private timer: NodeJS.Timeout | null = null;
  private working: Promise<void> | null = null;
  private stopped = false;
  /* It followed, and its keeper ends: nothing more is looked at. */
  private done = false;
  private failing = false;
  private offer: HandSample['offer'] = null;
  private wConfirmedAt: number | null = null;
  private state: TakeState | null = null;
  private goAt = -Infinity;
  private waitingSaidAt: number | null = null;
  private unfindableSaid = false;
  private phase: Handing['phase'] | null;

  constructor(private readonly opts: HanderOptions) {
    this.phase = readHanding(opts.dir, opts.log)?.phase ?? null;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    await this.look();
    this.timer = setInterval(() => void this.look(), this.opts.everyMs ?? EVERY_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.working;
  }

  /* From the moment it stopped until it follows or leads again: this keeper takes no lease, says in its hello that it
     does not lead, and keeps its front door shut and its link's client stopped. */
  holds(): boolean {
    return this.phase === 'stopped' || this.phase === 'go' || this.phase === 'followed';
  }

  /* One look at a time; a look that fails changes nothing, and is said once an outage. */
  look(): Promise<void> {
    if (this.stopped || this.done) return Promise.resolve();
    this.working ??= this.lookOnce()
      .then(
        () => void (this.failing = false),
        (err: unknown) => {
          if (!this.failing) this.opts.log(`The keeper could not go on handing the server over: ${reasonOf(err)}`);
          this.failing = true;
        },
      )
      .finally(() => void (this.working = null));
    return this.working;
  }

  private keep(handing: Handing): Handing {
    writeHanding(this.opts.dir, handing);
    this.phase = handing.phase;
    return handing;
  }

  private forget(): void {
    rmSync(join(this.opts.dir, HANDING_FILE), { force: true });
    this.phase = null;
  }

  private async lookOnce(): Promise<void> {
    const handing = readHanding(this.opts.dir, this.opts.log);
    this.phase = handing?.phase ?? null;
    const move = handing ? null : await this.move();
    const sample = await this.sample(handing, move);
    await this.act(nextHandStep(sample), handing, move);
  }

  /* The CEO's request as this database holds it, with its target's row. */
  private async move(): Promise<Move | null> {
    const [row] = (
      await this.opts.sql.query<{ request: string; machine: string; networkId: string | null; hostname: string; state: Move['state']; askedAt: Date | string; endedAt: Date | string | null; numbered: boolean; data: boolean; live: boolean }>(
        `SELECT v.request::text AS request, v.machine_id::text AS machine, m.network_id AS "networkId", m.hostname, v.state, v.asked_at AS "askedAt", v.ended_at AS "endedAt",
                m.server_order IS NOT NULL AS numbered, m.role IS NOT DISTINCT FROM 'data' AS data, m.revoked_at IS NULL AS live
           FROM net.move v JOIN public.machines m ON m.id = v.machine_id`,
      )
    ).rows;
    return row ? { ...row, askedAt: new Date(row.askedAt).getTime(), endedAt: row.endedAt === null ? null : new Date(row.endedAt).getTime() } : null;
  }

  private async sample(handing: Handing | null, move: Move | null): Promise<HandSample> {
    const { sync } = this.opts;
    const now = this.now();
    const target = move?.live && move.networkId ? move.networkId : null;
    const record = sync.record();
    const copy = target ? sync.copies().find(one => one.networkId === target) : undefined;
    const others = handing?.phase === 'stopped' && handing.w !== null ? await this.copiesAt(handing, handing.w, now) : { atW: [], online: [] };
    return {
      now, handing,
      move: move ? { request: move.request, networkId: move.networkId ?? '', state: move.state, askedAt: move.askedAt, endedAt: move.endedAt } : null,
      target: move && target
        ? {
            numbered: move.numbered, data: move.data, named: sync.named() === target,
            onStored: record?.state === 'on' && record.copy === target && record.generation === sync.generation(),
            pace: copy?.state === 'sync' || copy?.state === 'pace',
          }
        : null,
      leads: this.opts.leads(), updating: this.opts.updating(), offer: this.offer,
      wConfirmedAt: this.wConfirmedAt, othersAtW: others.atW, othersOnline: others.online, state: this.state,
    };
  }

  /* Which copies hold where this machine's log ended: the target's slot, remembered from the first look that saw it
     there, and the other copies that are ready and read now. One that still makes its first copy is none of them. */
  private async copiesAt(handing: Handing, w: string, now: number): Promise<{ atW: string[]; online: string[] }> {
    const wal = this.opts.wal ?? this.ownWal();
    const slots = await wal.slots(w);
    const { rows } = await this.opts.sql.query<{ networkId: string; copyName: string | null; ready: boolean }>(
      `SELECT network_id AS "networkId", copy_name AS "copyName", copy_state IS NOT DISTINCT FROM 'ready' AS ready
         FROM public.machines WHERE role = 'data' AND revoked_at IS NULL AND network_id IS NOT NULL AND network_id <> $1`,
      [this.opts.machine.networkId],
    );
    const slotOf = (row: { copyName: string | null }) => slots.find(slot => slot.name === row.copyName);
    const target = rows.find(row => row.networkId === handing.to.networkId);
    if (target && slotOf(target)?.atW) this.wConfirmedAt ??= now;
    const others = rows.filter(row => row.networkId !== handing.to.networkId && row.ready && slotOf(row)?.read);
    return { online: others.map(row => row.networkId), atW: others.filter(row => slotOf(row)?.atW).map(row => row.networkId) };
  }

  private ownWal(): NonNullable<HanderOptions['wal']> {
    const { sql } = this.opts;
    return {
      position: async () => (await sql.query<{ lsn: string }>('SELECT pg_current_wal_lsn()::text AS lsn')).rows[0]!.lsn,
      slots: async w =>
        (await sql.query<{ name: string; read: boolean; atW: boolean }>(
          'SELECT slot_name::text AS name, active_pid IS NOT NULL AS read, COALESCE(confirmed_flush_lsn >= $1::pg_lsn, false) AS "atW" FROM pg_replication_slots WHERE database = current_database()', [w])).rows,
    };
  }

  private async act(action: HandAction, handing: Handing | null, move: Move | null): Promise<void> {
    if (action.do === 'none') return;
    if (action.do === 'offer') return move ? this.offerTo(move) : undefined;
    if (action.do === 'fail') return this.fail(action.reason, handing, move);
    if (action.do === 'forget') return void (await this.opts.sql.query(`DELETE FROM net.move WHERE state = 'failed'`));
    if (!handing) return;
    if (action.do === 'stop') return this.fence(this.keep({ ...handing, phase: 'stopped', fenced: false }));
    if (action.do === 'fence') return this.fence(handing);
    if (action.do === 'read_w') return void this.keep({ ...handing, w: await (this.opts.wal ?? this.ownWal()).position() });
    if (action.do === 'go') return this.go(this.keep({ ...handing, phase: 'go', copies: action.copies }));
    if (action.do === 'send_go') return this.sendGo(handing);
    if (action.do === 'ask') return this.ask(handing);
    if (action.do === 'follow') return this.follow(this.keep({ ...handing, phase: 'followed', slot: action.slot }));
    if (action.do === 'abort') await this.request(handing, 'POST', 'abort', { switch: handing.switch }, GO_WAIT_MS);
    this.reenter(handing, action.reason);
  }

  private request(handing: Handing, method: 'GET' | 'POST', name: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; body: unknown } | null> {
    return this.opts.peer(handing.to.networkId).request(method, `${SWITCH_PATH}${name}`, body, timeoutMs).catch(() => null);
  }

  /* The request is claimed as the one this look saw; one the CEO replaced or took off meanwhile is not, and the next
     look sees what is there then. Then the switch is written down, and the offer goes. */
  private async offerTo(move: Move): Promise<void> {
    const term = this.opts.term();
    if (!term || !move.networkId) return;
    /* As one that follows, this machine finds the new leader by the company's link, with the keys its database holds
       of it: without them it offers nothing. */
    const findable = (await seedView(this.opts.sql, this.opts.machine.networkId, this.opts.secret)).link !== null;
    if (!findable && !this.unfindableSaid) this.opts.log("The server does not move yet: this machine does not hold the company's link with its keys, which it would find the new server by.");
    this.unfindableSaid = !findable;
    if (!findable || !(await claimMove(this.opts.sql, move.request))) return;
    const at = this.now();
    const handing = this.keep({
      switch: move.request, to: { machine: move.machine, networkId: move.networkId, hostname: move.hostname }, term, at, deadline: at + SWITCH_MS,
      phase: 'offered', fenced: false, w: null, copies: null, slot: null, reason: null,
    });
    this.opts.log(`Handing the server over to ${move.hostname || 'another machine'}.`);
    this.offer = 'waiting';
    const answer = await this.request(handing, 'POST', 'offer', { switch: handing.switch, term, deadline: handing.deadline }, OFFER_WAIT_MS);
    this.offer = answer?.status === 200 ? 'accepted' : answer ? 'refused' : 'silent';
  }

  /* The front door first, so nothing new comes in; then the lease ends, and with it the sessions that write. Written
     down only once both are done: a keeper that starts again before that does them again. */
  private async fence(handing: Handing): Promise<void> {
    await this.opts.front.close();
    await this.opts.lease.fence();
    this.keep({ ...handing, fenced: true });
  }

  /* The go carries where the log ended and which copies hold it. Its answer is not needed: the target's state is
     asked from here on. The link's client stops, so the target can take the company's name. */
  private async go(handing: Handing): Promise<void> {
    this.goAt = this.now();
    this.waitingSaidAt = this.goAt;
    this.state = null;
    const sent = this.request(handing, 'POST', 'go', { switch: handing.switch, w: handing.w, copies: handing.copies ?? [] }, GO_WAIT_MS);
    await this.opts.tunnel.stop();
    await sent;
  }

  /* The same go again, to a target that still holds only the offer; once a second at most. */
  private async sendGo(handing: Handing): Promise<void> {
    const now = this.now();
    if (now - this.goAt < GO_EVERY_MS) return;
    this.goAt = now;
    this.state = null;
    await this.request(handing, 'POST', 'go', { switch: handing.switch, w: handing.w, copies: handing.copies ?? [] }, GO_WAIT_MS);
  }

  private async ask(handing: Handing): Promise<void> {
    const answer = await this.request(handing, 'GET', `state?switch=${handing.switch}`);
    const state = answer?.status === 200 ? TakeStateShape.safeParse(answer.body) : null;
    this.state = state?.success ? state.data : null;
    const now = this.now();
    this.waitingSaidAt ??= now;
    if (this.state) this.waitingSaidAt = now;
    else if (now - this.waitingSaidAt >= WAITING_SAID_MS) {
      this.waitingSaidAt = now;
      this.opts.log(`Waiting for ${handing.to.hostname || 'the other machine'} to say whether it took the server.`);
    }
  }

  /* The target leads. This database's time as the leader is marked ended where its log ended, its slots go, and its
     keeper is left what one that follows starts on: the view of the network from its own database, the slot the new
     leader made for it, and the marker of a machine that keeps a copy. Then this keeper ends. */
  private async follow(handing: Handing): Promise<void> {
    const { opts } = this;
    if (!handing.slot || handing.w === null) throw new Error('what it wrote down names no slot to follow by');
    await markHanded(opts.sql, { to: handing.to.networkId, lsn: handing.w, at: new Date(this.now()) });
    await dropSlots(opts.sql);
    writePrivately(join(opts.dir, PEERS_FILE), JSON.stringify(await seedView(opts.sql, opts.machine.networkId, opts.secret)));
    writePrivately(join(opts.dir, COPY_STATE), JSON.stringify({ attempt: Number(/_(\d+)$/.exec(handing.slot)?.[1] ?? 1), database: FOLLOW_DB, phase: 'join', slot: handing.slot, leader: handing.to.networkId }));
    const marker = join(opts.controlDir, REPLICA_FILE);
    writeFileSync(`${marker}.${process.pid}.tmp`, JSON.stringify({ since: new Date(this.now()).toISOString() }));
    chmodSync(`${marker}.${process.pid}.tmp`, 0o644);
    renameSync(`${marker}.${process.pid}.tmp`, marker);
    this.forget();
    this.done = true;
    opts.log(`${handing.to.hostname || 'The other machine'} leads now; this machine keeps a copy.`);
    opts.exit();
  }

  /* The server stays here: written down with the reason, the front door opens, and the link's client starts again.
     The keeper takes its next term by itself, and the request is marked once it leads. */
  private reenter(handing: Handing, reason: MoveReason): void {
    this.keep({ ...handing, phase: 'aborted', reason });
    this.offer = null;
    this.wConfirmedAt = null;
    this.state = null;
    this.opts.front.open();
    this.opts.tunnel.start();
    this.opts.log(`The server stays here: ${staysBecause(reason, handing.to.hostname || 'the other machine')}.`);
  }

  /* The request says why the server did not move, for the CEO to read; what was written down of the switch goes. */
  private async fail(reason: MoveReason, handing: Handing | null, move: Move | null): Promise<void> {
    const request = handing?.switch ?? move?.request;
    if (request) {
      await this.opts.sql.query(`UPDATE net.move SET state = 'failed', reason = $2, ended_at = to_timestamp($3::float8 / 1000) WHERE request = $1::uuid AND state <> 'failed'`, [request, reason, this.now()]);
    }
    if (handing) this.forget();
  }
}
