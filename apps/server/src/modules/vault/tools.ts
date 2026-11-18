import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PRIVATE_TOOLS } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { jobs, vaultLog } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { refusal } from '../../errors.js';
import { companyEntries, entryByName, secretsOf, unknownEntry } from './store.js';
import { totpCode, totpSecondsLeft } from './totp.js';

/* Agents use entries saved through the vault. */

/* The agent at its tools: itself, its company and the turn it runs. */
type VaultAgent = { id: string; companyId: string; jobId: string };

const said = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(isError ? { isError } : {}) });

async function answer(call: () => Promise<unknown>) {
  try {
    return said(await call());
  } catch (err) {
    const refused = refusal(err);
    if (refused) return said(refused.body, true);
    throw err;
  }
}

export function registerVaultTools(server: McpServer, ctx: Ctx, agent: VaultAgent): void {
  server.registerTool(
    'vault_entries',
    { description: "The company's saved site sign-ins: each entry's name, site, login and whether it has a one-time code. Take one with vault_entry to sign in." },
    () =>
      answer(async () => ({
        entries: (await companyEntries(ctx, agent.companyId)).map(e => ({ name: e.name, site: e.site, login: e.login, hasCode: e.totpEnc !== null })),
      })),
  );
  server.registerTool(
    PRIVATE_TOOLS.entry.name,
    {
      _meta: PRIVATE_TOOLS.entry._meta,
      description:
        "One saved sign-in by its name: the site, the login, the password and, when the site asks for one, the current one-time code with the seconds it is still good for. " +
        'Type the values yourself into the protected sign-in field. Refer to the entry by name everywhere else. For a missing sign-in, ask its holder to add it in the vault.',
      inputSchema: { entry: z.string().trim().min(1).max(200).describe('The entry name, as vault_entries lists it.') },
    },
    ({ entry: name }) =>
      answer(async () => {
        const entry = await entryByName(ctx, agent.companyId, name);
        if (!entry) throw unknownEntry();
        const { password, totp } = secretsOf(ctx, entry);
        const [job] = await ctx.db.select(only(jobs, 'taskId')).from(jobs).where(eq(jobs.id, agent.jobId));
        await ctx.db.insert(vaultLog).values({ companyId: entry.companyId, entryId: entry.id, entryName: entry.name, site: entry.site, kind: 'taken', agentId: agent.id, taskId: job?.taskId ?? null });
        const at = ctx.clock();
        return { name: entry.name, site: entry.site, login: entry.login, password, ...(totp ? { code: totpCode(totp, at), codeSecondsLeft: totpSecondsLeft(totp, at) } : {}) };
      }),
  );
}
