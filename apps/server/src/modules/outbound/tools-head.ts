import { OutboundPolicyValue } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { orchestratorDecisionHeaders } from '../../auth/internal.js';
import { outboundAccounts, outboundCatalogRevisions, outboundChannels } from '../../db/schema.js';
import { standingPrincipal } from '../conversation/decision-context.js';
import type { ToolJob } from '../tools/job.js';
import { catalogOf } from './catalog-view.js';
import { channelsOfDepartment } from './views.js';

/* A department runs its own messages: what a person who runs it decides, its head carries out here, with no word of the
   orchestrator or the CEO. Each tool calls the route the department's screen calls, as the last person who wrote to the
   head, so it allows exactly what that person may do there. Nothing of another department is reached: there a head is told
   what it is told of nothing at all. A setting or secret of an account never passes through here: a person gives it on
   their own screen, and these tools say where. */

export const WHERE_ACCOUNTS =
  'A person who runs the department connects a mail account (SMTP) or a webhook, with its password or key, in Settings under External messaging, or on the department\'s screen under External messaging. Never ask for a password or key in a message and never pass one on.';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const ASK_THEM = 'Only the people who run this department decide this, or the CEO; ask them';
const NO_PRINCIPAL = `No person's words stand behind this: nobody wrote to you yet, or words for this turn are still on their way. Nothing was changed. ${ASK_THEM}.`;
const NOT_THEIRS = `The last person who wrote to you may not decide this. Nothing was changed. ${ASK_THEM}.`;
const REFUSED: Record<string, string> = { outbound_not_allowed: NOT_THEIRS, decision_context_missing: NO_PRINCIPAL };

const Name = z.string().trim().min(1).max(200);
const Channel = z.uuid().describe('The channel\'s id, from outbound_setup.');
const Account = z.uuid().describe('The account\'s id, from outbound_setup.');
const Revision = z.uuid().describe('The revision\'s id, from outbound_catalog.');

const errorOf = (body: string): { message?: string; reason?: string } => {
  try {
    return (JSON.parse(body) as { error?: { message?: string; reason?: string } }).error ?? {};
  } catch {
    return {};
  }
};

type Place = { kind: 'channel' | 'account' | 'revision'; id: string };
const TABLE = { channel: outboundChannels, account: outboundAccounts, revision: outboundCatalogRevisions } as const;
const UNKNOWN = { channel: 'There is no such channel.', account: 'There is no such account here.', revision: 'There is no such catalog revision.' } as const;

type Head = { ctx: Ctx; app: FastifyInstance; job: ToolJob };

/* Whether a channel, an account or a revision is of the head's own department. */
async function ours({ ctx, job }: Head, { kind, id }: Place): Promise<boolean> {
  const own = job.departmentId;
  if (!own) return false;
  const table = TABLE[kind];
  const [row] = await ctx.db.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.companyId, job.companyId), eq(table.departmentId, own)));
  return row !== undefined;
}

/* The route the department's screen calls, as the last person who wrote to the head, answered in that route's words. */
async function call({ ctx, app, job }: Head, url: string, payload: object, after: (body: string) => string = body => body) {
  const principal = await standingPrincipal(ctx.db, job.id);
  if (!principal) return say(NO_PRINCIPAL, true);
  const headers = orchestratorDecisionHeaders({ personId: principal.personId, sourceSeq: principal.sourceSeq, agentId: job.agentId, jobId: job.id });
  const res = await app.inject({ method: 'POST', url, payload, headers });
  if (res.statusCode < 400) return say(after(res.body));
  const { message, reason } = errorOf(res.body);
  return say(REFUSED[reason ?? ''] ?? message ?? `Hornhoof answered ${res.statusCode}.`, true);
}

/* A move on something of the head's own department, or the answer nothing at all would get. */
async function onOwn(head: Head, place: Place, url: string, payload: object) {
  return (await ours(head, place)) ? call(head, url, payload) : say(UNKNOWN[place.kind], true);
}

async function setupOf({ ctx, job }: Head) {
  const channels = job.departmentId ? await channelsOfDepartment(ctx.db, job.companyId, job.departmentId) : [];
  const working = channels.some(c => c.accounts.some(a => a.status === 'active'));
  return { channels, ...(working ? {} : { noAccount: `Your department has no working account to send from. ${WHERE_ACCOUNTS}` }) };
}

const newChannelNote = (body: string) => `${body}\nIt has no account yet. ${WHERE_ACCOUNTS} Then set its policy with outbound_policy_set and its author with outbound_account_author.`;

