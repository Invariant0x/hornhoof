import { eq } from 'drizzle-orm';
import { maskEvent, seesAgentId, type AgentViewer } from '../../auth/agent-view.js';
import type { Db } from '../../db/client.js';
import { tasks } from '../../db/schema.js';
import { seesTask } from '../tasks/sight.js';
import type { Endpoint, StreamMessage } from './bus.js';
import { workingCount } from './store.js';

type Listener = { db: Db; companyId: string; viewer: AgentViewer };
type Heard = StreamMessage | null | Promise<StreamMessage | null>;
type Filters = { [K in StreamMessage['type']]: (m: Extract<StreamMessage, { type: K }>, who: Listener) => Heard };

/* A pulse shows where it runs: both of its ends must be this person or agents they see. */
const seesEnd = (viewer: AgentViewer, end: Endpoint) => (end.kind === 'person' ? end.id === viewer.personId : end.kind === 'agent' && seesAgentId(viewer, end.id));

/* What someone with the full view hears of a message: all of it, but nothing of another person's assistant's own agent,
   which its owner alone sees, nor its name at the other end of a message. */
export function heardInFull(viewer: AgentViewer, m: StreamMessage): StreamMessage | null {
  if (!viewer.apart.size) return m;
  const apart = (end: Endpoint) => end.kind === 'agent' && viewer.apart.has(end.id);
  if (m.type === 'agent_event') return viewer.apart.has(m.agentId) ? null : { ...m, event: maskEvent(viewer, m.event) };
  if (m.type === 'context') return viewer.apart.has(m.agentId) ? null : m;
  if (m.type === 'pulse') return apart(m.from) || apart(m.to) ? null : m;
  return m;
}

/* How many of the employees this person sees are at work. */
export const workingSeen = (db: Db, companyId: string, viewer: AgentViewer) => workingCount(db, companyId, viewer.full ? undefined : [...viewer.agents], true);

const passes = (m: StreamMessage) => m;

/* What someone without the full view hears of a message, or nothing: only what they see of agents and their work. The last
   ones say only that something changed where the person reaches. A new kind of message has to be named here. */
const FILTERS: Filters = {
  agent_event: (m, { viewer }) => (seesAgentId(viewer, m.agentId) ? { ...m, event: maskEvent(viewer, m.event) } : null),
  context: (m, { viewer }) => (seesAgentId(viewer, m.agentId) ? m : null),
  pulse: (m, { viewer }) => (seesEnd(viewer, m.from) && seesEnd(viewer, m.to) ? m : null),
  working: async (_m, { db, companyId, viewer }) => ({ type: 'working', working: await workingSeen(db, companyId, viewer) }),
  task: async (m, { db, viewer }) => {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, m.id));
    return task && seesTask(viewer, task) ? m : null;
  },
  org: passes,
  requests: passes,
  notebook: passes,
  improvements: passes,
  backlog: passes,
  computer: passes,
  'subscription.signin': passes,
};

export async function heardBy(db: Db, companyId: string, viewer: AgentViewer, m: StreamMessage): Promise<StreamMessage | null> {
  const filter = FILTERS[m.type] as (m: StreamMessage, who: Listener) => Heard;
  return filter(m, { db, companyId, viewer });
}
