import type { AgentEvent } from '@hornhoof/protocol';
import type { RunInput, RunResult } from '../runner.js';
import { PhaseStore, type Finish, type PhaseAttempt, type PhaseRecord, type PhaseSummary } from './phase.js';

/* Optional recording never decides the host's control flow or result. */
export function observePhase(phase: PhaseAttempt | undefined, observation: (phase: PhaseAttempt) => void): void {
  if (phase) observation(phase);
}

export function turnPhase(turn: { phase?: PhaseAttempt } | null): PhaseAttempt | undefined { return turn?.phase; }

export function queuedPhase(dir: string, untimed: boolean, job: { workspace?: { key: string } | null; jobId: string }): PhaseAttempt | undefined {
  const agentKey = job.workspace?.key;
  return untimed && agentKey ? new PhaseStore(dir).begin(agentKey, job.jobId, 'queued') : undefined;
}

export function jobPhase(agent: { phaseStore?: PhaseStore }, input: RunInput, jobId?: string): PhaseAttempt | undefined {
  const phase = input.terminalPhase;
  if (!phase?.matchesJob(jobId)) return undefined;
  agent.phaseStore = phase.store;
  return phase;
}

export function launchPhase(phase: PhaseAttempt | undefined, goesOn: boolean, current: string | null, next: string | null, hash: string | null, flags: PhaseRecord['launch'], program: PhaseRecord['source']['program']): void {
  observePhase(phase, value => value.launch(goesOn ? current : next, hash, flags, program));
}

export function hookPhase(phase: PhaseAttempt | undefined, session: unknown, event: 'prompt' | 'stop'): void {
  if (typeof session !== 'string' || !phase?.matchesSession(session)) return;
  if (event === 'prompt') phase.ack('hook');
  else phase.end('hook', 'completed');
}

export function wireEndPhase(phase: PhaseAttempt | undefined, aborted: boolean | undefined, failed = false): void {
  observePhase(phase, value => value.end('wire', aborted ? 'aborted' : failed ? 'failed' : 'completed'));
}

export function wireFinish(failure: string | undefined): Finish { return failure === undefined ? 'wire_completed' : 'wire_failed'; }

export function typedPhase(store: PhaseStore | undefined, key: string, ref: string, session: string | null, hash: string | null, program: { kind: PhaseRecord['source']['program'] } | null, fromLog: boolean, hookSession: unknown): PhaseAttempt | undefined {
  const phase = store?.begin(key, null, 'typed', ref);
  observePhase(phase, value => {
    value.launch(session, hash, { goesOn: null, sameSession: null, hashMatch: null }, program?.kind ?? null);
    value.waitStart('done', Date.now(), null);
  });
  if (!fromLog) hookPhase(phase, hookSession, 'prompt');
  return phase;
}

export function completeTypedPhase(phase: PhaseAttempt | undefined, error: RunResult['error'], reason: Finish): PhaseSummary | undefined {
  observePhase(phase, value => {
    value.waitEnd('done', error === 'cancelled' ? 'aborted' : error ? 'failed' : 'completed');
    value.finish(reason);
    value.complete(!error, error === 'cancelled');
  });
  return phaseSummary(phase);
}

export function phaseSummary(phase: PhaseAttempt | undefined): PhaseSummary | undefined { return phase?.diagnostic(); }

export function bindTurnPhase(turn: { phase?: PhaseAttempt; over?: { phaseSummary?: PhaseSummary } | null }, jobId: string | null, token: string | null, ref?: string): void {
  if (jobId && token) turn.phase?.bind(jobId, ref);
  if (turn.over) turn.over.phaseSummary = phaseSummary(turn.phase);
}

export function observedWireSize(wire: { file: string } | undefined, size: (file: string) => number | null): number | null {
  return wire ? size(wire.file) : null;
}

export function completePhase(phase: PhaseAttempt | undefined, result: RunResult, notify: (event: AgentEvent) => void, typedSnapshot?: PhaseSummary): RunResult {
  if (!phase) return result;
  phase.complete(result.ok, result.error === 'cancelled');
  const phaseSummary = typedSnapshot ?? phase.diagnostic();
  if (result.ok && phase.isDurable()) return { ...result, phaseSummary };
  const summary = phase.summary();
  try { notify({ kind: 'tool_result', ok: false, summary }); } catch { /* Preserve the original result. */ }
  return { ...result, phaseSummary, output: result.ok ? result.output : `${summary}\n\n${result.output}` };
}
