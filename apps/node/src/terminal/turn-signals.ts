import type { Failure } from '@hornhoof/protocol';
import { isRecord, toolName } from '../providers/events.js';
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
