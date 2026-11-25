import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { attachments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { oldFileStream } from '../files/legacy.js';

/* A file's bytes as they go out: from the store, or, for a row from before it that is not moved yet, as it was kept.
   Its own module, so what reads bytes (hiding a secret, a recording) does not import the task file routes. */
export async function fileStream(ctx: Pick<Ctx, 'db' | 'config' | 'files'>, id: string): Promise<Readable> {
  const [row] = await ctx.db.select({ sha256: attachments.sha256 }).from(attachments).where(eq(attachments.id, id));
  if (!row) throw new ApiError(404, 'not_found', 'There is no such file.', 'attachment_unknown');
  return row.sha256 ? ctx.files.open(ctx.db, row.sha256) : oldFileStream(ctx, id);
}

/* A file's bytes whole, for one small enough to hold. */
export async function fileBytes(ctx: Pick<Ctx, 'db' | 'config' | 'files'>, id: string): Promise<Buffer> {
  return buffer(await fileStream(ctx, id));
}
