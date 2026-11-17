import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Sql } from './lease-store.js';
import { reasonOf, writePrivately } from './machine-keys.js';
import { PROMISE_MS } from './update-steps.js';

/* What a machine that keeps a copy does while the machine that leads updates: it promises to wait, so it takes
   nothing over and makes no copy again, stops applying when the leader is about to migrate, and goes on once the
   leader says the update ended, or once the promise ran out. */

export const PROMISE_FILE = 'promise.json';

/* until: when the promise ends, by this machine's own clock. */
type UpdateWord = { leader: string; version: string; until: number; migrations: number | null; stopped: boolean; at: number };

/* A version goes into a line of the log and a row of the database, so it is a plain word. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const WordShape = z.object({
  leader: z.string(), version: z.string().regex(VERSION), until: z.number(), migrations: z.number().int().nullable(), stopped: z.boolean(), at: z.number(),
});
/* until: when the promise ends by the leader's clock, which this machine does not go by. */
const Promise_ = z.strictObject({ version: z.string().regex(VERSION), until: z.number(), migrations: z.number().int().min(0).nullable() });
const Stop = z.strictObject({ stop: z.literal(true) });
const Ended = z.strictObject({ ended: z.literal(true) });

/* The promise this keeper wrote down; null when there is none. A file that cannot be read counts as none, and is said. */
export function readWord(controlDir: string, log?: (line: string) => void): UpdateWord | null {
  let text: string;
  try {
    text = readFileSync(join(controlDir, PROMISE_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log?.(`The keeper could not read its promise to wait for an update: ${reasonOf(err)}`);
    return null;
  }
  try {
    return WordShape.parse(JSON.parse(text));
  } catch (err) {
    log?.(`The keeper could not read its promise to wait for an update: ${reasonOf(err)}`);
    return null;
  }
}

export type CopyUpdatingOptions = {
  /* The control folder, which the updater of this machine reads too. */
  controlDir: string;
  /* This machine's own database. */
  sql: Sql;
  /* The machine this keeper's link names as the one that leads, by its network id; null while none does. */
  leader: () => string | null;
  subscription: { enabled(): Promise<boolean>; disable(): Promise<void> };
  now?: () => number;
  log: (line: string) => void;
};

const OK = { status: 200, body: { ok: true } };
const no = (status: number): { status: number; body: object } => ({ status, body: { ok: false } });

export class CopyUpdating {
  private word: UpdateWord | null;
  private last: Promise<unknown> = Promise.resolve();
  private readonly clock: () => number;

  constructor(private readonly opts: CopyUpdatingOptions) {
    this.clock = opts.now ?? Date.now;
    this.word = readWord(opts.controlDir, opts.log);
  }

  /* A word whose time has not passed. */
  holds(): boolean {
    return this.word !== null && this.clock() < this.word.until;
  }

  /* The word stopped the subscription, and still holds. */
  stopped(): boolean {
    return this.holds() && this.word!.stopped;
  }

  /* What the keeper of another data machine said about an update, on POST /peer/updating. */
  handle(from: string, body: unknown): Promise<{ status: number; body: object }> {
    return this.inTurn(async () => {
      const promise = Promise_.safeParse(body);
      if (promise.success) return this.promise(from, promise.data);
      if (Stop.safeParse(body).success) return this.stop(from);
      if (Ended.safeParse(body).success) return this.ended(from);
      return no(400);
    });
  }

  /* On start and once a second: a word past its time goes, and a stop that a restart cut is finished. */
  tick(): Promise<void> {
    return this.inTurn(async () => {
      if (!this.word) return;
      if (!this.holds()) {
        await this.forget();
        this.opts.log("The company server's update promise ran out.");
        return;
      }
      if (this.word.stopped && (await this.opts.subscription.enabled())) await this.opts.subscription.disable();
    });
  }

  /* One at a time, so a word is never written by two hands. */
  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.last.then(work, work);
    this.last = turn.catch(() => undefined);
    return turn;
  }

  private held(): UpdateWord | null {
    return this.holds() ? this.word : null;
  }

  private async promise(from: string, said: z.infer<typeof Promise_>): Promise<{ status: number; body: object }> {
    const held = this.held();
    /* The leader in maintenance says in its hello that it leads no more; the promise it renews is still its own. */
    if (from !== this.opts.leader() && from !== held?.leader) return no(403);
    const now = this.clock();
    /* The promise holds for as long as the leader gives one, counted on this machine's own clock from when it heard
       it: the time the leader named is of the leader's clock, and two clocks that differ change nothing. */
    const word: UpdateWord = { leader: from, version: said.version, until: now + PROMISE_MS, migrations: said.migrations, stopped: held?.stopped ?? false, at: now };
    writePrivately(join(this.opts.controlDir, PROMISE_FILE), JSON.stringify(word));
    this.word = word;
    await this.opts.sql.query(
      `INSERT INTO net_local.maintenance (version, since, until) VALUES ($1, to_timestamp($2::float8 / 1000), to_timestamp($3::float8 / 1000))
       ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, until = EXCLUDED.until`,
      [word.version, now, word.until]);
    if (!held) this.opts.log(`The company server is updating to ${word.version}; this copy waits.`);
    return OK;
  }

  private async stop(from: string): Promise<{ status: number; body: object }> {
    const held = this.held();
    if (!held) return no(409);
    if (from !== held.leader) return no(403);
    if (!held.stopped) {
      /* Written first: a keeper that starts again in the middle finishes the stop, and enables nothing meanwhile. */
      const word = { ...held, stopped: true };
      writePrivately(join(this.opts.controlDir, PROMISE_FILE), JSON.stringify(word));
      this.word = word;
    }
    if (await this.opts.subscription.enabled()) await this.opts.subscription.disable();
    return OK;
  }

  private async ended(from: string): Promise<{ status: number; body: object }> {
    const held = this.held();
    if (!held) return OK;
    if (from !== held.leader) return no(403);
    await this.forget();
    this.opts.log("The company server's update ended.");
    return OK;
  }

  private async forget(): Promise<void> {
    await this.opts.sql.query('DELETE FROM net_local.maintenance');
    rmSync(join(this.opts.controlDir, PROMISE_FILE), { force: true });
    this.word = null;
  }
}
