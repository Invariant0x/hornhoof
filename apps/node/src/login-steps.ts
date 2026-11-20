import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeMessage } from '@hornhoof/protocol';
import { SIGNIN_ERRORS, SIGNIN_STEPS, type SigninStep } from '@hornhoof/protocol/signin';
import { hideKeyLike } from './redact.js';
import type { LoginIo, ProviderAdapter } from './runner.js';

/* Where a sign-in in the install window leaves its steps for the running node, one JSON line each. */
export const LOGIN_STEPS_FILE = 'login-steps';
/* The longest last line a step says, as login.step takes it. */
const LINE_MAX = 400;

const seconds = (ms: number) => Math.round(ms / 1000);

type ProgressOptions = { send(m: NodeMessage): void; log(line: string): void };

/* Where a sign-in is after its code, said to whoever listens. */
export const sayStep = (io: LoginIo, step: SigninStep): void => io.step?.(step);

/* Reads what a plan can do once its program signed in, saying each step. */
export type ReadPlan = (step: (s: SigninStep) => void) => Promise<void>;

/* The steps of one sign-in after its code, as Hornhoof hears them, and in the node's log when the code came, when the plan
   was ready and how long each step took. A sign-in that said no step yet says nothing when it ends. */
export class SignInProgress {
  private first: number | null = null;
  private last: { step: SigninStep; at: number } | null = null;
  private took: string[] = [];

  constructor(private readonly opts: ProgressOptions) {}

  step(step: SigninStep): void {
    const now = Date.now();
    if (this.first === null) {
      this.first = now;
      this.opts.log(`Sign-in: ${step}, 0 s after the code (${new Date(now).toISOString()}).`);
    } else {
      this.tookUntil(now);
      this.opts.log(`Sign-in: ${step}, ${seconds(now - this.first)} s after the code.`);
    }
    this.last = { step, at: now };
    this.opts.send({ type: 'login.step', step });
  }

  /* line: the last line the program said, already through the node's masks. */
  failed(error: string, line: string | null): void {
    if (this.first === null) return;
    this.opts.log(`Sign-in: failed ${seconds(Date.now() - this.first)} s after the code: ${error}${line ? ` ${line}` : ''}`);
    this.opts.send({ type: 'login.step', step: 'failed', error, line });
    this.reset();
  }

  /* What the node sends, noting on the way how a sign-in in Hornhoof's window ended. */
  passing(send: (m: NodeMessage) => void): (m: NodeMessage) => void {
    return m => {
      if (m.type === 'login.done') this.ended(m.ok);
      send(m);
    };
  }

  /* Once the program signed in: the node reads what the plan can do, saying each step, and then the plan is ready. */
  async readPlan(read: ReadPlan): Promise<void> {
    try {
      await read(step => this.step(step));
      this.ended(true);
    } catch (err) {
      this.opts.log(`Could not read the plan after its sign-in: ${err instanceof Error ? err.message : String(err)}`);
      this.failed(SIGNIN_ERRORS.broke, null);
    }
  }

  /* Hornhoof asks again after a connection that failed or took too long: whether the program is signed in, then the plan.
     A node that holds no sign-in has none to check. */
  async checkAgain({ holds, signedIn, read }: { holds: boolean; signedIn(): Promise<boolean>; read: ReadPlan }): Promise<void> {
    if (!holds) return;
    this.step('checking');
    if (!(await signedIn().catch(() => false))) return this.failed(SIGNIN_ERRORS.signedOut, null);
    this.step('signed_in');
    await this.readPlan(read);
  }

  /* The sign-in ended: kept, with the plan read, or not, which login.done says to Hornhoof itself. */
  ended(ok: boolean): void {
    if (this.first === null) return;
    const now = Date.now();
    this.tookUntil(now);
    const after = seconds(now - this.first);
    this.opts.log(ok ? `Sign-in: ready ${after} s after the code (${new Date(now).toISOString()}). Steps: ${this.took.join(', ')}.` : `Sign-in: failed ${after} s after the code.`);
    this.reset();
  }

  private tookUntil(now: number): void {
    if (this.last) this.took.push(`${this.last.step} ${seconds(now - this.last.at)} s`);
  }

  private reset(): void {
    this.first = null;
    this.last = null;
    this.took = [];
  }
}

type PlanReads = { setup(): Promise<unknown>; account(): Promise<void>; limits(): Promise<void> };

/* What the node reads of its plan once its program signed in or out. After a sign-in it says each step to Hornhoof, and
   reads the plan's limits at once rather than at its next look; a program with a first setup looks whether it needs it. */
