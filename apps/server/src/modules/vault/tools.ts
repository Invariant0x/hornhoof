import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { refusal } from '../../errors.js';
import { mayUse, type VaultAgent } from './access.js';
import { companyEntries, entryByName, entryViews, notAllowed, takeEntry, unknownEntry } from './store.js';

/* The vault for an agent: which sign-ins it may use, and one of them as text, to type it in itself the way a person does. */

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

export function registerVaultTools(server: McpServer, ctx: Ctx, agent: () => Promise<VaultAgent>): void {
  server.registerTool(
    'vault_entries',
    {
      description:
        "The company's saved site sign-ins you may use: each entry's name, site, login and whether it has a one-time code. " +
        'Take one with vault_entry by its name when you sign in.',
    },
    () =>
      answer(async () => {
        const me = await agent();
        const views = await entryViews(ctx, (await companyEntries(ctx, me.companyId)).filter(e => mayUse(e, me)));
        return { entries: views.map(({ name, site, login, hasCode, scope }) => ({ name, site, login, hasCode, scope: scope.kind })) };
      }),
  );
  server.registerTool(
    'vault_entry',
    {
      description:
        "One saved sign-in of the company by its name: the site, the login, the password and, when the site asks for one, the current one-time code with the seconds it is still valid. " +
        'Type them into the sign-in form yourself. Never write them into a task, comment, chat, message, file or commit. Taking it is logged with your task, without the values.',
      inputSchema: { entry: z.string().trim().min(1).max(200).describe('The entry name, as vault_entries lists it.') },
    },
    ({ entry: name }) =>
      answer(async () => {
        const me = await agent();
        const entry = await entryByName(ctx, me.companyId, name);
        if (!entry) throw unknownEntry();
        if (!mayUse(entry, me)) throw notAllowed('This sign-in is kept for another department or employee.');
        return takeEntry(ctx, entry, me);
      }),
  );
}
