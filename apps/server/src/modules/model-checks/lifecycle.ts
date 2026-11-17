import { createHash } from 'node:crypto';
import { canonicalJson, type CheckBinding, type InvalidationCode } from '@hornhoof/protocol';
import type { Decision } from './score.js';

export type BindingPart = Exclude<InvalidationCode, 'evaluation_failed'>;
export type CheckState = { status: 'on' | 'off'; bindingDigest: string | null; validUntil: Date | null };
type DueRun = { bindingDigest: string; trigger: 'change' | 'weekly'; parts: BindingPart[]; dedupKey: string };
export type Signal = { dedupKey: string; problems: Decision['problems'] };

const WEEK_MS = 7 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/* What can change under a check, by the fields of its binding. A bare new definition number names no part, but it is still
   another binding. */
const PARTS: readonly [BindingPart, readonly (keyof CheckBinding)[]][] = [
  ['code', ['checkerCodeHash']],
  ['prompt', ['promptHash']],
  ['output_schema', ['outputSchemaHash']],
  ['list', ['sourceListHash']],
  ['taxonomy', ['taxonomyHash']],
  ['model', ['model']],
  ['dataset', ['datasetVersion', 'datasetHash']],
  ['thresholds', ['thresholdsHash']],
  ['scope', ['companyId', 'departmentId', 'productId', 'checkId', 'kind']],
];

export const bindingDigest = (binding: CheckBinding): string => createHash('sha256').update(canonicalJson(binding)).digest('hex');

const changedParts = (previous: CheckBinding | null, next: CheckBinding): BindingPart[] =>
  PARTS.filter(([, fields]) => !previous || fields.some(field => canonicalJson(previous[field]) !== canonicalJson(next[field]))).map(([part]) => part);

/* Whatever changed, the check goes off at once and stays off until a run of the new binding passes. */
export function afterChange(previous: CheckBinding | null, next: CheckBinding, now: Date): { state: CheckState; run: DueRun } | null {
  const digest = bindingDigest(next);
  if (previous && bindingDigest(previous) === digest) return null;
  return {
    state: { status: 'off', bindingDigest: digest, validUntil: null },
    run: { bindingDigest: digest, trigger: 'change', parts: changedParts(previous, next), dedupKey: `change:${digest}:${now.toISOString()}` },
  };
}

/* A run answers only for the binding it ran: one that changed meanwhile can neither turn the check on nor speak for it. The
   signal's key is the same for the same failure of the same binding, so a repeat of it does not call anyone again. */
export function afterRun(state: CheckState, ran: { bindingDigest: string }, decision: Decision, now: Date): { state: CheckState; signal: Signal | null } {
  if (ran.bindingDigest !== state.bindingDigest) return { state, signal: null };
  if (decision.status === 'passed') return { state: { status: 'on', bindingDigest: ran.bindingDigest, validUntil: new Date(now.getTime() + WEEK_MS) }, signal: null };
  return { state: { status: 'off', bindingDigest: ran.bindingDigest, validUntil: null }, signal: { dedupKey: `${ran.bindingDigest}:${decision.problems.join('+')}`, problems: decision.problems } };
}

/* A check is on only inside the week its last run gives it: with no run due in a quiet department, it simply expires. */
export const isOn = (state: CheckState, now: Date): boolean => state.status === 'on' && state.validUntil !== null && now < state.validUntil;

function isoWeek(date: Date): string {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const weekHasPassed = (lastFinishedAt: Date | null, now: Date): boolean => !lastFinishedAt || now.getTime() - lastFinishedAt.getTime() >= WEEK_MS;

/* Due a week after the last run, and only while the department has work. */
export function weeklyRun(state: CheckState, lastFinishedAt: Date | null, hasWork: boolean, now: Date): DueRun | null {
  if (!state.bindingDigest || !hasWork || !weekHasPassed(lastFinishedAt, now)) return null;
  return { bindingDigest: state.bindingDigest, trigger: 'weekly', parts: [], dedupKey: `weekly:${state.bindingDigest}:${isoWeek(now)}` };
}
