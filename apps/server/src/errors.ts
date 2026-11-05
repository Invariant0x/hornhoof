import { DrizzleQueryError } from 'drizzle-orm';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export type ErrorCode = 'validation' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'gone' | 'too_many' | 'unavailable';

/* A stable reason the web app turns into text in the person's language. */
export type ErrorReason =
  | 'signed_out'
  | 'cross_site'
  | 'company_scope_only'
  | 'decision_not_allowed'
  | 'owner_ceo_only'
  | 'owner_no_access'
  | 'owner_on_department'
  | 'policy_not_allowed'
  | 'policy_invalid'
  | 'decision_context_missing'
  | 'decision_context_changed'
  | 'delegate_requires_company_access'
  | 'wrong_password'
  | 'already_set_up'
  | 'setup_code'
  | 'invite_unknown'
  | 'invite_used'
  | 'email_taken'
  | 'person_unknown'
  | 'owner_locked'
  | 'self_locked'
  | 'unknown_place'
  | 'not_owner'
  | 'wrong_kind'
  | 'orchestrator_only'
  | 'not_company_level'
  | 'subscription_unknown'
  | 'code_unknown'
  | 'command_active'
  | 'code_used'
  | 'machine_unknown'
  | 'machine_offline'
  | 'programs_unavailable'
  | 'other_machine'
  | 'already_on_machine'
  | 'already_connected'
  | 'no_node_online'
  | 'browser_failed'
  | 'signin_unsupported'
  | 'needs_login'
  | 'needs_setup'
  | 'job_unknown'
  | 'too_many_attempts'
  | 'tool_token_invalid'
  | 'orchestrator_not_ready'
  | 'agent_unknown'
  | 'agent_not_ready'
  | 'not_your_department'
  | 'orchestrator_card'
  | 'orchestrator_locked'
  | 'subscription_cannot_serve'
  | 'model_unknown'
  | 'effort_unknown'
  | 'notebook_full'
  | 'note_unknown'
  | 'skill_unknown'
  | 'skill_locked'
  | 'skill_company_only'
  | 'instructions_too_long'
  | 'agent_working'
  | 'agent_has_tasks'
  | 'required_role'
  | 'no_subscription'
  | 'no_role'
  | 'nothing_running'
  | 'proposal_closed'
  | 'structure_invalid'
  | 'staff_invalid'
  | 'department_unknown'
  | 'updater_missing'
  | 'update_running'
  | 'turns_would_stop'
  | 'version_unknown'
  | 'registry_unreachable'
  | 'task_unknown'
  | 'task_closed'
  | 'task_changed'
  | 'task_not_yours'
  | 'task_invalid'
  | 'request_unknown'
  | 'request_closed'
  | 'improvement_unknown'
  | 'improvement_decided'
  | 'improvement_not_requested'
  | 'no_head'
  | 'switched_off'
  | 'turn_open'
  | 'turn_unknown'
  | 'repo_invalid'
  | 'repo_command_invalid'
  | 'attachment_invalid'
  | 'attachment_unknown'
  | 'picture_invalid'
  | 'picture_too_big'
  | 'relay_unreachable'
  | 'link_taken'
  | 'link_reserved'
  | 'link_invalid';

/* details: what the web shows with the reason's words, such as the machines it names and a command to run there. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly reason?: ErrorReason,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const body = (code: ErrorCode, message: string, reason?: ErrorReason, details?: Record<string, unknown>) => ({
  error: { code, message, ...(reason ? { reason } : {}), ...(details ? { details } : {}) },
});

/* user:password@ in an address, as in a database URL. */
const PASSWORD = /(\/\/[^\s:@/]+):[^\s@/]+@/g;
const hidden = (text: string) => text.replace(PASSWORD, '$1:***@');
const CAUSES_KEPT = 3;

/* What the log keeps of an error: what it says, its code and where it came from, with a failed query's text but not the
   values it was given, nothing of the driver's detail, and no password written into an address. */
export function loggable(err: unknown, depth = 0): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: hidden(String(err)) };
  const said = err instanceof DrizzleQueryError ? `Failed query: ${err.query}` : err.message;
  const { code } = err as { code?: unknown };
  return {
    type: err.constructor.name,
    message: hidden(said),
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    stack: hidden((err.stack ?? '').replace(err.message, said)),
    ...(err.cause !== undefined && depth < CAUSES_KEPT ? { cause: loggable(err.cause, depth + 1) } : {}),
  };
}

/* Optional handler for unmatched requests that are not errors, like the web app's own routes. */
export type Fallback = (req: FastifyRequest, reply: FastifyReply) => FastifyReply | Promise<FastifyReply> | undefined;

/* A rejected transport body keeps its original text with the caller and names the file path forward. */
function requestError(status: number, message: string, url: string) {
  if (status !== 413 || !/^\/(mcp|api\/(tasks\/[^/]+\/comments|requests\/[^/]+|agents\/[^/]+\/messages))(?:\?|$)/.test(url)) return body('validation', message);
  const next = url.startsWith('/mcp')
    ? 'Save the full text as a file and attach it with hh-attach --task <task number> FILE. Then send its file name.'
    : 'Keep the full text in a file on its task and send the file link. Your text has not been submitted.';
  return body('validation', `The text is too large to send in one request. ${next}`, 'attachment_invalid');
}

export function registerErrorHandling(app: FastifyInstance, fallback?: Fallback): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(body(err.code, err.message, err.reason, err.details));
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? first.path.join('.') + ': ' : '';
      return reply.status(400).send(body('validation', where + (first?.message ?? 'Invalid input.')));
    }
    const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status < 500) return reply.status(status).send(requestError(status, err.message, req.url));
    req.log.error({ error: loggable(err), method: req.method, route: req.routeOptions.url }, 'A request failed.');
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong.' } });
  });
  app.setNotFoundHandler(async (req, reply) => (await fallback?.(req, reply)) ?? reply.status(404).send(body('not_found', 'Not found.')));
}
