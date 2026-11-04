import { isRecord } from '../providers/events.js';
import type { TermProgram } from './programs.js';

const nonempty = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;
const thoughtParts = (value: unknown): boolean => Array.isArray(value) && value.some(nonempty);

/* These private program records disarm first-activity detection without publishing any reasoning content. */
export function ownThought(kind: TermProgram['kind'], line: Record<string, unknown>, turnId?: string): boolean {
  if (kind === 'claude') {
    const message = isRecord(line.message) ? line.message : {};
    return line.type === 'assistant' && line.isSidechain !== true && line.isApiErrorMessage !== true && Array.isArray(message.content)
      && message.content.some(part => isRecord(part) && part.type === 'thinking' && nonempty(part.thinking));
  }
  if (kind === 'kimi') {
    const event = isRecord(line.event) ? line.event : {}, part = isRecord(event.part) ? event.part : {};
    return line.type === 'context.append_loop_event' && (line.agentId === undefined || line.agentId === 'main')
      && (!turnId || event.turnId === undefined || event.turnId === turnId) && event.type === 'content.part' && part.type === 'think' && nonempty(part.think);
  }
  if (kind === 'codex') {
    const payload = isRecord(line.payload) ? line.payload : {}, item = isRecord(payload.item) ? payload.item : {};
    if (line.type !== 'event_msg' || (turnId && payload.turn_id !== undefined && payload.turn_id !== turnId)) return false;
    if (payload.type === 'agent_reasoning' || payload.type === 'agent_reasoning_raw_content') return nonempty(payload.text);
    return payload.type === 'item_completed' && item.type === 'Reasoning' && (thoughtParts(item.summary_text) || thoughtParts(item.raw_content));
  }
  return false;
}
