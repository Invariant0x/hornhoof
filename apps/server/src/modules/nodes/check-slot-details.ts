import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, jobs, tasks, testParts, testRuns } from '../../db/schema.js';
import { onTask } from '../tasks/attachments.js';
import type { ToolJob } from '../tools/job.js';
import { builtinOf, keyOf, nodeIdentity, ownBuiltin, type NodeIdentity } from './hub.js';
import { checkQueueSnapshot } from './check-slots.js';
import type { CheckClaim } from './check-slots-queue.js';

type Part = typeof testParts.$inferSelect;
type Actor = { kind: 'tests' | 'work'; run: number; task: number; part: number }
  | { kind: 'check'; task: number | null; agent: string; label: string }
  | { kind: 'unavailable' };
type Claim = Actor & { since: string; position: number; releasing: boolean };
type Slot = { machine: string; state: 'queued' | 'running' | 'not_recorded'; capacity: number | null; queued: number | null; position: number | null; holders: Claim[]; ahead: Claim[] };
export type CheckWait = { queuePosition: number | null; checkSlot: Slot; waiting: string };

const oneLine = (value: string): string => value.replace(/[\s\p{Cc}]+/gu, ' ').trim();
const partNode = (ctx: Ctx, part: Pick<Part, 'builtin' | 'builtinMachine' | 'nodeId'>): NodeIdentity | null => part.builtin
  ? part.builtinMachine ? builtinOf(part.builtinMachine) : ownBuiltin(ctx.config)
  : part.nodeId ? nodeIdentity(part.nodeId) : null;

/* Labels identify existing run parts; neither a label nor a machine claim grants access to that part. */
async function actorOf(ctx: Ctx, viewer: ToolJob, claim: CheckClaim): Promise<Actor> {
  const partId = /^Run part (.+)$/.exec(claim.request.label)?.[1];
  if (partId && z.uuid().safeParse(partId).success) {
    const [row] = await ctx.db.select({ part: testParts, run: testRuns, task: tasks }).from(testParts)
      .innerJoin(testRuns, eq(testRuns.id, testParts.runId)).innerJoin(tasks, eq(tasks.id, testRuns.taskId))
      .where(and(eq(testParts.companyId, viewer.companyId), eq(testRuns.companyId, viewer.companyId), eq(tasks.companyId, viewer.companyId), eq(testParts.id, partId)));
    const node = row && partNode(ctx, row.part);
    if (row && node && keyOf(node) === claim.node && (row.run.agentId === viewer.agentId || onTask(viewer, row.task))) {
      return { kind: row.run.kind, run: row.run.number, task: row.task.number, part: row.part.part };
    }
  }
  if (claim.request.jobId) {
    const [row] = await ctx.db.select({ job: jobs, task: tasks, name: agents.name }).from(jobs)
      .innerJoin(agents, eq(agents.id, jobs.agentId)).leftJoin(tasks, eq(tasks.id, jobs.taskId))
      .where(and(eq(jobs.companyId, viewer.companyId), eq(jobs.id, claim.request.jobId)));
    const node = row && partNode(ctx, { ...row.job, builtin: row.job.nodeId === null });
    if (row && node && keyOf(node) === claim.node && (row.job.agentId === viewer.agentId || (row.task && onTask(viewer, row.task)))) {
      return { kind: 'check', task: row.task?.number ?? null, agent: oneLine(row.name), label: oneLine(claim.request.label) };
    }
  }
  return { kind: 'unavailable' };
}

async function claimView(ctx: Ctx, job: ToolJob, claim: CheckClaim): Promise<Claim> {
  return { ...await actorOf(ctx, job, claim), since: new Date(claim.startedAt ?? claim.queuedAt).toISOString(), position: claim.position, releasing: claim.retired };
}

function claimLine(claim: Claim): string {
  const who = claim.kind === 'unavailable' ? 'Check (details unavailable)' : claim.kind === 'check'
    ? `Check ${claim.label} by ${claim.agent}, task ${claim.task ?? 'unknown'}`
    : `${claim.kind === 'work' ? 'Work' : 'Test'} run ${claim.run}, task ${claim.task}, part ${claim.part}`;
  return `${who}, since ${claim.since}${claim.releasing ? ', releasing' : ''}`;
}

function waitingLine(slot: Slot, recorded: boolean): string {
  const state = { running: 'Machine check slot granted', queued: 'Waiting for a machine check slot', not_recorded: 'Machine check request is not recorded' }[slot.state];
  const holders = slot.holders.length ? slot.holders.map(claimLine).join('; ') : 'none';
  const ahead = slot.ahead.length ? slot.ahead.map(claim => `${claim.position}: ${claimLine(claim)}`).join('; ') : 'nobody';
  const empty = recorded && slot.queued === 0 && !slot.holders.length && slot.state === 'not_recorded' ? ' Queue is empty; no matching request is recorded.' : '';
  return `${state} on ${slot.machine}. Position ${slot.position ?? 'unknown'}. Capacity ${slot.capacity ?? 'unknown'}. Queued ${slot.queued ?? 'unknown'}. Holders: ${holders}. Ahead: ${ahead}.${empty}${recorded ? '' : ' Queue state is not recorded by this server.'}`;
}

/* This result is read live for each caller; a stored waiting line cannot keep showing a holder that already released. */
export async function partCheckWait(ctx: Ctx, job: ToolJob, part: Part): Promise<CheckWait | null> {
  const node = partNode(ctx, part);
  const snapshot = node ? checkQueueSnapshot(ctx, node) : null;
  const mine = (claim: CheckClaim) => claim.node === (node && keyOf(node)) && claim.request.label === `Run part ${part.id}`;
  const waiting = snapshot?.queue.find(mine), running = snapshot?.holders.find(mine);
  const reported = /^Waiting for a machine check slot\. Position ([1-9][0-9]*)\.$/.exec(part.tail)?.[1];
  if (!reported && !waiting && !running) return null;
  const position = waiting?.position ?? (running ? 0 : reported ? Number(reported) : null);
  const slot: Slot = {
    machine: oneLine(part.machineName ?? 'a machine'), state: waiting ? 'queued' : running ? 'running' : 'not_recorded', capacity: snapshot?.capacity ?? null, queued: snapshot?.queue.length ?? null, position,
    holders: await Promise.all((snapshot?.holders ?? []).map(claim => claimView(ctx, job, claim))),
    ahead: await Promise.all((waiting ? snapshot!.queue.filter(claim => claim.position < waiting.position) : []).map(claim => claimView(ctx, job, claim))),
  };
  return { queuePosition: position, checkSlot: slot, waiting: waitingLine(slot, snapshot !== null) };
}
