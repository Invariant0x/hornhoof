import type { FastifyRequest } from 'fastify';
import { ApiError, loggable } from '../../errors.js';
import { FRESH_MS, freshState, type KeeperState, type Mode } from './state.js';

const CHECK_EVERY_MS = 1000;

export const READ_ONLY_MESSAGE = 'Hornhoof only reads on this machine now, so nothing was changed.';
const MESSAGES = {
  read_only: READ_ONLY_MESSAGE,
  maintenance: 'Hornhoof is installing an update and takes no changes until it ends.',
  starting: 'Hornhoof is starting.',
} as const;
type Refusal = keyof typeof MESSAGES;

type Hook = { enter: () => unknown; leave: () => unknown };
/* One stay in lead: the hooks it entered, which are the only ones it leaves, and whether it has ended. */
type LeadStay = { entered: Hook[]; over: boolean };
export type AppModeOptions = {
  dir: string;
  fromKeeper: boolean;
  everyMs?: number;
  staleMs?: number;
  now?: () => number;
  log: (line: string) => void;
};

/* The mode the app runs in: lead, read, maintenance or off. The keeper says it in keeper.json; an app with no keeper
   (tests, a compose file of an older build) leads. Work only a leader does registers with whenLead. */
export class AppMode {
  private mode: Mode = 'off';
  private readonly hooks: Hook[] = [];
  private readonly atLeaving: (() => unknown)[] = [];
  private stay: LeadStay = { entered: [], over: true };
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /* When the keeper gave its last fresh word. */
  private heardAt: number | null = null;
  /* Hook runs, one after another, so a quick lead, read, lead never overlaps its own work. */
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly opts: AppModeOptions) {}

  current(): Mode {
    return this.mode;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    if (!this.opts.fromKeeper) return this.change('lead');
    void this.check();
    this.timer = setInterval(() => void this.check(), this.opts.everyMs ?? CHECK_EVERY_MS);
    this.timer.unref();
  }

  /* Resolves when the work of the start or of any change so far has ended. */
  settled(): Promise<void> {
    return this.pending;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.change('off');
    await this.pending;
  }

  async check(): Promise<void> {
    if (this.stopped) return;
    const now = (this.opts.now ?? Date.now)();
    const word = this.opts.fromKeeper ? freshState(this.opts.dir, now, this.opts.staleMs) : null;
    if (word) this.heard(word);
    else if (this.keeperWentSilent(now)) this.change('read');
    await this.pending;
  }

  private heard(word: KeeperState): void {
    this.heardAt = Date.parse(word.at);
    this.change(word.mode);
  }

  /* A keeper that stopped speaking renews no lease either, so the database refuses this app's changes within the same
     ten seconds: the app says so itself and serves what it can read. Any other mode stays until the keeper's next word. */
  private keeperWentSilent(now: number): boolean {
    return this.opts.fromKeeper && this.mode === 'lead' && this.heardAt !== null && now - this.heardAt > (this.opts.staleMs ?? FRESH_MS);
  }

  /* Entered after whatever is pending, so a hook never starts ahead of or beside the ones registered before it. */
  whenLead(enter: () => unknown, leave: () => unknown): void {
    const hook = { enter, leave };
    this.hooks.push(hook);
    if (this.mode === 'lead') this.enterAfterPending(this.stay, [hook]);
  }

  /* For what must not wait behind a slow hook: it runs in the very call that leaves lead, however that stay in lead went. */
  whenLeaving(now: () => unknown): void {
    this.atLeaving.push(now);
  }

  private change(next: Mode): void {
    const was = this.mode;
    if (was === next) return;
    this.mode = next;
    this.opts.log(`Hornhoof now runs in ${next} mode.`);
    if (next === 'lead') this.beginStay();
    else if (was === 'lead') this.endStay();
  }

  private beginStay(): void {
    this.stay = { entered: [], over: false };
    this.enterAfterPending(this.stay, [...this.hooks]);
  }

  private endStay(): void {
    const stay = this.stay;
    stay.over = true;
    for (const now of this.atLeaving) void this.attempt('leaving', now);
    this.pending = this.pending.then(() => this.leave(stay));
  }

  private enterAfterPending(stay: LeadStay, hooks: Hook[]): void {
    this.pending = this.pending.then(() => this.enter(stay, hooks));
  }

  /* A hook counts as entered from the moment it starts, since what it began needs its leave even if it then throws. */
  private async enter(stay: LeadStay, hooks: Hook[]): Promise<void> {
    for (const hook of hooks) {
      if (stay.over) return;
      stay.entered.push(hook);
      await this.attempt('enter', hook.enter);
    }
  }

  private async leave(stay: LeadStay): Promise<void> {
    for (const hook of stay.entered) await this.attempt('leave', hook.leave);
  }

  /* A hook that throws costs one log line and stops neither the others nor the change. */
  private async attempt(which: 'enter' | 'leave' | 'leaving', work: () => unknown): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.opts.log(`A hook of lead mode failed on ${which}: ${String(loggable(err).message)}`);
    }
  }
}

type Asked = Pick<FastifyRequest, 'method' | 'url' | 'headers'>;
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const pathOf = (url: string): string => url.split('?')[0]!;
const wantsSocket = (req: Asked): boolean => String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';

/* Why this mode turns the request away, or null when it lets it through. */
export function refusalOf(mode: Mode, req: Asked): Refusal | null {
  if (mode === 'lead') return null;
  if (mode === 'off') return req.method === 'GET' && pathOf(req.url) === '/api/health' ? null : 'starting';
  return READS.has(req.method) && !wantsSocket(req) ? null : mode === 'read' ? 'read_only' : 'maintenance';
}

export function modeGate(mode: AppMode): (req: FastifyRequest) => Promise<void> {
  return async req => {
    const refusal = refusalOf(mode.current(), req);
    if (refusal) throw new ApiError(503, 'unavailable', MESSAGES[refusal], refusal);
  };
}

/* Work that runs only while leading, judged when the call runs: a call queued in lead that comes up after the app left
   it does nothing. */
export function whileLeading<A extends unknown[]>(mode: AppMode, work: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args) => {
    if (mode.current() === 'lead') await work(...args);
  };
}
