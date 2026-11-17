import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PEER_PATHS } from '../../net/peer-server.js';
import type { Beat, Heard } from './beats.js';
import type { Clocks } from './lease.js';
import { reasonOf } from './machine-keys.js';
import { CEO_KEEP_MS } from './takeover-step.js';
import { Ticker } from './ticker.js';

/* The question a copy puts to the CEO when the machine that leads is gone and the copy may lack changes: which copy
   to go on from, or to wait for the leader. The keeper writes the question into its word to the app, the app shows it
   and writes the CEO's answer into the control folder, and the keeper acts on it, for itself or by telling the copy
   the CEO named. */

/* A copy counts as up while its newest beat, either way, is no older than this. */
const UP_MS = 5_000;
const ASK_MS = 5_000;
const EVERY_MS = 1_000;

/* since: when the question first stood. leader: the machine that stopped answering, and when it was last heard.
   copies: this copy and each other one that is up, in the server order, with how far its changes reach. waiting:
   until when the CEO chose to wait. Every time is ISO. */
export type Question = {
  since: string;
  leader: { networkId: string; host: string; heard: string | null };
  copies: { networkId: string; host: string; number: number | null; reach: string | null; self: boolean }[];
  waiting: string | null;
};

export const QuestionShape = z.object({
  since: z.string(),
  leader: z.object({ networkId: z.string(), host: z.string(), heard: z.string().nullable() }),
  copies: z.array(z.object({ networkId: z.string(), host: z.string(), number: z.number().int().nullable(), reach: z.string().nullable(), self: z.boolean() })),
  waiting: z.string().nullable(),
});

/* The CEO's answer as the app writes it into the control folder: whole and then moved, for the keeper alone. */
export const RECOVERY_FILE = 'recovery.json';
export type RecoveryWord = { id: string; by: string; at: string } & ({ goOn: string; reach: string | null } | { wait: true });

const WordShape = z.union([
  z.object({ id: z.string(), by: z.string(), at: z.string(), goOn: z.string(), reach: z.string().nullable() }),
  z.object({ id: z.string(), by: z.string(), at: z.string(), wait: z.literal(true) }),
]);
const GoOn = z.strictObject({ reach: z.string().nullable() });
const Wait = z.strictObject({ wait: z.literal(true) });

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/* The question as of now. since, heard, waiting: by the wall clock, in ms. now: by the clock that never jumps, which
   the beats' times are of. A machine counts as a copy that is up only on its own beat that says its copy is ready. */
export function makeQuestion(o: {
  since: number; leader: { networkId: string; host: string }; heard: number | null; self: Beat; beats: ReadonlyMap<string, Heard>; now: number; waiting: number | null;
}): Question {
  const up = [...o.beats.values()]
    .filter(({ beat, at }) => beat.machine !== o.self.machine && beat.machine !== o.leader.networkId && beat.ready && o.now - at <= UP_MS)
    .map(({ beat }) => beat);
  const copies = [...up, o.self]
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || (a.machine < b.machine ? -1 : 1))
    .map(beat => ({ networkId: beat.machine, host: beat.host, number: beat.number, reach: beat.reach, self: beat.machine === o.self.machine }));
  return { since: iso(o.since)!, leader: { ...o.leader, heard: iso(o.heard) }, copies, waiting: iso(o.waiting) };
}

export type RecoveryOptions = {
  /* The control folder, where the app of this machine writes the CEO's answer. */
  controlDir: string;
  /* This keeper's network id. */
  self: string;
  /* How far this copy's changes reach, as a time. */
  reach: () => string | null;
  /* The other copies of the question that stands, by their network ids. */
  others: () => string[];
  /* A machine's name, for the log. */
  host: (networkId: string) => string;
  /* One POST to another data machine's keeper; none when no whole answer came in time. */
  ask: (networkId: string, path: string, body: unknown, timeoutMs: number) => Promise<{ status: number; body: unknown } | null>;
  now?: () => Clocks;
  everyMs?: number;
  log: (line: string) => void;
};

const OK = { status: 200, body: { ok: true } };
/* A copy that never said how far its changes reach is named by what it holds. */
const WHAT_IT_HOLDS = 'what it holds';

export class Recovery {
  private readonly ticks: Ticker;
  private working = false;
  private went: number | null = null;
  private waits: number | null = null;
  private readonly clocks: () => Clocks;

  constructor(private readonly opts: RecoveryOptions) {
    this.clocks = opts.now ?? (() => ({ wall: Date.now(), mono: performance.now() }));
    this.ticks = new Ticker(() => this.tick(), opts.everyMs ?? EVERY_MS);
  }

