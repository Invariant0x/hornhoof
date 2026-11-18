import { createHash, randomUUID } from 'node:crypto';
import type { OperatorQuestion } from '@hornhoof/protocol/program-operator';
import { redactOperator } from '../redact.js';
import { protectedOperatorContent } from './operator-privacy.js';

const fingerprints = new WeakMap<OperatorQuestion, string>();
const workQuestions = new Set(['AskUserQuestion', 'ExitPlanMode']);

/* PermissionRequest is a program hook. AskUserQuestion belongs to the person, even when the program calls it asking. A question
   of sign-in, consent, payment or secrets is protected by its kind only: the orchestrator and Operations read it, with the
   values of secrets masked, and answer it. */
export function operatorQuestion(data: Record<string, unknown>, secrets: string[], previous?: OperatorQuestion | null): OperatorQuestion {
  const rawTool = String(data.tool_name ?? 'Permission');
  const tool = redactOperator(rawTool, secrets).slice(0, 100);
  const rawId = data.tool_use_id ?? data.tool_call_id;
  const callId = questionCallId(rawId, secrets);
  const input = questionInput(data);
  const request = redactOperator(JSON.stringify({ tool, request: input }), secrets);
  const kind = questionKind(rawTool, protectedOperatorContent(JSON.stringify({ tool: rawTool, request: input })));
  const digest = createHash('sha256').update(JSON.stringify({ request, rawId })).digest('hex');
  if (previous && fingerprints.get(previous) === digest) return previous;
  const question = { id: randomUUID(), kind, tool, text: request.slice(0, 4096), callId } satisfies OperatorQuestion;
  fingerprints.set(question, digest);
  return question;
}

function questionCallId(rawId: unknown, secrets: string[]): string | null {
  return typeof rawId === 'string' || typeof rawId === 'number' ? redactOperator(String(rawId), secrets).slice(0, 128) : null;
}

function questionKind(tool: string, protectedQuestion: boolean): OperatorQuestion['kind'] {
  if (workQuestions.has(tool)) return 'work';
  return protectedQuestion ? 'protected' : 'permission';
}

function questionInput(data: Record<string, unknown>): unknown {
  /* Grouped, so a mutant that turns one ?? into || still compiles. */
  return ((data.tool_input ?? data.input) ?? data.message) ?? null;
}
