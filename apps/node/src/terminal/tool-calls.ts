import { isRecord, toolName } from '../providers/events.js';
import { codexTool } from './transcripts.js';
import type { TermProgram } from './programs.js';

/* The tool calls a line of a program's log begins, by id with the tool's name, and those it ends, by id. A call begun and
   not yet ended is the tool the program runs now, or the question it waits on. */
export type Calls = { began: { id: string; name: string }[]; ended: string[] };

const none = (): Calls => ({ began: [], ended: [] });
const blocks = (message: unknown): Record<string, unknown>[] => (isRecord(message) && Array.isArray(message.content) ? message.content.filter(isRecord) : []);
const idOf = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/* Claude Code logs each call as a tool_use block of the assistant, and its end as a tool_result of the user with its id. */
function claudeCalls(line: unknown): Calls {
  if (!isRecord(line)) return none();
  const said = blocks(line.message);
  if (line.type === 'assistant') return { began: said.filter(b => b.type === 'tool_use' && idOf(b.id) && typeof b.name === 'string').map(b => ({ id: idOf(b.id), name: toolName(String(b.name)) })), ended: [] };
  if (line.type === 'user') return { began: [], ended: said.filter(b => b.type === 'tool_result' && idOf(b.tool_use_id)).map(b => idOf(b.tool_use_id)) };
  return none();
}

/* A loop event of Kimi Code's main agent, not of an agent it started. */
function kimiLoopEvent(line: unknown): Record<string, unknown> | null {
  if (!isRecord(line) || line.type !== 'context.append_loop_event' || !isRecord(line.event)) return null;
  return line.agentId === undefined || line.agentId === 'main' ? line.event : null;
}

/* Kimi Code logs its main agent's calls and their results as loop events, by the call's id. */
function kimiCalls(line: unknown): Calls {
  const event = kimiLoopEvent(line);
  const id = idOf(event?.toolCallId);
  if (!event || !id) return none();
  if (event.type === 'tool.call') return { began: [{ id, name: toolName(String(event.name ?? '')) }], ended: [] };
  return event.type === 'tool.result' ? { began: [], ended: [id] } : none();
}

/* Codex logs an item when it completes; one that runs a tool also when it starts. */
function codexCalls(line: unknown): Calls {
  if (!isRecord(line) || line.type !== 'event_msg' || !isRecord(line.payload) || !isRecord(line.payload.item)) return none();
  const { type } = line.payload;
  const item = line.payload.item;
  const name = codexTool(item);
  if (!name || !idOf(item.id)) return none();
  if (type === 'item_started') return { began: [{ id: idOf(item.id), name }], ended: [] };
  return type === 'item_completed' ? { began: [], ended: [idOf(item.id)] } : none();
}

export const CALLS: Record<Exclude<TermProgram['kind'], 'antigravity'>, (line: unknown) => Calls> = { claude: claudeCalls, codex: codexCalls, kimi: kimiCalls };
