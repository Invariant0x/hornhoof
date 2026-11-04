import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { attachments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { agentFor } from '../agents/find.js';
import { checkPictureRoom, fileName, PICTURE_BYTES, pictureType } from '../tasks/attachments.js';

export const PICTURES_PER_MESSAGE = 10;
/* A file only somewhat over the limit is read, so the person hears why it is turned away. */
const READ_BYTES = 8 * PICTURE_BYTES;

export type MessagePicture = { id: string; name: string };

const NameQuery = z.object({ name: z.string().optional() });
const EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;

/* The pictures a person sends this agent with a message: their own, sent for this agent, in the order they named them. */
export async function ownPictures(ctx: Pick<Ctx, 'db'>, me: Person, agentId: string, ids: string[]): Promise<MessagePicture[]> {
  if (!ids.length) return [];
  const wanted = [...new Set(ids)];
  const found = me.via
    ? []
    : await ctx.db
        .select({ id: attachments.id, name: attachments.name })
        .from(attachments)
        .where(and(inArray(attachments.id, wanted), eq(attachments.companyId, me.companyId), eq(attachments.agentId, agentId), eq(attachments.personId, me.id), isNull(attachments.operatorCaseId)));
  const pictures = wanted.flatMap(id => found.filter(p => p.id === id).map(p => ({ id: p.id, name: p.name ?? 'picture' })));
  if (pictures.length !== wanted.length) throw new ApiError(404, 'not_found', 'A picture of this message is not there. Add it again.', 'attachment_unknown');
  return pictures;
}

/* What the agent reads of a message with pictures: each file's name and the command that downloads it, in place of the
   picture itself, so any program can open it. */
export function withPictures(text: string, pictures: MessagePicture[]): string {
  if (!pictures.length) return text;
  const lines = pictures.map(p => `${p.name}: hh-fetch message ${p.id}`);
  return `${text}\n\n${pictures.length === 1 ? 'A picture came' : 'Pictures came'} with this message. To see one, run its command, then open the file it prints:\n${lines.join('\n')}`;
}

/* A person who may write to the agent sends a picture as raw bytes, which say what it is, whatever its name and type say.
   Whoever may not gets turned away before its bytes are read. */
export function pictureRoutes(app: FastifyInstance, ctx: Ctx): void {
  void app.register(async scope => {
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: READ_BYTES }, (_req, body, done) => done(null, body));
    scope.post('/api/agents/:id/pictures', { bodyLimit: READ_BYTES, onRequest: async req => void (await agentFor(ctx, req)) }, async (req, reply) => {
      const { me, agent } = await agentFor(ctx, req);
      if (me.via) throw new ApiError(403, 'forbidden', 'Only a person sends a picture to an agent.', 'attachment_invalid');
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (bytes.length > PICTURE_BYTES) throw new ApiError(413, 'validation', `A picture is at most ${PICTURE_BYTES / 1024 / 1024} MB.`, 'picture_too_big');
      const mediaType = pictureType(bytes);
      if (!mediaType) throw new ApiError(400, 'validation', 'Send a PNG, JPEG or WebP picture.', 'picture_invalid');
      await checkPictureRoom(ctx, me.companyId, bytes.length);
      const name = fileName(NameQuery.parse(req.query).name ?? '') ?? `picture.${EXTENSION[mediaType]}`;
      const [row] = await ctx.db
        .insert(attachments)
        .values({ companyId: me.companyId, agentId: agent.id, personId: me.id, name, mediaType, bytes, size: bytes.length })
        .returning({ id: attachments.id });
      reply.code(201);
      return { id: row!.id, name };
    });
  });
}
