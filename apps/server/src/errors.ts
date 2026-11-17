import { DrizzleQueryError } from 'drizzle-orm';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { notConfirmed, requestRoute } from './db/confirm.js';
import { isLeaseRefused } from './db/net.js';

export type ErrorCode = 'validation' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'gone' | 'too_many' | 'unavailable';

/* A stable reason the web app turns into text in the person's language. */
export type ErrorReason =
  | 'signed_out'
  | 'cross_site'
  | 'company_scope_only'
  | 'department_owner_only'
  | 'decision_not_allowed'
  | 'owner_ceo_only'
  | 'owner_no_access'
  | 'owner_on_department'
  | 'policy_not_allowed'
  | 'policy_invalid'
  | 'autonomous_release_not_allowed'
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
  | 'internal_address'
  | 'not_api_key'
  | 'models_internal_address'
  | 'models_redirect'
  | 'models_too_large'
  | 'models_timeout'
  | 'models_unreachable'
  | 'models_bad_answer'
  | 'models_refused'
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
  | 'machine_updating'
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
  | 'letter_unknown'
  | 'agent_not_ready'
  | 'not_your_department'
  | 'agent_hidden'
  | 'task_hidden'
  | 'ceo_view_only'
  | 'attachment_hidden'
  | 'orchestrator_card'
  | 'orchestrator_locked'
  | 'subscription_cannot_serve'
  | 'model_unknown'
  | 'fallback_invalid'
  | 'effort_unknown'
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
  | 'task_paused'
  | 'task_changed'
  | 'task_not_yours'
  | 'test_mode_conflict'
  | 'tests_not_release'
  | 'task_invalid'
  | 'goal_unknown'
  | 'goal_changed'
  | 'goal_invalid'
  | 'pipeline_unknown'
  | 'pipeline_changed'
  | 'pipeline_invalid'
  | 'stage_gone'
  | 'responsible_invalid'
  | 'view_as_ceo_only'
  | 'urgent_not_allowed'
  | 'urgent_follows_parent'
  | 'urgent_only_team'
  | 'request_unknown'
  | 'request_closed'
  | 'improvement_unknown'
  | 'improvement_decided'
  | 'backlog_unknown'
  | 'backlog_changed'
  | 'improvement_not_requested'
  | 'improvement_platform_elsewhere'
  | 'improvement_not_platform'
  | 'feedback_changed'
  | 'feedback_person_only'
  | 'feedback_refused'
  | 'feedback_unknown'
  | 'feedback_issued'
  | 'feedback_no_github_key'
  | 'feedback_issue_refused'
  | 'feedback_not_sent'
  | 'feedback_no_repeats'
  | 'no_head'
  | 'switched_off'
  | 'turn_open'
  | 'turn_unknown'
  | 'turn_mode_fixed'
  | 'turn_department'
  | 'no_turnkey_team'
  | 'repo_invalid'
  | 'repo_command_invalid'
  | 'repo_folder_taken'
  | 'product_taken'
  | 'repo_host_invalid'
  | 'repo_host_on_product'
  | 'repo_host_missing'
  | 'repo_host_refused'
  | 'repo_name_invalid'
  | 'repo_exists'
  | 'google_sheets_invalid'
  | 'google_sheets_share_needed'
  | 'vault_invalid'
  | 'vault_unknown'
  | 'vault_not_allowed'
  | 'vault_name_taken'
  | 'phone_invalid'
  | 'phone_unknown'
  | 'phone_not_allowed'
  | 'phone_unavailable'
  | 'phone_busy'
  | 'phone_session_gone'
  | 'attachment_invalid'
  | 'attachment_unknown'
  | 'file_empty'
  | 'file_too_big'
  | 'file_link_expired'
  | 'file_lost'
  | 'relay_unreachable'
  | 'link_taken'
  | 'link_reserved'
  | 'link_invalid'
  | 'maintenance'
  | 'read_only'
  | 'not_confirmed'
  | 'already_done'
  | 'not_keeper'
  | 'no_machine_id'
  | 'key_changed'
  | 'not_a_machine'
  | 'ticket_used'
  | 'machine_taken'
  | 'renew_refused'
  | 'core_present'
  | 'key_exists'
  | 'not_machine_owner'
  | 'machine_unreachable'
  | 'no_core'
  | 'grant_needed'
  | 'confirm_needed'
  | 'bad_grant'
  | 'key_not_held'
  | 'no_key'
  | 'recovery_file_invalid'
  | 'restore_busy'
  | 'merge_pending'
  | 'leader_scope'
  | 'leader_pin'
  | 'already_leader'
  | 'no_number'
  | 'updating'
  | 'switching'
  | 'moving'
  | 'leader'
  | 'server_install'
  | 'only_copy'
  | 'unfit'
  | 'try_again'
  | 'not_data'
  | 'no_age_key'
  | 'not_pending'
  | 'restore_running'
  | 'newer_build'
  | 'not_held'
  | 'needs_recovery_file'
  | 'challenge_refused'
  | 'bundle_refused'
  | 'have_it'
  | 'not_recovering'
  | 'no_authority'
  | 'not_owner_session'
  | 'question_changed'
  | 'merge_pending'
  | `bundle_${'format' | 'authority' | 'role' | 'time' | 'signature' | 'company' | 'size' | 'hash' | 'content' | 'key' | 'room' | 'idle'}`
  | 'starting'
  | 'telegram_token'
  | 'telegram_unreachable'
  | 'telegram_taken'
  | 'telegram_heads_only'
  | 'telegram_invalid'
  | 'telegram_person_taken'
  | 'assistant_owner_invalid'
  | 'not_an_assistant'
  | 'assistant_no_sign_in'
  | 'assistant_has_owner_rights'
  | 'assistant_key_invalid'
  | 'assistant_owner_inactive'
  | 'assistant_plan_owner_only'
  | 'assistant_plan_invalid'
  | 'assistant_agent_card'
  | 'assistant_not_allowed'
  | 'assistant_agent_refused'
  | 'assistant_switched_off';

