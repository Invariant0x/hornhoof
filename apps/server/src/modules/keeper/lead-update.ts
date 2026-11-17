import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DROPPED_FILE, PROMISED_FILE, SETTLED_FILE } from '../updates/control.js';
import type { Sql } from './lease-store.js';
import { IDLE_MS, Looks } from './looks.js';
import { walOf, type Wal } from './sql-words.js';
import { reasonOf, writePrivately } from './machine-keys.js';
import { dropSlots } from './promote.js';
import type { CopyView } from './sync.js';
import { ANSWER_MS, nextUpdateStep, PROMISE_MS, type UpdateAction, type UpdateMemory, type UpdateSample } from './update-steps.js';

/* The keeper's part of an update on the machine that leads, while other machines keep copies. Its updater asks through
   the control folder, and this answers there: whether every copy promised to wait, whether the dump may be taken (the
   copies hold everything this machine wrote), and that the copies' slots went before a database is put back. What it
   does is written down first, so a keeper that starts again in the middle goes on. */

export const LEAD_UPDATE = 'lead-update.json';
const UPDATING_PATH = '/peer/updating';
const EVERY_MS = 250;
const NOT_CONFIRMED = 'The copies did not confirm the last changes';

const Memory = z.object({
  id: z.string(), version: z.string(), migrations: z.number().int().nullable(), promised: z.array(z.string()), promisedAt: z.number(), answered: z.boolean(),
  w: z.string().nullable(), wAt: z.number().nullable(), stopped: z.boolean(), stopAcks: z.array(z.string()), settled: z.boolean(), dropped: z.boolean(),
});
const Status = z.object({
  id: z.string(), version: z.string(), state: z.enum(['running', 'done', 'failed', 'rolled_back']),
  step: z.enum(['backup', 'pull', 'promise', 'wait', 'install', 'health', 'rollback', 'finished']),
  migrations: z.number().int().nullable().optional(), restore: z.boolean().optional(),
});
const Answered = z.object({ id: z.string() });

export type LeadUpdateOptions = {
  /* The keeper's own folder, and the control folder it shares with the updater. */
  dir: string;
  controlDir: string;
  sql: Sql;
  sync: { copies(): CopyView[]; hold(on: boolean): void; held(): boolean };
  /* The keeper of a machine that keeps a copy, by its network id, on this keeper's session to it. */
  peer: (networkId: string) => { request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; body: unknown } | null> };
  /* The name a machine goes by, for the line that says which copy did not promise. */
  hostname: (networkId: string) => Promise<string>;
  /* Whether this keeper leads under a normal lease with its app leading, and whether its lease is in maintenance. */
  leads: () => boolean;
  maintenance: () => boolean;
  /* Where this database's log ends, and its slots with whether each holds that position; the database's own unless a
     test says otherwise. */
  wal?: { position(): Promise<string>; slots(w: string): Promise<{ name: string; read: boolean; atW: boolean }[]> };
  dropSlots?: () => Promise<string[]>;
  now?: () => number;
  log: (line: string) => void;
  everyMs?: number;
  /* How often it looks while no update runs. */
  idleMs?: number;
};

export class LeadUpdate {
  private readonly looks = new Looks(() => this.look(), () => this.pace());
  private working: Promise<void> | null = null;
  private stopped = false;
  private failing = false;
  private memory: UpdateMemory | null;
  /* What each copy said to the last promise; kept in memory only, so a keeper that starts again asks anew. */
  private answers: UpdateSample['answers'] = null;

