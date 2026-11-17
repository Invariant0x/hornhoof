import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ASSIGNMENT_RECEIPT_MS, FIRST_ACTIVITY_MS, OperatorNodeMessage, OperatorQuestion, QUESTION_WAIT_MS, STARTUP_EXIT_MS, type OperatorCheck, type OperatorDelivery, type OperatorEvidence, type OperatorReason } from '@hornhoof/protocol/program-operator';
import { z } from 'zod';
import { checkSlotWaiting } from '../check-queue.js';
import { readOperatorStore, writeOperatorStore } from './operator-storage.js';

const Identity = z.object({ agentKey: z.uuid(), jobId: z.uuid().nullable(), instance: z.uuid() });
export type OperatorIdentity = z.infer<typeof Identity>;
const Question = z.object({ data: OperatorQuestion, jobId: z.uuid().nullable(), at: z.number(), ordinal: z.number().int().positive(), alarmed: z.boolean() });
const Instance = Identity.extend({ at: z.number(), startedAt: z.number().nullable(), active: z.boolean(), exited: z.boolean(), ordinal: z.number().int().nonnegative(), phases: z.array(z.enum(['attempt', 'started', 'failed'])), alarmed: z.boolean(), question: Question.nullable().default(null), questionOrdinal: z.number().int().nonnegative().default(0), recovered: z.array(z.uuid()).default([]), recoveredByOwner: z.array(z.uuid()).default([]) });
const Delivery = Identity.extend({ id: z.uuid(), ordinal: z.number().int().positive(), kind: z.enum(['assignment', 'live']), digest: z.string(), at: z.number(), receiptAt: z.number().nullable(), checkAfter: z.number().nullable().default(null), active: z.boolean(), outcome: z.enum(['pending', 'taken', 'not_taken', 'cancelled']), phases: z.array(z.enum(['attempt', 'queued', 'taken', 'activity', 'not_taken', 'cancelled'])), alarms: z.array(z.string()) });
const StoredEvidence = OperatorNodeMessage.refine((frame): frame is OperatorEvidence => 'evidenceId' in frame);
const Store = z.object({ instances: z.record(z.string(), Instance), deliveries: z.record(z.string(), Delivery), outbox: z.array(StoredEvidence) });
type Store = z.infer<typeof Store>;
type Delivery = z.infer<typeof Delivery>;
type Instance = z.infer<typeof Instance>;
/* What a look at the program saw: what goes with the alarm, and whether the program is inside a tool call with Hornhoof's
   words gone in, so that it records them once the call ends. */
export type ProgramLook = OperatorCheck & { inToolCall?: boolean };
type Options = { file: string; send(fact: OperatorEvidence): boolean; connected(): boolean; now?(): number; look?(identity: OperatorIdentity): Promise<ProgramLook> };
type Exit = { code: number | null; signal: string | null };
type ExitCause = 'cancelled' | 'update' | 'restart' | 'offline' | 'completed';
type EvidenceInput<T = OperatorEvidence> = T extends OperatorEvidence ? Omit<T, 'evidenceId' | 'ordinal'> : never;
const MAX_PENDING = 4096;

/* Only identities, hashes and bounded facts reach disk; program words and screens stay out of this outbox. A screen goes
   with the first telling of its fact alone: told again, the fact has the state of the input line without it. */