export const READ_ONLY_MESSAGE = 'Hornhoof only reads on this machine now, so nothing was changed.';
export const NOT_CONFIRMED = 'Hornhoof could not confirm this change. It may be saved; look before you try again.';
/* A change counts as sent once any commit of it is listed. One that failed between two commits is listed too, so the
   words promise no more than that. */
export const ALREADY_DONE = 'This change was already sent, and Hornhoof made it or began to make it, but its answer was lost. Reload the page to see what is there.';

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

const MODE_MESSAGES = {
  read_only: READ_ONLY_MESSAGE,
  maintenance: 'Hornhoof is installing an update and takes no changes until it ends.',
  starting: 'Hornhoof is starting.',
} as const;

export type ModeRefusal = keyof typeof MODE_MESSAGES;
export const modeRefusal = (reason: ModeRefusal): ApiError => new ApiError(503, 'unavailable', MODE_MESSAGES[reason], reason);

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

/* A write that failed at a fence reaches people as what it is, never as "Something went wrong.". */
function fenceAnswer(err: unknown, req: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  if (isLeaseRefused(err)) {
    const refused = modeRefusal('read_only');
    return reply.status(refused.status).send(body(refused.code, refused.message, refused.reason));
  }
  if (!notConfirmed(err)) return undefined;
  req.log.warn({ error: loggable(err), method: req.method, route: req.routeOptions.url }, 'A commit was not confirmed.');
  return reply.status(503).send(body('unavailable', NOT_CONFIRMED, 'not_confirmed'));
}

/* A refusal as the caller reads it, its status and its body, for an ApiError or input that does not parse; null for any
   other error. */
/* How many seconds a caller is asked to wait before it tries again, for the refusals that say so. */
export const retryAfterOf = (err: unknown): string | null => (err instanceof ApiError && err.reason === 'merge_pending' ? '60' : null);

export function refusal(err: unknown): { status: number; body: ReturnType<typeof body> } | null {
  if (err instanceof ApiError) return { status: err.status, body: body(err.code, err.message, err.reason, err.details) };
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? first.path.join('.') + ': ' : '';
    return { status: 400, body: body('validation', where + (first?.message ?? 'Invalid input.')) };
  }
  return null;
}

const statusOf = (err: FastifyError | Error): number => ('statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500);

export function errorAnswer(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const refused = refusal(err);
  const wait = retryAfterOf(err);
  if (wait) reply.header('retry-after', wait);
  if (refused) return reply.status(refused.status).send(refused.body);
  const status = statusOf(err);
  if (status < 500) return reply.status(status).send(requestError(status, err.message, req.url));
  const atFence = fenceAnswer(err, req, reply);
  if (atFence) return atFence;
  req.log.error({ error: loggable(err), method: req.method, route: req.routeOptions.url }, 'A request failed.');
  return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong.' } });
}

export function registerErrorHandling(app: FastifyInstance, fallback?: Fallback): void {
  /* The log lines of a transaction name the route that ran it, however many awaits lie between them. */
  app.addHook('preHandler', (req, _reply, done) => requestRoute.run(`${req.method} ${req.routeOptions.url}`, done));
  app.setErrorHandler(errorAnswer);
  /* A fallback that answers gives back the reply, which waits for the answer to end and then gives nothing. So it is not
     awaited here, or a 404 would follow the page already sent. */
  app.setNotFoundHandler((req, reply) => fallback?.(req, reply) ?? reply.status(404).send(body('not_found', 'Not found.')));
}
