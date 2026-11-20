import { MAX_RUN_FILES, RunFile } from '@hornhoof/protocol';
import { and, desc, eq, like } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { attachments } from '../../db/schema.js';
import { countOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { identify } from '../nodes/socket.js';
import { checkRoom, FILE_BYTES } from '../tasks/file-policy.js';
import { sendFile } from '../tasks/attachments.js';
import { madeName, runningPartOn } from './runs.js';

const FileParams = z.object({ id: z.string().max(64), name: RunFile });

/* The node that runs a part fetches the task's files its run of work names, and puts on the task the files the part left in
   $HH_OUT, a part of work's or of a test run's, with its own key. Nothing else reaches them: not another node, not a part
   that ended, not a file the run did not name. A test run names none. */
export function partFileRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  async function partOf(req: FastifyRequest) {
    const node = await identify(ctx, req);
    if (!node) throw new ApiError(401, 'unauthorized', 'Unknown node key.');
    const { id, name } = FileParams.parse(req.params);
    const found = await runningPartOn(ctx, node, id);
    if (!found) throw new ApiError(404, 'not_found', 'This node runs no such part now.');
    return { ...found, name };
  }

  app.get('/api/parts/:id/files/:name', async (req, reply) => {
    const { run, task, name } = await partOf(req);
    const [file] = run.files.includes(name)
      ? await db
          .select({ id: attachments.id, name: attachments.name, length: attachments.size })
          .from(attachments)
          .where(and(eq(attachments.taskId, run.taskId), eq(attachments.name, name)))
          .orderBy(desc(attachments.createdAt))
          .limit(1)
      : [];
    if (!file) throw new ApiError(404, 'not_found', `Task ${task.number} gives this run no file ${name}.`, 'attachment_unknown');
    return sendFile(ctx, reply, file);
  });

  void app.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: FILE_BYTES }, (_req, body, done) => done(null, body));
    scope.put('/api/parts/:id/files/:name', { bodyLimit: FILE_BYTES }, async (req, reply) => {
      const { part, run, task, name } = await partOf(req);
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const [made] = await db
        .select(countOnly())
        .from(attachments)
        .where(and(eq(attachments.taskId, run.taskId), like(attachments.name, `${madeName(run, part.part, '')}%`)));
      if (Number(made?.n ?? 0) >= MAX_RUN_FILES) throw new ApiError(409, 'conflict', `A part puts at most ${MAX_RUN_FILES} files on its task.`, 'attachment_invalid');
      await checkRoom(ctx, run.companyId, task, bytes.length);
      const file = madeName(run, part.part, name);
      await db.insert(attachments).values({ companyId: run.companyId, jobId: run.jobId, agentId: run.agentId, taskId: run.taskId, name: file, mediaType: 'application/octet-stream', bytes, size: bytes.length });
      reply.code(201);
      return { name: file };
    });
  });
}
