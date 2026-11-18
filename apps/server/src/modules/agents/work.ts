import { and, desc, eq, inArray, isNotNull, ne, notInArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { viewerOf } from '../../auth/agent-view.js';
import type { Person } from '../../auth/session.js';
import { agents, jobs, requests, tasks } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { seesTask } from '../tasks/visibility.js';
import { notStep } from '../tools/steps.js';

type Task = typeof tasks.$inferSelect;
type Agent = Pick<typeof agents.$inferSelect, 'id' | 'subscriptionId'>;
type Run = Pick<typeof jobs.$inferSelect, 'id' | 'agentId' | 'taskId' | 'startedAt' | 'createdAt'>;
type Asked = Pick<typeof requests.$inferSelect, 'agentId' | 'taskId'>;
type Status = 'off' | 'working' | 'waiting' | 'queued' | 'handed' | 'idle';
type Work = { status: Status; task: Task | null };
type Facts = { openTasks: Task[]; running: Run[]; asked: Asked[]; notDone: ReadonlySet<string> };

/* Only the current assignee owns a task, including a checker who received it from its author. */
function holds(task: Task, agentId: string): boolean {
  return task.assigneeAgentId === agentId;
}

function waiting(agentId: string, facts: Facts, held: Task[]): Task[] {
  const byId = new Map(facts.openTasks.map(t => [t.id, t]));
  const asked = facts.asked.filter(r => r.agentId === agentId).map(r => byId.get(r.taskId)).filter(t => t !== undefined);
  return [...asked, ...held.filter(t => t.status === 'blocked' || t.status === 'waiting')];
}

function choices(agentId: string, facts: Facts) {
  const held = facts.openTasks.filter(t => holds(t, agentId) && !t.after.some(id => facts.notDone.has(id)));
  const parents = new Set(facts.openTasks.map(t => t.parentId));
  const waits = waiting(agentId, facts, held);
  const next = held.filter(t => !parents.has(t.id) && !waits.includes(t));
  const gave = [...facts.openTasks.filter(t => t.assigneeAgentId !== agentId && t.executorAgentId === agentId), ...held.filter(t => parents.has(t.id))];
  return { held, waits, next, gave };
}

/* A running turn identifies its task before any queued work. Otherwise keep the task the agent holds or waits on. */
function doing(agent: Agent, facts: Facts): Work {
  const pick = (status: Status, task?: Task | null): Work => ({ status, task: task ?? null });
  if (!agent.subscriptionId) return pick('off');
  const run = facts.running.find(j => j.agentId === agent.id);
  const { held, waits, next, gave } = choices(agent.id, facts);
  if (run) return pick('working', facts.openTasks.find(t => t.id === run.taskId) ?? next[0] ?? held[0]);
  if (waits.length) return pick('waiting', waits[0]);
  if (next.length) return pick('queued', next[0]);
  if (gave.length) return pick('handed', gave[0]);
  return pick('idle');
}

/* The map and the agent API read the same work state; neither derives a task from the map's visible employees. */
export async function agentWork(db: Db, companyId: string) {
  const openTasks = await db.select().from(tasks)
    .where(and(eq(tasks.companyId, companyId), notInArray(tasks.status, ['done', 'cancelled'])))
    .orderBy(desc(tasks.number));
  const running = await db.select({ id: jobs.id, agentId: jobs.agentId, taskId: jobs.taskId, startedAt: jobs.startedAt, createdAt: jobs.createdAt })
    .from(jobs).where(and(eq(jobs.companyId, companyId), eq(jobs.status, 'running'), isNotNull(jobs.agentId), notStep));
  const asked = await db.select({ agentId: requests.agentId, taskId: requests.taskId })
    .from(requests).where(and(eq(requests.companyId, companyId), eq(requests.status, 'open')));
  const afterIds = [...new Set(openTasks.flatMap(t => t.after))];
  const notDone = new Set(afterIds.length ? (await db.select(idOnly(tasks)).from(tasks).where(and(inArray(tasks.id, afterIds), ne(tasks.status, 'done')))).map(t => t.id) : []);
  const facts: Facts = { openTasks, running, asked, notDone };
  return { openTasks, running, busy: new Set(running.map(j => j.agentId)), doing: (agent: Agent) => doing(agent, facts) };
}

export async function currentAgentTask(db: Db, agent: typeof agents.$inferSelect, viewer: Person): Promise<{ id: string; number: number; title: string } | null> {
  const current = (await agentWork(db, agent.companyId)).doing(agent).task;
  if (!current || !seesTask(await viewerOf(db, viewer), current)) return null;
  return { id: current.id, number: current.number, title: current.title };
}
