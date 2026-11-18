import { createHash, randomUUID } from 'node:crypto';
import { DocumentCandidate } from '@hornhoof/protocol/echelons';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { filesOf } from './file-views.js';
import { requiredStagesComplete } from './echelons-accept.js';
import { checkingIdentity, producerIdentity } from './echelons-assign.js';
import { currentDocument } from './echelons-candidates.js';
import type { Submission } from './echelons-operations.js';
import { changeRoute, type Route } from './route-records.js';
import { requireTaskHead } from './echelons-update.js';
import { giver, refuse, type Moved, type Task, type Tx } from './state.js';
import { move } from './transitions.js';

/* A document goes through its stages as the words of the hand-in and the files on its task: the work of a department that
   keeps no repository, or a task made as a document where one does. Nothing here reads a commit, and Tests and Cleanup, which need one, are not among its stages. */

type Reader = Pick<Ctx, 'db' | 'bus'>;

/* The document as it is handed in: a later hand-in with other words or other files is another candidate. */
export async function documentHandIn(ctx: Reader, agentId: string, task: Task, route: Route, r: Submission) {
  if (r.review) throw refuse(400, 'task_invalid', `#${task.number} is handed in as a document: name no commit. Attach the files to the task and say in the summary what you hand in.`);
  const input = route.state.stage === 'development' ? null : await currentDocument(ctx.db, task, route);
  const producer = await producerIdentity(ctx.db, task, agentId);
  if (input) await checkingIdentity(ctx, task, route, input);
  const files = (await filesOf(ctx.db, task.id)).map(file => [file.id, file.name, file.size]);
  const digest = createHash('sha256').update(JSON.stringify([r.summary, r.evidence, files])).digest('hex');
  const candidate = DocumentCandidate.parse({ id: randomUUID(), parentId: route.state.candidateId, revision: route.revision + 1, digest, producedBy: { ...producer, stage: route.state.stage } });
  return { input, candidate, review: null };
}

/* The head of the department closes a document every stage of its route passed. There is nothing to merge, so the head
   names no commit. */
export async function acceptDocument(ctx: Reader, task: Task, route: Route, agentId: string, summary: string): Promise<Moved> {
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', 'Only the current accepting owner may close this result.');
  await requireTaskHead(ctx, task, agentId);
  if (route.state.phase !== 'ready' || !requiredStagesComplete(route)) throw refuse(409, 'task_invalid', 'The required stages have not checked this result.');
  const candidate = await currentDocument(ctx.db, task, route);
  const wakes = giver(task, 'done', agentId, summary);
  const row = await move(ctx, task, { status: 'done', assigneeAgentId: null, closedAt: new Date(), silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, data: { done: true, acceptedDocument: { candidateId: candidate.id, digest: candidate.digest, routeRevision: route.revision + 1 } }, returned: true,
  }, async tx => {
    await requireTaskHead({ db: tx }, task, agentId);
    await changeRoute(tx, route, { ...route.state, phase: 'done' });
  }, wakes);
  return { task: row, wakes };
}

const Acceptance = z.object({ candidateId: z.uuid(), digest: z.string(), routeRevision: z.number().int().positive() });

/* What a group pins of a document closed under it: the candidate its head accepted, unchanged since. */
export async function acceptedDocument(tx: Tx, child: Task, route: Route, report: Record<string, unknown> | undefined): Promise<{ taskId: string; candidateId: string; digest: string }> {
  const candidate = await currentDocument(tx, child, route);
  const acceptance = Acceptance.safeParse(report?.acceptedDocument);
  const same = acceptance.success && acceptance.data.candidateId === candidate.id && acceptance.data.digest === candidate.digest && acceptance.data.routeRevision === route.revision;
  if (!requiredStagesComplete(route) || !same) throw refuse(409, 'task_invalid', 'A child document is unchecked, unaccepted or stale.');
  return { taskId: child.id, candidateId: candidate.id, digest: candidate.digest };
}
