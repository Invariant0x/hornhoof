import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { REPLICA_FILE } from './become.js';
import { COPY_STATE, copyName } from './copy.js';
import type { Sql } from './lease-store.js';
import { reasonOf, writePrivately } from './machine-keys.js';
import { IDLE_MS, Looks } from './looks.js';
import { ident, TermShape } from './sql-words.js';
import { NoteUnreadable, readNote } from './notes.js';
import { applyRunning, dropSubscriptions, handoverOf, makeSlots, raiseSequences, recordHandover, termOf, waitForNoCopy, writeTerm } from './promote.js';
import { ensurePublication } from './replica.js';
import { nextTakeStep, SWITCH_MS, takeState, type Taking, type TakeState } from './switch-step.js';

/* How the machine a planned switch moves the server to takes it over: its follow keeper answers the keeper that hands
   over, and once that one said go, the machine's keeper starts again as a leading keeper that takes no lease until it
   holds the company's name at hornhoof.org, proved it by a nonce of its own, and promoted its database. */

export const TAKING_FILE = 'taking.json';
export const SWITCH_PATH = '/peer/switch/';
const EVERY_MS = 250;
const PROBE_EVERY_MS = 1000;

const TakingShape = z.object({
  switch: z.uuid(),
  from: z.object({ networkId: z.string(), hostname: z.string().optional() }),
  term: TermShape,
  at: z.number(),
  deadline: z.number(),
  phase: z.enum(['offered', 'go', 'promoted', 'aborted']),
  w: z.string().nullable(),
  copies: z.array(z.string()).nullable(),
  slots: z.record(z.string(), z.string()).nullable(),
  why: z.literal('no_link').nullable(),
  kind: z.enum(['planned', 'takeover', 'ceo']).optional(),
  heard: z.number().nullable().optional(),
  reach: z.string().nullable().optional(),
  full: z.boolean().optional(),
  generation: z.number().int().min(0).optional(),
});

const LSN = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/;
const NETWORK_ID = /^[0-9a-f]{32}([0-9a-f]{32})?$/;
const Offer = z.object({ switch: z.uuid(), term: TermShape, deadline: z.number() });
const Go = z.object({ switch: z.uuid(), w: z.string().regex(LSN), copies: z.array(z.string().regex(NETWORK_ID)).max(64) });
const Abort = z.object({ switch: z.uuid() });

/* What this keeper wrote down of a switch it takes part in as the target; null when there is none. A note that is
   there and cannot be read is no word that there is none: this throws, and whoever asked decides nothing on it. */
export function readTaking(dir: string): Taking | null {
  return readNote(join(dir, TAKING_FILE), TakingShape, 'taking the server over');
}

/* Written whole and then moved, so a keeper that starts again never reads half of it. */
export function writeTaking(dir: string, taking: Taking): void {
  writePrivately(join(dir, TAKING_FILE), JSON.stringify(taking));
}

function forgetTaking(dir: string): void {
  rmSync(join(dir, TAKING_FILE), { force: true });
}

/* This machine's subscription to the machine that leads, as far as a switch asks of it. applying: it is enabled and
   its apply worker runs. */
export type OwnSubscription = { enabled(): Promise<boolean>; applying(): Promise<boolean>; disable(): Promise<void>; enable(): Promise<void> };

/* The subscription of a real Postgres, by the name the copy's maker gave it; with no name there is none. */
export function pgSubscription(sql: Sql, name: () => Promise<string | null>): OwnSubscription {
  const enabled = async (): Promise<boolean> => {
    const { rows } = await sql.query<{ enabled: boolean }>(
      'SELECT s.subenabled AS enabled FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = current_database() AND s.subname = $1', [await name()]);
    return rows[0]?.enabled === true;
  };
  const set = async (word: 'ENABLE' | 'DISABLE'): Promise<void> => {
    const subscription = await name();
    if (subscription && (await enabled()) !== (word === 'ENABLE')) await sql.query(`ALTER SUBSCRIPTION ${ident(subscription)} ${word}`);
  };
  return {
    enabled,
    applying: async () => {
      const subscription = await name();
      return subscription !== null && (await applyRunning(sql, subscription));
    },
    disable: () => set('DISABLE'),
    enable: () => set('ENABLE'),
  };
}

const PROBE_MS = 5000;
const Proof = z.object({ machine: z.string(), nonce: z.string() });

/* Asks through the company's public name who holds the lease there, with this nonce: what the keeper that answers
   says, or nothing when none does in five seconds. base: the link's address, https://<host>. */
