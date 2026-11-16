import { PROGRAM_SCREEN_MAX, type NodeMessage, type ProgramExit, type ProgramState } from '@hornhoof/protocol';
import type { ProgramRetry } from '@hornhoof/protocol/map';
import { redact } from '../redact.js';
import { agyPrompt, atEmptyPrompt } from './input.js';
import { stripEscapes } from '../providers/process.js';
import type { TermProgram } from './programs.js';

type Kind = TermProgram['kind'];

/* A tool the program called and has no result for yet, and since when, by the node's clock. */
export type Pending = { name: string; at: number; asking?: boolean };

/* A program is ready for its first prompt once its screen shows this; Claude Code says so through its hook. */
export const READY: Record<Exclude<Kind, 'claude'>, (screen: string) => boolean> = {
  antigravity: screen => agyPrompt(screen)?.footer.startsWith('? for shortcuts') ?? false,
  codex: screen => /OpenAI Codex/.test(screen) && /›/.test(screen),
  /* The footer under Kimi's prompt, with how full its context is. */
  kimi: screen => /context: \d+%/.test(screen),
};

/* Tools that put a question to a person and wait for the answer. The programs run without asking leave for their tools. */
const QUESTIONS = new Set(['AskUserQuestion']);

/* Only the program's hooks and log say whether its turn runs and which call is pending. Its screen says only if it is gone. */
export function programState(screen: string | null, pending: Pending | null, running: boolean, retry: ProgramRetry | null = null): ProgramState {
  if (screen === null) return 'gone';
  if (!running) return 'idle';
  if (pending) return pending.asking || QUESTIONS.has(pending.name) ? 'asking' : 'tool';
  return retry ? 'retrying' : 'thinking';
}

/* An empty input stays visible during work. Only Claude's completed-duration line immediately above its current empty
   prompt proves a finished response independently of hooks. Unknown layouts and other programs give no such proof. */
export function idleScreen(kind: Kind, screen: string): boolean {
  if (kind !== 'claude' || !atEmptyPrompt(kind, screen)) return false;
  const plain = stripEscapes(screen);
  const prompt = [...plain.matchAll(/^[ \t]*❯[^\n]*$/gm)].at(-1);
  if (!prompt) return false;
  const above = plain.slice(0, prompt.index).trimEnd().replace(/(?:^|\n)[ \t]*[─━═]{2,}[ \t]*$/, '').trimEnd();
  return /(?:^|\n)[ \t]*[✻✽✢✳✶✹] [^\n…]+ for \d[^\n…]* · done [^\n]+$/.test(above);
}

/* The last 40 lines a gone program showed, rows left blank counted as one, cut to what Hornhoof takes of them. */
export function lastScreen(screen: string): string {
  return screen.trimEnd().replace(/\n(?:[ \t]*\n){2,}/g, '\n\n').split('\n').slice(-40).join('\n').slice(-PROGRAM_SCREEN_MAX);
}

/* How often the node tells what a running turn's program does when nothing changed, so Hornhoof knows the node is there
   and whether the screen moved. */
export const REPORT_MS = 60_000;

type Diagnostics = Pick<Extract<NodeMessage, { type: 'job.program' }>, 'tool' | 'exitCode' | 'signal' | 'screen'>;

/* Diagnostic strings are untrusted, including tool names. Mask every field before applying the wire limits; clipping
   first could leave part of a known secret that no longer matches the whole value. */
function diagnostics(fields: Diagnostics, secrets: string[]): Diagnostics {
  const clean = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === 'string' ? redact(value, secrets) : value])) as Diagnostics;
  if (clean.tool !== undefined) clean.tool = clean.tool.slice(0, 100);
  if (clean.screen !== undefined) clean.screen = lastScreen(clean.screen);
  return clean;
}

/* Follows what a turn's program does, look by look, and tells Hornhoof each change of its state or tool at once, and the
   same again once a minute while nothing changes. A turn without a job tells nobody. */
export class ProgramWatch {
  private screen: string | null = null;
  private screenAt = 0;
  private signAt: number | undefined;
  private retry: ProgramRetry | null = null;
  private state: ProgramState | null = null;
  private tool: string | undefined;
  private since = 0;
  private toldAt = -Infinity;
  private ended: Diagnostics = {};

  constructor(
    private jobId: string | null | undefined,
    private readonly send: (m: NodeMessage) => void,
    private readonly reportMs = REPORT_MS,
    private readonly secrets: () => string[] = () => [],
  ) {}

  /* A typed turn may have changed state or ended before the server named its job. Only that confirmed id goes out,
     with the latest observation, including a gone program's diagnostics. */
  bind(jobId: string, now: number): void {
    this.jobId = jobId;
    this.tell(now);
  }

  look(now: number, screen: string | null, pending: Pending | null, running: boolean, signAt?: number, retry: ProgramRetry | null = null): ProgramState {
    if (screen !== this.screen) Object.assign(this, { screen, screenAt: now });
    const retryChanged = JSON.stringify(this.retry) !== JSON.stringify(retry);
    this.signAt = signAt;
    this.retry = retry;
    const state = programState(screen, pending, running, retry);
    /* Only a tool or a question has a call to tell. */
    const call = state === 'tool' || state === 'asking' ? pending : null;
    if (this.changed(now, state, call) || retryChanged || this.due(now)) this.tell(now);
    return state;
  }

  /* Takes what the program does now, and whether it changed: a tool's state began when the program called it. */
  private changed(now: number, state: ProgramState, call: Pending | null): boolean {
    const tool = call?.name;
    if (state === this.state && tool === this.tool) return false;
    Object.assign(this, { state, tool, since: call?.at ?? now });
    return true;
  }

  /* The program is gone: Hornhoof hears how it ended, null both when its session went whole, and what it showed last. */
  gone(now: number, exit: ProgramExit | null, screen: string, signAt = this.signAt): void {
    this.signAt = signAt;
    this.retry = null;
    if (this.screen !== null) Object.assign(this, { screen: null, screenAt: now });
    this.changed(now, 'gone', null);
    this.ended = { exitCode: exit?.code ?? null, signal: exit?.signal ?? null, screen };
    this.tell(now);
  }

  /* Hornhoof is due to hear again what the program does, once it heard it first. */
  due(now: number): boolean {
    return this.state !== null && now - this.toldAt >= this.reportMs;
  }

  private tell(now: number): void {
    this.toldAt = now;
    if (!this.jobId || !this.state) return;
    const detail = diagnostics({ ...(this.tool ? { tool: this.tool } : {}), ...this.ended }, this.secrets());
    this.send({ type: 'job.program', jobId: this.jobId, state: this.state, since: this.since, screenAt: this.screenAt, ...(this.signAt !== undefined ? { signAt: this.signAt } : {}), ...(this.state === 'retrying' && this.retry ? { retry: this.retry } : {}), ...detail });
  }
}