  constructor(private readonly opts: LeadUpdateOptions) {
    this.memory = this.read();
    /* A keeper that starts in the middle of an update names no copy: migrations may be running. */
    if (this.memory?.stopped || this.memory?.dropped) opts.sync.hold(true);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
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

  /* How long until its next look: a quarter of a second while an update runs or this keeper has one to end, a second
     while there is none. */
  pace(): number {
    return this.busy() ? (this.opts.everyMs ?? EVERY_MS) : (this.opts.idleMs ?? IDLE_MS);
  }

  /* Whether an update runs or this keeper still has one to end: no server is moved meanwhile. */
  busy(): boolean {
    return this.memory !== null || this.status()?.state === 'running';
  }

  /* One look at a time; a look that fails changes nothing, and is said once an outage. */
  look(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.working ??= this.lookOnce()
      .then(
        () => void (this.failing = false),
        (err: unknown) => {
          if (!this.failing) this.opts.log(`The keeper could not go on with its part of the update: ${reasonOf(err)}`);
          this.failing = true;
        },
      )
      .finally(() => void (this.working = null));
    return this.working;
  }

  private read(): UpdateMemory | null {
    try {
      const kept = Memory.safeParse(JSON.parse(readFileSync(join(this.opts.dir, LEAD_UPDATE), 'utf8')));
      return kept.success ? kept.data : null;
    } catch {
      return null;
    }
  }

  private keep(memory: UpdateMemory): UpdateMemory {
    writePrivately(join(this.opts.dir, LEAD_UPDATE), JSON.stringify(memory));
    this.memory = memory;
    return memory;
  }

  private status(): UpdateSample['status'] {
    try {
      const said = Status.safeParse(JSON.parse(readFileSync(join(this.opts.controlDir, 'status.json'), 'utf8')));
      if (!said.success) return null;
      const { id, version, state, step, migrations, restore } = said.data;
      return { id, version, state, step, migrations: migrations ?? null, restore: restore === true };
    } catch {
      return null;
    }
  }

  private answer(file: string, said: { id: string; ok: boolean; why?: string }): void {
    writePrivately(join(this.opts.controlDir, file), JSON.stringify(said));
  }

  private wal(): Wal {
    return this.opts.wal ?? walOf(this.opts.sql);
  }

  /* The promised copies whose slot holds where the log ended. */
  private async atW(memory: UpdateMemory): Promise<string[]> {
    if (memory.w === null || memory.settled || memory.promised.length === 0) return [];
    const slots = await this.wal().slots(memory.w);
    const copies = this.opts.sync.copies();
    return memory.promised.filter(networkId => slots.find(slot => slot.name === copies.find(copy => copy.networkId === networkId)?.name)?.atW === true);
  }

  private async lookOnce(): Promise<void> {
    const { opts } = this;
    const memory = this.memory;
    const sample: UpdateSample = {
      now: this.now(), status: this.status(), memory,
      online: opts.sync.copies().filter(copy => copy.state === 'sync' || copy.state === 'pace').map(copy => copy.networkId),
      answers: this.answers, inFlight: false, maintenance: opts.maintenance(), leads: opts.leads(),
      atW: memory ? await this.atW(memory) : [], held: opts.sync.held(),
    };
    await this.act(nextUpdateStep(sample), sample);
  }

  /* The same word to each of these copies at once; what each answered, none for one that said nothing in time. */
  private async tell(to: string[], body: object): Promise<Record<string, number | null>> {
    const said = await Promise.all(to.map(networkId => this.opts.peer(networkId).request('POST', UPDATING_PATH, body, ANSWER_MS).catch(() => null)));
    return Object.fromEntries(to.map((networkId, at) => [networkId, said[at]?.status ?? null]));
  }

  private promiseOf(memory: UpdateMemory, now: number): object {
    return { version: memory.version, until: now + PROMISE_MS, migrations: memory.migrations };
  }

  private async act(action: UpdateAction, s: UpdateSample): Promise<void> {
    const { opts } = this;
    const now = s.now;
    if (action.do === 'none') return;
    if (action.do === 'promise') {
      const status = s.status!;
      const memory = this.keep({
        id: status.id, version: status.version, migrations: status.migrations, promised: action.to, promisedAt: now, answered: false,
        w: null, wAt: null, stopped: false, stopAcks: [], settled: false, dropped: false,
      });
      this.answers = null;
      const said = await this.tell(action.to, this.promiseOf(memory, now));
      this.answers = Object.fromEntries(action.to.map(networkId => [networkId, said[networkId] === 200 ? 'ok' : said[networkId] === null ? 'silent' : 'refused']));
      return;
    }
    const memory = this.memory;
    if (action.do === 'end') return this.end(memory);
    if (!memory) return;
    if (action.do === 'answer') {
      const why = action.why ? `${(await opts.hostname(action.why.copy)) || 'A machine that keeps a copy'} ${action.why.said === 'silent' ? 'did not answer' : 'did not promise to wait'}` : undefined;
      this.answer(PROMISED_FILE, { id: memory.id, ok: action.ok, ...(why ? { why } : {}) });
      return void this.keep({ ...memory, answered: true });
    }
    if (action.do === 'promise_again') {
      this.keep({ ...memory, promisedAt: now });
      await opts.sql.query('UPDATE net_local.maintenance SET until = to_timestamp($1::float8 / 1000)', [now + PROMISE_MS]);
      const said = await this.tell(memory.promised, this.promiseOf(memory, now));
      for (const networkId of memory.promised) {
        if (said[networkId] !== 200) opts.log(`${(await opts.hostname(networkId)) || 'A machine that keeps a copy'} did not answer that it waits for the update.`);
      }
      return;
    }
    if (action.do === 'begin') {
      /* The copies read from this row that the company updates, and until when; then where the log ends is read: the
         app's sessions ended, so nothing of theirs comes after it. */
      await opts.sql.query(
        `INSERT INTO net_local.maintenance (version, since, until) VALUES ($1, to_timestamp($2::float8 / 1000), to_timestamp($3::float8 / 1000))
         ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, since = EXCLUDED.since, until = EXCLUDED.until`,
        [memory.version, now, now + PROMISE_MS],
      );
      return void this.keep({ ...memory, w: await this.wal().position(), wAt: now });
    }
    if (action.do === 'stop_copies') {
      /* Written down first: from here on no copy is named, also by a keeper that starts again. */
      const stopping = this.keep({ ...memory, stopped: true });
      opts.sync.hold(true);
      const left = stopping.promised.filter(networkId => !stopping.stopAcks.includes(networkId));
      const said = await this.tell(left, { stop: true });
      return void this.keep({ ...stopping, stopAcks: [...stopping.stopAcks, ...left.filter(networkId => said[networkId] === 200)] });
    }
    if (action.do === 'settle') {
      this.answer(SETTLED_FILE, { id: memory.id, ok: action.ok, ...(action.ok ? {} : { why: NOT_CONFIRMED }) });
      return void this.keep({ ...memory, settled: true });
    }
    /* drop_slots: the database is to be put back as it was before the update, and nothing of the copies' may hold it:
       they stop, commits wait for none, and every slot goes. */
    await this.tell(memory.promised, { stop: true });
    opts.sync.hold(true);
    await (opts.dropSlots ?? (() => dropSlots(opts.sql)))();
    this.answer(DROPPED_FILE, { id: memory.id, ok: true });
    this.keep({ ...memory, dropped: true });
  }

  /* The update is over and this machine leads again: the copies hear so, one try each, a copy may be named again, and
     what was written of this update goes, the answers of another left alone. */
  private async end(memory: UpdateMemory | null): Promise<void> {
    const { opts } = this;
    if (!memory) return;
    await opts.sql.query('DELETE FROM net_local.maintenance');
    await this.tell(memory.promised, { ended: true });
    opts.sync.hold(false);
    for (const name of [PROMISED_FILE, SETTLED_FILE, DROPPED_FILE]) {
      const file = join(opts.controlDir, name);
      try {
        if (Answered.parse(JSON.parse(readFileSync(file, 'utf8'))).id === memory.id) rmSync(file, { force: true });
      } catch {
        /* None there, or none of this keeper's to read. */
      }
    }
    rmSync(join(opts.dir, LEAD_UPDATE), { force: true });
    this.memory = null;
    this.answers = null;
  }
}
