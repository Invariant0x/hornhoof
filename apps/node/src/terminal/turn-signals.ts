import type { Failure } from '@hornhoof/protocol';
import { isRecord, toolName } from '../providers/events.js';
import type { TermProgram } from './programs.js';
import type { Calls } from './tool-calls.js';

export type TurnEnd = { status: 'done' | 'failed' | 'stopped'; message: string; failure?: Failure };
type EndRecord = { id?: string; status?: TurnEnd['status']; diagnosed?: boolean };

/* The first end wins. A late second channel can diagnose disagreement, including while the next prompt goes in. */
export class TurnEnds {
  private current: EndRecord = {};
  private last: EndRecord | null = null;
  private readonly identified = new Map<string, EndRecord>();

  begin(): void {
    if (this.current.status) this.last = this.current;
    this.current = {};
  }

  started(id?: string): void {
    this.current.id ??= id;
  }

  end(status: TurnEnd['status'], stoppable: boolean, id?: string): { accept: boolean; conflict: boolean } {
    const different = id !== undefined && this.current.id !== undefined && id !== this.current.id;
    const record = (id !== undefined ? this.identified.get(id) : undefined) ?? (different ? this.last : !stoppable && !this.current.status ? this.last : this.current);
    if (!record || (id !== undefined && record.id !== undefined && id !== record.id)) return { accept: false, conflict: false };
    if (record.status) {
      const conflict = record.status !== status && !record.diagnosed;
      if (conflict) record.diagnosed = true;
      return { accept: false, conflict };
    }
    if (!stoppable || different) return { accept: false, conflict: false };
    record.id ??= id;
    record.status = status;
    if (record.id !== undefined) this.identified.set(record.id, record);
    return { accept: true, conflict: false };
  }
}

/* Whether a stop hook arriving now tells of a turn that is over. The host answers a turn once the program's log says it
   ended, so the stop of that same end can still be on its way, or be sent again, when the next turn begins. A stop from
   before the running turn took its prompt cannot be that turn's, nor can one from a session the agent has left. A session
   the agent came back to counts as its own, and one the host never heard of is where a cleared conversation went on.
   The stop that answers words a person sent while the prompt waited is of now too: it frees the program for the prompt. */
export function stopIsLate({ promptIn, answersPerson = false, from, session, left }: { promptIn: boolean; answersPerson?: boolean; from: unknown; session: string | null; left: ReadonlySet<string> }): boolean {
  if (!promptIn && !answersPerson) return true;
  return typeof from === 'string' && from !== session && left.has(from);
}

/* Antigravity hooks carry conversationId; accept session_id only as a fallback. */
export function agyHookSession(data: Record<string, unknown>): string | null {
  for (const value of [data.conversationId, data.session_id]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/* Antigravity runs subagents in the same workspace with their own conversation ids. Once the program's main
   conversation is known (from --conversation or its first hook), hooks from any other conversation belong to a
   subagent or a former session and must never replace the agent's session or end its turn. */
export function foreignAgyHook(
  kind: TermProgram['kind'] | undefined,
  session: string | null,
  left: ReadonlySet<string>,
  data: Record<string, unknown>,
): boolean {
  if (kind !== 'antigravity') return false;
  const from = agyHookSession(data);
  if (from === null) return false;
  return session !== null ? from !== session : left.has(from);
}

export function keepsAgySession(kind: TermProgram['kind'] | undefined, session: string | null): boolean {
  return kind === 'antigravity' && session !== null;
}

export function stopSession(kind: TermProgram['kind'] | undefined, data: Record<string, unknown>): unknown {
  return kind === 'antigravity' ? agyHookSession(data) : data.session_id;
}

export function hookCalls(event: string, data: Record<string, unknown>): Calls {
  const rawId = data.tool_use_id ?? data.tool_call_id;
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : '';
  if (!id) return { began: [], ended: [] };
  return event === 'tool' || event === 'ask'
    ? { began: [{ id, name: toolName(String(data.tool_name ?? 'tool')) }], ended: [] }
    : { began: [], ended: [id] };
}

export function claudeEnd(line: unknown, answer: string | null, error: Failure | null): TurnEnd | null {
  if (!isRecord(line) || line.type !== 'system' || line.subtype !== 'turn_duration') return null;
  return error ? { status: 'failed', message: '', failure: error } : { status: 'done', message: answer ?? '' };
}
