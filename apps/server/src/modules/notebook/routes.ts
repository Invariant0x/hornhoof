import { and, asc, eq, isNull, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { changedBy, requireCompanyScope, requirePerson } from '../../auth/session.js';
import { companies, notebookNotes, people } from '../../db/schema.js';
import { ApiError } from '../../errors.js';

/* A note is one fact; the notebook goes into the orchestrator's instructions, so it stays small. */
export const NOTE_MAX = 300;
export const NOTES_MAX = 30;
export const NOTEBOOK_MAX = 4000;

export const NoteBody = z.object({ text: z.string().trim().min(1).max(NOTE_MAX) });
const NoteParams = z.object({ number: z.coerce.number().int().positive() });

export type NoteView = { number: number; text: string; by: { kind: 'orchestrator' } | { kind: 'person'; id: string; name: string } | null; updatedAt: string };

type Db = Ctx['db'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const live = (companyId: string) => and(eq(notebookNotes.companyId, companyId), isNull(notebookNotes.removedAt));

/* The notes, oldest first, with who wrote each last. */
export async function listNotes(db: Db, companyId: string): Promise<NoteView[]> {
  const rows = await db
    .select({ note: notebookNotes, name: people.name })
    .from(notebookNotes)
    .leftJoin(people, eq(people.id, notebookNotes.personId))
    .where(live(companyId))
    .orderBy(asc(notebookNotes.number));
  return rows.map(({ note, name }) => ({
    number: note.number,
    text: note.text,
    by: note.byOrchestrator ? { kind: 'orchestrator' } : note.personId ? { kind: 'person', id: note.personId, name: name ?? '' } : null,
    updatedAt: note.updatedAt.toISOString(),
  }));
}

/* The company's notebook, for people who see the whole company and the orchestrator acting for them. */
export function notebookRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const changed = (companyId: string) => ctx.bus.publish(companyId, { type: 'notebook', spot: { departmentId: null } });

  /* One change to a company's notebook at a time, so two writes cannot take one number or both fit the last room. */
  const locked = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
    db.transaction(async tx => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for('update');
      return fn(tx);
    });

  /* Refuses a notebook that would hold too many notes or too much text once `text` takes the place of note `replacing`. */
  async function checkRoom(tx: Tx, companyId: string, text: string, replacing: number | null) {
    const rows = await tx.select({ number: notebookNotes.number, text: notebookNotes.text }).from(notebookNotes).where(live(companyId));
    const kept = rows.filter(r => r.number !== replacing);
    const size = kept.reduce((n, r) => n + r.text.length, text.length);
    if (kept.length + 1 > NOTES_MAX || size > NOTEBOOK_MAX) {
      throw new ApiError(409, 'conflict', `The notebook holds ${NOTES_MAX} notes and ${NOTEBOOK_MAX} characters at most. Rewrite or remove a note first.`, 'notebook_full');
    }
  }

  async function noteOf(tx: Tx, companyId: string, number: number) {
    const [note] = await tx.select().from(notebookNotes).where(and(live(companyId), eq(notebookNotes.number, number)));
    if (!note) throw new ApiError(404, 'not_found', `The notebook has no note #${number}.`, 'note_unknown');
    return note;
  }

  app.get('/api/notebook', async req => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    return { notes: await listNotes(db, me.companyId) };
  });

  app.post('/api/notebook', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const { text } = NoteBody.parse(req.body);
    const note = await locked(me.companyId, async tx => {
      await checkRoom(tx, me.companyId, text, null);
      /* Removed notes count too: a number never comes back. */
      const [{ last } = { last: 0 }] = await tx.select({ last: max(notebookNotes.number) }).from(notebookNotes).where(eq(notebookNotes.companyId, me.companyId));
      return (await tx.insert(notebookNotes).values({ companyId: me.companyId, number: (last ?? 0) + 1, text, ...changedBy(me) }).returning())[0]!;
    });
    changed(me.companyId);
    reply.code(201);
    return { note: { number: note.number, text: note.text } };
  });

  app.patch('/api/notebook/:number', async req => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const { number } = NoteParams.parse(req.params);
    const { text } = NoteBody.parse(req.body);
    await locked(me.companyId, async tx => {
      const note = await noteOf(tx, me.companyId, number);
      await checkRoom(tx, me.companyId, text, number);
      await tx.update(notebookNotes).set({ text, ...changedBy(me), updatedAt: new Date() }).where(eq(notebookNotes.id, note.id));
    });
    changed(me.companyId);
    return { note: { number, text } };
  });

  app.delete('/api/notebook/:number', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const { number } = NoteParams.parse(req.params);
    await locked(me.companyId, async tx => {
      const note = await noteOf(tx, me.companyId, number);
      await tx.update(notebookNotes).set({ removedAt: new Date(), ...changedBy(me) }).where(eq(notebookNotes.id, note.id));
    });
    changed(me.companyId);
    return reply.code(204).send();
  });
}
