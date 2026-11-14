import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireDepartmentChanger } from '../../auth/departments.js';
import { requirePerson } from '../../auth/session.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { googleSheets } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { checkShareEmail, parseGoogleCredentials } from './sheets.js';

type Row = typeof googleSheets.$inferSelect;

const PutBody = z
  .object({
    credentials: z.string().max(32_000).optional(),
    shareEmail: z.string().max(254).nullable().optional(),
  })
  .strict();

export const googleSheetsView = (row: Row) => ({
  kind: row.kind,
  account: row.account,
  shareEmail: row.shareEmail,
  keyLast4: row.keyLast4,
});

export function googleSheetsRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  async function requireWholeCompanyPerson(req: Parameters<typeof requirePerson>[0]) {
    const me = await requirePerson(req, db);
    if (me.via) throw new ApiError(403, 'forbidden', 'A person connects Google Sheets directly in Company settings.');
    await requireDepartmentChanger(db, me, null);
    return me;
  }

  app.get('/api/google-sheets', async req => {
    const me = await requireWholeCompanyPerson(req);
    const [row] = await db.select().from(googleSheets).where(eq(googleSheets.companyId, me.companyId));
    return { google: row ? googleSheetsView(row) : null };
  });

  app.put('/api/google-sheets', async req => {
    const me = await requireWholeCompanyPerson(req);
    const body = PutBody.parse(req.body);
    const [saved] = await db.select().from(googleSheets).where(eq(googleSheets.companyId, me.companyId));
    const rawCreds = body.credentials?.trim() ?? '';
    if (!rawCreds && !saved) {
      throw new ApiError(400, 'validation', 'Paste the Google JSON key to connect Google Sheets.', 'google_sheets_invalid');
    }
    const shareEmail = body.shareEmail === undefined ? (saved?.shareEmail ?? null) : checkShareEmail(body.shareEmail);
    if (!rawCreds && saved) {
      const [updated] = await db
        .update(googleSheets)
        .set({ shareEmail, updatedBy: me.id, updatedAt: new Date() })
        .where(eq(googleSheets.id, saved.id))
        .returning();
      ctx.bus.publish(me.companyId, { type: 'org' });
      return { google: googleSheetsView(updated!) };
    }
    const parsed = parseGoogleCredentials(rawCreds);
    const credentialsEnc = encryptSecret(JSON.stringify(parsed.secret), ctx.config.secret);
    const values = {
      kind: parsed.secret.kind,
      account: parsed.account,
      shareEmail,
      credentialsEnc,
      keyLast4: parsed.keyLast4,
      updatedBy: me.id,
      updatedAt: new Date(),
    };
    const [row] = saved
      ? await db.update(googleSheets).set(values).where(eq(googleSheets.id, saved.id)).returning()
      : await db.insert(googleSheets).values({ companyId: me.companyId, ...values }).returning();
    ctx.bus.publish(me.companyId, { type: 'org' });
    return { google: googleSheetsView(row!) };
  });

  app.delete('/api/google-sheets', async (req, reply) => {
    const me = await requireWholeCompanyPerson(req);
    await db.delete(googleSheets).where(eq(googleSheets.companyId, me.companyId));
    ctx.bus.publish(me.companyId, { type: 'org' });
    return reply.code(204).send();
  });
}