function registerChannelTools(server: McpServer, head: Head): void {
  server.registerTool(
    'outbound_setup',
    {
      description:
        'Your department\'s ways out: each channel with its status, its policy (limits, and autoSend: whether a direct message goes without a person\'s yes to each one) and its accounts by name, with who writes from each. ' +
        'Never a setting, password or key. When no account works, it says where a person connects one.',
    },
    async () => say(JSON.stringify(await setupOf(head))),
  );

  server.registerTool(
    'outbound_channel_create',
    {
      description:
        'Makes a way out for your department, or a product of it, when a person who runs the department decides so, as the last person who wrote to you. It starts new: every message is reviewed, and it takes nothing until it has a policy and an account. ' +
        'adapter: smtp or webhook. purpose: what contacts agree to, like first_contact. audience: direct to contacts, or public.',
      inputSchema: { product: z.uuid().optional(), name: Name, adapter: z.enum(['smtp', 'webhook']), purpose: Name, audience: z.enum(['direct', 'public']) },
    },
    async ({ product, ...rest }) => {
      const own = head.job.departmentId;
      if (!own) return say('You have no department to make a channel for.', true);
      return call(head, '/api/outbound/channels', { departmentId: own, ...(product === undefined ? {} : { productId: product }), ...rest }, newChannelNote);
    },
  );

  server.registerTool(
    'outbound_policy_set',
    {
      description:
        'Sets the next revision of a channel\'s policy, as a person who runs your department decides: its time zone, daily limits per account and per sender domain, how messages are sampled for review and when it stops itself, all their numbers with no default. ' +
        'autoSend true lets a direct message go without a person\'s yes to each one; limits, consent, suppression, content checks, price rules and a check that asks for a person still hold. The department\'s log keeps who turned it on or off.',
      inputSchema: { channel: Channel, value: OutboundPolicyValue },
    },
    ({ channel, value }) => onOwn(head, { kind: 'channel', id: channel }, `/api/outbound/channels/${channel}/policies`, value),
  );

  server.registerTool(
    'outbound_channel_stop',
    { description: 'Stops a channel of your department at once: nothing new goes through it, and what waits stays. What already left cannot be called back.', inputSchema: { channel: Channel } },
    ({ channel }) => onOwn(head, { kind: 'channel', id: channel }, `/api/outbound/channels/${channel}/stop`, {}),
  );

  server.registerTool(
    'outbound_channel_reopen',
    { description: 'Opens a stopped channel of your department, once its check passes, as new: every message is reviewed again and what was admitted before the stop does not go.', inputSchema: { channel: Channel } },
    ({ channel }) => onOwn(head, { kind: 'channel', id: channel }, `/api/outbound/channels/${channel}/reopen`, {}),
  );
}

function registerAccountTools(server: McpServer, head: Head): void {
  server.registerTool(
    'outbound_contact_suppress',
    { description: 'Records that a contact must not be written to, for good: their permissions end and what waits for them is cancelled. evidence: how they said so.', inputSchema: { contact: z.uuid(), evidence: z.string().trim().min(1).max(2000) } },
    ({ contact, evidence }) => call(head, `/api/outbound/contacts/${contact}/suppress`, { evidence }),
  );

  server.registerTool(
    'outbound_account_author',
    {
      description:
        'Says which employee of your department writes from an account of it, as a person who runs the department decides: employee null leaves it to nobody. ' +
        'One author per account and one account per author; what the last author queued does not move.',
      inputSchema: { account: Account, employee: z.uuid().nullable() },
    },
    ({ account, employee }) => onOwn(head, { kind: 'account', id: account }, `/api/outbound/accounts/${account}/${employee === null ? 'release' : 'bind'}`, employee === null ? {} : { agentId: employee }),
  );

  server.registerTool(
    'outbound_account_revoke',
    { description: 'Takes an account of your department out of use for good, with its settings: nothing new leaves from it. A new one is connected by a person, as outbound_setup says.', inputSchema: { account: Account } },
    ({ account }) => onOwn(head, { kind: 'account', id: account }, `/api/outbound/accounts/${account}/revoke`, {}),
  );
}

function registerCatalogTools(server: McpServer, head: Head): void {
  server.registerTool(
    'outbound_catalog',
    { description: 'Your department\'s catalog: each entry with every revision, its status (proposed, published or revoked), its words, who wrote and who published it, and current: the revision a message may use now.' },
    async () => say(JSON.stringify(head.job.departmentId ? await catalogOf(head.ctx.db, head.job.companyId, head.job.departmentId) : [])),
  );

  server.registerTool(
    'outbound_publish',
    {
      description:
        'Publishes a proposed revision of your department\'s catalog, so that messages may use it, as a person who runs the department decides: no one clicks for each one. ' +
        'The department\'s log keeps that you published it and on whose word, and the people who run it see this in its catalog.',
      inputSchema: { revision: Revision },
    },
    ({ revision }) => onOwn(head, { kind: 'revision', id: revision }, `/api/outbound/catalog/${revision}/publish`, {}),
  );

  server.registerTool(
    'outbound_revoke',
    { description: 'Takes back a published revision of your department\'s catalog: what would use it stops at its last look.', inputSchema: { revision: Revision } },
    ({ revision }) => onOwn(head, { kind: 'revision', id: revision }, `/api/outbound/catalog/${revision}/revoke`, {}),
  );
}

export function registerOutboundHeadTools(server: McpServer, ctx: Ctx, app: FastifyInstance, job: ToolJob): void {
  const head = { ctx, app, job };
  registerChannelTools(server, head);
  registerAccountTools(server, head);
  registerCatalogTools(server, head);
}
