import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { signedBody, signedToken } from '../../crypto/tokens.js';
import { attachments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { attachmentForPerson, fileStream, headerName } from '../tasks/attachments.js';

const FileParams = z.object({ id: z.uuid() });
const LinkParams = z.object({ '*': z.string() });

/* A link to one file opens it this long after it was made, with no key and no sign-in, for the owner to download on a
   phone what is too big to send there. */
export const LINK_DAYS = 7;
const LINK = 'hornhoof file link v1';
const LinkBody = z.strictObject({ f: z.uuid(), until: z.number().int() });

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

/* Use the interface's current owner visibility, with one refusal for every unavailable file. */
async function ownerFile(db: Ctx['db'], me: Person, id: string) {
  try {
    return await attachmentForPerson(db, me, id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/* The file's bytes as they were sent, a piece at a time, under the type and the name it was kept with, as often as the
   program asks. */
export async function fileFor(ctx: Ctx, me: Person, params: unknown, reply: FastifyReply) {
  const asked = FileParams.safeParse(params);
  const found = asked.success ? await ownerFile(ctx.db, me, asked.data.id) : undefined;
  /* An automatic program screenshot has no file name, even if it acquired a task link. Message/request pictures are
     governed by their person's visibility instead. */
  if (!found || (!found.picture && found.name === null)) throw noFile();
  return sendWhole(ctx, found, reply);
}

/* The link to a file its owner sees, at this server's address. */
export const fileLink = (secret: Buffer, base: string, id: string): string =>
  `${base}/api/files/${signedToken(secret, LINK, { f: id, until: Date.now() + LINK_DAYS * 24 * 60 * 60_000 })}`;

/* The one file a link names, while the link lasts. */
export async function fileByLink(ctx: Ctx, params: unknown, reply: FastifyReply) {
  const asked = LinkParams.safeParse(params);
  const link = LinkBody.safeParse(asked.success ? signedBody(ctx.config.secret, LINK, asked.data['*']) : null);
  if (!link.success) throw noFile();
  if (link.data.until <= Date.now()) throw new ApiError(410, 'gone', `This link to a file worked for ${LINK_DAYS} days, and they are over.`, 'file_link_expired');
  const [found] = await ctx.db
    .select({ id: attachments.id, name: attachments.name, mediaType: attachments.mediaType, length: attachments.size })
    .from(attachments)
    .where(and(eq(attachments.id, link.data.f), isNull(attachments.operatorCaseId)));
  if (!found) throw noFile();
  return sendWhole(ctx, found, reply);
}

async function sendWhole(ctx: Ctx, found: { id: string; name: string | null; mediaType: string; length: number }, reply: FastifyReply) {
  const bytes = await fileStream(ctx, found.id);
  return reply
    .header('content-disposition', disposition(found.name ?? 'file'))
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'")
    .header('content-length', String(found.length))
    .type(found.mediaType)
    .send(bytes);
}
