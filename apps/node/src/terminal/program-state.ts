import { PROGRAM_SCREEN_MAX, type NodeMessage, type ProgramExit, type ProgramState } from '@hornhoof/protocol';
import { stripEscapes } from '../providers/process.js';
import { atEmptyPrompt } from './input.js';
import type { TermProgram } from './programs.js';

type Kind = TermProgram['kind'];
/* A tool the program called and has no result for yet, and since when, by the node's clock. */
export type Pending = { name: string; at: number };

/* A program is ready for its first prompt once its screen shows this; Claude Code and Hornhoof's screen for Antigravity
   say so through their hook instead. */
export const READY: Record<'codex' | 'kimi', (screen: string) => boolean> = {
  codex: screen => /OpenAI Codex/.test(screen) && /›/.test(screen),
  /* The footer under Kimi's prompt, with how full its context is. */
  kimi: screen => /context: \d+%/.test(screen),
};

/* A program at work shows it, so a long thought whose log is quiet is no lost end. Claude Code and Codex show how to stop
   them under their spinner; Hornhoof's screen for Antigravity shows its prompt again only once agy answered; Kimi Code's
   screen does not tell, so its log does: running is that it said it took the turn and not yet that the turn ended. */
export const BUSY: Record<Kind, (screen: string, running: boolean) => boolean> = {
  claude: screen => /esc to interrupt/i.test(stripEscapes(screen)),
  codex: screen => /esc to interrupt/i.test(stripEscapes(screen)),
  kimi: (_screen, running) => running,
  antigravity: screen => !atEmptyPrompt('antigravity', screen),
};

/* Tools that put a question to a person and wait for the answer. The programs run without asking leave for their tools. */
const QUESTIONS = new Set(['AskUserQuestion']);

/* What the program does now: gone with its session; waiting for what to type at its empty prompt, not at work, whatever
   its log still owes; asking or running the oldest tool it has no result for; else thinking. */
export function programState(kind: Kind, screen: string | null, pending: Pending | null, running: boolean): ProgramState {
  if (screen === null) return 'gone';
  if (!BUSY[kind](screen, running) && atEmptyPrompt(kind, screen)) return 'idle';
  if (pending) return QUESTIONS.has(pending.name) ? 'asking' : 'tool';
  return 'thinking';
}

/* The last 40 lines a gone program showed, rows left blank counted as one, cut to what Hornhoof takes of them. */
export function lastScreen(screen: string): string {
  return screen.trimEnd().replace(/\n(?:[ \t]*\n){2,}/g, '\n\n').split('\n').slice(-40).join('\n').slice(-PROGRAM_SCREEN_MAX);
}

/* How often the node tells what a running turn's program does when nothing changed, so Hornhoof knows the node is there
   and whether the screen moved. */
export const REPORT_MS = 60_000;

/* Follows what a turn's program does, look by look, and tells Hornhoof each change of its state or tool at once, and the
   same again once a minute while nothing changes. A turn without a job tells nobody. */
export class ProgramWatch {
  private screen: string | null = null;
  private screenAt = 0;
  private state: ProgramState | null = null;
  private tool: string | undefined;
  private since = 0;
  private toldAt = -Infinity;

  constructor(
    private readonly jobId: string | null | undefined,
    private readonly kind: Kind,
    private readonly send: (m: NodeMessage) => void,
    private readonly reportMs = REPORT_MS,
  ) {}

  look(now: number, screen: string | null, pending: Pending | null, running: boolean): ProgramState {
    if (screen !== this.screen) Object.assign(this, { screen, screenAt: now });
    const state = programState(this.kind, screen, pending, running);
    /* Only a tool or a question has a call to tell. */
    const call = state === 'tool' || state === 'asking' ? pending : null;
    if (this.changed(now, state, call) || this.due(now)) this.tell(now);
    return state;
  }

  /* Takes what the program does now, and whether it changed: a tool's state began when the program called it. */
  private changed(now: number, state: ProgramState, call: Pending | null): boolean {
    const tool = call?.name.slice(0, 100);
    if (state === this.state && tool === this.tool) return false;
    Object.assign(this, { state, tool, since: call?.at ?? now });
    return true;
  }

  /* The program is gone: Hornhoof hears how it ended, null both when its session went whole, and what it showed last. */
  gone(now: number, exit: ProgramExit | null, screen: string): void {
    if (this.screen !== null) Object.assign(this, { screen: null, screenAt: now });
    this.changed(now, 'gone', null);
    this.tell(now, { exitCode: exit?.code ?? null, signal: exit?.signal ?? null, screen: lastScreen(screen) });
  }

  /* Hornhoof is due to hear again what the program does, once it heard it first. */
  due(now: number): boolean {
    return this.state !== null && now - this.toldAt >= this.reportMs;
  }

  /* How long the program has waited for what to type, or 0 while it does anything else. */
  idleFor(now: number): number {
    return this.state === 'idle' ? now - this.since : 0;
  }

  private tell(now: number, ended: Pick<Extract<NodeMessage, { type: 'job.program' }>, 'exitCode' | 'signal' | 'screen'> = {}): void {
    this.toldAt = now;
    if (!this.jobId || !this.state) return;
    this.send({ type: 'job.program', jobId: this.jobId, state: this.state, since: this.since, ...(this.tool ? { tool: this.tool } : {}), screenAt: this.screenAt, ...ended });
  }
}