export async function probeLink(base: string, nonce: string): Promise<{ machine: string; nonce: string } | null> {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/network/lease?nonce=${encodeURIComponent(nonce)}`, { signal: AbortSignal.timeout(PROBE_MS), redirect: 'error', headers: { 'cache-control': 'no-store' } });
    if (res.status !== 200) return null;
    const proof = Proof.safeParse(await res.json());
    return proof.success ? proof.data : null;
  } catch {
    return null;
  }
}

/* after: what is done once the answer has gone out. */
type SwitchAnswer = { status: number; body: object; after?: () => void };

const refused = (status: 403 | 404 | 409, why?: string): SwitchAnswer => ({ status, body: { ok: false, ...(why ? { why } : {}) } });
const OK: SwitchAnswer = { status: 200, body: { ok: true } };

type Asked = { name: 'offer' | 'go' | 'abort'; body: unknown } | { name: 'state'; switch: string };

/* Which of the switch's paths a request names; null for none of them. */
function asked(method: string, path: string, body: unknown): Asked | null {
  if (!path.startsWith(SWITCH_PATH)) return null;
  const [name, query = ''] = path.slice(SWITCH_PATH.length).split('?', 2);
  if (method === 'POST' && (name === 'offer' || name === 'go' || name === 'abort')) return { name, body };
  const id = new URLSearchParams(query).get('switch') ?? '';
  return method === 'GET' && name === 'state' && z.uuid().safeParse(id).success ? { name: 'state', switch: id } : null;
}

type Paths = {
  dir: string;
  sql: Sql;
  subscription: OwnSubscription;
  now: () => number;
  log: (line: string) => void;
};

/* What the target answers of a switch: from what it wrote down while that is of this switch, else from the handover
   it recorded. Only the machine that offered is answered; with nothing written down, the machine the handover names
   as the leader before, so a new leader of any kind tells an old one that comes back late that it leads. */
async function stateOf(p: Paths, from: string, id: string): Promise<SwitchAnswer> {
  const mine = readTaking(p.dir);
  const taking = mine?.switch === id ? mine : null;
  const handover = await handoverOf(p.sql, id);
  if (taking ? taking.from.networkId !== from : handover !== null && handover.term.machine !== from) return refused(403);
  const state: TakeState = takeState(taking, handover ? { switch: id, term: handover.term, slots: handover.slots } : null);
  return { status: 200, body: state };
}

/* What the target answers of this switch: that it leads once it recorded the handover, else how far it is. */
async function saidOf(sql: Sql, taking: Taking): Promise<TakeState> {
  const handover = await handoverOf(sql, taking.switch);
  return takeState(taking, handover ? { switch: taking.switch, term: handover.term, slots: handover.slots } : null);
}

/* The switch is given up while this machine wrote no term: what it wrote down says so, with the term the old leader
   leads again under, and its subscription follows again. Once its term is written nothing takes the server back. */
async function abortNow(p: Paths, taking: Taking, termWritten: boolean, why: Taking['why']): Promise<TakeState> {
  if (!termWritten && taking.phase !== 'aborted' && taking.phase !== 'promoted') {
    taking = { ...taking, phase: 'aborted', at: p.now(), why };
    writeTaking(p.dir, taking);
    await p.subscription.enable();
  }
  return saidOf(p.sql, taking);
}

/* The term of this attempt, when this machine wrote it: its own, above the old leader's, and of no handed-over time. */
async function ownTerm(sql: Sql, taking: Taking, machine: string): Promise<boolean> {
  const term = await termOf(sql);
  return term !== null && term.machine === machine && term.handedLsn === null && term.number > taking.term.number;
}

export type TakerOptions = {
  /* The keeper's own folder. */
  dir: string;
  sql: Sql;
  /* The machine this keeper's link names as the leader now, by its network id, with the name it goes by. */
  leader: () => { networkId: string; hostname: string } | null;
  /* Whether this machine's copy holds every table. */
  copyReady: () => boolean;
  subscription: OwnSubscription;
  /* Ends this keeper, so that it starts again as the one that takes the server over. */
  exit: () => void;
  now?: () => number;
  log: (line: string) => void;
};

/* In the follow keeper of the machine the server moves to: it answers the keeper that hands the server over. An offer
   is taken only from the machine its link names as the leader, and only while its copy is ready and follows; the go
   only from the machine that offered, before the deadline and while its apply worker runs. With the go written down
   and its subscription stopped, the keeper ends and starts again as the one that takes over. The deadline is counted
   on this machine's own clock from the moment the offer came, so two clocks that differ change nothing. */
export class Taker {
  /* This keeper was told to end, once. */
  private ended = false;

  constructor(private readonly opts: TakerOptions) {}

  /* The keeper ends, to start again as the one that takes the server; however often this is asked, it ends once. */
  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.opts.exit();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private paths(): Paths {
    return { dir: this.opts.dir, sql: this.opts.sql, subscription: this.opts.subscription, now: () => this.now(), log: this.opts.log };
  }

  /* from: the network id of the machine that asks, as its certificate names its row. */
  async handle(from: string, method: string, path: string, body: unknown): Promise<SwitchAnswer> {
    const what = asked(method, path, body);
    if (!what) return refused(404);
    if (what.name === 'state') return stateOf(this.paths(), from, what.switch);
    if (what.name === 'offer') return this.offer(from, what.body);
    if (what.name === 'go') return this.go(from, what.body);
    return this.abort(from, what.body);
  }

  /* Each second: an offer nobody followed ends at its deadline, and a switch that was given up is forgotten in time.
     A go that was taken ends this keeper also when the answer to it never went out, or its subscription could not be
     stopped then: the go is written down, so whatever was left of it is done here. */
  async tick(): Promise<void> {
    const taking = readTaking(this.opts.dir);
    if (taking?.phase === 'go') {
      if (await this.opts.subscription.enabled()) await this.opts.subscription.disable();
      return this.end();
    }
    const step = nextTakeStep({ now: this.now(), taking, termWritten: false, registered: false, probed: false, appLeads: false });
    if (step.do === 'expire' || step.do === 'forget') forgetTaking(this.opts.dir);
  }

  /* Whether an offer of a planned switch stands, which no go followed yet. */
  offered(): boolean {
    try {
      return readTaking(this.opts.dir)?.phase === 'offered';
    } catch (err) {
      if (err instanceof NoteUnreadable) return true;
      throw err;
    }
  }

  /* The copy decided to take the server over and wrote that down: its subscription stops, and the keeper ends. */
  async takenOver(): Promise<void> {
    if (await this.opts.subscription.enabled()) await this.opts.subscription.disable();
    this.end();
  }

  /* Whether a go was taken, and this keeper is to end: its subscription stays stopped from then on. A note that
     cannot be read counts as one, so nothing starts the subscription again on it. */
  going(): boolean {
    try {
      return readTaking(this.opts.dir)?.phase === 'go';
    } catch (err) {
      if (err instanceof NoteUnreadable) return true;
      throw err;
    }
  }

  private async offer(from: string, body: unknown): Promise<SwitchAnswer> {
    const offer = Offer.safeParse(body);
    const leader = this.opts.leader();
    if (!leader || leader.networkId !== from) return refused(403);
    if (!offer.success) return refused(409, 'not_ready');
    const taking = readTaking(this.opts.dir);
    if (taking && taking.phase !== 'aborted') {
      return taking.switch === offer.data.switch && taking.phase === 'offered' && taking.from.networkId === from ? OK : refused(409, 'not_ready');
    }
    if (!this.opts.copyReady() || !(await this.opts.subscription.enabled())) return refused(409, 'not_ready');
    const at = this.now();
    writeTaking(this.opts.dir, {
      switch: offer.data.switch, from: { networkId: from, hostname: leader.hostname }, term: offer.data.term, at, deadline: at + SWITCH_MS,
      phase: 'offered', w: null, copies: null, slots: null, why: null,
    });
    return OK;
  }

  private async go(from: string, body: unknown): Promise<SwitchAnswer> {
    const go = Go.safeParse(body);
    const taking = readTaking(this.opts.dir);
    if (!taking || taking.from.networkId !== from) return refused(403);
    if (!go.success || taking.switch !== go.data.switch) return refused(409);
    if (taking.phase === 'go') return OK;
    if (taking.phase !== 'offered' || this.now() >= taking.deadline) return refused(409);
    if (!(await this.opts.subscription.applying())) return refused(409);
    writeTaking(this.opts.dir, { ...taking, phase: 'go', w: go.data.w, copies: go.data.copies });
    await this.opts.subscription.disable();
    this.opts.log(`Taking the server over from ${taking.from.hostname || 'the machine that led'}.`);
    return { ...OK, after: () => this.end() };
  }

  private async abort(from: string, body: unknown): Promise<SwitchAnswer> {
    const abort = Abort.safeParse(body);
    const taking = readTaking(this.opts.dir);
    if (!taking || taking.from.networkId !== from) return refused(403);
    if (!abort.success || taking.switch !== abort.data.switch) return refused(409);
    /* A follow keeper writes no term: the machine that takes over does, once it started again. */
    return { status: 200, body: await abortNow(this.paths(), taking, false, null) };
  }
}

export type PromoterOptions = {
  /* The keeper's own folder, and the control folder it shares with the updater. */
  dir: string;
  controlDir: string;
  sql: Sql;
  /* The id this machine's keeper runs under. */
  machine: { networkId: string };
  /* Whether hornhoof.org names this keeper's own link client for the company's name now. */
  registered: () => Promise<boolean>;
  /* The company's name at hornhoof.org as it stands now: held or free, whether its last registration was this
     keeper's own client's, and at which generation; null when it cannot be told. A keeper that took over by itself
     goes by it: its own registration counts only at the generation right after the one its window saw free. */
  name?: () => Promise<{ state: 'held' | 'empty'; mine: boolean; generation: number } | null>;
  /* A request through the company's link for the proof of the lease, with a nonce of this keeper's. */
  probe: (nonce: string) => Promise<{ machine: string; nonce: string } | null>;
  tunnel: { start(): void; stop(): Promise<void> };
  subscription: OwnSubscription;
  appLeads: () => boolean;
  exit: () => void;
  /* The promotion, answering the slot made for each machine; the steps below unless a test says otherwise. */
  promote?: (taking: Taking) => Promise<Record<string, string>>;
  now?: () => number;
  log: (line: string) => void;
  everyMs?: number;
  /* How often it looks once nothing of a switch is left to do. */
  idleMs?: number;
};

/* In a leading keeper that is taking the server over. Until it promoted, the keeper takes no lease. It starts its
   link's client, waits until hornhoof.org names that client for the company's name, sends a nonce of its own through
   the link and takes only its own answer for proof that the name leads to this machine; then it promotes its database.
   When the name does not come before the deadline it gives the server back: the old leader leads again. Once its term
   is written there is no way back, and it promotes whatever the time. */
export class Promoter {
  private readonly looks = new Looks(() => this.look(), () => this.pace());
  /* A switch is written down that is not through yet. */
  private under = true;
  private working: Promise<void> | null = null;
  private stopped = false;
  private started = false;
  private probed = false;
  private probedAt = -Infinity;
  private promoted = false;
  private failing = false;

  constructor(private readonly opts: PromoterOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private paths(): Paths {
    return { dir: this.opts.dir, sql: this.opts.sql, subscription: this.opts.subscription, now: () => this.now(), log: this.opts.log };
  }

  async start(): Promise<void> {
    await this.look();
    this.looks.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.looks.stop();
    await this.working;
  }

  /* How long until its next look: a quarter of a second while it takes the server, a second once it leads as any
     keeper. */
  pace(): number {
    return this.under ? (this.opts.everyMs ?? EVERY_MS) : (this.opts.idleMs ?? IDLE_MS);
  }

  /* Promoted: the keeper may take its lease and start what a leading keeper runs. */
  leads(): boolean {
    return this.promoted;
  }

  /* The machine it takes the server from, and when that began, while a switch is written down; none otherwise, also
     when the note cannot be read. */
  from(): { networkId: string; at: number } | null {
    try {
      const taking = readTaking(this.opts.dir);
      return taking ? { networkId: taking.from.networkId, at: taking.at } : null;
    } catch {
      return null;
    }
  }

  /* One look at a time; a look that fails changes nothing, and is said once an outage. */
  look(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.working ??= this.lookOnce()
      .then(
        () => void (this.failing = false),
        (err: unknown) => {
          if (!this.failing) this.opts.log(`The keeper could not go on taking the server over: ${reasonOf(err)}`);
          this.failing = true;
        },
      )
      .finally(() => void (this.working = null));
    return this.working;
  }

  /* The paths of a switch, as the machine that offered asks them of a keeper that is taking over. */
  async handle(from: string, method: string, path: string, body: unknown): Promise<SwitchAnswer> {
    const what = asked(method, path, body);
    if (!what) return refused(404);
    if (what.name === 'state') return stateOf(this.paths(), from, what.switch);
    const taking = readTaking(this.opts.dir);
    if (!taking || taking.from.networkId !== from) return refused(403);
    if (what.name === 'offer') return refused(409, 'not_ready');
    const named = z.object({ switch: z.uuid() }).safeParse(what.body);
    if (!named.success || named.data.switch !== taking.switch) return refused(409);
    /* The go was taken before this keeper started: the same one again changes nothing. */
    if (what.name === 'go') return taking.phase === 'aborted' ? refused(409) : OK;
    const written = await ownTerm(this.opts.sql, taking, this.opts.machine.networkId);
    if (written || taking.phase === 'promoted') return { status: 409, body: await saidOf(this.opts.sql, taking) };
    const gave = taking.phase !== 'aborted';
    const state = await this.giveBack(taking, null);
    return { status: 200, body: state, ...(gave ? { after: () => this.opts.exit() } : {}) };
  }

  private async lookOnce(): Promise<void> {
    const { opts } = this;
    const taking = readTaking(opts.dir);
    this.under = taking !== null && taking.phase !== 'promoted';
    if (!taking) {
      /* Nothing written down: the switch ended, and this keeper leads as any other. */
      this.promoted = true;
      return;
    }
    if (taking.phase === 'promoted') this.promoted = true;
    const termWritten = taking.phase === 'go' ? await ownTerm(opts.sql, taking, opts.machine.networkId) : false;
    const { registered, foreign } = taking.phase === 'go' && !termWritten ? await this.named(taking) : { registered: false, foreign: false };
    const step = nextTakeStep({ now: this.now(), taking, termWritten, registered, probed: this.probed, appLeads: opts.appLeads(), foreign });
    /* The link's client runs from the first look that goes on, also in a keeper that started again and finds the name
       its own already, or its database promoted. */
    if (taking.phase === 'promoted' || step.do === 'register' || step.do === 'probe' || step.do === 'promote') this.register();
    if (step.do === 'none' || step.do === 'lead' || step.do === 'register') return;
    if (step.do === 'probe') return this.probe();
    if (step.do === 'promote') return this.promote(taking);
    if (step.do === 'abort') {
      await this.giveBack(taking, step.why);
      return opts.exit();
    }
    if (step.do === 'done') {
      const term = await termOf(opts.sql);
      forgetTaking(opts.dir);
      opts.log(`This machine leads the company now, under term ${term?.number ?? '?'}.`);
      return;
    }
    forgetTaking(opts.dir);
  }

  /* Whether the company's name is this keeper's now, and for a takeover whether anyone else registered it since the
     window the copy decided on: its own client at exactly the next generation is its own registration; another
     client's at any later generation, or its own at a later one still, means someone registered in between. */
  private async named(taking: Taking): Promise<{ registered: boolean; foreign: boolean }> {
    const { opts } = this;
    if ((taking.kind ?? 'planned') === 'planned' || taking.generation === undefined || !opts.name) return { registered: await opts.registered().catch(() => false), foreign: false };
    const name = await opts.name().catch(() => null);
    if (!name) return { registered: false, foreign: false };
    const next = taking.generation + 1;
    return {
      registered: name.state === 'held' && name.mine && name.generation === next,
      foreign: name.generation > next || (name.generation > taking.generation && !name.mine),
    };
  }

  private register(): void {
    if (this.started) return;
    this.started = true;
    this.opts.tunnel.start();
  }

  /* Once a second: a nonce of this keeper's own goes through the link, and only an answer that names this machine and
     that nonce counts. An answer of the old leader's, or of anyone else, proves nothing. */
  private async probe(): Promise<void> {
    const now = this.now();
    if (now - this.probedAt < PROBE_EVERY_MS) return;
    this.probedAt = now;
    const nonce = randomBytes(16).toString('base64url');
    const answer = await this.opts.probe(nonce).catch(() => null);
    this.probed = answer?.machine === this.opts.machine.networkId && answer.nonce === nonce;
  }

  private async promote(taking: Taking): Promise<void> {
    const { opts } = this;
    const slots = await (opts.promote ?? (t => this.promotion(t)))(taking);
    rmSync(join(opts.controlDir, REPLICA_FILE), { force: true });
    rmSync(join(opts.dir, COPY_STATE), { force: true });
    writeTaking(opts.dir, { ...taking, phase: 'promoted', slots });
    this.promoted = true;
  }

  /* The steps by which this machine's database becomes the leader's, each doing nothing when its work is done: the
     term, the subscription gone, the sequences raised, the publication, a slot for the old leader and for each copy
     that held everything the old leader wrote, and the record of the handover, which ends the CEO's request. A slot is
     named after the attempt following the machine's last copy, so no old subscription of that machine attaches to it. */
  private async promotion(taking: Taking): Promise<Record<string, string>> {
    const { sql, machine } = this.opts;
    if ((taking.kind ?? 'planned') !== 'planned') return this.takeover(taking);
    if (taking.w === null) throw new Error('what it wrote down names no end of the old leader\'s log');
    await waitForNoCopy(sql);
    await writeTerm(sql, { above: taking.term.number, machine: machine.networkId });
    await dropSubscriptions(sql);
    await raiseSequences(sql);
    await ensurePublication(sql);
    const named = [...new Set([machine.networkId, taking.from.networkId, ...(taking.copies ?? [])])];
    const { rows } = await sql.query<{ id: string; networkId: string; copyName: string | null }>(
      'SELECT id::text AS id, network_id AS "networkId", copy_name AS "copyName" FROM public.machines WHERE network_id = ANY($1::text[]) AND revoked_at IS NULL', [named]);
    const mine = rows.find(row => row.networkId === machine.networkId);
    const old = rows.find(row => row.networkId === taking.from.networkId);
    if (!mine || !old) throw new Error(`${mine ? 'the machine that led' : 'this machine'} has no row here`);
    const slots: Record<string, string> = {};
    for (const row of rows) if (row !== mine) slots[row.networkId] = copyName(row.networkId, Number(/_(\d+)$/.exec(row.copyName ?? '')?.[1] ?? 0) + 1);
    await makeSlots(sql, Object.values(slots));
    await recordHandover(sql, { id: taking.switch, from: old.id, term: taking.term, applied: taking.w, to: mine.id, at: new Date(this.now()), slots });
    return slots;
  }

  /* The promotion after a takeover, or after the CEO chose this copy: as a planned one, but nobody stopped the old
     leader, so how far this copy read its log is asked of the copy itself and written down before its subscription
     goes; and no slot is made, since every other machine makes its copy again after an unplanned switch. */
  private async takeover(taking: Taking): Promise<Record<string, string>> {
    const { sql, machine, dir } = this.opts;
    let applied = taking.w;
    if (applied === null) {
      const [read] = (await sql.query<{ lsn: string | null }>(
        `SELECT pg_replication_origin_progress('pg_' || s.oid, true)::text AS lsn FROM pg_subscription s JOIN pg_database d ON d.oid = s.subdbid WHERE d.datname = current_database() ORDER BY s.oid LIMIT 1`)).rows;
      applied = read?.lsn ?? '0/0';
      writeTaking(dir, { ...taking, w: applied });
    }
    await waitForNoCopy(sql);
    await writeTerm(sql, { above: taking.term.number, machine: machine.networkId });
    await dropSubscriptions(sql);
    await raiseSequences(sql);
    await ensurePublication(sql);
    const { rows } = await sql.query<{ id: string; networkId: string }>(
      'SELECT id::text AS id, network_id AS "networkId" FROM public.machines WHERE network_id = ANY($1::text[]) AND revoked_at IS NULL', [[machine.networkId, taking.from.networkId]]);
    const mine = rows.find(row => row.networkId === machine.networkId);
    const old = rows.find(row => row.networkId === taking.from.networkId);
    if (!mine || !old) throw new Error(`${mine ? 'the machine that led' : 'this machine'} has no row here`);
    await recordHandover(sql, {
      id: taking.switch, from: old.id, term: taking.term, applied, to: mine.id, at: new Date(this.now()), slots: {},
      kind: taking.kind, heardAt: taking.heard == null ? null : new Date(taking.heard), reach: taking.reach ? new Date(taking.reach) : null, reason: taking.full ? 'disk_full' : null,
    });
    return {};
  }

  /* The name did not come, or the old leader called the switch off: the link's client stops, the subscription follows
     again, and what is written down says the old leader leads under its next term. */
  private async giveBack(taking: Taking, why: Taking['why']): Promise<TakeState> {
    const gave = taking.phase !== 'aborted';
    if (gave) await this.opts.tunnel.stop();
    const state = await abortNow(this.paths(), taking, false, why);
    if (gave) this.opts.log(`Gave the server back to ${taking.from.hostname || 'the machine that led'}: ${why === 'no_link' ? "hornhoof.org did not give this machine the company's name in time" : 'that machine called the move off'}.`);
    return state;
  }
}