  start(): void {
    this.ticks.start();
  }

  stop(): void {
    this.ticks.stop();
  }

  /* When the CEO said to go on from this copy, by the clock that never jumps; null once that word is too old, or
     while he said none. */
  go(): number | null {
    if (this.went !== null && this.clocks().mono - this.went >= CEO_KEEP_MS) this.went = null;
    return this.went;
  }

  /* Until when the CEO chose to wait, by the wall clock; null once that passed. */
  waiting(): number | null {
    if (this.waits !== null && this.clocks().wall >= this.waits) this.waits = null;
    return this.waits;
  }

  /* One look, each second: the CEO's answer, when the app wrote one, is acted on and removed. */
  async tick(): Promise<void> {
    if (this.ticks.stopped || this.working) return;
    this.working = true;
    try {
      const word = this.take();
      if (word) await this.act(word);
    } finally {
      this.working = false;
    }
  }

  /* What another copy's keeper passes on, on POST /peer/go-on: the CEO's word to go on from this copy, or to wait. */
  handle(from: string, body: unknown): { status: number; body: object } {
    if (!from) return { status: 403, body: { ok: false } };
    if (Wait.safeParse(body).success) {
      this.wait();
      return OK;
    }
    const said = GoOn.safeParse(body);
    if (!said.success) return { status: 400, body: { ok: false } };
    /* The CEO chose it for what it had when he looked: with anything else, the question he answered is another. */
    if (said.data.reach !== this.opts.reach()) return { status: 409, body: { ok: false, why: 'reach' } };
    this.goOn(said.data.reach);
    return OK;
  }

  /* The answer in the control folder, taken away before it is read, so one the app writes meanwhile is never removed
     unseen. A word that cannot be read is dropped, and said; so is one older than a word holds, as a keeper finds it
     that was away when the CEO answered. */
  private take(): RecoveryWord | null {
    const path = join(this.opts.controlDir, RECOVERY_FILE);
    const taken = `${path}.taken`;
    let text: string;
    try {
      renameSync(path, taken);
      text = readFileSync(taken, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.opts.log(`The keeper could not read the CEO's answer: ${reasonOf(err)}`);
      return null;
    } finally {
      rmSync(taken, { force: true });
    }
    try {
      const word = WordShape.parse(JSON.parse(text));
      const age = this.clocks().wall - Date.parse(word.at);
      if (!(age < CEO_KEEP_MS)) {
        this.opts.log("The CEO's answer is too old to act on; the question is asked again.");
        return null;
      }
      return word;
    } catch (err) {
      this.opts.log(`The keeper could not read the CEO's answer: ${reasonOf(err)}`);
      return null;
    }
  }

  private async act(word: RecoveryWord): Promise<void> {
    const { opts } = this;
    if ('wait' in word) {
      this.wait();
      await Promise.all(opts.others().map(other => opts.ask(other, PEER_PATHS.goOn, { wait: true }, ASK_MS).catch(() => null)));
      return;
    }
    if (word.goOn === opts.self) {
      if (word.reach === opts.reach()) this.goOn(word.reach, Date.parse(word.at));
      else opts.log('The CEO chose to go on from this copy as it was before; it holds something else now, so nothing is done.');
      return;
    }
    const said = await opts.ask(word.goOn, PEER_PATHS.goOn, { reach: word.reach }, ASK_MS).catch(() => null);
    const host = opts.host(word.goOn) || 'another machine';
    if (said?.status === 200) opts.log(`The CEO chose to go on from ${word.reach ?? WHAT_IT_HOLDS} on ${host}.`);
    else opts.log(`The CEO chose to go on from ${word.reach ?? WHAT_IT_HOLDS} on ${host}, which did not take it.`);
  }

  /* given: when the CEO gave the word, by the wall clock, where this keeper knows it: the word counts from then, so a
     leader heard between his answer and this keeper's reading of it voids it as any leader heard after it does. */
  private goOn(reach: string | null, given?: number): void {
    const now = this.clocks();
    const age = given === undefined || Number.isNaN(given) ? 0 : Math.max(0, now.wall - given);
    this.went = now.mono - age;
    this.waits = null;
    this.opts.log(`The CEO chose to go on from ${reach ?? WHAT_IT_HOLDS} on ${this.opts.host(this.opts.self) || 'this machine'}.`);
  }

  private wait(): void {
    this.went = null;
    this.waits = this.clocks().wall + CEO_KEEP_MS;
    this.opts.log('The CEO chose to wait for the machine that led.');
  }
}
