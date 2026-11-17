import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { attachments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { agentFor } from '../agents/find.js';
import { checkPictureRoom, fileName, onDisk, pictureType, type Taken } from '../tasks/attachments.js';

export const PICTURES_PER_MESSAGE = 10;
/* A document, a table or an archive a person passes to an agent; the browser makes a big picture smaller first. */
export const MESSAGE_FILE_BYTES = 10 * 1024 * 1024;
/* A file only somewhat over the limit is read, so the person hears why it is turned away. */
const READ_BYTES = 3 * MESSAGE_FILE_BYTES;

/* file: no picture, so the window offers it to download instead of showing it. big: it lives on one machine's disk. */
export type MessagePicture = { id: string; name: string; file?: true; big?: true };

const NameQuery = z.object({ name: z.string().optional() });
const EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;

/* The pictures and other files a person sends this agent with a message: their own, sent for this agent, in the order they
   named them. */
export async function ownPictures(ctx: Pick<Ctx, 'db'>, me: Person, agentId: string, ids: string[]): Promise<MessagePicture[]> {
  if (!ids.length) return [];
  const wanted = [...new Set(ids)];
  const found = me.via
    ? []
    : await ctx.db
        .select({ id: attachments.id, name: attachments.name, mediaType: attachments.mediaType, big: onDisk })
        .from(attachments)
        .where(and(inArray(attachments.id, wanted), eq(attachments.companyId, me.companyId), eq(attachments.agentId, agentId), eq(attachments.personId, me.id), isNull(attachments.operatorCaseId)));
  const pictures = wanted.flatMap(id => found.filter(p => p.id === id).map(p => ({ id: p.id, name: p.name ?? 'picture', ...(p.mediaType in EXTENSION ? {} : { file: true as const }), ...(p.big ? { big: true as const } : {}) })));
  if (pictures.length !== wanted.length) throw new ApiError(404, 'not_found', 'A picture of this message is not there. Add it again.', 'attachment_unknown');
  return pictures;
}

/* What the agent reads of a message with pictures or other files: each file's name and the command that downloads it, in
   place of the file itself, so any program can open it. */
export function withPictures(text: string, pictures: MessagePicture[]): string {
  if (!pictures.length) return text;
  const lines = pictures.map(p => `${p.name}: hh-fetch message ${p.id}`);
  const one = pictures.length === 1;
  const came = pictures.some(p => p.file) ? `${one ? 'A file came' : 'Files came'} with this message. To open one` : `${one ? 'A picture came' : 'Pictures came'} with this message. To see one`;
  return `${text}\n\n${came}, run its command, then open the file it prints:\n${lines.join('\n')}\n\n${KEEP_IN_REPOSITORY}`;
}

/* Hornhoof drops a message's files 30 days on, so what the team sends is kept where the department keeps its work. */
export const KEEP_IN_REPOSITORY =
  'Hornhoof keeps the files of a message for 30 days only. When you work in a repository, save each of these files into it, in the folder where your department keeps such files (unpack an archive there only when its contents are what is needed), and commit it, unless the person said not to keep it.';

/* A person who may write to the agent sends a picture or any other file as raw bytes. Its bytes say whether it is a
   picture, whatever its name and type say; anything else is kept as bytes of no type. Whoever may not gets turned away
   before its bytes are read. */
export function pictureRoutes(app: FastifyInstance, ctx: Ctx): void {
  void app.register(async scope => {
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: READ_BYTES }, (_req, body, done) => done(null, body));
    scope.post('/api/agents/:id/pictures', { bodyLimit: READ_BYTES, onRequest: async req => void (await agentFor(ctx, req)) }, async (req, reply) => {
      const { me, agent } = await agentFor(ctx, req);
      if (me.via) throw new ApiError(403, 'forbidden', 'Only a person sends a file to an agent.', 'attachment_invalid');
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!bytes.length) throw new ApiError(400, 'validation', 'This file is empty, or it is a folder. Send a file with something in it.', 'file_empty');
      if (bytes.length > MESSAGE_FILE_BYTES) throw new ApiError(413, 'validation', `A file is at most ${MESSAGE_FILE_BYTES / 1024 / 1024} MB.`, 'file_too_big');
      const kept = await keepMessageFile(ctx, me, agent.id, { bytes, size: bytes.length }, NameQuery.parse(req.query).name ?? '');
      reply.code(201);
      return kept;
    });
  });
}

/* Keeps a file a person sends this agent with a message, from its window, through its Telegram bot or its assistant, under
   its cleaned name; whoever calls this has checked that the person may write to the agent and that the file is not too big. */
export async function keepMessageFile(ctx: Pick<Ctx, 'db' | 'config'>, me: Person, agentId: string, file: Taken, rawName: string): Promise<{ id: string; name: string }> {
  const picture = pictureType(file.bytes);
  await checkPictureRoom(ctx, me.companyId, file.size);
  const name = fileName(rawName) ?? (picture ? `picture.${EXTENSION[picture]}` : 'file');
  const [row] = await ctx.db
    .insert(attachments)
    .values({ ...(file.disk ? { id: file.disk } : {}), companyId: me.companyId, agentId, personId: me.id, name, mediaType: picture ?? 'application/octet-stream', bytes: file.bytes, size: file.size })
    .returning({ id: attachments.id });
  return { id: row!.id, name };
}
