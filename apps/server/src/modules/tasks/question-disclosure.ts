import type { SourceRef } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import { computerAccessIntents, proposals, requests, tasks } from '../../db/schema.js';
import type { Request, Task, Tx } from './engine.js';
import { classificationRequired, notAllowed, sourceClosed, staleRevision, staleRoute } from './question-authority.js';
import { staleIntent, type Intent } from './question-computer.js';
import { noSuchSource, staleClassification } from './question-lifecycle.js';
import { staleCard, type Card } from './question-proposals.js';

/* What a person is about to read or answer of what is before them, as it stands: the one check that it is theirs, for whoever then
   seals or hands over its material, in the same transaction. It holds the source until that transaction ends, so that what it
   checked cannot change before then. It seals nothing itself and grants nothing beyond this source. */

type Held = { kind: 'task_request'; request: Request; task: Task } | { kind: 'proposal'; proposal: Card } | { kind: 'computer_access'; intent: Intent };

export type QuestionDisclosure = Held & {
  source: SourceRef; revision: number; routeRevision: number; personId: string; companyId: string;
  classificationId: string; digest: string; materialRevision: number | null; materialDigest: string | null;
};

type Found = { row: Request | Card | Intent; open: boolean; changed: () => Promise<boolean>; held: Held };

async function taskQuestion(tx: Tx, companyId: string, id: string): Promise<Found | null> {
  const [found] = await tx.select({ taskId: requests.taskId }).from(requests).where(and(eq(requests.id, id), eq(requests.companyId, companyId)));
  if (!found) return null;
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, found.taskId)).for('update');
  const [request] = await tx.select().from(requests).where(eq(requests.id, id)).for('update');
  return { row: request!, open: request!.status === 'open', changed: () => staleClassification(tx, task!, request!), held: { kind: 'task_request', request: request!, task: task! } };
}

async function card(tx: Tx, companyId: string, id: string): Promise<Found | null> {
  const [proposal] = await tx.select().from(proposals).where(and(eq(proposals.id, id), eq(proposals.companyId, companyId))).for('update');
  return proposal ? { row: proposal, open: proposal.status === 'pending', changed: () => staleCard(tx, proposal), held: { kind: 'proposal', proposal } } : null;
}

async function computerRequest(tx: Tx, companyId: string, id: string): Promise<Found | null> {
  const [intent] = await tx.select().from(computerAccessIntents).where(and(eq(computerAccessIntents.id, id), eq(computerAccessIntents.companyId, companyId))).for('update');
  return intent ? { row: intent, open: intent.status === 'open', changed: () => staleIntent(tx, intent), held: { kind: 'computer_access', intent } } : null;
}

const READS = { task_request: taskQuestion, proposal: card, computer_access: computerRequest };

export async function questionDisclosure(tx: Tx, who: { personId: string; companyId: string }, source: SourceRef, expected?: { revision: number; routeRevision: number }): Promise<QuestionDisclosure> {
  const found = await READS[source.kind](tx, who.companyId, source.id);
  if (!found) throw noSuchSource();
  const { row, open, changed, held } = found;
  if (expected && expected.revision !== row.questionRevision) throw staleRevision();
  if (expected && expected.routeRevision !== row.routeRevision) throw staleRoute();
  if (!open) throw sourceClosed();
  const snapshot = row.classification;
  if (!snapshot || row.audience !== 'human') throw classificationRequired();
  if (!snapshot.authority.recipientPersonIds.includes(who.personId)) throw notAllowed();
  if (await changed()) throw staleRoute();
  return {
    ...held, source, revision: row.questionRevision, routeRevision: row.routeRevision, personId: who.personId, companyId: who.companyId,
    classificationId: snapshot.classificationId, digest: snapshot.digest, materialRevision: snapshot.materialRevision, materialDigest: snapshot.materialDigest,
  };
}
