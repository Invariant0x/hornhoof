import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ASSIGNMENT_RECEIPT_MS, FIRST_ACTIVITY_MS, OperatorNodeMessage, STARTUP_EXIT_MS, type OperatorDelivery, type OperatorEvidence, type OperatorReason } from '@hornhoof/protocol/program-operator';
import { z } from 'zod';
import { readOperatorStore, writeOperatorStore } from './operator-storage.js';

const Identity = z.object({ agentKey: z.uuid(), jobId: z.uuid().nullable(), instance: z.uuid() });
export type OperatorIdentity = z.infer<typeof Identity>;
const Instance = Identity.extend({ at: z.number(), startedAt: z.number().nullable(), active: z.boolean(), exited: z.boolean(), ordinal: z.number().int().nonnegative(), phases: z.array(z.enum(['attempt', 'started', 'failed'])), alarmed: z.boolean() });
const Delivery = Identity.extend({ id: z.uuid(), ordinal: z.number().int().positive(), kind: z.enum(['assignment', 'live']), digest: z.string(), at: z.number(), receiptAt: z.number().nullable(), active: z.boolean(), outcome: z.enum(['pending', 'taken', 'not_taken', 'cancelled']), phases: z.array(z.enum(['attempt', 'queued', 'taken', 'activity', 'not_taken', 'cancelled'])), alarms: z.array(z.string()) });
const StoredEvidence = OperatorNodeMessage.refine((frame): frame is OperatorEvidence => 'evidenceId' in frame);
const Store = z.object({ instances: z.record(z.string(), Instance), deliveries: z.record(z.string(), Delivery), outbox: z.array(StoredEvidence) });
type Store = z.infer<typeof Store>;
type Delivery = z.infer<typeof Delivery>;
type Instance = z.infer<typeof Instance>;
type Options = { file: string; send(fact: OperatorEvidence): boolean; connected(): boolean; now?(): number };
type Exit = { code: number | null; signal: string | null };
type ExitCause = 'cancelled' | 'update' | 'restart' | 'offline' | 'completed';
type EvidenceInput<T = OperatorEvidence> = T extends OperatorEvidence ? Omit<T, 'evidenceId' | 'ordinal'> : never;
const MAX_PENDING = 4096;

