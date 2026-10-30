import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { AgentEvent, Limits } from '@hornhoof/protocol';
import { isRecord } from '../providers/events.js';

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

/* What a line of Codex's session log tells: things to show, the session, a turn's start or end, the limits. */
export type RolloutNews = { events: AgentEvent[]; session?: { id: string; cwd: string }; started?: true; ended?: { message: string }; limits?: Limits };

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
      return { events: isRecord(p.item) ? itemEvents(p.item) : [] };
    case 'task_started':
      return { events: [], started: true };
    case 'task_complete':
      return { events: [], ended: { message: String(p.last_agent_message ?? '') } };
    case 'token_count': {
      const rate = isRecord(p.rate_limits) ? p.rate_limits : null;
      if (!rate) return { events: [] };
      const windows = [rate.primary, rate.secondary].filter(isRecord).map(w => ({ name: windowName(w.window_minutes), utilization: share(w.used_percent), resetsAt: iso(w.resets_at) }));
      return { events: [], limits: { status: rate.rate_limit_reached_type ? 'rejected' : 'allowed', windows } };
    }
    default:
      return { events: [] };
  }
}

/* The limits Claude Code hands its status line: five hours and seven days. */
export function claudeStatusLimits(status: unknown): Limits | null {
  if (!isRecord(status) || !isRecord(status.rate_limits)) return null;
  const windows = Object.entries(status.rate_limits)
    .filter((e): e is [string, Record<string, unknown>] => isRecord(e[1]))
    .map(([name, w]) => ({ name, utilization: share(w.used_percentage), resetsAt: iso(w.resets_at) }));
  return { status: 'allowed', windows: windows.slice(0, 8) };
}
