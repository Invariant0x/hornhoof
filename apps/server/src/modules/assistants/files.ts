import { Readable } from 'node:stream';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { assistants, attachments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { filePieces, headerName } from '../tasks/attachments.js';

const FileParams = z.object({ id: z.uuid() });

/* One answer for a file the assistant may not have, one that is not there and an id that is none, so it tells nothing of
   which. */
const noFile = () => new ApiError(404, 'not_found', 'There is no such file.', 'attachment_unknown');

/* A name as one header carries it, whatever it holds: filename in printable ASCII without quotes or backslashes, a letter
   with marks as the letter and anything else as _, and filename* as the whole name in UTF-8, every byte past plain letters
   and digits encoded. A lone surrogate goes as U+FFFD. */
export function disposition(name: string): string {
  const whole = Buffer.from(name, 'utf8').toString('utf8');
  const ascii = whole.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7e]|["\\]/gu, '_');
  return `attachment; filename="${ascii || 'file'}"; filename*=UTF-8''${headerName(whole)}`;
}

/* A file the assistant's own agent put in Hornhoof in a turn of its own with hh-attach: in the assistant's company, by its
   agent and no person, under a name, and no picture Hornhoof took of the agent's program. Whose it is the same query asks
   that finds it. */
async function ownFile(db: Ctx['db'], me: Person, id: string) {
  const [found] = await db
    .select({ id: attachments.id, name: attachments.name, mediaType: attachments.mediaType, length: sql<number>`octet_length(${attachments.bytes})`.mapWith(Number) })
    .from(attachments)
    .innerJoin(assistants, and(eq(assistants.agentId, attachments.agentId), eq(assistants.companyId, attachments.companyId)))
    .where(
      and(
        eq(attachments.id, id),
        eq(attachments.companyId, me.companyId),
        eq(assistants.personId, me.assistant!.id),
        isNotNull(attachments.jobId),
        isNull(attachments.personId),
        isNull(attachments.operatorCaseId),
        isNotNull(attachments.name),
      ),
    );
  return found;
}

/* The file's bytes as they were sent, a piece at a time, under the type and the name it was kept with, as often as the
   program asks. */
export async function fileFor(ctx: Ctx, me: Person, params: unknown, reply: FastifyReply) {
  const asked = FileParams.safeParse(params);
  const found = asked.success ? await ownFile(ctx.db, me, asked.data.id) : undefined;
  if (!found) throw noFile();
  return reply
    .header('content-disposition', disposition(found.name ?? 'file'))
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'")
    .header('content-length', String(found.length))
    .type(found.mediaType)
    .send(Readable.from(filePieces(ctx.db, found.id, found.length)));
}
