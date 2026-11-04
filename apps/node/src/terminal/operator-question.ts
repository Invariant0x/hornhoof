import { randomUUID } from 'node:crypto';
import type { OperatorQuestion } from '@hornhoof/protocol/program-operator';
import { redact } from '../redact.js';

/* PermissionRequest is a program hook. AskUserQuestion belongs to the person, even when the program calls it asking. */
export function operatorQuestion(data: Record<string, unknown>, secrets: string[], previous?: OperatorQuestion | null): OperatorQuestion {
  const tool = redact(String(data.tool_name ?? 'Permission'), secrets).slice(0, 100);
  const rawId = data.tool_use_id ?? data.tool_call_id;
  const callId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).slice(0, 128) : null;
  const text = redact(JSON.stringify({ tool, request: data.tool_input ?? data.input ?? data.message ?? null }), secrets).slice(0, 4096);
  const kind = tool === 'AskUserQuestion' ? 'work' : 'permission';
  if (previous?.tool === tool && previous.callId === callId && previous.text === text) return previous;
  return { id: randomUUID(), kind, tool, text, callId };
}
