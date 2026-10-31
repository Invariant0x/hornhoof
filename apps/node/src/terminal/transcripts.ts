import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { AgentEvent, Limits } from '@hornhoof/protocol';
import { contentText, inputText, isRecord, toolName } from '../providers/events.js';

/* Follows a log file a program appends to, a whole line at a time. */
export class LineTail {
  private offset: number;
  private partial = '';

  constructor(
    private readonly file: string,
    { fromEnd = false }: { fromEnd?: boolean } = {},
  ) {
    this.offset = fromEnd ? sizeOf(file) : 0;
  }

  read(): string[] {
    const size = sizeOf(this.file);
    if (size <= this.offset) return [];
    const buf = Buffer.alloc(size - this.offset);
    const fd = openSync(this.file, 'r');
    try {
      readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const lines = (this.partial + buf.toString('utf8')).split('\n');
    this.partial = lines.pop() ?? '';
    return lines.filter(l => l.trim());
  }
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

const iso = (epochSeconds: unknown) => (typeof epochSeconds === 'number' ? new Date(epochSeconds * 1000).toISOString() : null);
const share = (percent: unknown) => (typeof percent === 'number' ? Math.min(1, Math.max(0, percent / 100)) : null);

/* Codex names its windows by minutes; Hornhoof by the names Claude Code uses. */
function windowName(minutes: unknown): string {
  if (minutes === 300) return 'five_hour';
  if (minutes === 10080) return 'seven_day';
  return typeof minutes === 'number' ? `${minutes}_minutes` : 'window';
}

/* What a line of Codex's session log tells: things to show, the session, a turn's start, what a person typed, the turn's
   end or that a person stopped it, the limits, how full the context is. */
export type RolloutNews = { events: AgentEvent[]; session?: { id: string; cwd: string }; started?: true; typed?: string; ended?: { message: string }; aborted?: true; limits?: Limits; context?: number };

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

function itemEvents(item: Record<string, unknown>): AgentEvent[] {
  switch (item.type) {
    case 'AgentMessage': {
      const text = textOf(item.content);
      return text.trim() ? [{ kind: 'text', text }] : [];
    }
    case 'CommandExecution':
      return [
        { kind: 'tool', name: 'Bash', input: String(item.command ?? '') },
        { kind: 'tool_result', ok: item.exit_code === 0, summary: String(item.aggregated_output ?? '') },
      ];
    case 'FileChange':
      return [
        { kind: 'tool', name: 'Edit', input: Object.keys(isRecord(item.changes) ? item.changes : {}).join(', ') },
        { kind: 'tool_result', ok: item.status === 'completed', summary: String(item.stdout || item.stderr || '') },
      ];
    case 'McpToolCall': {
      const error = isRecord(item.error) ? String(item.error.message ?? '') : '';
      return [
        { kind: 'tool', name: `${String(item.server ?? '')}.${String(item.tool ?? '')}`, input: json(item.arguments) },
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
      return { events: [], ended: { message: String(p.last_agent_message ?? '') } };
    case 'token_count': {
      const news: RolloutNews = { events: [] };
      const context = codexContext(p.info);
      if (context !== null) news.context = context;
      const rate = isRecord(p.rate_limits) ? p.rate_limits : null;
      if (!rate) return news;
      const windows = [rate.primary, rate.secondary].filter(isRecord).map(w => ({ name: windowName(w.window_minutes), utilization: share(w.used_percent), resetsAt: iso(w.resets_at) }));
      return { ...news, limits: { status: rate.rate_limit_reached_type ? 'rejected' : 'allowed', windows } };
    }
    default:
      return { events: [] };
  }
}

/* What a line of the main agent's log in Kimi Code tells: things to show, a turn's start, how it ended, which model runs
   and how many tokens its context holds. Kimi logs a turn's end without its answer, which is the turn's last text. Read
   from Kimi Code 2.4's source, not yet from a signed-in run. */
export type WireNews = { events: AgentEvent[]; started?: true; ended?: true; aborted?: true; failed?: string; step?: true; blocked?: true; tokens?: number; model?: string };

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
    case 'turn.prompt':
      return { events: [], started: true };
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
      const error = isRecord(line.error) && typeof line.error.message === 'string' ? line.error.message : '';
      return { events: [], failed: error || String(line.reason ?? 'failed') };
    }
    default:
      return { events: [] };
  }
}

/* The plan's limits from Kimi's usage page: five hours and seven days, each used as a share. */
export function kimiUsageLimits(page: unknown): Limits | null {
  if (!isRecord(page) || !isRecord(page.usages)) return null;
  const usages = page.usages;
  const windows = (
    [
      ['five_hour', usages.limit_5h],
      ['seven_day', usages.limit_7d],
    ] as const
  ).flatMap(([name, w]) => {
    const used = isRecord(w) ? Number(w.used_ratio) : NaN;
    if (!isRecord(w) || !Number.isFinite(used)) return [];
    const reset = typeof w.reset_time === 'string' ? new Date(w.reset_time) : null;
    return [{ name, utilization: Math.min(1, Math.max(0, used)), resetsAt: reset && !Number.isNaN(reset.getTime()) ? reset.toISOString() : null }];
  });
  if (!windows.length) return null;
  return { status: windows.some(w => w.utilization >= 1) ? 'rejected' : 'allowed', windows };
}

/* How full Claude Code's context is, from its status line. */
export function claudeStatusContext(status: unknown): number | null {
  return isRecord(status) && isRecord(status.context_window) ? share(status.context_window.used_percentage) : null;
}

/* The limits Claude Code hands its status line: five hours and seven days. */
export function claudeStatusLimits(status: unknown): Limits | null {
  if (!isRecord(status) || !isRecord(status.rate_limits)) return null;
  const windows = Object.entries(status.rate_limits)
    .filter((e): e is [string, Record<string, unknown>] => isRecord(e[1]))
    .map(([name, w]) => ({ name, utilization: share(w.used_percentage), resetsAt: iso(w.resets_at) }));
  return { status: 'allowed', windows: windows.slice(0, 8) };
}
