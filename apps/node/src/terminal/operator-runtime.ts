import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { OperatorDelivery, OperatorNodeMessage, OperatorQuestion, OperatorServerMessage } from '@hornhoof/protocol/program-operator';
import { OperatorControl, type OperatorProgram } from './operator-control.js';
import { OperatorObserver, type OperatorIdentity } from './operator-observer.js';

export type OperatorOptions = { dir: string; send(frame: OperatorNodeMessage): boolean; connected(): boolean; now?(): number };
type Pane = { cols: number; rows: number; cells: string };
type Source = {
  current(key: string): Omit<OperatorProgram, keyof OperatorIdentity | 'generation'> | null;
  capture(key: string): Promise<Pane>;
  press(key: string, value: 'Enter' | 'Up' | 'Down' | 'Left' | 'Right' | 'Tab'): Promise<void>;
  secrets(): string[];
};
type Target = { identity: OperatorIdentity; control: OperatorControl; generation: number; physical: boolean; pasted: boolean; started: boolean; active: boolean; recorded: boolean; taken: boolean; assignment: OperatorDelivery | null; caseId: string | null; deadline: number | null; failed: string | null; intentional?: 'cancelled' | 'update' | 'restart' | 'offline' | 'completed' };

/* Runtime glue stays outside the terminal host's provider logic; evidence and the key guard share one input lane. */
export class OperatorRuntime {
  private readonly observer: OperatorObserver;
  private readonly targets = new Map<string, Target>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly options: OperatorOptions, private readonly source: Source) {
    this.now = options.now ?? (() => performance.timeOrigin + performance.now());
    this.observer = new OperatorObserver({ file: join(options.dir, 'evidence.json'), send: options.send, connected: options.connected, now: this.now });
  }

  begin(key: string, jobId: string | null, metadata: OperatorDelivery | undefined, words: string, reuse: boolean): void {
    if (!z.uuid().safeParse(key).success || !z.uuid().safeParse(jobId).success) return;
    let target = this.targets.get(key);
    if (!target || !reuse) {
      const identity = { agentKey: key, jobId, instance: randomUUID() };
      const control = new OperatorControl({ file: join(this.options.dir, `actions-${key}.json`), now: this.now, current: () => this.current(key), capture: () => this.source.capture(key), press: value => this.source.press(key, value), lane: run => this.serial(key, run), secrets: this.source.secrets });
      target = { identity, control, generation: 0, physical: reuse, pasted: reuse, started: reuse, active: reuse, recorded: false, taken: false, assignment: null, caseId: null, deadline: null, failed: null };
      this.targets.set(key, target);
    }
    if (target.identity.jobId !== jobId || target.assignment?.id !== metadata?.id) { target.caseId = null; target.deadline = null; target.failed = null; }
    target.identity = { ...target.identity, jobId };
    target.assignment = metadata ?? null; target.recorded = false; target.taken = false;
    target.generation++; target.intentional = undefined;
    if (words && metadata) this.observer.attempt(target.identity, metadata, 'assignment', words);
    if (reuse && !target.physical) target.physical = true;
  }

  enabled(key: string): boolean { return this.targets.has(key); }
  identity(key: string): OperatorIdentity | null { return this.targets.get(key)?.identity ?? null; }

  launch(key: string, phase: 'attempt' | 'started' | 'failed'): void {
    const target = this.targets.get(key); if (!target) return;
    target.generation++;
    if (phase === 'started') target.physical = true;
    this.observer.launch(target.identity, phase);
  }

  changed(key: string): void { const target = this.targets.get(key); if (target) target.generation++; }
  pasted(key: string): void { const target = this.targets.get(key); if (target) { target.pasted = true; target.generation++; } }
  started(key: string): void { const target = this.targets.get(key); if (target) { target.started = true; target.generation++; } }

  activity(key: string): void {
    const target = this.targets.get(key); if (!target) return;
    target.active = true; target.generation++;
    this.observer.activity(target.identity);
  }

  question(key: string, question: OperatorQuestion | null): void {
    const target = this.targets.get(key); if (!target) return;
    target.generation++;
    this.observer.question(target.identity, question);
  }

  receipt(key: string, metadata: OperatorDelivery | undefined, phase: 'queued' | 'taken' | 'not_taken' | 'cancelled'): void {
    if (!metadata) return;
    const target = this.targets.get(key); if (!target) return;
    if (phase === 'queued' || phase === 'taken') {
      this.observer.receipt(metadata.id, phase);
      if (target.assignment?.id === metadata.id) { target.recorded = true; target.taken ||= phase === 'taken'; }
    } else this.observer.finalize(metadata.id, phase);
    target.generation++;
  }

  live(key: string, metadata: OperatorDelivery | undefined, words: string): void {
    const target = this.targets.get(key); if (!metadata || !target) return;
    this.observer.attempt(target.identity, metadata, 'live', words);
    this.pasted(key);
  }

  recorded(key: string): boolean { return this.targets.get(key)?.recorded ?? false; }

  failure(key: string): string | null {
    const target = this.targets.get(key);
    if (!target || target.recorded || target.active || target.started) return null;
    return target.failed;
  }

  intentional(key: string, cause: NonNullable<Target['intentional']>): void {
    const target = this.targets.get(key); if (!target) return;
    target.intentional = cause; target.generation++;
    this.observer.question(target.identity, null);
    if (cause === 'cancelled' && target.assignment) this.observer.finalize(target.assignment.id, 'cancelled');
  }

  exited(key: string, exit: { code: number | null; signal: string | null }): void {
    const target = this.targets.get(key); if (!target) return;
    target.physical = false; target.generation++;
    this.observer.exit(target.identity, exit, target.intentional);
  }

  tick(): void {
    this.observer.tick();
    for (const target of this.targets.values()) if (target.deadline !== null && this.now() >= target.deadline) target.failed ??= 'operator_timeout';
  }

  replay(): void { this.observer.replay(); }

  async message(frame: OperatorServerMessage): Promise<void> {
    if (frame.type === 'program.evidence_ack') { this.observer.ack(frame.evidenceId); return; }
    const target = this.targets.get(frame.agentKey);
    if (!target) {
      const identity = { agentKey: frame.agentKey, jobId: frame.jobId, instance: frame.instance };
      if (frame.type === 'program.screen_get') this.options.send({ type: 'program.screen', ...identity, request: frame.request, result: 'refused', reason: 'no_program', snapshot: null, generation: 0, state: 'unknown', keysAllowed: false, protected: false, cols: 1, rows: 1, cells: '' });
      if (frame.type === 'program.key_send') this.options.send({ type: 'program.key_result', ...identity, action: frame.action, result: 'refused', reason: 'no_program' });
      return;
    }
    if (frame.type === 'program.operator_case') {
      const accepted = target.control.openCase(frame);
      if (!accepted || frame.instance !== target.identity.instance || frame.jobId !== target.identity.jobId) return;
      target.caseId = frame.case;
      target.deadline = Math.min(target.deadline ?? Infinity, this.now() + frame.remainingMs);
      if (frame.disposition === 'revoke') target.failed ??= 'operator_case_closed';
      return;
    }
    if (frame.type === 'program.screen_get') this.options.send(await target.control.screen(frame));
    else this.options.send(await target.control.key(frame));
  }

  serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const result = (this.lanes.get(key) ?? Promise.resolve()).then(run);
    const settled = result.catch(() => {});
    this.lanes.set(key, settled);
    void settled.then(() => { if (this.lanes.get(key) === settled) this.lanes.delete(key); });
    return result;
  }

  private current(key: string): OperatorProgram | null {
    const target = this.targets.get(key), source = this.source.current(key);
    if (!target || !source) return null;
    return { ...source, ...target.identity, generation: target.generation, alive: source.alive && target.physical, pasted: source.pasted || target.pasted, turnStarted: source.turnStarted || target.started, active: source.active || target.active };
  }
}
