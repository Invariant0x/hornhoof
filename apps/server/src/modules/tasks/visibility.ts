import { canReach } from '../../auth/access.js';
import { knowsAgentId, seesAgentId, type AgentViewer } from '../../auth/agent-view.js';
import { taskSpot, type Task } from './state.js';
/* What a person reads of tasks (auth/agent-view.ts): every task of the company, with every employee named in it and its
   stages, as the tasks are the company's work. What an agent said in them is its own, for the people who open that agent;
   what the repository says stays with the CEO's view and the owner of the task's department. Changing a task goes by who
   acts on its work. Agents' own tools do not come this way. */

export type TaskPlace = Pick<Task, 'departmentId' | 'productId' | 'createdByPersonId' | 'createdByAgentId' | 'assigneeAgentId' | 'executorAgentId'>;

/* Every task of the company, but the work of another person's assistant's own agent. */
export function seesTask(viewer: Pick<AgentViewer, 'apart'>, task: TaskPlace): boolean {
  return [task.assigneeAgentId, task.executorAgentId].every(id => !id || knowsAgentId(viewer, id));
}

/* Whether the person changes the task: the work of the agents they open in a place they reach, and what they gave themselves. */
export function actsOnTask(viewer: AgentViewer, task: TaskPlace): boolean {
  if (!canReach(viewer.access, taskSpot(task))) return false;
  if (viewer.full || task.createdByPersonId === viewer.personId) return true;
  return [task.assigneeAgentId, task.executorAgentId, task.createdByAgentId].some(id => seesAgentId(viewer, id));
}