export async function readSignedIn(program: Pick<ProviderAdapter, 'setupNeeded'> | null, step: ((s: SigninStep) => void) | undefined, reads: PlanReads): Promise<void> {
  if (step && program?.setupNeeded) step('setup');
  await reads.setup();
  step?.('account');
  await reads.account();
  if (!step) return;
  step('limits');
  await reads.limits();
  step('models');
}

/* A last line from a program, as it may go to Hornhoof: no key in it, and no longer than login.step takes. */
const maskedLine = (line: string) => hideKeyLike(line.replace(/\s+/g, ' ').trim()).slice(0, LINE_MAX) || null;

/* The steps of a sign-in in the install window, which runs apart from the node: a new sign-in starts the file empty and
   marks each line with its own id, the same step twice in a row is said once, and a failure is said only once a step was. */
export function stepsFile(dir: string) {
  const path = join(dir, LOGIN_STEPS_FILE);
  const run = randomUUID();
  writeFileSync(path, '', { mode: 0o600 });
  let last: SigninStep | null = null;
  const write = (entry: object) => appendFileSync(path, JSON.stringify({ run, ...entry }) + '\n');
  return {
    step(step: SigninStep) {
      if (step === last) return;
      last = step;
      write({ step });
    },
    /* A step that only follows the code, such as the first setup: said once a step was. */
    after(step: SigninStep) {
      if (last !== null) this.step(step);
    },
    failed(error: string, line: string | null) {
      if (last === null) return;
      last = null;
      write({ step: 'failed', error, line: line === null ? null : maskedLine(line) });
    },
  };
}

type Entry = { step: SigninStep } | { step: 'failed'; error: string; line: string | null };
type Line = { run: string | null; entry: Entry | null };

function lineOf(text: string): Line {
  try {
    const e = JSON.parse(text) as { run?: unknown; step?: unknown; error?: unknown; line?: unknown };
    const run = typeof e.run === 'string' ? e.run : null;
    if (e.step === 'failed') return { run, entry: { step: 'failed', error: typeof e.error === 'string' ? e.error.slice(0, 300) : SIGNIN_ERRORS.unfinished, line: typeof e.line === 'string' ? maskedLine(e.line) : null } };
    return { run, entry: (SIGNIN_STEPS as readonly unknown[]).includes(e.step) ? { step: e.step as SigninStep } : null };
  } catch {
    return { run: null, entry: null };
  }
}

/* The whole lines of the file; a line still being written waits for the next look. */
function wholeLines(path: string): Line[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').slice(0, -1).map(lineOf);
}

type WatchOptions = {
  dir: string;
  progress: SignInProgress;
  /* Whether this node holds its program's sign-in; one that does not has no install window to watch. */
  holds: boolean;
  /* Once the program signed in: the node reads what the plan can do, saying each step. */
  signedIn: ReadPlan;
  everyMs?: number;
};

/* Passes the steps of a sign-in in the install window on to Hornhoof as they come, and once the program signed in, has the
   node read the plan at once rather than at its next look. What the file held before the node started is an earlier
   sign-in's. */
export class StepWatch {
  private readonly path: string;
  /* The sign-in the file is of, and how many of its lines were taken. */
  private seen: { run: string | null; taken: number };
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly opts: WatchOptions) {
    this.path = join(opts.dir, LOGIN_STEPS_FILE);
    const lines = wholeLines(this.path);
    this.seen = { run: lines[0]?.run ?? null, taken: lines.length };
  }

  start(): void {
    if (!this.opts.holds) return;
    this.timer ??= setInterval(() => void this.look(), this.opts.everyMs ?? 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async look(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const entry of this.read()) await this.take(entry);
    } finally {
      this.busy = false;
    }
  }

  /* The lines written since the last look, all of them for a new sign-in. */
  private read(): Entry[] {
    const lines = wholeLines(this.path);
    const run = lines[0]?.run ?? null;
    if (run !== this.seen.run || lines.length < this.seen.taken) this.seen = { run, taken: 0 };
    const fresh = lines.slice(this.seen.taken);
    this.seen.taken = lines.length;
    return fresh.flatMap(l => (l.entry ? [l.entry] : []));
  }

  private async take(entry: Entry): Promise<void> {
    const { progress } = this.opts;
    if (entry.step === 'failed') return progress.failed(entry.error, entry.line);
    progress.step(entry.step);
    if (entry.step === 'signed_in') await progress.readPlan(this.opts.signedIn);
  }
}
