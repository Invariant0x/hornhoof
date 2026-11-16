import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MachineDrain, type NodeWait } from '@hornhoof/protocol';
import { PROGRAM_OPERATOR_ROLE } from '@hornhoof/protocol/program-operator';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { loggable } from '../../errors.js';
import { pumpWaiting } from '../conversation/queue.js';
import { identityOfKey, keyOf, ownBuiltin, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { pumpTests } from '../testruns/runs.js';
import { hasLiveDrainWork } from './drain-live.js';
import { drainPostponed, drainWork, namedWork, nodePlaces, type Place } from './drain-work.js';

/* heldAt: when this hold of the node began. A wait saved before this began when the server read it. */
const Saved = z.object({ key: z.string(), boot: z.string().nullable(), view: MachineDrain, touched: z.number(), heldAt: z.number().default(() => Date.now()) });
type Saved = z.infer<typeof Saved>;
type Drain = { node: NodeIdentity; view: MachineDrain };
/* By the config, which a transaction's copy of the context shares with the context itself. */
const states = new WeakMap<Ctx['config'], NodeDrains>();
/* An installer that disappeared must not hold a node forever. Restarting gets longer for image/container startup. */
const REQUEST_LEASE_MS = 2 * 60_000;
const RESTART_LEASE_MS = 10 * 60_000;

class NodeDrains {
  private readonly records = new Map<string, Saved>();
  private readonly boots = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();
  /* The nodes whose hold ran past what the orchestrator and the heads wait, for which they were woken. */
  private readonly woken = new Set<string>();
  private readonly path: string;

  constructor(private readonly ctx: Ctx) {
    this.path = join(ctx.config.controlDir, 'node-drains.json');
    let raw: string;
    try { raw = readFileSync(this.path, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    /* A damaged file only forgets the waits: each installer asks again, and the file is written anew. */
    /* A wait a build before saved for the server's built-in node names it by its bare word. */
    try { for (const record of z.array(Saved).parse(JSON.parse(raw))) { const key = keyOf(this.nodeOf(record.key)); this.records.set(key, { ...record, key }); } }
    catch (err) { ctx.log.error({ error: loggable(err) }, `Could not read ${this.path}: no node waits for an update now.`); }
  }

  private nodeOf(key: string): NodeIdentity {
    return identityOfKey(key, ownBuiltin(this.ctx.config));
  }

  view(node: NodeIdentity): MachineDrain | null {
    return this.records.get(keyOf(node))?.view ?? null;
  }

  all(): Drain[] {
    return [...this.records.values()].map(r => ({ node: this.nodeOf(r.key), view: r.view }));
  }

  heldLong(node: NodeIdentity): boolean {
    const record = this.records.get(keyOf(node));
    return record ? this.overHold(record) : false;
  }

  private overHold(record: Saved): boolean {
    return record.view.state !== 'postponed' && Date.now() - record.heldAt >= this.ctx.config.nodeLeaderHoldMs;
  }

  async request(node: NodeIdentity): Promise<MachineDrain> {
    const key = keyOf(node);
    const at = Date.now();
    let record = this.records.get(key);
    if (!record) {
      record = { key, boot: this.boots.get(key) ?? null, view: { state: 'waiting', turnsLeft: 0, partsLeft: 0, until: new Date(at + this.ctx.config.nodeDrainMs).toISOString() }, touched: at, heldAt: at };
      this.records.set(key, record);
      try { this.save(); }
      catch (err) { this.records.delete(key); throw err; }
    }
    record.touched = at;
    await this.check(record, true);
    return record.view;
  }

  hello(node: NodeIdentity, boot: string | undefined): void {
    const key = keyOf(node);
    if (boot) this.boots.set(key, boot);
    const record = this.records.get(key);
    if (record?.view.state === 'restarting' && boot && boot !== record.boot) this.cancel(node);
  }

  cancel(node: NodeIdentity): void {
    if (!this.records.delete(keyOf(node))) return;
    this.woken.delete(keyOf(node));
    this.save();
    this.wake();
  }

  tick(): void {
    for (const record of this.records.values()) {
      const lease = record.view.state === 'restarting' ? RESTART_LEASE_MS : REQUEST_LEASE_MS;
      if (Date.now() - record.touched > lease) { this.cancel(this.nodeOf(record.key)); continue; }
      this.wakeLeaders(record);
      void this.check(record).catch(err => this.ctx.log.error({ error: loggable(err) }, 'Could not check a node waiting for an update.'));
    }
  }

  /* Once, at the limit: nothing else starts the turns of the orchestrator and the heads that the node kept waiting. */
  private wakeLeaders(record: Saved): void {
    if (this.woken.has(record.key) || !this.overHold(record)) return;
    this.woken.add(record.key);
    this.wake();
  }

  /* asked: an updater asks now, and hears the answer. */
  private check(record: Saved, asked = false): Promise<void> {
    const prior = this.pending.get(record.key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.advance(record, asked));
    this.pending.set(record.key, next);
    void next.finally(() => { if (this.pending.get(record.key) === next) this.pending.delete(record.key); }).catch(() => {});
    return next;
  }

  private async advance(record: Saved, asked: boolean): Promise<void> {
    if (this.records.get(record.key) !== record || record.view.state === 'restarting') return;
    const now = Date.now();
    if (record.view.state === 'postponed') {
      if (Date.parse(record.view.retryAt) > now) return;
      record.view = { state: 'waiting', turnsLeft: 0, partsLeft: 0, until: new Date(now + this.ctx.config.nodeDrainMs).toISOString() };
      record.heldAt = now;
      this.woken.delete(record.key);
      this.save();
    }
    const node = this.nodeOf(record.key);
    const found = await this.workOf(record, node, now);
    if (!found) return;
    const { work, live } = found;
    const counts = { turnsLeft: work.turnsLeft, partsLeft: work.partsLeft };
    /* A node restarts only for an updater told it is free. Until one asks, the node waits with nothing left on it, so the
       orchestrator and the heads come back past their limit and the hold ends with the lease of a wait: an updater that
       went away never restarts it. */
    if (!live) {
      record.view = asked ? { state: 'restarting', since: new Date(now).toISOString() } : { ...record.view, turnsLeft: 0, partsLeft: 0 };
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
    await drainPostponed(this.ctx, node, retryAt, work);
  }

  /* The work that holds the node and whether any of it is live, or null when this hold ended meanwhile. */
  private async workOf(record: Saved, node: NodeIdentity, now: number): Promise<{ work: Awaited<ReturnType<typeof drainWork>>; live: boolean } | null> {
    const work = await drainWork(this.ctx, node);
    if (this.records.get(record.key) !== record) return null;
    const live = (work.turns.length > 0 || work.parts.length > 0) && (await hasLiveDrainWork(this.ctx, node, now));
    return this.records.get(record.key) === record ? { work, live } : null;
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

/* What it knows of the nodes is read on any machine; its rounds change turns and runs, so they go only while the app leads. */
export function startNodeDrains(ctx: Ctx): void {
  const drains = new NodeDrains(ctx);
  states.set(ctx.config, drains);
  let timer: NodeJS.Timeout | null = null;
  ctx.mode.whenLead(
    () => {
      timer = setInterval(() => drains.tick(), Math.min(1000, ctx.config.nodeDrainMs, ctx.config.nodeUpdateRetryMs));
      timer.unref();
    },
    () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  );
}

export const nodeDrain = (ctx: Ctx, node: NodeIdentity): MachineDrain | null => states.get(ctx.config)?.view(node) ?? null;
export const nodeHeld = (ctx: Ctx, node: NodeIdentity): boolean => {
  const state = nodeDrain(ctx, node)?.state;
  return state === 'waiting' || state === 'restarting';
};
/* Whether the node has held new turns for longer than the orchestrator and the heads wait. */
export const nodeHeldLong = (ctx: Ctx, node: NodeIdentity): boolean => states.get(ctx.config)?.heldLong(node) ?? false;
/* Whether a new turn of this role stays off the node. A program operator's goes in while the node waits, since a program
   there may wait for its answer; its case ends within OPERATOR_CASE_MS, so it does not hold the wait longer. So does the
   orchestrator's or a head's past the limit: nothing else can take it, the company waits for it, and the work that runs on
   the node goes on either way. A node that restarts takes nothing. */
export const nodeHeldFrom = (ctx: Ctx, node: NodeIdentity, role: string | null | undefined, leader = false): boolean => {
  const state = nodeDrain(ctx, node)?.state;
  return state === 'waiting' ? !entersWaitingNode(ctx, node, role, leader) : state === 'restarting';
};
const entersWaitingNode = (ctx: Ctx, node: NodeIdentity, role: string | null | undefined, leader: boolean): boolean =>
  role === PROGRAM_OPERATOR_ROLE || (leader && nodeHeldLong(ctx, node));
export const requestNodeDrain = (ctx: Ctx, node: NodeIdentity): Promise<MachineDrain> => states.get(ctx.config)!.request(node);
export const cancelNodeDrain = (ctx: Ctx, node: NodeIdentity): void => states.get(ctx.config)?.cancel(node);
export const nodeDrainHello = (ctx: Ctx, node: NodeIdentity, boot: string | undefined): void => states.get(ctx.config)?.hello(node, boot);

export function machineDrain(ctx: Ctx, nodes: NodeIdentity[]): MachineDrain | null {
  const views = nodes.map(n => nodeDrain(ctx, n)).filter((v): v is MachineDrain => v !== null);
  const waiting = views.filter(v => v.state === 'waiting');
  if (waiting.length) return { state: 'waiting', turnsLeft: waiting.reduce((n, v) => n + v.turnsLeft, 0), partsLeft: waiting.reduce((n, v) => n + v.partsLeft, 0), until: waiting.map(v => v.until).sort()[0]! };
  return views.find(v => v.state === 'restarting') ?? views[0] ?? null;
}

/* Of each node this company sees, what it waits for and until when: the built-in node and the company's own, the built-in
   one first. Other companies' work on the built-in node counts in its numbers and has no names. */
export async function nodeWaits(ctx: Ctx, companyId: string): Promise<NodeWait[]> {
  const drains = states.get(ctx.config)?.all() ?? [];
  const ids = drains.flatMap(d => (d.node.kind === 'node' ? [d.node.nodeId] : []));
  const places = await nodePlaces(ctx, companyId, ids);
  const seen = drains.filter(d => d.node.kind === 'builtin' || places.has(d.node.nodeId));
  const waits = await Promise.all(seen.map(d => nodeWait(ctx, companyId, d, d.node.kind === 'node' ? places.get(d.node.nodeId) : undefined)));
  return waits.sort((a, b) => placeOrder(a).localeCompare(placeOrder(b)));
}

async function nodeWait(ctx: Ctx, companyId: string, { node, view }: Drain, place: Place | undefined): Promise<NodeWait> {
  const work = view.state === 'restarting' ? [] : namedWork(await drainWork(ctx, node), companyId);
  /* The server's own built-in node goes by its bare word, as the screens know it. */
  return { node: sameNode(node, ownBuiltin(ctx.config)) ? 'builtin' : keyOf(node), provider: place?.provider ?? null, hostname: place?.hostname ?? null, drain: view, work };
}

const placeOrder = (wait: NodeWait): string => (wait.hostname === null ? '' : `${wait.hostname} ${wait.provider ?? ''} ${wait.node}`);
