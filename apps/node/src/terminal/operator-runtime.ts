import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { checkSlotWaiting } from '../check-queue.js';
import type { OperatorCheck, OperatorDelivery, OperatorInputLine, OperatorNodeMessage, OperatorQuestion, OperatorReason, OperatorRecoveryState, OperatorServerMessage } from '@hornhoof/protocol/program-operator';
import { OperatorControl, type OperatorProgram, type Pane } from './operator-control.js';
import { OperatorObserver, type OperatorIdentity } from './operator-observer.js';
import { ProgramAccess, type ProgramFacts } from './program-access.js';

export type OperatorOptions = { dir: string; send(frame: OperatorNodeMessage): boolean; connected(): boolean; now?(): number; lookMs?: number };
/* A look at a screen waits its turn among the keys, and the tmux behind it can hang. Neither may hold back telling of a turn. */
const LOOK_MS = 5000;
const NO_LOOK: OperatorCheck = { input: 'unknown', screen: null };
type Source = {
  current(key: string): Omit<OperatorProgram, keyof OperatorIdentity | 'generation'> | null;
  capture(key: string): Promise<Pane>;
  inputLine(key: string, cells: string): OperatorInputLine;
  /* What an agent's program here shows and does now, for whoever the server lets look at it, and their keys and words. */
  facts(key: string): Promise<ProgramFacts | null>;
  press(key: string, keys: string[]): Promise<void>;
  paste(key: string, text: string): Promise<void>;
  secrets(): string[];
  /* What the program shows now: its input, null when that cannot be read, whether that is only Hornhoof's own words it never
     sent, and whether it works on a turn. */
  recovery(key: string): Promise<{ alive: boolean; input: string | null; own: boolean; busy: boolean }>;
};
type Target = { identity: OperatorIdentity; control: OperatorControl; generation: number; physical: boolean; recorded: boolean; sinceWords: boolean; assignment: OperatorDelivery | null; sourceDelivery: OperatorDelivery | undefined; caseId: string | null; caseReason: OperatorReason | null; ownerTouched: boolean; bound: boolean; idle: boolean; pendingActivity: boolean; pendingQuestion: { data: OperatorQuestion; at: number } | null; deadline: number | null; failed: string | null; intentional?: 'cancelled' | 'update' | 'restart' | 'offline' | 'completed' };

const NO_PROGRAM = { program: 'gone', current: null, generation: 0, input: 'unknown', wait: null, runningTool: false, retrying: false, busy: false } as const;

/* Hornhoof's own words that never went are no person's: the words that go on take their place. */
export function inputShown(input: string | null, own: boolean): OperatorRecoveryState['input'] {
  if (input === null) return 'unknown';
  if (!input) return 'empty';
  return own ? 'hornhoof' : 'words';
}

function programAt(program: ReturnType<Source['current']>): Pick<OperatorRecoveryState, 'wait' | 'runningTool' | 'retrying'> {
  const wait = program?.wait?.kind ?? null;
  return { wait, runningTool: Boolean(program?.runningTool), retrying: Boolean(program?.retrying) };
}

