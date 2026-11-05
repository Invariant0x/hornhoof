import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, canReach } from '../../auth/access.js';
import { seesAgentId, viewerOf } from '../../auth/agent-view.js';
import { changedBy, requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import { departments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { addNote, type Book, companyBook, departmentBook, listNotes, NoteBody, removeNote, rewriteNote } from './book.js';

const NoteParams = z.object({ number: z.coerce.number().int().positive() });
const DeptParams = z.object({ id: z.uuid() });

/* The company's notebook, for people who see the whole company and the orchestrator acting for them, and each
   department's, for people who may change that department's employees. */
export function notebookRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  async function companyFor(req: FastifyRequest) {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    return { me, book: companyBook(me.companyId) };
  }

  async function departmentFor(req: FastifyRequest) {
    const me = await requirePerson(req, db);
    const { id } = DeptParams.parse(req.params);
    const [dept] = await db.select().from(departments).where(and(eq(departments.id, id), eq(departments.companyId, me.companyId)));
    if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    /* As for its employees' cards: a team of the department is not enough. */
    if (me.scopeKind !== 'company' && !canReach({ ...(await accessOf(db, me)), teams: new Set() }, { departmentId: dept.id, parentId: dept.parentId })) {
      throw new ApiError(403, 'forbidden', "Only people with access to this department or the whole company can read and change its notebook.", 'not_your_department');
    }
    return { me, book: departmentBook(dept) };
  }

  function routes(base: string, bookFor: (req: FastifyRequest) => Promise<{ me: Person; book: Book }>) {
    app.get(base, async req => {
      const { me, book } = await bookFor(req);
      const viewer = await viewerOf(db, me);
      /* A note is the notebook's; who wrote it goes when that is an agent this person does not see. */
      return { notes: (await listNotes(db, book)).map(n => (n.by?.kind === 'agent' && !seesAgentId(viewer, n.by.id) ? { ...n, by: null } : n)) };
    });

    app.post(base, async (req, reply) => {
      const { me, book } = await bookFor(req);
      const { text } = NoteBody.parse(req.body);
      const note = await addNote(ctx, book, text, changedBy(me));
      reply.code(201);
      return { note };
    });

    app.patch(`${base}/:number`, async req => {
      const { me, book } = await bookFor(req);
      const { number } = NoteParams.parse(req.params);
      const { text } = NoteBody.parse(req.body);
      await rewriteNote(ctx, book, number, text, changedBy(me));
      return { note: { number, text } };
    });

    app.delete(`${base}/:number`, async (req, reply) => {
      const { me, book } = await bookFor(req);
      const { number } = NoteParams.parse(req.params);
      await removeNote(ctx, book, number, changedBy(me));
      return reply.code(204).send();
    });
  }

  routes('/api/notebook', companyFor);
  routes('/api/departments/:id/notebook', departmentFor);
}
