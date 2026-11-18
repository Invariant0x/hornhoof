import { and, asc, eq, isNull, max } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, companies, notebookNotes, people } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';

export const NoteBody = z.object({ text: z.string().trim().min(1) });

/* The company's notebook, which the orchestrator carries, or a department's, which its head carries. */
export type Book = { companyId: string; departmentId: string | null; parentId?: string | null };
/* Who changed a note last: a person, the orchestrator acting for one, or a head. */
export type Writer = { personId: string | null; byOrchestrator: boolean; agentId?: string | null };

export type NoteView = {
  number: number;
  text: string;
  by: { kind: 'orchestrator' } | { kind: 'person'; id: string; name: string } | { kind: 'agent'; id: string; name: string } | null;
  updatedAt: string;
};

type Db = Ctx['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const companyBook = (companyId: string): Book => ({ companyId, departmentId: null });
export const departmentBook = (dept: { id: string; companyId: string; parentId: string | null }): Book => ({ companyId: dept.companyId, departmentId: dept.id, parentId: dept.parentId });

/* Every note of one notebook, removed ones too; `live` leaves those out. */
const ofBook = (book: Book) => and(eq(notebookNotes.companyId, book.companyId), book.departmentId ? eq(notebookNotes.departmentId, book.departmentId) : isNull(notebookNotes.departmentId));
const live = (book: Book) => and(ofBook(book), isNull(notebookNotes.removedAt));
const writer = (by: Writer) => ({ personId: by.personId, byOrchestrator: by.byOrchestrator, agentId: by.agentId ?? null });

/* The notes, oldest first, with who wrote each last. */
export async function listNotes(db: Db, book: Book): Promise<NoteView[]> {
  const rows = await db
    .select({ note: notebookNotes, person: people.name, agent: agents.name })
    .from(notebookNotes)
    .leftJoin(people, eq(people.id, notebookNotes.personId))
    .leftJoin(agents, eq(agents.id, notebookNotes.agentId))
    .where(live(book))
    .orderBy(asc(notebookNotes.number));
  return rows.map(({ note, person, agent }) => ({
    number: note.number,
    text: note.text,
    by: note.byOrchestrator
      ? { kind: 'orchestrator' }
      : note.agentId
        ? { kind: 'agent', id: note.agentId, name: agent ?? '' }
        : note.personId
          ? { kind: 'person', id: note.personId, name: person ?? '' }
          : null,
    updatedAt: note.updatedAt.toISOString(),
  }));
}

/* One change to a company's notebooks at a time, so two writes cannot take one number. */
function locked<T>(db: Db, book: Book, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, book.companyId)).for('update');
    return fn(tx);
  });
}

async function noteOf(tx: Tx, book: Book, number: number) {
  const [note] = await tx.select().from(notebookNotes).where(and(live(book), eq(notebookNotes.number, number)));
  if (!note) throw new ApiError(404, 'not_found', `The notebook has no note #${number}.`, 'note_unknown');
  return note;
}

/* People who reach the notebook's place hear that it changed. */
const changed = (ctx: Pick<Ctx, 'bus'>, book: Book) =>
  ctx.bus.publish(book.companyId, { type: 'notebook', spot: { departmentId: book.departmentId, parentId: book.parentId ?? null } });

export async function addNote(ctx: Pick<Ctx, 'db' | 'bus'>, book: Book, text: string, by: Writer): Promise<{ number: number; text: string }> {
  const note = await locked(ctx.db, book, async tx => {
    /* Removed notes count too: a number never comes back. */
    const [{ last } = { last: 0 }] = await tx.select({ last: max(notebookNotes.number) }).from(notebookNotes).where(ofBook(book));
    return (await tx
      .insert(notebookNotes)
      .values({ companyId: book.companyId, departmentId: book.departmentId, number: (last ?? 0) + 1, text, ...writer(by) })
      .returning())[0]!;
  });
  changed(ctx, book);
  return { number: note.number, text: note.text };
}

export async function rewriteNote(ctx: Pick<Ctx, 'db' | 'bus'>, book: Book, number: number, text: string, by: Writer): Promise<void> {
  await locked(ctx.db, book, async tx => {
    const note = await noteOf(tx, book, number);
    await tx.update(notebookNotes).set({ text, ...writer(by), updatedAt: new Date() }).where(eq(notebookNotes.id, note.id));
  });
  changed(ctx, book);
}

export async function removeNote(ctx: Pick<Ctx, 'db' | 'bus'>, book: Book, number: number, by: Writer): Promise<void> {
  await locked(ctx.db, book, async tx => {
    const note = await noteOf(tx, book, number);
    await tx.update(notebookNotes).set({ removedAt: new Date(), ...writer(by) }).where(eq(notebookNotes.id, note.id));
  });
  changed(ctx, book);
}
