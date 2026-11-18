import { and, eq, isNotNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { tasks, testParts, testRuns } from '../../db/schema.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { partsOfNode } from '../nodes/check-slots.js';
import { alreadyAlerted, busyAgentIds, enqueueProgramAlarm, screenReader } from '../tasks/silent.js';

const sending = new WeakMap<Ctx, Set<string>>();

/* A repeat attempt has a new id. Operations hear once for the part in its run, including across a reconnect or restart. */
export async function alertSilentPart(ctx: Ctx, node: NodeIdentity, partId: string): Promise<void> {
  const [row] = await ctx.db.select({ part: testParts.part, machine: testParts.machineName, run: testRuns, task: tasks.number }).from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId)).innerJoin(tasks, eq(tasks.id, testRuns.taskId))
    .where(and(eq(testParts.id, partId), eq(testParts.status, 'running'), isNotNull(testParts.startedAt), partsOfNode(ctx, node)));
  if (!row) return;
  const { run, part } = row;
  const caseId = `run-part:${run.id}:${part}`;
  const pending = sending.get(ctx) ?? new Set<string>();
  sending.set(ctx, pending);
  if (pending.has(caseId)) return;
  pending.add(caseId);
  try {
    if (await alreadyAlerted(ctx, caseId)) return;
    const to = await screenReader(ctx, run.companyId, run.agentId ?? '', await busyAgentIds(ctx));
    if (!to) return;
    const work = run.kind === 'work';
    const name = `${work ? 'Work' : 'Test'} run ${run.number}, part ${part}`;
    const text = `Hornhoof: ${name} on ${row.machine ?? 'a machine'} has given no output or progress within its expected time. ` +
      `Task #${row.task}. Read ${work ? 'work_run' : 'test_run'} ${run.number} for the part's state.`;
    await enqueueProgramAlarm(ctx, to, { caseId, text, task: { id: run.taskId, number: row.task },
      detail: { en: `${name} is silent`, ru: `Прогон ${run.number}, часть ${part} молчит` } });
  } finally { pending.delete(caseId); }
}
