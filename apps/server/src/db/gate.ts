import { AsyncLocalStorage } from 'node:async_hooks';

/* How long a merge waits for the writes that are inside to leave. */
export const GATE_WAIT_MS = 30_000;

export class GateBusy extends Error {
  constructor() {
    super("The app's writes did not stop within 30 s.");
  }
}

/* What a piece of work that is inside the gate carries, until it leaves. */
type Pass = { left: boolean };

/* The gate every write of this process goes through before its transaction begins. Writers go in together. A merge
   closes it to new writers, waits until those inside have left and then holds it alone, so a write that comes meanwhile
   waits with no transaction open and no lock held, and lands after the merge. */
export class WriteGate {
  private readonly passes = new AsyncLocalStorage<Pass>();
  private writers = 0;
  /* The merges that hold the gate or wait for it: it is closed to new writers while there is one. */
  private merges = 0;
  private readonly waiting: (() => void)[] = [];
  private emptied: (() => void) | null = null;
  private turn: Promise<unknown> = Promise.resolve();

  /* Whether this piece of work is inside already: a writer's own nested write, or the merge's work. What a writer
     started and left behind is no part of it once it has left. */
  private holds(): boolean {
    const pass = this.passes.getStore();
    return pass !== undefined && !pass.left;
  }

  /* At once while the gate is open, or from inside it; else once the merge is done. The answer leaves, once. */
  async enter(): Promise<() => void> {
    if (this.holds()) return () => undefined;
    while (this.merges > 0) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.writers += 1;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.writers -= 1;
      if (this.writers === 0) this.emptied?.();
    };
  }

  /* Runs a write inside the gate: whatever it writes itself meanwhile goes through with it. */
  async through<T>(work: () => Promise<T>): Promise<T> {
    if (this.holds()) return work();
    const leave = await this.enter();
    const pass: Pass = { left: false };
    try {
      return await this.passes.run(pass, work);
    } finally {
      pass.left = true;
      leave();
    }
  }

  /* One at a time: closes the gate to new writers, waits until every writer inside has left, runs the work inside, then
     opens the gate. With writers still inside after waitMs it opens the gate, lets the waiting ones in and throws. */
  exclusive<T>(work: () => Promise<T>, waitMs: number = GATE_WAIT_MS): Promise<T> {
    this.merges += 1;
    const run = this.turn.then(() => this.alone(work, waitMs));
    this.turn = run.catch(() => undefined);
    return run;
  }

  inside(): number {
    return this.writers;
  }

  private async alone<T>(work: () => Promise<T>, waitMs: number): Promise<T> {
    const pass: Pass = { left: false };
    try {
      if (!(await this.empty(waitMs))) throw new GateBusy();
      return await this.passes.run(pass, work);
    } finally {
      pass.left = true;
      this.merges -= 1;
      for (const go of this.waiting.splice(0)) go();
    }
  }

  private empty(waitMs: number): Promise<boolean> {
    if (this.writers === 0) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.emptied = null;
        resolve(false);
      }, waitMs);
      this.emptied = () => {
        clearTimeout(timer);
        this.emptied = null;
        resolve(true);
      };
    });
  }
}

/* One for the process. */
export const writeGate = new WriteGate();
