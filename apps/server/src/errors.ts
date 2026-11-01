import { DrizzleQueryError } from 'drizzle-orm';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export type ErrorCode = 'validation' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'gone' | 'too_many' | 'unavailable';

/* A stable reason the web app turns into text in the person's language. */
export type ErrorReason =
  | 'signed_out'
  | 'company_scope_only'
  | 'wrong_password'
  | 'already_set_up'
  | 'invite_unknown'
  | 'invite_used'
  | 'email_taken'
  | 'person_unknown'
  | 'owner_locked'
  | 'self_locked'
  | 'unknown_place'
  | 'not_owner'
  | 'orchestrator_only'
  | 'already_connected'
  | 'not_company_level'
  | 'subscription_unknown'
  | 'code_unknown'
  | 'code_used'
  | 'machine_unknown'
  | 'machine_offline'
  | 'needs_login'
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
  | 'no_subscription'
  | 'no_role'
  | 'nothing_running'
  | 'proposal_closed'
  | 'structure_invalid'
  | 'staff_invalid'
  | 'department_unknown'
  | 'updater_missing'
  | 'update_running'
  | 'version_unknown'
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
  | 'attachment_invalid'
  | 'attachment_unknown';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly reason?: ErrorReason,
  ) {
    super(message);
  }
}

const body = (code: ErrorCode, message: string, reason?: ErrorReason) => ({ error: reason ? { code, message, reason } : { code, message } });

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

export function registerErrorHandling(app: FastifyInstance, fallback?: Fallback): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(body(err.code, err.message, err.reason));
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? first.path.join('.') + ': ' : '';
      return reply.status(400).send(body('validation', where + (first?.message ?? 'Invalid input.')));
    }
    const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status < 500) return reply.status(status).send(body('validation', err.message));
    req.log.error({ error: loggable(err), method: req.method, route: req.routeOptions.url }, 'A request failed.');
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong.' } });
  });
  app.setNotFoundHandler(async (req, reply) => (await fallback?.(req, reply)) ?? reply.status(404).send(body('not_found', 'Not found.')));
}
