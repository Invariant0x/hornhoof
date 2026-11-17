import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { jobs, vaultLog } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { refusal } from '../../errors.js';
import { changeEntry, companyEntries, createEntry, entryByName, entryViews, NewEntry, parseBody, secretsOf, unknownEntry } from './store.js';
import { totpCode, totpSecondsLeft } from './totp.js';

/* The vault for an agent: the company's saved site sign-ins, which it takes as text and types in itself, as a person
   does, and saves when a person gives it one. Every agent of the company uses every entry. */

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
    'vault_entry',
    {
      description:
        "One saved sign-in by its name: the site, the login, the password and, when the site asks for one, the current one-time code with the seconds it is still good for. " +
        'Type them into the sign-in form yourself. Never write them into a task, comment, chat, file, commit or report.',
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
  server.registerTool(
    'vault_save',
    {
      description:
        'Saves a site sign-in a person gave you, so that every employee and assistant of the company can take it with vault_entry: ' +
        'adds the entry, or replaces the site, login and password of the entry of this name. Never repeat the password anywhere else.',
      inputSchema: {
        name: z.string().describe('A short name to ask for it by, such as LinkedIn.'),
        site: z.string().describe('The site or the address of its sign-in page.'),
        login: z.string(),
        password: z.string(),
        code: z.string().optional().describe("The site's one-time code secret for an authenticator app, or its otpauth:// address, when the person gave one."),
      },
    },
    args =>
      answer(async () => {
        const actor = { agentId: agent.id };
        const input = parseBody(NewEntry, args);
        const found = await entryByName(ctx, agent.companyId, input.name);
        const saved = found ? await changeEntry(ctx, found, actor, { site: input.site, login: input.login, password: input.password, code: input.code }) : await createEntry(ctx, agent.companyId, actor, input);
        return (await entryViews(ctx, [saved], null))[0];
      }),
  );
}
