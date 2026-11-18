import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { departments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { notebookPart } from '../agents/instructions.js';
import { addNote, departmentBook, NoteBody, removeNote, rewriteNote } from './book.js';

type ToolJob = { companyId: string; agentId: string; departmentId: string | null };

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

/* A head's own notebook: its department's, which its instructions carry and which it reads again after a compaction,
   since people may have changed it while the program ran. Changes are recorded as the head's. */
export function registerHeadNotebookTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  const book = async () => {
    const [dept] = job.departmentId ? await ctx.db.select().from(departments).where(eq(departments.id, job.departmentId)) : [];
    return dept && dept.companyId === job.companyId ? departmentBook(dept) : null;
  };
  const by = { personId: null, byOrchestrator: false, agentId: job.agentId };
  /* A refusal comes back to the head as its reason. */
  const run = async (fn: (b: NonNullable<Awaited<ReturnType<typeof book>>>) => Promise<string>) => {
    const b = await book();
    if (!b) return say('You have no department, so you have no notebook.', true);
    try {
      return say(await fn(b));
    } catch (err) {
      if (err instanceof ApiError) return say(err.message, true);
      throw err;
    }
  };
  const Note = z.number().int().positive().describe("The note's number, as your notebook shows it, like 3 for [#3].");

  server.registerTool('notebook', { description: 'Your department notebook as it is now. People may change it while you work, so read it again after a compaction.' }, () =>
    run(b => notebookPart(ctx.db, b)),
  );
  server.registerTool(
    'remember',
    {
      description:
        'Writes a note into your department notebook, which your instructions carry into every conversation: a decision, rule, preference or agreement for your department that must outlive this one. ' +
        'People who run the department read and change it too.',
      inputSchema: NoteBody.shape,
    },
    ({ text }) => run(async b => JSON.stringify({ note: await addNote(ctx, b, text, by) })),
  );
  server.registerTool('rewrite_note', { description: 'Rewrites a note of your department notebook when what it says changed.', inputSchema: { note: Note, ...NoteBody.shape } }, ({ note, text }) =>
    run(async b => {
      await rewriteNote(ctx, b, note, text, by);
      return 'Done.';
    }),
  );
  server.registerTool('forget', { description: 'Removes a note from your department notebook that no longer holds.', inputSchema: { note: Note } }, ({ note }) =>
    run(async b => {
      await removeNote(ctx, b, note, by);
      return 'Done.';
    }),
  );
}
