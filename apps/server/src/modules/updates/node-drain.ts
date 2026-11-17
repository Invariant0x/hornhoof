import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MachineDrain } from '@hornhoof/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { loggable } from '../../errors.js';
import { pumpWaiting } from '../conversation/queue.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { pumpTests } from '../testruns/runs.js';
import { PROGRAM_OPERATOR_ROLE } from '../operations/required.js';
import { drainPostponed, drainWork, serverNodes } from './drain-work.js';

const Saved = z.object({ key: z.string(), targets: z.array(z.object({ key: z.string(), boot: z.string().nullable() })), companyId: z.string().optional(), view: MachineDrain, touched: z.number() });
type Saved = z.infer<typeof Saved>;
const states = new WeakMap<Ctx, NodeDrains>();
const keyOf = (node: NodeIdentity) => node.kind === 'builtin' ? 'builtin' : node.nodeId;
const nodeOf = (key: string): NodeIdentity => key === 'builtin' ? { kind: 'builtin' } : { kind: 'node', nodeId: key };
/* An installer that disappeared must not hold a node forever. Restarting gets longer for image/container startup. */
const REQUEST_LEASE_MS = 2 * 60_000;
const RESTART_LEASE_MS = 10 * 60_000;

class NodeDrains {
  private readonly records = new Map<string, Saved>();
  private readonly boots = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly paused = new Map<string, number>();
  private readonly path: string;

