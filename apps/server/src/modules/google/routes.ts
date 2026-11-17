import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireDepartmentChanger } from '../../auth/departments.js';
import { requirePerson, type Person } from '../../auth/session.js';
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

/* A service account owns the spreadsheets it creates and opens them to no one else, so its links open only for the Google
   account they are shared with. What an OAuth key creates belongs to its own account. */
function requireShareFor(kind: Row['kind'], shareEmail: string | null): void {
  if (kind === 'service_account' && !shareEmail) {
    throw new ApiError(
      400,
      'validation',
      'A service account opens the spreadsheets it creates to no one else. Enter the email of the Google account to share them with.',
      'google_sheets_share_needed',
    );
  }
}

const googleSheetsView = (row: Row) => ({
  kind: row.kind,
  account: row.account,
  shareEmail: row.shareEmail,
  keyLast4: row.keyLast4,
});

/* The Google account new spreadsheets are shared with: as given, or as saved when the change leaves it out. */
const shareOf = (given: string | null | undefined, saved: Row | undefined): string | null =>
  given === undefined ? (saved?.shareEmail ?? null) : checkShareEmail(given);

export function googleSheetsRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  /* The saved key with only the Google account changed. */
  async function keepKey(saved: Row, shareEmail: string | null, by: string): Promise<Row> {
    requireShareFor(saved.kind, shareEmail);
    const [updated] = await db.update(googleSheets).set({ shareEmail, updatedBy: by, updatedAt: new Date() }).where(eq(googleSheets.id, saved.id)).returning();
    return updated!;
  }

  /* A new key, encrypted, in place of the saved one if there is one. */
  async function saveKey(companyId: string, saved: Row | undefined, rawCreds: string, shareEmail: string | null, by: string): Promise<Row> {
    const parsed = parseGoogleCredentials(rawCreds);
    requireShareFor(parsed.secret.kind, shareEmail);
    const values = {
      kind: parsed.secret.kind,
      account: parsed.account,
      shareEmail,
      credentialsEnc: encryptSecret(JSON.stringify(parsed.secret), ctx.config.secret),
      keyLast4: parsed.keyLast4,
      updatedBy: by,
      updatedAt: new Date(),
    };
    const [row] = saved
      ? await db.update(googleSheets).set(values).where(eq(googleSheets.id, saved.id)).returning()
      : await db.insert(googleSheets).values({ companyId, ...values }).returning();
    return row!;
  }

  /* Only a person who may change the whole company, by themselves or through the orchestrator, never a head, holds the
     company's Google key. */
  async function requireWholeCompany(me: Person): Promise<void> {
    if (me.viaHead) throw new ApiError(403, 'forbidden', 'A person connects Google Sheets directly in Settings, under Integrations, or the orchestrator does.');
    await requireDepartmentChanger(db, me, null);
  }

  app.get('/api/google-sheets', async req => {
    const me = await requirePerson(req, db);
    await requireWholeCompany(me);
    const [row] = await db.select().from(googleSheets).where(eq(googleSheets.companyId, me.companyId));
    return { google: row ? googleSheetsView(row) : null };
  });

  app.put('/api/google-sheets', async req => {
    const me = await requirePerson(req, db);
    await requireWholeCompany(me);
    const body = PutBody.parse(req.body);
    const [saved] = await db.select().from(googleSheets).where(eq(googleSheets.companyId, me.companyId));
    const rawCreds = body.credentials?.trim() ?? '';
    if (!rawCreds && !saved) {
      throw new ApiError(400, 'validation', 'Paste the Google JSON key to connect Google Sheets.', 'google_sheets_invalid');
    }
    const shareEmail = shareOf(body.shareEmail, saved);
    const row = rawCreds ? await saveKey(me.companyId, saved, rawCreds, shareEmail, me.id) : await keepKey(saved!, shareEmail, me.id);
    ctx.bus.publish(me.companyId, { type: 'org' });
    return { google: googleSheetsView(row) };
  });

  app.delete('/api/google-sheets', async (req, reply) => {
    const me = await requirePerson(req, db);
    await requireWholeCompany(me);
    await db.delete(googleSheets).where(eq(googleSheets.companyId, me.companyId));
    ctx.bus.publish(me.companyId, { type: 'org' });
    return reply.code(204).send();
  });
}
