import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { jobs, vaultLog } from '../../db/schema.js';
import { refusal } from '../../errors.js';
import { mayUse, type VaultAgent } from './access.js';
import { companyEntries, entryById, entryByName, entryViews, notAllowed, unknownEntry } from './store.js';
import { parseCode, totpCode } from './totp.js';

const said = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  ...(isError ? { isError } : {}),
});

async function answer(call: () => Promise<unknown>) {
  try {
    return said(await call());
  } catch (err) {
    const refused = refusal(err);
    if (refused) return said(refused.body, true);
    throw err;
  }
}

/* Only the current code leaves the server, never the secret or the other periods' codes. */
function currentCode(ctx: Ctx, sealed: string, at: number) {
  const stored = JSON.parse(decryptSecret(sealed, ctx.config.secret)) as { secret: string; digits: number; period: number; algorithm: string };
  const totp = parseCode(`otpauth://totp/entry?${new URLSearchParams({ secret: stored.secret, digits: String(stored.digits), period: String(stored.period), algorithm: stored.algorithm })}`);
  return { value: totpCode(totp, at), validForSeconds: totp.period - Math.floor(at / 1000) % totp.period };
}

async function takeEntry(ctx: Ctx, agent: VaultAgent, ref: string) {
  const entry = (await entryById(ctx, ref)) ?? (await entryByName(ctx, agent.companyId, ref));
  if (!entry) throw unknownEntry();
  if (!mayUse(entry, agent)) throw notAllowed('This entry is not available to you.');
  const at = new Date();
  const password = decryptSecret(entry.passwordEnc, ctx.config.secret);
  const code = entry.totpEnc ? currentCode(ctx, entry.totpEnc, at.getTime()) : undefined;
  const [job] = agent.jobId ? await ctx.db.select({ taskId: jobs.taskId }).from(jobs).where(and(eq(jobs.id, agent.jobId), eq(jobs.companyId, agent.companyId), eq(jobs.agentId, agent.id))) : [];
  await ctx.db.insert(vaultLog).values({ companyId: entry.companyId, entryId: entry.id, entryName: entry.name, site: entry.site, kind: 'taken', agentId: agent.id, taskId: job?.taskId ?? null, at });
  return { name: entry.name, site: entry.site, login: entry.login, password, ...(code ? { code } : {}) };
}

export function registerVaultTools(server: McpServer, ctx: Ctx, agent: () => Promise<VaultAgent>): void {
  server.registerTool(
    'vault_entries',
    {
      description:
        "The company's saved site sign-ins you may use: each entry's name, site, login and whether it has a one-time code. " +
        'Ask for the login, password and current code with vault_entry by the entry name.',
    },
    () => answer(async () => {
      const me = await agent();
      const views = await entryViews(ctx, (await companyEntries(ctx, me.companyId)).filter(e => mayUse(e, me)));
      return { entries: views.map(({ name, site, login, hasCode, scope }) => ({ name, site, login, hasCode, scope: scope.kind })) };
    }),
  );
  server.registerTool(
    'vault_entry',
    {
      description:
        "Gives you a saved sign-in's login, password and current one-time code as text, if you may use it. " +
        'Type them into the sign-in form of its site yourself, as a person would. The code includes the seconds it remains valid. ' +
        'Never copy these values into a task, chat, report, file or commit. The code secret stays on the server. ' +
        'The log records who took the entry, when and for which task, without the values.',
      inputSchema: { entry: z.string().trim().min(1).max(200).describe('The entry name, as vault_entries lists it.') },
    },
    ({ entry }) => answer(async () => takeEntry(ctx, await agent(), entry)),
  );
}