  constructor(private readonly ctx: Ctx) {
    this.path = join(ctx.config.controlDir, 'node-drains.json');
    let raw: string;
    try { raw = readFileSync(this.path, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const record of z.array(Saved).parse(JSON.parse(raw))) this.records.set(record.key, record);
  }

  view(node: NodeIdentity): MachineDrain | null {
    const views = [...this.records.values()].filter(r => r.targets.some(t => t.key === keyOf(node))).map(r => r.view);
    return views.find(v => v.state === 'waiting') ?? views.find(v => v.state === 'restarting') ?? views[0] ?? null;
  }

  held(node: NodeIdentity): boolean {
    const state = this.view(node)?.state;
    return this.paused.has(keyOf(node)) || state === 'waiting' || state === 'restarting';
  }

  takesTurn(node: NodeIdentity, role: string | null): boolean {
    if (this.paused.has(keyOf(node))) return false;
    const views = [...this.records.values()].filter(r => r.targets.some(t => t.key === keyOf(node))).map(r => r.view);
    return views.every(v => v.state === 'postponed' || (v.state === 'waiting' && role === PROGRAM_OPERATOR_ROLE));
  }

  pause(targets: NodeIdentity[]): () => void {
    for (const node of targets) this.paused.set(keyOf(node), (this.paused.get(keyOf(node)) ?? 0) + 1);
    return () => {
      for (const node of targets) {
        const left = this.paused.get(keyOf(node))! - 1;
        if (left) this.paused.set(keyOf(node), left);
        else this.paused.delete(keyOf(node));
      }
      this.wake();
    };
  }

  restart(targets: NodeIdentity[]): void {
    this.records.set('server', { key: 'server', targets: targets.map(n => ({ key: keyOf(n), boot: this.boots.get(keyOf(n)) ?? null })), touched: Date.now(), view: { state: 'restarting', since: new Date().toISOString() } });
    this.save();
  }

  async request(targets: NodeIdentity[], key: string, companyId?: string): Promise<MachineDrain> {
    const at = Date.now();
    let record = this.records.get(key);
    if (!record) {
      record = { key, targets: targets.map(n => ({ key: keyOf(n), boot: this.boots.get(keyOf(n)) ?? null })), ...(companyId ? { companyId } : {}), view: { state: 'waiting', turnsLeft: 0, partsLeft: 0, until: new Date(at + this.ctx.config.nodeDrainMs).toISOString() }, touched: at };
      this.records.set(key, record);
      try { this.save(); }
      catch (err) { this.records.delete(key); throw err; }
    }
    record.touched = at;
    await this.check(record);
    return record.view;
  }

  hello(node: NodeIdentity, boot: string | undefined): void {
    const key = keyOf(node);
    if (boot) this.boots.set(key, boot);
    for (const record of this.records.values()) {
      const target = record.targets.find(t => t.key === key);
      if (record.view.state !== 'restarting' || !target || !boot || boot === target.boot) continue;
      record.targets = record.targets.filter(t => t !== target);
      if (!record.targets.length) this.cancel(record.key);
      else this.save();
    }
  }

  cancel(key: string): void {
    if (!this.records.delete(key)) return;
    this.save();
    this.wake();
  }

  tick(): void {
    for (const record of this.records.values()) {
      const lease = record.view.state === 'restarting' ? RESTART_LEASE_MS : REQUEST_LEASE_MS;
      if (Date.now() - record.touched > lease) { this.cancel(record.key); continue; }
      void this.check(record).catch(err => this.ctx.log.error({ error: loggable(err) }, 'Could not check a node waiting for an update.'));
    }
  }

  private check(record: Saved): Promise<void> {
    const prior = this.pending.get(record.key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.advance(record));
    this.pending.set(record.key, next);
    void next.finally(() => { if (this.pending.get(record.key) === next) this.pending.delete(record.key); }).catch(() => {});
    return next;
  }

  private async advance(record: Saved): Promise<void> {
    if (this.records.get(record.key) !== record || record.view.state === 'restarting') return;
    const now = Date.now();
    if (record.view.state === 'postponed') {
      if (Date.parse(record.view.retryAt) > now) return;
      record.view = { state: 'waiting', turnsLeft: 0, partsLeft: 0, until: new Date(now + this.ctx.config.nodeDrainMs).toISOString() };
      this.save();
    }
    const targets = record.targets.map(t => nodeOf(t.key));
    const work = await drainWork(this.ctx, targets, record.companyId);
    if (this.records.get(record.key) !== record) return;
    const counts = { turnsLeft: work.turnsLeft, partsLeft: work.partsLeft };
    if (!work.turns.length && !work.parts.length) {
      record.view = { state: 'restarting', since: new Date(now).toISOString() };
      this.save();
      return;
    }
    if (Date.parse(record.view.until) > now) {
      record.view = { ...record.view, ...counts };
      this.save();
      return;
    }
    const retryAt = new Date(now + this.ctx.config.nodeUpdateRetryMs).toISOString();
    record.view = { state: 'postponed', ...counts, retryAt };
    this.save();
    this.wake();
    await drainPostponed(this.ctx, targets, retryAt, work);
  }

  private save(): void {
    mkdirSync(this.ctx.config.controlDir, { recursive: true });
    const next = `${this.path}.new`;
    writeFileSync(next, JSON.stringify([...this.records.values()]), { mode: 0o600 });
    renameSync(next, this.path);
  }

  private wake(): void {
    void Promise.all([pumpWaiting(this.ctx), pumpTests(this.ctx)]).catch(err => this.ctx.log.error({ error: loggable(err) }, 'Could not resume work after postponing an update.'));
  }
}

export function startNodeDrains(app: FastifyInstance, ctx: Ctx): void {
  const drains = new NodeDrains(ctx);
  states.set(ctx, drains);
  const timer = setInterval(() => drains.tick(), Math.min(1000, ctx.config.nodeDrainMs, ctx.config.nodeUpdateRetryMs));
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

export const nodeDrain = (ctx: Ctx, node: NodeIdentity): MachineDrain | null => states.get(ctx)?.view(node) ?? null;
export const nodeHeld = (ctx: Ctx, node: NodeIdentity): boolean => states.get(ctx)?.held(node) ?? false;
export const nodeTakesTurn = (ctx: Ctx, node: NodeIdentity, role: string | null = null): boolean => states.get(ctx)?.takesTurn(node, role) ?? true;
export const pauseNodeWork = (ctx: Ctx, targets: NodeIdentity[]): (() => void) => states.get(ctx)!.pause(targets);
export const restartServerNodes = (ctx: Ctx, targets: NodeIdentity[]): void => states.get(ctx)!.restart(targets);
export const requestNodeDrain = (ctx: Ctx, node: NodeIdentity): Promise<MachineDrain> => states.get(ctx)!.request([node], keyOf(node));
export const cancelNodeDrain = (ctx: Ctx, node: NodeIdentity): void => states.get(ctx)?.cancel(keyOf(node));
export const requestServerDrain = async (ctx: Ctx, companyId?: string): Promise<MachineDrain> => states.get(ctx)!.request(await serverNodes(ctx), 'server', companyId);
export const cancelServerDrain = (ctx: Ctx): void => states.get(ctx)?.cancel('server');
export const nodeDrainHello = (ctx: Ctx, node: NodeIdentity, boot: string | undefined): void => states.get(ctx)?.hello(node, boot);

export function machineDrain(ctx: Ctx, nodes: NodeIdentity[]): MachineDrain | null {
  const views = [...new Set(nodes.map(n => nodeDrain(ctx, n)).filter((v): v is MachineDrain => v !== null))];
  const waiting = views.filter(v => v.state === 'waiting');
  if (waiting.length) return { state: 'waiting', turnsLeft: waiting.reduce((n, v) => n + v.turnsLeft, 0), partsLeft: waiting.reduce((n, v) => n + v.partsLeft, 0), until: waiting.map(v => v.until).sort()[0]! };
  return views.find(v => v.state === 'restarting') ?? views[0] ?? null;
}
