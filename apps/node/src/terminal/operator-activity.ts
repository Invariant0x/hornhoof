import { isRecord } from '../providers/events.js';
import type { TermProgram } from './programs.js';

const nonempty = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;
const thoughtParts = (value: unknown): boolean => Array.isArray(value) && value.some(nonempty);
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const sameTurn = (value: unknown, turnId?: string): boolean => !turnId || value === undefined || value === turnId;

/* These private program records disarm first-activity detection without publishing any reasoning content. */
export function ownThought(kind: TermProgram['kind'], line: Record<string, unknown>, turnId?: string): boolean {
  if (kind === 'claude') return claudeThought(line);
  if (kind === 'kimi') return kimiThought(line, turnId);
  if (kind === 'codex') return codexThought(line, turnId);
  return false;
}

function claudeThought(line: Record<string, unknown>): boolean {
  const message = record(line.message);
  return line.type === 'assistant' && line.isSidechain !== true && line.isApiErrorMessage !== true
    && Array.isArray(message.content) && message.content.some(thinkingPart);
}

function thinkingPart(value: unknown): boolean {
  return isRecord(value) && value.type === 'thinking' && nonempty(value.thinking);
}

function kimiThought(line: Record<string, unknown>, turnId?: string): boolean {
  const event = record(line.event), part = record(event.part);
  return line.type === 'context.append_loop_event' && (line.agentId === undefined || line.agentId === 'main')
    && sameTurn(event.turnId, turnId) && event.type === 'content.part' && part.type === 'think' && nonempty(part.think);
}

function codexThought(line: Record<string, unknown>, turnId?: string): boolean {
  const payload = record(line.payload), item = record(payload.item);
  if (line.type !== 'event_msg' || !sameTurn(payload.turn_id, turnId)) return false;
  if (payload.type === 'agent_reasoning' || payload.type === 'agent_reasoning_raw_content') return nonempty(payload.text);
  return payload.type === 'item_completed' && item.type === 'Reasoning' && (thoughtParts(item.summary_text) || thoughtParts(item.raw_content));
}
