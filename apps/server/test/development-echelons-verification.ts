import type { EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { taskEvents } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

/* A candidate at Tests: Review passed it, or fixed it and passed the fix. */
export async function testsFixture(fix = false) {
  const f = await fixture();
  const input = { summary: 'Keep totals.', evidence: 'Focused checks.', review: { baseCommit: BASE } };
  await submit(f.ctx, f.author.id, f.task.id, input);
  let finalCommit = HEAD;
  if (fix) {
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, comment: 'Fixing a boundary.', reviewedCommit: HEAD });
    finalCommit = 'c'.repeat(40);
    f.atCommit(finalCommit);
    await submit(f.ctx, f.reviewer.id, f.task.id, input);
  } else await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Checked the candidate.', reviewedCommit: HEAD });
  const snapshot = (await f.detail()).echelons;
  return { ...f, snapshot, finalCommit, verified: () => verified(snapshot) };
}

/* The Tests report of an exact candidate, checked with local tests of what its change touched. */
export const verified = (snapshot: Pick<EchelonsSnapshot, 'candidateId' | 'revision'>) =>
  ({ done: true, summary: 'Checked the changed area with local tests.', verification: { candidateId: snapshot.candidateId!, revision: snapshot.revision } });

/* Changes what the newest report of a task keeps under key, as a report of an earlier version may hold more. */
export async function changeReport(db: Db, taskId: string, key: string, change: (value: Record<string, unknown>) => unknown) {
  const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(desc(taskEvents.id));
  const event = events.find(e => e.kind === 'report' && key in e.data)!;
  await db.update(taskEvents).set({ data: { ...event.data, [key]: change(event.data[key] as Record<string, unknown>) } }).where(eq(taskEvents.id, event.id));
}
