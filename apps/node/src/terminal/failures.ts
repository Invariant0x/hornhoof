import type { Failure, FailureKind } from '@hornhoof/protocol';
import { SIGNED_OUT as AGY_SIGNED_OUT } from '../providers/antigravity.js';
import { isRecord } from '../providers/events.js';

const text = (v: unknown): string => typeof v === 'string' ? v : '';
const passing = new Set<FailureKind>(['overloaded', 'rate_limited', 'network', 'cut', 'crash', 'tools']);

export function failure(kind: FailureKind, reason: string, retryable?: unknown): Failure {
  return { kind, text: reason.slice(0, 2000), retryable: typeof retryable === 'boolean' ? retryable : passing.has(kind) };
}

const reason = (...parts: unknown[]) => parts.map(text).filter(Boolean).join(': ') || 'unknown';
const PLAN_LIMIT = /limit reached|hit your usage limit|\b\d+[- ]hour limit/i;
const NETWORK = /ECONNREFUSED|ENOTFOUND|timed out|connection/i;
const serverError = (status: unknown): boolean => typeof status === 'number' && status >= 500 && status < 600;
const CLAUDE: Record<string, FailureKind> = {
  overloaded: 'overloaded', rate_limit: 'rate_limited', authentication_failed: 'auth', oauth_org_not_allowed: 'auth',
  billing_error: 'refused', account_on_hold: 'refused', verification_required: 'refused', cloud_credential_error: 'refused', max_output_tokens: 'too_big',
};

function claudeFailure(raw: Record<string, unknown>): Failure {
  const code = text(raw.error);
  const message = text(raw.error_details) || text(raw.last_assistant_message);
  let kind = CLAUDE[code] ?? 'unknown';
  if (code === 'rate_limit' && PLAN_LIMIT.test(message)) kind = 'usage_limit';
  if (code === 'server_error' && /\b529\b|overloaded/i.test(message)) kind = 'overloaded';
  else if (code === 'server_error' && NETWORK.test(message)) kind = 'network';
  if (code === 'unknown' && /empty or malformed response/i.test(message)) kind = 'cut';
  const retryable = kind === 'unknown' && code === 'server_error' ? true : undefined;
  return failure(kind, reason(code, message), raw.retryable ?? retryable);
}

const CODEX: Record<string, FailureKind> = {
  server_overloaded: 'overloaded', model_access_denied: 'model_access_denied', rate_limit_exceeded: 'rate_limited', usage_limit_exceeded: 'usage_limit', unauthorized: 'auth',
  response_stream_connection_failed: 'network', response_stream_disconnected: 'cut',
  cyber_policy: 'refused', bio_policy: 'refused', misalignment_policy_violation: 'refused', context_window_exceeded: 'too_big', session_budget_exceeded: 'too_big',
};

export function codexFailure(raw: Record<string, unknown>): Failure {
  const info = raw.codex_error_info;
  const [code, details] = isRecord(info) ? Object.entries(info)[0] ?? ['', null] : [text(info), null];
  const status = isRecord(details) ? details.http_status_code : undefined;
  let kind = CODEX[code] ?? 'unknown';
  if (status === 503 || status === 529) kind = 'overloaded';
  else if (status === 401) kind = 'auth';
  else if (code === 'response_too_many_failed_attempts' && status === 429) kind = 'rate_limited';
  else if (code === 'http_connection_failed' && status == null) kind = 'network';
  if (code === 'other' && /stream disconnected/i.test(text(raw.message))) kind = 'cut';
  const retryable = kind === 'unknown' && (code === 'internal_server_error' || serverError(status)) ? true : undefined;
  return failure(kind, reason(code + (typeof status === 'number' ? ` ${status}` : ''), raw.message), raw.retryable ?? retryable);
}

const KIMI: Record<string, FailureKind> = {
  'provider.overloaded': 'overloaded', APIProviderOverloadedError: 'overloaded',
  'provider.rate_limit': 'rate_limited', APIProviderRateLimitError: 'rate_limited',
  'provider.quota_exhausted': 'usage_limit', APIProviderQuotaExhaustedError: 'usage_limit',
  'provider.auth_error': 'auth', 'provider.connection_error': 'network', APIConnectionError: 'network', APITimeoutError: 'network',
};

function kimiFailure(raw: Record<string, unknown>): Failure {
  const code = text(raw.code) || text(raw.error_type) || text(raw.name);
  const message = text(raw.message) || text(raw.error_message);
  const kind = code === 'APIStatusError' && /^401\b/.test(message) ? 'auth' : KIMI[code] ?? KIMI[text(raw.name)] ?? 'unknown';
  const status = isRecord(raw.details) ? raw.details.statusCode : undefined;
  const server = serverError(status) || ((code === 'APIStatusError' || raw.name === 'APIStatusError') && /^5\d\d\b/.test(message));
  return failure(kind, reason(code, message), raw.retryable ?? (kind === 'unknown' && server ? true : undefined));
}

const AGY: [FailureKind, RegExp][] = [
  ['overloaded', /overload/i], ['rate_limited', /\b429\b/],
  ['usage_limit', /quota/i], ['network', /network issue/i],
];

/* What agy says when the Google access token it holds ran out: the token lasts an hour, and a program that has run longer
   keeps using the old one. The saved sign-in is still good, so a program started anew gets a new token from it. */
export const AGY_TOKEN_REFUSED = /UNAUTHENTICATED|\(code 401\)|invalid authentication credentials|Expected OAuth 2 access token/i;

/* renewed: the program started anew after a refusal and answered no turn since. */
function agyTokenFailure(message: string, renewed: boolean): Failure {
  if (renewed) return failure('auth', `Antigravity refused its sign-in again (401 UNAUTHENTICATED), right after its program started anew with the saved sign-in, so the saved sign-in no longer works. The plan's owner signs in again on the machine of this node. It said: ${message}`, false);
  return failure('unknown', `Antigravity refused its sign-in token (401 UNAUTHENTICATED): the program holds a token that ran out. Hornhoof starts the program anew with the saved sign-in and tries the turn once more. It said: ${message}`, true);
}

function agyFailure(raw: Record<string, unknown>, renewed = false): Failure {
  const message = text(raw.short_error) || text(raw.error) || 'unknown';
  if (AGY_SIGNED_OUT.test(message)) return failure('auth', message, raw.retryable);
  if (AGY_TOKEN_REFUSED.test(message)) return agyTokenFailure(message, renewed);
  return failure(AGY.find(([, pattern]) => pattern.test(message))?.[0] ?? 'unknown', message, raw.retryable);
}

export const FAILURE = { claude: claudeFailure, codex: codexFailure, kimi: kimiFailure, antigravity: agyFailure };
