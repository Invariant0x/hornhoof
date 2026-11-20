import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { AgentEvent, Failure, Limits } from '@hornhoof/protocol';
import { agyInput } from '../providers/antigravity.js';
import type { Calls } from './tool-calls.js';
import { contentText, inputText, isoFrom, isRecord, toolName } from '../providers/events.js';
import { codexFailure } from './failures.js';

/* Follows a log file a program appends to, a whole line at a time. */
export class LineTail {
  private offset: number;
  /* The start of a line the program has not ended yet. It waits as bytes, since a read can stop inside a letter. */
  private partial = Buffer.alloc(0);
  /* Whether it knows the end of the file as it read last: what it reads from now on was written from now on. A file to
     follow from its end that it could not find has no known end until it reads it. */
  private known: boolean;

  constructor(
    private readonly file: string,
    { fromEnd = false }: { fromEnd?: boolean } = {},
  ) {
    const size = fromEnd ? sizeOf(file) : 0;
    this.offset = size ?? 0;
    this.known = size !== null;
  }

  get bounded(): boolean { return this.known; }

  read(): string[] {
    const size = sizeOf(this.file);
    if (size === null) return [];
    this.known = true;
    if (size <= this.offset) return [];
    const buf = Buffer.alloc(size - this.offset);
    const fd = openSync(this.file, 'r');
    let got: number;
    try {
      got = readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset += got;
    const bytes = Buffer.concat([this.partial, buf.subarray(0, got)]);
    const end = bytes.lastIndexOf(0x0a) + 1;
    this.partial = Buffer.from(bytes.subarray(end));
    return bytes.subarray(0, end).toString('utf8').split('\n').filter(l => l.trim());
  }
}

function sizeOf(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

type AgyStep = Calls & { events: AgentEvent[]; answered?: boolean };

/* agy logs each planner response whole. The generic steps after a call are its results, in order. */
export function agySteps(): (line: unknown) => AgyStep {
  const pending: string[] = [];
  const seen = new Set<string>();
  const inputs = new Set<string>();
  return line => {
    const news: AgyStep = { events: [], began: [], ended: [] };
    const step = agyStep(line, seen, inputs);
    if (!step) return news;
    if (step.type === 'USER_INPUT') news.ended = pending.splice(0);
    if (step.type === 'PLANNER_RESPONSE') {
      news.events = agyResponse(step);
      news.began = news.events.filter(e => e.kind === 'tool').map((e, i) => ({ id: `${step.step_index}:${i}`, name: e.name }));
      pending.push(...news.began.map(c => c.id));
      news.answered = news.began.length === 0;
    }
    if (step.type === 'GENERIC' && pending.length) {
      news.ended.push(pending.shift()!);
      news.events.push({ kind: 'tool_result', ok: step.status === 'DONE', summary: typeof step.content === 'string' ? step.content : '' });
    }
    return news;
  };
}

function agyStep(line: unknown, seen: Set<string>, inputs: Set<string>): Record<string, unknown> | null {
  if (!isRecord(line) || !agyStepComplete(line)) return null;
  if (line.type === 'USER_INPUT') return agyUserStep(line, seen, inputs);
  const key = typeof line.step_index === 'number' ? `${line.type}:${line.step_index}` : null;
  if (key && seen.has(key)) return null;
  if (key) seen.add(key);
  return line;
}

function agyUserStep(line: Record<string, unknown>, seen: Set<string>, inputs: Set<string>): Record<string, unknown> | null {
  const key = JSON.stringify([line.step_index, line.created_at, line.source, line.content]);
  if (inputs.has(key)) return null;
  inputs.add(key);
  seen.clear();
  return line;
}

/* Preserve records without status; an explicit running snapshot cannot finish a tool or publish an answer. */
function agyStepComplete(line: Record<string, unknown>): boolean {
  return line.status === undefined || line.status === 'DONE' || line.status === 'ERROR';
}

function agyResponse(line: Record<string, unknown>): AgentEvent[] {
  const events: AgentEvent[] = typeof line.content === 'string' && line.content.trim() ? [{ kind: 'text', text: line.content }] : [];
  const calls = Array.isArray(line.tool_calls) ? line.tool_calls.filter(isRecord) : [];
  for (const call of calls) events.push({ kind: 'tool', name: toolName(String(call.name ?? 'tool')), input: agyInput(call.args) });
  return events;
}

/* The native terminal keeps agy's stderr. Only a detail for this Stop's reason belongs to its failure. */
const agyErrors = (output: string) => output.split('\n').filter(line => line.includes('AGY_ERROR: '));

export function agyError(output: string, reason: unknown): Record<string, unknown> | null {
  const line = agyErrors(output).at(-1);
  if (!line) return null;
  try {
    const detail: unknown = JSON.parse(line.slice(line.indexOf('AGY_ERROR: ') + 'AGY_ERROR: '.length));
    return isRecord(detail) && typeof detail.short_error === 'string' && (reason === undefined || detail.short_error === reason) ? detail : null;
  } catch {
    /* A partial diagnostic leaves the hook's original reason intact. */
    return null;
  }
}

const share = (percent: unknown) => (typeof percent === 'number' ? Math.min(1, Math.max(0, percent / 100)) : null);

/* Codex names its windows by minutes; Hornhoof by the names Claude Code uses. */
function windowName(minutes: unknown): string {
  if (minutes === 300) return 'five_hour';
  if (minutes === 10080) return 'seven_day';
  return typeof minutes === 'number' ? `${minutes}_minutes` : 'window';
}

/* What a line of Codex's session log tells: things to show, the session, a turn's start, what a person typed, the turn's
   end, failure or that a person stopped it, the limits, how full the context is. */
type RolloutNews = { events: AgentEvent[]; session?: { id: string; cwd: string }; started?: true; typed?: string; ended?: { message: string }; aborted?: true; failed?: Failure; limits?: Limits; context?: number };

/* Codex counts its context past the part every session starts with, and so does Hornhoof, to show what its screen shows. */
const CODEX_BASELINE = 12_000;

function codexContext(info: unknown): number | null {
  if (!isRecord(info) || !isRecord(info.last_token_usage)) return null;
  const tokens = info.last_token_usage.total_tokens;
  const window = info.model_context_window;
  if (typeof tokens !== 'number' || typeof window !== 'number' || window <= CODEX_BASELINE) return null;
  return Math.min(1, Math.max(0, (tokens - CODEX_BASELINE) / (window - CODEX_BASELINE)));
}

const textOf = (content: unknown) =>
  Array.isArray(content)
    ? content
        .filter(isRecord)
        .map(c => (typeof c.text === 'string' ? c.text : ''))
        .join('')
    : '';
const json = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? {}));