export class OperatorObserver {
  private state: Store;
  private readonly looking = new Set<string>();
  private staged: { facts: OperatorEvidence[]; changed: boolean } | null = null;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.timeOrigin + performance.now());
    this.state = readOperatorStore(options.file, Store, { instances: {}, deliveries: {}, outbox: [] });
  }

  launch(identity: OperatorIdentity, phase: 'attempt' | 'started' | 'failed'): void {
    this.transition(() => {
      if (this.state.instances[identity.instance]?.phases.includes(phase)) return;
      this.room(1);
      const instance = this.instance(identity);
      if (!instance.phases.length) instance.at = this.now();
      instance.phases.push(phase);
      if (phase === 'started') instance.startedAt = this.now();
      this.emit(instance, { type: 'program.launch', ...this.identity(instance), phase, elapsedMs: this.elapsed(instance.at) });
    });
  }

  attempt(identity: OperatorIdentity, metadata: OperatorDelivery, kind: 'assignment' | 'live', words: string): void {
    this.transition(() => {
      const digest = createHash('sha256').update(words).digest('hex');
      const old = this.state.deliveries[metadata.id];
      if (old) {
        if (old.digest !== digest || old.agentKey !== identity.agentKey || old.ordinal !== metadata.ordinal || old.kind !== kind) throw new Error('A delivery identity cannot be reused for different words.');
        return;
      }
      this.room(1);
      if (Object.keys(this.state.deliveries).length >= MAX_PENDING) throw new Error('Program delivery history must be acknowledged before more input.');
      this.instance(identity);
      const delivery: Delivery = { ...identity, ...metadata, kind, digest, at: this.now(), receiptAt: null, checkAfter: null, active: false, outcome: 'pending', phases: [], alarms: [] };
      this.state.deliveries[metadata.id] = delivery;
      this.deliveryFact(delivery, 'attempt');
    });
  }

  receipt(id: string, phase: 'queued' | 'taken'): void {
    this.transition(() => {
      const delivery = this.state.deliveries[id];
      if (!delivery || delivery.outcome === 'cancelled' || delivery.phases.includes(phase)) return;
      if (phase === 'queued' && delivery.phases.includes('taken')) return;
      this.room(1);
      delivery.receiptAt ??= this.now();
      if (phase === 'taken') delivery.outcome = 'taken';
      this.deliveryFact(delivery, phase);
    });
  }

  activity(identity: OperatorIdentity, source?: OperatorDelivery): void {
    this.transition(() => {
      const instance = this.state.instances[identity.instance];
      if (!instance || instance.exited) return;
      const deliveries = this.activityDeliveries(identity, source);
      if (instance.active && !instance.question && !deliveries.length) return;
      this.room(Number(Boolean(instance.question)) + deliveries.length);
      this.clearQuestion(instance);
      instance.active = true;
      for (const delivery of deliveries) {
        delivery.active = true;
        this.deliveryFact(delivery, 'activity');
      }
      this.save();
    });
  }

  private activityDeliveries(identity: OperatorIdentity, source: OperatorDelivery | undefined): Delivery[] {
    return Object.values(this.state.deliveries).filter(delivery => !delivery.active && this.activityOwner(delivery, identity, source));
  }

  sourceActivity(identity: OperatorIdentity, source: OperatorDelivery): void {
    this.transition(() => {
      const instance = this.state.instances[identity.instance];
      const delivery = this.sourceForActivity(identity, source);
      if (!instance || instance.exited || !delivery || delivery.active) return;
      this.room(1);
      instance.active = true;
      delivery.active = true;
      this.deliveryFact(delivery, 'activity');
    });
  }

  private sourceForActivity(identity: OperatorIdentity, source: OperatorDelivery): Delivery | undefined {
    const delivery = this.state.deliveries[source.id];
    return delivery && this.matchesSource(delivery, source) && this.activityOwner(delivery, identity, source) ? delivery : undefined;
  }

  private activityOwner(delivery: Delivery, identity: OperatorIdentity, source: OperatorDelivery | undefined): boolean {
    if (delivery.agentKey !== identity.agentKey || delivery.instance !== identity.instance) return false;
    if (delivery.jobId === identity.jobId) return true;
    return this.matchesSource(delivery, source);
  }

  private matchesSource(delivery: Delivery, source: OperatorDelivery | undefined): boolean {
    return Boolean(source && delivery.id === source.id && delivery.ordinal === source.ordinal);
  }

  finalize(id: string, outcome: 'not_taken' | 'cancelled'): void {
    this.transition(() => {
      const delivery = this.state.deliveries[id];
      if (!delivery || delivery.outcome !== 'pending') return;
      this.room(1);
      delivery.outcome = outcome;
      this.deliveryFact(delivery, outcome);
    });
  }

  tick(): void {
    if (!this.options.connected()) return;
    const errors: unknown[] = [];
    this.transition(() => {
      const check = (instance: Instance, delivery?: Delivery) => {
        const beforeInstance = { ...instance, question: instance.question && { ...instance.question } };
        const beforeDelivery = delivery && { ...delivery, alarms: [...delivery.alarms] };
        const outbox = this.state.outbox.length, facts = this.staged!.facts.length, changed = this.staged!.changed;
        try {
          if (delivery) this.checkDelivery(delivery);
          else this.checkQuestion(instance);
        } catch (error) {
          this.state.instances[instance.instance] = beforeInstance;
          if (beforeDelivery) this.state.deliveries[beforeDelivery.id] = beforeDelivery;
          this.state.outbox.length = outbox;
          this.staged!.facts.length = facts;
          this.staged!.changed = changed;
          errors.push(error);
        }
      };
      for (const id of Object.keys(this.state.instances)) check(this.state.instances[id]!);
      for (const id of Object.keys(this.state.deliveries)) {
        const delivery = this.state.deliveries[id]!;
        /* A delivery always has its program; one without it has nothing to alarm about. */
        const owner = this.state.instances[delivery.instance];
        if (owner) check(owner, delivery);
      }
    });
    if (errors.length) throw errors[0];
  }

  private checkDelivery(delivery: Delivery): void {
    if (this.deliveryInactive(delivery) || this.deferForCheck(delivery)) return;
    if (delivery.receiptAt === null) {
      if (this.elapsed(delivery.at) >= ASSIGNMENT_RECEIPT_MS) this.unrecorded(delivery);
      return;
    }
    if (!delivery.active && this.elapsed(delivery.receiptAt) >= FIRST_ACTIVITY_MS) this.alarm(delivery, 'recorded_no_activity');
  }

  /* What follows the alarm can end the turn, so the screen and the input line come first. */
  private unrecorded(delivery: Delivery): void {
    if (!this.options.look) return this.alarm(delivery, 'assignment_unrecorded');
    if (delivery.alarms.includes('assignment_unrecorded') || this.looking.has(delivery.id)) return;
    this.looking.add(delivery.id);
    void this.options.look(this.identity(delivery))
      .catch((): ProgramLook => ({ input: 'unknown', screen: null }))
      .then(look => this.transition(() => this.alarmLooked(delivery.id, look)))
      .catch(() => {})
      .finally(() => this.looking.delete(delivery.id));
  }

  /* A program inside a tool call records the words it was given once the call ends: it is looked at again a minute later. */
  private alarmLooked(id: string, look: ProgramLook): void {
    const delivery = this.state.deliveries[id];
    if (!delivery || this.deliveryInactive(delivery) || delivery.receiptAt !== null) return;
    if (!look.inToolCall) return this.alarm(delivery, 'assignment_unrecorded', { input: look.input, screen: look.screen });
    delivery.checkAfter = this.now() + ASSIGNMENT_RECEIPT_MS;
    this.save();
  }

  private deferForCheck(delivery: Delivery): boolean {
    if (checkSlotWaiting(delivery.agentKey, delivery.jobId)) {
      delivery.checkAfter = this.now() + (delivery.receiptAt === null ? ASSIGNMENT_RECEIPT_MS : FIRST_ACTIVITY_MS);
      this.save(); return true;
    }
    return delivery.checkAfter !== null && this.now() < delivery.checkAfter;
  }

  private deliveryInactive(delivery: Delivery): boolean {
    return delivery.kind !== 'assignment' || delivery.outcome === 'cancelled' || this.state.instances[delivery.instance]?.exited === true;
  }

  exit(identity: OperatorIdentity, exit: Exit, cause?: ExitCause): void {
    this.transition(() => {
      const instance = this.state.instances[identity.instance];
      if (!instance || instance.exited) return;
      const elapsedMs = this.elapsed(instance.startedAt ?? instance.at);
      const startup = this.startupExit(instance, cause, elapsedMs);
      const pending = Object.values(this.state.deliveries).filter(delivery => delivery.instance === identity.instance && delivery.outcome === 'pending');
      this.room(Number(Boolean(instance.question)) + Number(startup) + pending.length);
      this.clearQuestion(instance);
      instance.exited = true;
      if (startup) {
        instance.alarmed = true;
        this.emit(instance, { type: 'program.operator_needed', ...this.identity(identity), reason: 'startup_exit', deliveryId: null, evidenceKey: identity.instance, elapsedMs, sinceLaunchMs: elapsedMs, exit });
      }
      for (const delivery of pending) {
        this.finalize(delivery.id, cause ? 'cancelled' : 'not_taken');
      }
      this.save();
    });
  }

  replay(): void {
    if (this.options.connected()) for (const fact of this.state.outbox) this.options.send(fact);
  }

  retire(): void {
    for (const instance of Object.values(this.state.instances)) if (!instance.exited) this.exit(instance, { code: null, signal: null }, 'offline');
  }

  recordedSource(id: string): boolean {
    const delivery = this.state.deliveries[id];
    return Boolean(delivery && (delivery.kind === 'live' ? delivery.outcome === 'taken' : delivery.receiptAt !== null));
  }

  /* Once by itself and once by its owner: the server may let only the owner go on. */
  recoveryReady(identity: OperatorIdentity, caseId: string, owner: boolean): void {
    this.transition(() => {
      const instance = this.instance(identity);
      const said = owner ? instance.recoveredByOwner : instance.recovered;
      if (said.includes(caseId) || instance.exited) return;
      this.room(1);
      said.push(caseId);
      this.emit(instance, { type: 'program.recovery_ready', ...identity, case: caseId, owner });
    });
  }

  ack(evidenceId: string): void {
    if (!this.state.outbox.some(fact => fact.evidenceId === evidenceId)) return;
    this.transition(() => {
      this.state.outbox = this.state.outbox.filter(fact => fact.evidenceId !== evidenceId);
      this.prune();
      this.save();
    });
  }

  private prune(): void {
    this.pruneDeliveries();
    const used = new Set([...Object.values(this.state.deliveries).map(delivery => delivery.instance), ...this.state.outbox.map(fact => fact.instance)]);
    for (const instance of Object.values(this.state.instances)) if (instance.exited && !used.has(instance.instance)) delete this.state.instances[instance.instance];
  }

  private pruneDeliveries(): void {
    const unacked = new Set(this.state.outbox.flatMap(fact => fact.type === 'program.delivery' ? [fact.deliveryId] : []));
    const deliveries = Object.values(this.state.deliveries).sort((a, b) => a.at - b.at);
    let excess = deliveries.length - MAX_PENDING / 2;
    for (const delivery of deliveries) {
      if (excess <= 0) break;
      if (!this.prunableDelivery(delivery, unacked)) continue;
      delete this.state.deliveries[delivery.id];
      excess--;
    }
  }

  private prunableDelivery(delivery: Delivery, unacked: Set<string>): boolean {
    if (unacked.has(delivery.id) || delivery.outcome === 'pending') return false;
    return delivery.kind !== 'assignment' || delivery.active || delivery.outcome === 'cancelled';
  }

  private startupExit(instance: Instance, cause: ExitCause | undefined, elapsedMs: number): boolean {
    return !cause && !instance.active && !instance.alarmed && elapsedMs <= STARTUP_EXIT_MS;
  }

  private alarm(delivery: Delivery, reason: OperatorReason, check?: OperatorCheck): void {
    if (delivery.alarms.includes(reason)) return;
    this.room(1);
    delivery.alarms.push(reason);
    const instance = this.state.instances[delivery.instance]!;
    this.emit(instance, { type: 'program.operator_needed', ...this.identity(delivery), reason, deliveryId: delivery.id, evidenceKey: delivery.id, elapsedMs: this.elapsed(delivery.at), sinceLaunchMs: this.elapsed(instance.startedAt ?? instance.at), exit: null, ...(check ? { check: { input: check.input, screen: null } } : {}) }, check?.screen);
  }

  question(identity: OperatorIdentity, input: OperatorQuestion | null, elapsedMs = 0): void {
    this.transition(() => {
      const instance = this.instance(identity);
      if (instance.exited) return;
      const incoming = input && OperatorQuestion.parse(input);
      if (incoming && incoming.id === instance.question?.data.id) {
        if (JSON.stringify(incoming) !== JSON.stringify(instance.question?.data)) throw new Error('A question identity cannot change its request.');
        return;
      }
      this.room(Number(Boolean(instance.question)) + Number(Boolean(incoming)));
      this.clearQuestion(instance);
      if (!incoming) return;
      const question = { data: incoming, jobId: identity.jobId, at: this.now() - Math.max(0, elapsedMs), ordinal: ++instance.questionOrdinal, alarmed: false };
      instance.question = question;
      this.questionFact(instance, question, 'asked');
    });
  }

  private clearQuestion(instance: Instance): void {
    const question = instance.question;
    if (!question) return;
    this.room(1);
    instance.question = null;
    this.questionFact(instance, question, 'cleared');
  }

  private questionFact(instance: Instance, question: z.infer<typeof Question>, phase: 'asked' | 'cleared'): void {
    this.emit(instance, { type: 'program.question', ...this.identity(instance), jobId: question.jobId, question: question.data, questionOrdinal: question.ordinal, phase, elapsedMs: this.elapsed(question.at) });
  }

  private checkQuestion(instance: Instance): void {
    const question = instance.question;
    if (instance.exited || !question || question.alarmed || question.data.kind === 'work' || this.elapsed(question.at) < QUESTION_WAIT_MS) return;
    this.room(1);
    question.alarmed = true;
    this.emit(instance, { type: 'program.operator_needed', ...this.identity(instance), jobId: question.jobId, reason: 'question_waiting', deliveryId: null, questionId: question.data.id, evidenceKey: question.data.id, elapsedMs: this.elapsed(question.at), sinceLaunchMs: this.elapsed(instance.startedAt ?? instance.at), exit: null });
  }

  private room(count: number): void {
    if (this.state.outbox.length + count > MAX_PENDING) throw new Error('The program evidence outbox is full.');
  }

  private deliveryFact(delivery: Delivery, phase: Delivery['phases'][number]): void {
    if (delivery.phases.includes(phase)) return;
    this.room(1);
    delivery.phases.push(phase);
    this.emit(this.state.instances[delivery.instance]!, { type: 'program.delivery', ...this.identity(delivery), deliveryId: delivery.id, deliveryOrdinal: delivery.ordinal, kind: delivery.kind, phase, elapsedMs: this.elapsed(delivery.at), wordsDigest: delivery.digest });
  }

  private emit(instance: Instance, frame: EvidenceInput, screen?: OperatorCheck['screen']): void {
    if (this.state.outbox.length >= MAX_PENDING) throw new Error('The program evidence outbox is full.');
    const fact = StoredEvidence.parse({ ...frame, evidenceId: randomUUID(), ordinal: instance.ordinal++ });
    this.state.outbox.push(fact);
    this.staged!.facts.push(screen && fact.type === 'program.operator_needed' && fact.check ? { ...fact, check: { ...fact.check, screen } } : fact);
    this.save();
  }

  private identity(value: OperatorIdentity): OperatorIdentity { return { agentKey: value.agentKey, jobId: value.jobId, instance: value.instance }; }
  private instance(identity: OperatorIdentity): Instance {
    return this.state.instances[identity.instance] ??= { ...identity, at: this.now(), startedAt: null, active: false, exited: false, ordinal: 0, phases: [], alarmed: false, question: null, questionOrdinal: 0, recovered: [], recoveredByOwner: [] };
  }
  private elapsed(at: number): number { return Math.max(0, Math.floor(this.now() - at)); }

  private save(): void { this.staged!.changed = true; }

  /* Helpers stage one complete local transition. Only its durable snapshot may publish evidence. */
  private transition(change: () => void): void {
    if (this.staged) { change(); return; }
    const previous = this.state;
    const staged = { facts: [] as OperatorEvidence[], changed: false };
    this.state = structuredClone(previous);
    this.staged = staged;
    try {
      change();
      if (staged.changed) writeOperatorStore(this.options.file, this.state);
      else this.state = previous;
    } catch (error) {
      this.state = previous;
      throw error;
    } finally {
      this.staged = null;
    }
    if (this.options.connected()) for (const fact of staged.facts) this.options.send(fact);
  }
}
