import { eq } from 'drizzle-orm';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, jobs } from '../src/db/schema.js';
import { said } from '../src/modules/conversation/live.js';
import { listEvents } from '../src/modules/events/store.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { failureCompany } from './failure-company.js';
import { listen, mcp } from './helpers.js';

export async function waitCompany() {
  const c = await failureCompany();
  await listen(c.app);
  c.sent.mockImplementation((_node, message) => {
    if (message.type === 'agent.say') queueMicrotask(() => said(c.ctx, BUILTIN, message.ref, true));
    return true;
  });
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const run = async (agentId = c.agent.id, taskId?: string) => {
    const token = `wait-flow-${agentId}`;
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Work.', status: 'running', taskId, startedAt: new Date(), timeoutMs: 1000, toolTokenHash: hashToken(token) }).returning();
    return { job: job!, client: await mcp(c.app, token) };
  };
  const task = async (agentId = c.agent.id) => (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Publish images', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: agentId, executor: true, resultKind: 'code' })).task;
  const messages = async (agentId: string) => (await listEvents(c.db, agentId, 0)).filter(e => e.kind === 'message' && e.message?.direction === 'in');
  return { ...c, orchestrator: orchestrator!, run, task, messages };
}