/* The tool a Codex item runs, by the name people read: a command, a change of files, or a tool of an MCP server. */
export function codexTool(item: Record<string, unknown>): string | null {
  if (item.type === 'CommandExecution') return 'Bash';
  if (item.type === 'FileChange') return 'Edit';
  return item.type === 'McpToolCall' ? `${String(item.server ?? '')}.${String(item.tool ?? '')}` : null;
}

function itemEvents(item: Record<string, unknown>): AgentEvent[] {
  const name = String(codexTool(item));
  switch (item.type) {
    case 'AgentMessage': {
      const text = textOf(item.content);
      return text.trim() ? [{ kind: 'text', text }] : [];
    }
    case 'CommandExecution':
      return [
        { kind: 'tool', name, input: String(item.command ?? '') },
        { kind: 'tool_result', ok: item.exit_code === 0, summary: String(item.aggregated_output ?? '') },
      ];
    case 'FileChange':
      return [
        { kind: 'tool', name, input: Object.keys(isRecord(item.changes) ? item.changes : {}).join(', ') },
        { kind: 'tool_result', ok: item.status === 'completed', summary: String(item.stdout || item.stderr || '') },
      ];
    case 'McpToolCall': {
      const error = isRecord(item.error) ? String(item.error.message ?? '') : '';
      return [
        { kind: 'tool', name, input: json(item.arguments) },
        { kind: 'tool_result', ok: item.status === 'completed', summary: error || textOf(isRecord(item.result) ? item.result.content : undefined) },
      ];
    }
    default:
      return [];
  }
}

