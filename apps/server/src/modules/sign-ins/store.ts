import { sameSite, SiteSession } from '@hornhoof/protocol';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import { agents, people, savedSignIns, SIGN_IN_SOURCES } from '../../db/schema.js';

/* The saved sign-ins of employees and assistants: a site's cookies and stored values, kept encrypted for one agent, which
   its hh-browse opens pages with. No view, answer or log holds them; a view says only where, how and when. */

export type SignIn = typeof savedSignIns.$inferSelect;
export type SignInSource = (typeof SIGN_IN_SOURCES)[number];
export type KeptSignIn = { companyId: string; agentId: string; site: string; session: SiteSession; source: SignInSource; savedBy: string | null; userAgent: string | null };

/* The origin a sign-in is kept under, or null for an address that is no web page. */
export function siteOf(address: string): string | null {
  try {
    const url = new URL(address);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/* Keeps a sign-in for an agent of that company, in place of the one it had for the site. False when the agent is not of
   the company, or the session or site is not one a browser keeps. */
export async function keepSignIn(ctx: Ctx, input: KeptSignIn): Promise<boolean> {
  const site = siteOf(input.site);
  const session = SiteSession.safeParse(input.session);
  if (!site || !session.success) return false;
  const [agent] = await ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId), isNull(agents.removedAt)));
  if (!agent) return false;
  const values = {
    companyId: input.companyId, agentId: agent.id, site,
    sessionEnc: encryptSecret(JSON.stringify(session.data), ctx.config.secret),
    userAgent: input.userAgent, source: input.source, savedBy: input.savedBy, savedAt: new Date(),
  };
  const { companyId: _companyId, agentId: _agentId, site: _site, ...change } = values;
  await ctx.db.insert(savedSignIns).values(values).onConflictDoUpdate({ target: [savedSignIns.agentId, savedSignIns.site], set: change });
  return true;
}

/* What the vault's browser got when it signed in with an entry, kept for the agent whose turn asked. */
export const keepVaultSignIn = (ctx: Ctx, input: { companyId: string; agentId: string; site: string; session: SiteSession }): Promise<boolean> =>
  keepSignIn(ctx, { ...input, source: 'vault', savedBy: null, userAgent: null });

export async function signInsOf(ctx: Ctx, agentId: string): Promise<SignIn[]> {
  return ctx.db.select().from(savedSignIns).where(eq(savedSignIns.agentId, agentId)).orderBy(desc(savedSignIns.savedAt));
}

export async function signInOf(ctx: Ctx, agentId: string, id: string): Promise<SignIn | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await ctx.db.select().from(savedSignIns).where(and(eq(savedSignIns.id, id), eq(savedSignIns.agentId, agentId)));
  return row ?? null;
}

export async function removeSignIn(ctx: Ctx, row: SignIn): Promise<void> {
  await ctx.db.delete(savedSignIns).where(eq(savedSignIns.id, row.id));
}

/* Whether a browser sends a cookie of that domain to that host: the host itself, or one under it. */
const cookieFor = (domain: string, host: string): boolean => {
  const d = domain.replace(/^\./, '').toLowerCase();
  return d.length > 0 && (host === d || host.endsWith(`.${d}`));
};

/* Whether a sign-in serves a page: one of its cookies goes to the page's host, as a browser sends it, or the page is of the
   site it was kept under. A sign-in kept under accounts.example.com with cookies of .example.com serves www.example.com. */
export function servesPage(site: string, session: SiteSession, address: string): boolean {
  let host: string;
  try {
    host = new URL(address).hostname.toLowerCase();
  } catch {
    return false;
  }
  return sameSite(site, address) || session.cookies.some(c => cookieFor(c.domain, host));
}

/* The agent's newest sign-in that serves the page at the address, opened. */
export async function sessionFor(ctx: Ctx, agentId: string, address: string): Promise<{ row: SignIn; session: SiteSession } | null> {
  if (!siteOf(address)) return null;
  for (const row of await signInsOf(ctx, agentId)) {
    const session = SiteSession.parse(JSON.parse(decryptSecret(row.sessionEnc, ctx.config.secret)));
    if (servesPage(row.site, session, address)) return { row, session };
  }
  return null;
}

/* What a person sees of a sign-in: never a value. */
export async function signInViews(ctx: Ctx, rows: SignIn[]) {
  const ids = [...new Set(rows.flatMap(r => (r.savedBy ? [r.savedBy] : [])))];
  const names = new Map((ids.length ? await ctx.db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, ids)) : []).map(p => [p.id, p.name]));
  return rows.map(r => ({
    id: r.id,
    site: r.site,
    source: r.source,
    savedBy: r.savedBy ? { id: r.savedBy, name: names.get(r.savedBy) ?? '' } : null,
    savedAt: r.savedAt.toISOString(),
  }));
}