/* Runtime glue stays outside the terminal host's provider logic; evidence and a look at the program share one input lane. */
export class OperatorRuntime {
  private readonly observer: OperatorObserver;
  private readonly access: ProgramAccess;
  private readonly targets = new Map<string, Target>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly options: OperatorOptions, private readonly source: Source) {
    this.now = options.now ?? (() => performance.timeOrigin + performance.now());
    this.observer = new OperatorObserver({ file: join(options.dir, 'evidence.json'), send: options.send, connected: options.connected, now: this.now, look: identity => this.look(identity.agentKey) });
    this.observer.retire();
    this.access = new ProgramAccess({ facts: key => this.source.facts(key), capture: key => this.source.capture(key), paste: (key, text) => this.source.paste(key, text), press: (key, keys) => this.source.press(key, keys), lane: (key, run) => this.serial(key, run), secrets: () => this.source.secrets(), now: this.now });
  }

  begin(key: string, jobId: string | null, metadata: OperatorDelivery | undefined, words: string, reuse: boolean, source?: OperatorDelivery): void {
    if (!z.uuid().safeParse(key).success || !z.uuid().safeParse(jobId).success) return;
    let target = this.targets.get(key);
    if (!target || !reuse) {
      target = this.replaceTarget(key, jobId, reuse, target);
    }
    this.bindTarget(target, jobId, metadata);
    target.sourceDelivery = structuredClone(source);
    if (words && metadata) this.observer.attempt(target.identity, metadata, 'assignment', words);
    this.restorePending(target);
    if (reuse && !target.physical) target.physical = true;
  }

  private async look(key: string): Promise<OperatorCheck> {
    const target = this.targets.get(key);
    if (!target) return NO_LOOK;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<OperatorCheck>(done => { timer = setTimeout(() => done(NO_LOOK), this.options.lookMs ?? LOOK_MS); });
    try {
      return await Promise.race([target.control.check(cells => this.source.inputLine(key, cells)), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private replaceTarget(key: string, jobId: string | null, reuse: boolean, previous: Target | undefined): Target {
    if (previous) this.observer.exit(previous.identity, { code: null, signal: null }, 'restart');
    const target = this.createTarget(key, jobId, reuse);
    this.targets.set(key, target);
    return target;
  }

  private createTarget(key: string, jobId: string | null, reuse: boolean): Target {
    const identity = { agentKey: key, jobId, instance: randomUUID() };
    const control = new OperatorControl({ file: join(this.options.dir, `actions-${key}.json`), now: this.now, capture: () => this.source.capture(key), lane: run => this.serial(key, run), secrets: this.source.secrets });
    return { identity, control, generation: 0, physical: reuse, sinceWords: reuse, recorded: false, assignment: null, sourceDelivery: undefined, caseId: null, caseReason: null, ownerTouched: false, bound: true, idle: false, pendingActivity: false, pendingQuestion: null, deadline: null, failed: null };
  }

  private bindTarget(target: Target, jobId: string | null, metadata: OperatorDelivery | undefined): void {
    if (target.identity.jobId !== jobId || target.assignment?.id !== metadata?.id) { target.caseId = null; target.caseReason = null; target.ownerTouched = false; target.deadline = null; target.failed = null; }
    /* What the program did before these words says nothing of them: a program that goes on its session has done plenty. */
    if (target.idle || metadata) target.sinceWords = false;
    target.bound = true; target.idle = false;
    target.identity = { ...target.identity, jobId };
    target.assignment = metadata ?? null; target.recorded = false;
    target.generation++; target.intentional = undefined;
  }

  private restorePending(target: Target): void {
    const pendingQuestion = target.pendingQuestion, pendingActivity = target.pendingActivity;
    target.pendingQuestion = null; target.pendingActivity = false;
    if (pendingActivity) this.observer.activity(target.identity, target.sourceDelivery);
    if (pendingQuestion) this.observer.question(target.identity, pendingQuestion.data, Math.max(0, this.now() - pendingQuestion.at));
  }

  enabled(key: string): boolean { return this.targets.has(key); }
  identity(key: string): OperatorIdentity | null { return this.targets.get(key)?.identity ?? null; }

  suspend(key: string): void {
    const target = this.targets.get(key); if (!target) return;
    this.observer.question(target.identity, null);
    target.bound = false; target.idle = false; target.pendingActivity = false; target.pendingQuestion = null;
    target.sinceWords = false; target.generation++;
  }

  launch(key: string, phase: 'attempt' | 'started' | 'failed'): void {
    const target = this.targets.get(key); if (!target) return;
    target.generation++;
    if (phase === 'started') target.physical = true;
    this.observer.launch(target.identity, phase);
  }

  changed(key: string): void { const target = this.targets.get(key); if (target) target.generation++; }
  started(key: string): void { const target = this.targets.get(key); if (target) { target.sinceWords = true; target.generation++; } }
  /* What came of a session it still loads, before these words went in, says nothing of them. */
  typed(key: string): void { const target = this.targets.get(key); if (target) target.sinceWords = false; this.changed(key); }

  activity(key: string): void {
    const target = this.targets.get(key); if (!target) return;
    target.sinceWords = true; target.generation++;
    if (target.bound) this.observer.activity(target.identity, target.sourceDelivery);
    else target.pendingActivity = true;
  }

  sourceActivity(key: string, instance: string, source: OperatorDelivery): void {
    this.observer.sourceActivity({ agentKey: key, jobId: null, instance }, source);
  }

  question(key: string, question: OperatorQuestion | null): void {
    const target = this.targets.get(key); if (!target) return;
    target.generation++;
    if (target.bound) this.observer.question(target.identity, question);
    else if (!question || target.pendingQuestion?.data.id !== question.id) target.pendingQuestion = question ? { data: question, at: this.now() } : null;
  }

  receipt(key: string, metadata: OperatorDelivery | undefined, phase: 'queued' | 'taken' | 'not_taken' | 'cancelled'): void {
    if (!metadata) return;
    const target = this.targets.get(key); if (!target) return;
    if (phase === 'queued' || phase === 'taken') {
      this.observer.receipt(metadata.id, phase);
      if (target.assignment?.id === metadata.id) target.recorded = true;
      /* The program took words that came after these: it went on past them, whether or not their own record came. */
      else if (phase === 'taken' && cameAfter(metadata, target.assignment)) target.sinceWords = true;
    } else this.observer.finalize(metadata.id, phase);
    target.generation++;
  }

  live(key: string, metadata: OperatorDelivery | undefined, words: string): void {
    const target = this.targets.get(key); if (!metadata || !target) return;
    this.observer.attempt(target.identity, metadata, 'live', words);
    this.changed(key);
  }

  recorded(key: string): boolean { return this.targets.get(key)?.recorded ?? false; }

  sourceRecorded(metadata: OperatorDelivery | undefined): boolean {
    return Boolean(metadata && this.observer.recordedSource(metadata.id));
  }

  inheritSource(key: string, metadata: OperatorDelivery | undefined): boolean {
    if (!this.sourceRecorded(metadata)) return false;
    const target = this.targets.get(key); if (!target) return false;
    target.recorded = true;
    if (target.assignment) this.observer.finalize(target.assignment.id, 'cancelled');
    return true;
  }

  failureDetail(key: string): string | null {
    const target = this.targets.get(key), reason = this.failure(key);
    return reason ? `${reason}; case ${target?.caseId ?? 'not yet assigned'}` : null;
  }

  /* The turn ends because its words never got recorded, which Hornhoof's case says and Hornhoof answers for. */
  unrecordedEnded(key: string): boolean {
    return this.failure(key) !== null && this.targets.get(key)?.caseReason === 'assignment_unrecorded';
  }

  recovering(key: string): boolean {
    const target = this.targets.get(key);
    return Boolean(target?.failed && target.caseId && target.caseReason === 'assignment_unrecorded' && !target.recorded && !target.sinceWords && target.physical);
  }

  ownerInput(key: string): void {
    const target = this.targets.get(key); if (!target) return;
    target.ownerTouched ||= this.recovering(key);
    target.generation++;
  }

  recoveryReady(key: string, ready: boolean): void {
    const target = this.targets.get(key);
    if (!target || !ready || !this.recovering(key) || this.awaitingNativeInput(key)) return;
    this.observer.recoveryReady(target.identity, target.caseId!, target.ownerTouched);
  }

  /* The program may still take these words again: it neither recorded them nor did anything since, and asks nothing. */
  wordsWaiting(key: string): boolean {
    const target = this.targets.get(key);
    return Boolean(target && !target.recorded && !target.sinceWords && !this.awaitingNativeInput(key));
  }

  private awaitingNativeInput(key: string): boolean {
    const source = this.source.current(key);
    return programWaits(source, checkSlotWaiting(key));
  }

  failure(key: string): string | null {
    const target = this.targets.get(key);
    if (!target || target.recorded || target.sinceWords) return null;
    return target.failed;
  }

  intentional(key: string, cause: NonNullable<Target['intentional']>): void {
    const target = this.targets.get(key); if (!target) return;
    target.intentional = cause; target.generation++;
    target.idle = cause === 'completed';
    this.question(key, null);
    if (target.bound && cause === 'cancelled' && target.assignment) this.observer.finalize(target.assignment.id, 'cancelled');
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
    if (frame.type === 'program.recovery_state_get') { this.options.send(await this.recoveryState(frame)); return; }
    if (frame.type === 'program.view_get') { this.options.send(await this.access.view(frame)); return; }
    if (frame.type === 'program.input_send') { this.options.send(await this.access.input(frame)); return; }
    const target = this.targets.get(frame.agentKey);
    if (target) this.updateCase(target, frame);
  }

  /* What the node sees of an agent's program right now, whichever program that is by now. It is busy exactly when the
     program works on a turn, as program_screen shows it: what it did since the words is no work it is on, and a program
     done with its turn is free for whoever releases its hold after a look at it. */
  private async recoveryState({ agentKey, jobId, instance, request }: Extract<OperatorServerMessage, { type: 'program.recovery_state_get' }>): Promise<OperatorRecoveryState> {
    const reply = { type: 'program.recovery_state' as const, agentKey, jobId, instance, request };
    const target = this.targets.get(agentKey);
    const shown = target?.physical ? await this.source.recovery(agentKey) : null;
    if (!target || !shown?.alive) return { ...reply, ...NO_PROGRAM };
    return { ...reply, program: 'here', current: target.identity.instance, generation: target.generation, input: inputShown(shown.input, shown.own), ...programAt(this.source.current(agentKey)), busy: shown.busy };
  }

  private updateCase(target: Target, frame: Extract<OperatorServerMessage, { type: 'program.operator_case' }>): void {
    const accepted = target.control.openCase(frame);
    if (!accepted || frame.instance !== target.identity.instance || frame.jobId !== target.identity.jobId) return;
    target.caseId = frame.case;
    target.caseReason = frame.reason ?? target.caseReason;
    target.deadline = Math.min(target.deadline ?? Infinity, this.now() + frame.remainingMs);
    if (frame.disposition === 'revoke') target.failed ??= frame.closedBecause ?? 'operator_case_closed';
  }

  serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const result = (this.lanes.get(key) ?? Promise.resolve()).then(run);
    const settled = result.catch(() => {});
    this.lanes.set(key, settled);
    void settled.then(() => { if (this.lanes.get(key) === settled) this.lanes.delete(key); });
    return result;
  }
}

const cameAfter = (words: OperatorDelivery, assignment: OperatorDelivery | null): boolean => assignment !== null && words.ordinal > assignment.ordinal;

function programWaits(source: ReturnType<Source['current']>, queued: boolean): boolean {
  return Boolean(source?.runningTool || source?.retrying || source?.wait || queued);
}
