import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agents, attachments, people, tasks } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { checkRoom, FILE_BYTES } from './attachments.js';
import type { Actor, Tx } from './engine.js';

/* Prose is preserved in full; transport and attachment budgets bound its storage. */
export const Text = z.string();
const INLINE = 4000;
const PREVIEW = 3000;
type Budget = Pick<Ctx['config'], 'taskFilesBytes'>;
type Scope = { id: string; companyId: string };
type Owner = { agentId: string; personId: string | null };
type Note = { kind: string; actor: Actor; text?: string; data?: Record<string, unknown>; inlineText?: true };
export type FullText = { field: 'text' | 'evidence'; id: string; name: string; size: number; sha256: string };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const forbidden = () => new ApiError(403, 'forbidden', 'You cannot attach text to this task.', 'task_not_yours');

/* A person's file uses a task recipient for the required agent reference, while retaining its actual person author. */
async function recipient(db: Db | Tx, task: Scope): Promise<string> {
  const [row] = await db.select().from(tasks).where(and(eq(tasks.id, task.id), eq(tasks.companyId, task.companyId)));
  const ids = [row?.assigneeAgentId, row?.executorAgentId, row?.createdByAgentId].filter((id): id is string => Boolean(id));
  const found = ids.length ? await db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, task.companyId), inArray(agents.id, ids))) : [];
  const preferred = ids.find(id => found.some(a => a.id === id));
  if (preferred) return preferred;
  const [orchestrator] = await db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, task.companyId), eq(agents.kind, 'orchestrator'))).limit(1);
  if (!orchestrator) throw forbidden();
  return orchestrator.id;
}

async function owner(db: Db | Tx, task: Scope, actor: Actor): Promise<Owner> {
  if (actor.agentId !== undefined) {
    const [agent] = await db.select(idOnly(agents)).from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, task.companyId)));
    if (!agent) throw forbidden();
    return { agentId: agent.id, personId: null };
  }
  const [person] = await db.select(idOnly(people)).from(people).where(and(eq(people.id, actor.personId), eq(people.companyId, task.companyId)));
  if (!person) throw forbidden();
  return { agentId: await recipient(db, task), personId: person.id };
}

/* Names carry the complete content hash; existing bytes are checked before a retry reuses one. */
async function archive(db: Db | Tx, task: Scope, author: Owner, kind: string, field: FullText['field'], text: string, config: Budget): Promise<FullText> {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > FILE_BYTES) throw new ApiError(413, 'validation', 'Keep the full text in a smaller task file and send its file name with hh-attach.', 'attachment_invalid');
  const sha256 = digest(bytes);
  const name = `${kind}-${field}-${sha256}.txt`;
  const [existing] = await db.select().from(attachments).where(and(eq(attachments.companyId, task.companyId), eq(attachments.taskId, task.id), eq(attachments.agentId, author.agentId), author.personId ? eq(attachments.personId, author.personId) : isNull(attachments.personId), eq(attachments.name, name), eq(attachments.mediaType, 'text/plain'), isNull(attachments.operatorCaseId))).limit(1);
  if (existing && digest(existing.bytes) === sha256) return { field, id: existing.id, name, size: bytes.length, sha256 };
  const [row] = await db.select(only(tasks, 'number')).from(tasks).where(eq(tasks.id, task.id));
  await checkRoom({ db, config }, task.companyId, { id: task.id, number: row!.number }, bytes.length);
  const [file] = await db.insert(attachments).values({ companyId: task.companyId, taskId: task.id, ...author, name, mediaType: 'text/plain', bytes, size: bytes.length }).returning({ id: attachments.id });
  return { field, id: file!.id, name, size: bytes.length, sha256 };
}

function preview(text: string, ref: FullText): string {
  const head = text.slice(0, PREVIEW).replace(/[\uD800-\uDBFF]$/, '');
  return `${head}\n\n[Full text](/api/attachments/${ref.id})`;
}

/* Called inside the note's transaction after its move/permission checks. Minimal engine callers retain full inline text. */
export async function preserveNote(db: Db | Tx, task: Scope, note: Note, config?: Budget): Promise<{ text: string; data: Record<string, unknown> }> {
  const text = note.text ?? '';
  const data = { ...note.data };
  const fields: { field: FullText['field']; text: string }[] = [{ field: 'text', text }];
  if (typeof data.evidence === 'string') fields.push({ field: 'evidence', text: data.evidence });
  const long = fields.filter(f => f.text.length > INLINE);
  if (note.inlineText || !config || !long.length) return { text, data };
  const author = await owner(db, task, note.actor);
  let shown = text;
  const refs: FullText[] = [];
  for (const f of long) {
    const ref = await archive(db, task, author, note.kind, f.field, f.text, config);
    refs.push(ref);
    if (f.field === 'text') shown = preview(f.text, ref);
    else data.evidence = preview(f.text, ref);
  }
  return { text: shown, data: { ...data, fullTexts: refs } };
}