export function codexRollout(line: unknown): RolloutNews {
  if (!isRecord(line) || !isRecord(line.payload)) return { events: [] };
  const p = line.payload;
  if (line.type === 'session_meta' && typeof p.id === 'string') return { events: [], session: { id: p.id, cwd: String(p.cwd ?? '') } };
  if (line.type !== 'event_msg') return { events: [] };
  switch (p.type) {
    case 'item_completed':
      if (isRecord(p.item) && p.item.type === 'UserMessage') return { events: [], typed: textOf(p.item.content) };
      return { events: isRecord(p.item) ? itemEvents(p.item) : [] };
    case 'task_started':
      return { events: [], started: true };
    case 'turn_aborted':
      return { events: [], aborted: true };
    case 'task_complete':
      if (isRecord(p.error)) return { events: [], failed: codexFailure(p.error) };
      return { events: [], ended: { message: String(p.last_agent_message ?? '') } };
    case 'token_count': {
      const news: RolloutNews = { events: [] };
      const context = codexContext(p.info);
      if (context !== null) news.context = context;
      const rate = isRecord(p.rate_limits) ? p.rate_limits : null;
      if (!rate) return news;
      const windows = [rate.primary, rate.secondary].filter(isRecord).map(w => ({ name: windowName(w.window_minutes), utilization: share(w.used_percent), resetsAt: isoFrom(w.resets_at) }));
      return { ...news, limits: { status: rate.rate_limit_reached_type ? 'rejected' : 'allowed', windows, complete: true } };
    }
    default:
      return { events: [] };
  }
}

/* What a line of the main agent's log in Kimi Code tells: things to show, a turn's start and its words, how it ended,
   which model runs and how many tokens its context holds. Kimi logs a turn's end without its answer, which is the turn's
   last text, or with an error's code and message when it failed. */
export type WireNews = { events: AgentEvent[]; started?: true; prompt?: string; ended?: true; aborted?: true; failed?: string; step?: true; blocked?: true; tokens?: number; model?: string; retry?: { attempt: number; max: number | null; delayMs: number } };

function loopEvents(event: Record<string, unknown>): AgentEvent[] {
  switch (event.type) {
    case 'content.part': {
      const part = isRecord(event.part) ? event.part : {};
      return part.type === 'text' && typeof part.text === 'string' && part.text.trim() ? [{ kind: 'text', text: part.text }] : [];
    }
    case 'tool.call':
      return [{ kind: 'tool', name: toolName(String(event.name ?? '')), input: inputText(event.args) }];
    case 'tool.result': {
      const result = isRecord(event.result) ? event.result : {};
      return [{ kind: 'tool_result', ok: result.isError !== true, summary: contentText(result.output) }];
    }
    default:
      return [];
  }
}

export function kimiWire(line: unknown): WireNews {
  if (!isRecord(line) || (line.agentId !== undefined && line.agentId !== 'main')) return { events: [] };
  switch (line.type) {
    case 'context.append_loop_event':
      if (isRecord(line.event) && line.event.type === 'step.begin') return { events: [], step: true };
      return { events: isRecord(line.event) ? loopEvents(line.event) : [] };
    /* A prompt hook of the person's own said no: the prompt is over, and no turn starts or ends for it. */
    case 'prompt.completed':
      return line.reason === 'blocked' ? { events: [], failed: 'A hook in Kimi Code blocked this message.', blocked: true } : { events: [] };
    case 'turn.step.retrying':
      return typeof line.failedAttempt === 'number' && typeof line.delayMs === 'number'
        ? { events: [], retry: { attempt: Math.max(1, Math.trunc(line.failedAttempt)), max: typeof line.maxAttempts === 'number' ? Math.max(1, Math.trunc(line.maxAttempts)) : null, delayMs: Math.max(0, line.delayMs) } }
        : { events: [] };
    /* A turn starts with the words it took, which tell whose they are. */
    case 'turn.prompt':
      return { events: [], started: true, prompt: contentText(line.input) };
    /* Kimi counts its context again as it grows, is compacted or a turn ends; each count is the size now. */
    case 'token_counting.measured':
    case 'token_counting.truncated':
    case 'token_counting.rebased':
    case 'token_counting.turn_recorded':
      return typeof line.tokens === 'number' ? { events: [], tokens: line.tokens } : { events: [] };
    /* The model Kimi runs now, also when a person picked another one with /model. */
    case 'config.update':
      return typeof line.modelAlias === 'string' && line.modelAlias ? { events: [], model: line.modelAlias } : { events: [] };
    case 'turn.ended': {
      if (line.reason === 'completed') return { events: [], ended: true };
      if (line.reason === 'cancelled') return { events: [], aborted: true };
      const error = isRecord(line.error) ? line.error : {};
      const message = typeof error.message === 'string' ? error.message : '';
      const code = typeof error.code === 'string' ? error.code : '';
      return { events: [], failed: [code, message].filter(Boolean).join(': ') || String(line.reason ?? 'failed') };
    }
    default:
      return { events: [] };
  }
}

