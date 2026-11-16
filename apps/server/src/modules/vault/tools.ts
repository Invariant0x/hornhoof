import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FILL_FIELDS } from '@hornhoof/protocol';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { refusal } from '../../errors.js';
import { mayUse, type VaultAgent } from './access.js';
import { fillEntry } from './fill.js';
import { companyEntries, entryViews } from './store.js';

/* The vault for an agent: which sign-ins it may use, and having its node type one into a sign-in form. The agent names an
   entry; no value ever reaches it, its tools or its turn. */

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const said = (value: unknown, isError = false, image?: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }, ...(image ? [{ type: 'image' as const, data: image, mimeType: 'image/png' }] : [])] as Content[],
  ...(isError ? { isError } : {}),
});

async function answer(call: () => Promise<{ value: unknown; image?: string }>) {
  try {
    const { value, image } = await call();
    return said(value, false, image);
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
        "The company's saved site sign-ins you may use: each entry's name, site, login and whether it has a one-time code. Passwords and codes are never shown; " +
        'sign in with vault_fill by the entry name.',
    },
    () =>
      answer(async () => {
        const me = await agent();
        const views = await entryViews(ctx, (await companyEntries(ctx, me.companyId)).filter(e => mayUse(e, me)));
        return { value: { entries: views.map(({ name, site, login, hasCode, scope }) => ({ name, site, login, hasCode, scope: scope.kind })) } };
      }),
  );
  server.registerTool(
    'vault_fill',
    {
      description:
        "Has your node type a vault entry's login, password and current one-time code into a sign-in form, with no value passing you. " +
        "target browser: the node's own browser opens the address (the entry's site by default), fills each step and keeps the sign-in for hh-browse; " +
        'a site that refuses automated browsers answers browser_refused, then ask a person or use a company phone. ' +
        'target phone: tap the field on the phone session you hold first, then name that one field. ' +
        'The answer is a status (filled, signed_in, rejected, needs_person, robot_check, browser_refused, ...) and, from the browser, a screenshot with every sign-in field painted over.',
      inputSchema: {
        entry: z.string().trim().min(1).max(200).describe('The entry name, as vault_entries lists it.'),
        target: z.enum(['browser', 'phone']).describe('Where to type it.'),
        address: z.string().max(2048).optional().describe("browser: the sign-in page's address, when it is not the entry's site."),
        phoneSession: z.uuid().optional().describe('phone: the phone session you hold.'),
        element: z.string().min(1).max(200).optional().describe('phone: the field from the screen tree; the focused field when left out.'),
        fields: z.array(z.enum(FILL_FIELDS)).min(1).max(3).optional().describe('Which to type: login, password, code. browser: all the entry has, by default; phone: the one field you tapped.'),
      },
    },
    args =>
      answer(async () => {
        const done = await fillEntry(ctx, await agent(), args);
        const { shot, ...rest } = done;
        return { value: rest, ...(shot ? { image: shot } : {}) };
      }),
  );
}
