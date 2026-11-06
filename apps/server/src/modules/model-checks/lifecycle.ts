import type { CheckBinding } from './contract.js';
import type { Decision } from './score.js';

export type BindingPart = 'code' | 'prompt' | 'output_schema' | 'list' | 'taxonomy' | 'model' | 'dataset' | 'thresholds' | 'scope';
export type CheckState = { status: 'on' | 'off'; bindingDigest: string | null; validUntil: Date | null };
export type DueRun = { bindingDigest: string; trigger: 'change' | 'weekly'; parts: BindingPart[]; dedupKey: string };
export type Signal = { dedupKey: string; problems: Decision['problems'] };

export const bindingDigest = (_binding: CheckBinding): string => '';
export function afterChange(_state: CheckState, _previous: CheckBinding | null, _next: CheckBinding, _now: Date): { state: CheckState; run: DueRun } | null {
  return null;
}
export function afterRun(state: CheckState, _ran: { bindingDigest: string }, _decision: Decision, _now: Date): { state: CheckState; signal: Signal | null } {
  return { state, signal: null };
}
export const isOn = (_state: CheckState, _now: Date): boolean => true;
export function weeklyRun(_state: CheckState, _lastFinishedAt: Date | null, _hasWork: boolean, _now: Date): DueRun | null {
  return null;
}