/* Only identities, hashes and bounded facts reach disk; program words and screens stay out of this outbox. */
export class OperatorObserver {
  private readonly state: Store;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => performance.timeOrigin + performance.now());
    this.state = readOperatorStore(options.file, Store, { instances: {}, deliveries: {}, outbox: [] });
  }

  launch(identity: OperatorIdentity, phase: 'attempt' | 'started' | 'failed'): void {
    const instance = this.state.instances[identity.instance] ??= { ...identity, at: this.now(), startedAt: null, active: false, exited: false, ordinal: 0, phases: [], alarmed: false };
    if (instance.phases.includes(phase)) return;
    instance.phases.push(phase);
    if (phase === 'started') instance.startedAt = this.now();
    this.emit(instance, { type: 'program.launch', ...this.identity(instance), phase, elapsedMs: this.elapsed(instance.at) });
  }

  attempt(identity: OperatorIdentity, metadata: OperatorDelivery, kind: 'assignment' | 'live', words: string): void {
    const digest = createHash('sha256').update(words).digest('hex');
    const old = this.state.deliveries[metadata.id];
    if (old) {
      if (old.digest !== digest || old.agentKey !== identity.agentKey || old.ordinal !== metadata.ordinal || old.kind !== kind) throw new Error('A delivery identity cannot be reused for different words.');
      return;
    }
    if (!this.state.instances[identity.instance]) throw new Error('The delivery has no program instance.');
    if (Object.keys(this.state.deliveries).length >= MAX_PENDING) throw new Error('Program delivery history must be acknowledged before more input.');
    const delivery: Delivery = { ...identity, ...metadata, kind, digest, at: this.now(), receiptAt: null, active: false, outcome: 'pending', phases: [], alarms: [] };
    this.state.deliveries[metadata.id] = delivery;
    this.deliveryFact(delivery, 'attempt');
  }

  receipt(id: string, phase: 'queued' | 'taken'): void {
    const delivery = this.state.deliveries[id];
    if (!delivery || delivery.outcome === 'cancelled' || delivery.phases.includes(phase)) return;
    if (phase === 'queued' && delivery.phases.includes('taken')) return;
    delivery.receiptAt ??= this.now();
    if (phase === 'taken') delivery.outcome = 'taken';
    this.deliveryFact(delivery, phase);
  }

  activity(identity: OperatorIdentity): void {
    const instance = this.state.instances[identity.instance];
    if (!instance || instance.exited) return;
    instance.active = true;
    for (const delivery of Object.values(this.state.deliveries)) {
      if (delivery.instance !== identity.instance || delivery.jobId !== identity.jobId || delivery.active) continue;
      delivery.active = true;
      this.deliveryFact(delivery, 'activity');
    }
    this.save();
  }

  finalize(id: string, outcome: 'not_taken' | 'cancelled'): void {
    const delivery = this.state.deliveries[id];
    if (!delivery || delivery.outcome !== 'pending') return;
    delivery.outcome = outcome;
    this.deliveryFact(delivery, outcome);
  }

  tick(): void {
    if (!this.options.connected()) return;
    for (const delivery of Object.values(this.state.deliveries)) this.checkDelivery(delivery);
  }

  private checkDelivery(delivery: Delivery): void {
    if (delivery.kind !== 'assignment' || delivery.outcome === 'cancelled' || this.state.instances[delivery.instance]?.exited) return;
    if (delivery.receiptAt === null) {
      if (this.elapsed(delivery.at) >= ASSIGNMENT_RECEIPT_MS) this.alarm(delivery, 'assignment_unrecorded');
      return;
    }
    if (!delivery.active && this.elapsed(delivery.receiptAt) >= FIRST_ACTIVITY_MS) this.alarm(delivery, 'recorded_no_activity');
  }

  exit(identity: OperatorIdentity, exit: Exit, cause?: ExitCause): void {
    const instance = this.state.instances[identity.instance];
    if (!instance || instance.exited) return;
    instance.exited = true;
    const elapsedMs = this.elapsed(instance.startedAt ?? instance.at);
    if (!cause && !instance.active && !instance.alarmed && elapsedMs <= STARTUP_EXIT_MS) {
      instance.alarmed = true;
      this.emit(instance, { type: 'program.operator_needed', ...this.identity(identity), reason: 'startup_exit', deliveryId: null, evidenceKey: identity.instance, elapsedMs, sinceLaunchMs: elapsedMs, exit });
    }
    for (const delivery of Object.values(this.state.deliveries)) {
      if (delivery.instance !== identity.instance) continue;
      this.finalize(delivery.id, cause ? 'cancelled' : 'not_taken');
    }
    this.save();
  }

  replay(): void {
    if (this.options.connected()) for (const fact of this.state.outbox) this.options.send(fact);
  }

  ack(evidenceId: string): void {
    this.state.outbox = this.state.outbox.filter(fact => fact.evidenceId !== evidenceId);
    this.prune();
    this.save();
  }

  private prune(): void {
    const unacked = new Set(this.state.outbox.flatMap(fact => fact.type === 'program.delivery' ? [fact.deliveryId] : []));
    const deliveries = Object.values(this.state.deliveries).sort((a, b) => a.at - b.at);
    let excess = deliveries.length - MAX_PENDING / 2;
    for (const delivery of deliveries) {
      if (excess <= 0) break;
      if (unacked.has(delivery.id) || delivery.outcome === 'pending') continue;
      if (delivery.kind === 'assignment' && !delivery.active && delivery.outcome !== 'cancelled') continue;
      delete this.state.deliveries[delivery.id];
      excess--;
    }
    const used = new Set([...Object.values(this.state.deliveries).map(delivery => delivery.instance), ...this.state.outbox.map(fact => fact.instance)]);
    for (const instance of Object.values(this.state.instances)) if (instance.exited && !used.has(instance.instance)) delete this.state.instances[instance.instance];
  }

  private alarm(delivery: Delivery, reason: OperatorReason): void {
    if (delivery.alarms.includes(reason)) return;
    delivery.alarms.push(reason);
    const instance = this.state.instances[delivery.instance]!;
    this.emit(instance, { type: 'program.operator_needed', ...this.identity(delivery), reason, deliveryId: delivery.id, evidenceKey: delivery.id, elapsedMs: this.elapsed(delivery.at), sinceLaunchMs: this.elapsed(instance.startedAt ?? instance.at), exit: null });
  }

  private deliveryFact(delivery: Delivery, phase: Delivery['phases'][number]): void {
    if (delivery.phases.includes(phase)) return;
    delivery.phases.push(phase);
    this.emit(this.state.instances[delivery.instance]!, { type: 'program.delivery', ...this.identity(delivery), deliveryId: delivery.id, deliveryOrdinal: delivery.ordinal, kind: delivery.kind, phase, elapsedMs: this.elapsed(delivery.at), wordsDigest: delivery.digest });
  }

  private emit(instance: Instance, frame: EvidenceInput): void {
    if (this.state.outbox.length >= MAX_PENDING) throw new Error('The program evidence outbox is full.');
    const fact = StoredEvidence.parse({ ...frame, evidenceId: randomUUID(), ordinal: instance.ordinal++ });
    this.state.outbox.push(fact);
    this.save();
    if (this.options.connected()) this.options.send(fact);
  }

  private identity(value: OperatorIdentity): OperatorIdentity { return { agentKey: value.agentKey, jobId: value.jobId, instance: value.instance }; }
  private elapsed(at: number): number { return Math.max(0, Math.floor(this.now() - at)); }

  private save(): void {
    writeOperatorStore(this.options.file, this.state);
  }
}
