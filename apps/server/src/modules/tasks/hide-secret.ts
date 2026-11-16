import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { writeGate } from '../../db/gate.js';
import { attachments, people, secretRedactions, taskEvents, tasks } from '../../db/schema.js';
import type { Person } from '../../auth/session.js';
import { runsDepartment } from '../../auth/departments.js';
import { ApiError } from '../../errors.js';
import { loadTask, note, taskSpot, type Task } from './engine.js';

const invalid = () => new ApiError(400, 'validation', 'Select a secret in this task or its log.');

/* Only validation and hashing see the value. No SQL parameter or audit entry carries it. */
export async function hideTaskSecret(ctx: Pick<Ctx, 'db' | 'bus'>, person: Person, task: Task, value: string): Promise<Task> {
  if (task.companyId !== person.companyId || person.via || person.assistant || !(await runsDepartment(ctx.db, person, task.departmentId))) {
    throw new ApiError(403, 'forbidden', 'Only the CEO, the CEO delegate and people running this department may hide a secret.');
  }
  if (!value.trim() || value.includes('[hidden]')) throw invalid();
  const fingerprint = createHash('sha256').update(value).digest('hex');
  await writeGate.exclusive(() => ctx.db.transaction(async tx => {
    /* Other database writers wait too: sweep and suppression must commit together. */
    const tables = await tx.execute(sql`select format('%I.%I', n.nspname, c.relname) as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'net') and c.relkind = 'r' order by 1`) as { rows: { name: string }[] };
    await tx.execute(sql.raw(`LOCK TABLE ${tables.rows.map(t => t.name).join(', ')} IN SHARE ROW EXCLUSIVE MODE`));
    const current = await loadTask(tx, task.id);
    const [actor] = await tx.select().from(people).where(and(eq(people.id, person.id), eq(people.companyId, person.companyId)));
    if (!actor || actor.status !== 'active' || !(await runsDepartment(tx, actor, current.departmentId))) {
      throw new ApiError(403, 'forbidden', 'Your access changed.');
    }
    const log = await tx.select({ text: taskEvents.text, data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.companyId, person.companyId)));
    const evidence = log.flatMap(e => typeof e.data?.evidence === 'string' ? [e.data.evidence] : []);
    const archiveIds = log.flatMap(e => Array.isArray(e.data?.fullTexts) ? e.data.fullTexts.flatMap((ref: unknown) => ref && typeof ref === 'object' && 'id' in ref && typeof ref.id === 'string' ? [ref.id] : []) : []);
    const archives = archiveIds.length ? await tx.select({ bytes: attachments.bytes }).from(attachments).where(and(eq(attachments.companyId, person.companyId), eq(attachments.taskId, task.id), eq(attachments.mediaType, 'text/plain'), inArray(attachments.id, archiveIds))) : [];
    const texts = [current.title, current.brief, current.body, ...log.map(e => e.text), ...evidence, ...archives.map(file => Buffer.from(file.bytes).toString('utf8'))];
    if (!texts.some(text => text.includes(value))) throw invalid();
    await tx.insert(secretRedactions).values({ companyId: person.companyId, fingerprint, characters: [...value].length, personId: person.id }).onConflictDoNothing();
    await note(tx, task, { actor: { personId: person.id }, kind: 'comment', text: 'Secret hidden.', data: { secretHidden: true } });
    await tx.update(tasks).set({ version: sql`${tasks.version} + 1`, updatedAt: new Date() }).where(eq(tasks.id, task.id));
  }));
  const changed = await loadTask(ctx.db, task.id);
  ctx.bus.publish(task.companyId, { type: 'task', id: task.id, spot: taskSpot(task) });
  return changed;
}