/* The plan's limits from Kimi's usage page: five hours, and seven days or a month, each used as a share. A plan counts
   a month of all its work and of Kimi Code's alone; the fuller one runs out first and speaks for both. */
export function kimiUsageLimits(page: unknown): Limits | null {
  if (!isRecord(page) || !isRecord(page.usages)) return null;
  const usages = page.usages;
  const read = (name: string, w: unknown) => {
    const used = isRecord(w) ? Number(w.used_ratio) : NaN;
    if (!isRecord(w) || !Number.isFinite(used)) return [];
    const reset = typeof w.reset_time === 'string' ? new Date(w.reset_time) : null;
    return [{ name, utilization: Math.min(1, Math.max(0, used)), resetsAt: reset && !Number.isNaN(reset.getTime()) ? reset.toISOString() : null }];
  };
  const month = [...read('month', usages.limit_month_total), ...read('month', usages.limit_month_code)].sort((a, b) => b.utilization - a.utilization).slice(0, 1);
  const windows = [...read('five_hour', usages.limit_5h), ...read('seven_day', usages.limit_7d), ...month];
  if (!windows.length) return null;
  return { status: windows.some(w => w.utilization >= 1) ? 'rejected' : 'allowed', windows, complete: true };
}

/* The plan's limits from Claude's usage page, the one its /usage shows: five hours and seven days, used in percent, and
   a week of one model, such as seven_day_opus, where the plan counts it apart and that week can run out first. */
export function claudeUsageLimits(page: unknown): Limits | null {
  if (!isRecord(page)) return null;
  const names = ['five_hour', 'seven_day', ...Object.keys(page).filter(name => /^seven_day_[a-z]+$/.test(name))];
  const windows = names.flatMap(name => {
    const w = page[name];
    const used = isRecord(w) ? share(w.utilization) : null;
    if (!isRecord(w) || used === null) return [];
    const reset = typeof w.resets_at === 'string' ? new Date(w.resets_at) : null;
    return [{ name, utilization: used, resetsAt: reset && !Number.isNaN(reset.getTime()) ? reset.toISOString() : null }];
  });
  if (!windows.length) return null;
  return { status: windows.some(w => w.utilization >= 1) ? 'rejected' : 'allowed', windows: windows.slice(0, 8), complete: true };
}

/* How full Claude Code's context is, from its status line. */
export function claudeStatusContext(status: unknown): number | null {
  return isRecord(status) && isRecord(status.context_window) ? share(status.context_window.used_percentage) : null;
}

/* The limits Claude Code hands its status line: every unified window the plan reports, such as five hours and seven days. */
export function claudeStatusLimits(status: unknown): Limits | null {
  if (!isRecord(status) || !isRecord(status.rate_limits)) return null;
  const windows = Object.entries(status.rate_limits).flatMap(([name, w]) => {
    const used = isRecord(w) ? share(w.used_percentage) : null;
    return isRecord(w) && used !== null ? [{ name, utilization: used, resetsAt: isoFrom(w.resets_at) }] : [];
  });
  if (!windows.length) return null;
  return { status: windows.some(w => w.utilization >= 1) ? 'rejected' : 'allowed', windows: windows.slice(0, 8), complete: true };
}
