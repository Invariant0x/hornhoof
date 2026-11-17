import { OutboundStatusInput, OutboundSubmit, SupportClassifyInput, SupportSubmit } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, outboundAccounts, outboundBindings, outboundChannels, outboundContacts, outboundPermissions, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { ownDepartment } from '../departments/approval-policy.js';
import type { ToolJob } from '../tools/job.js';
import { proposeRevision, ProposalInput } from './catalog.js';
import { currentCatalog, outboundStatus, submitOutbound, type Authority } from './core.js';
import { liveCheckPorts } from './live-checks.js';
import { classifySupportTicket, submitSupportReply, SupportGatewayError, type SupportCaller } from './support.js';

/* The gateway as an agent's tools. The same kernel as HTTP behind them, and nothing to say with: an author names published
   entries, never words, numbers, links or an address. These tools read no secret and start no transport. */

const CONTACTS_SHOWN = 500;

export const authorityOf = (job: ToolJob): Authority => ({ companyId: job.companyId, agentId: job.agentId, departmentId: job.departmentId, jobId: job.id });

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

const reasonsOf = (err: ApiError): string => {
  const codes = err.details?.['reasonCodes'];
  return Array.isArray(codes) && codes.length ? ` (${codes.join(', ')})` : '';
};

/* A refused move comes back as a readable error, with the codes it was refused by. */
const answer = async (fn: () => Promise<unknown>) => {
  try {
    return say(JSON.stringify(await fn()));
  } catch (err) {
    if (err instanceof ApiError) return say(`${err.message}${reasonsOf(err)}`, true);
    if (err instanceof SupportGatewayError) return say(`${err.message} (${err.code})`, true);
    throw err;
  }
};

const NOTHING = { channels: [], catalog: [], contacts: [] };

/* The one way this agent is bound to, what it may name there and whom it may write to. Ids and kinds only: an author never
   reads an address, a setting or a hidden record, and needs none to name them. */
async function optionsOf(ctx: Ctx, job: ToolJob, now = new Date()) {
  const [way] = await ctx.db
    .select({ channel: outboundChannels, accountId: outboundAccounts.id, accountStatus: outboundAccounts.status, bindingGeneration: outboundBindings.generation })
    .from(outboundBindings)
    .innerJoin(outboundAccounts, eq(outboundAccounts.id, outboundBindings.accountId))
    .innerJoin(outboundChannels, eq(outboundChannels.id, outboundAccounts.channelId))
    .where(and(eq(outboundBindings.companyId, job.companyId), eq(outboundBindings.agentId, job.agentId), eq(outboundBindings.status, 'active')));
  if (!way) return NOTHING;
  const { channel } = way;
  const catalog = await currentCatalog(ctx.db, channel, now);
  const contacts = await ctx.db
    .select({ contactId: outboundContacts.id, kind: outboundContacts.kind })
    .from(outboundPermissions)
    .innerJoin(outboundContacts, eq(outboundContacts.id, outboundPermissions.contactId))
    .where(and(eq(outboundPermissions.channelId, channel.id), eq(outboundPermissions.purpose, channel.purpose), eq(outboundPermissions.status, 'granted'), eq(outboundContacts.doNotContact, false)))
    .orderBy(outboundContacts.id)
    .limit(CONTACTS_SHOWN);
  return {
    channels: [{
      channelId: channel.id, name: channel.name, purpose: channel.purpose, audience: channel.audience, status: channel.status, generation: channel.generation,
      accounts: [{ accountId: way.accountId, channelId: channel.id, available: way.accountStatus === 'active' && channel.status !== 'stopped', bindingGeneration: way.bindingGeneration }],
    }],
    catalog: catalog.map(({ entryId, revision, kind, locale, value }) => ({ entryId, revision, kind, locale, value })),
    contacts: contacts.map(c => ({ ...c, channelId: channel.id })),
  };
}

/* An agent proposes for its own department; the orchestrator, which has none, for any. Either way nothing is usable until
   a person who runs the department, or its head on their word, publishes it. */
async function proposeAs(ctx: Ctx, job: ToolJob, input: ProposalInput) {
  const dept = await ownDepartment(ctx.db, job.companyId, input.departmentId);
  if (job.agentKind !== 'orchestrator' && job.departmentId !== dept.id) throw new ApiError(403, 'forbidden', 'You propose for your own department.', 'outbound_not_allowed');
  return proposeRevision(ctx, { ...input, companyId: job.companyId, author: { kind: 'agent', id: job.agentId } });
}

/* An author of a reply, with the plan its turn runs on: a model of the same vendor may not review it. */
async function supportCallerOf(ctx: Ctx, job: ToolJob): Promise<SupportCaller> {
  const [turn] = await ctx.db
    .select({ provider: subscriptions.provider, model: agents.model })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .leftJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(eq(jobs.id, job.id));
  return { companyId: job.companyId, agentId: job.agentId, jobId: job.id, authorProvider: turn?.provider ?? null, authorVendorId: turn?.model ?? '' };
}

export function registerOutboundTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'outbound_options',
    { description: `What you may send with: the channel and account you are bound to, the published catalog you may name there with its ids and revisions, and up to ${CONTACTS_SHOWN} contacts who agreed, by id and kind. Addresses and account settings are never shown. Empty when you are bound to no account.` },
    () => answer(() => optionsOf(ctx, job)),
  );

  server.registerTool(
    'outbound_submit',
    {
      description:
        'The only way a message leaves the company. You name a published template and its blocks by id and revision; Hornhoof writes every word, price and link itself, and checks consent, stops, limits, reviews and approvals. There is no field for your own words, a recipient, a link or an amount. ' +
        'It answers scheduled, waiting_checks, waiting_approval or rejected with reason codes; nothing has left yet at that point. Send again with the same idempotencyKey to get the same answer. scheduledAt: when it may go, in UTC.',
      inputSchema: OutboundSubmit,
    },
    input => answer(() => submitOutbound(ctx, authorityOf(job), input)),
  );

  server.registerTool(
    'support_classify',
    {
      description: 'Has a fresh model of another vendor sort a ticket you hold, before you draft anything. It reads the ticket, not your draft. It answers ready or unavailable with a receipt id for support_submit.',
      inputSchema: SupportClassifyInput,
    },
    input => answer(async () => classifySupportTicket(ctx, liveCheckPorts(ctx), await supportCallerOf(ctx, job), input)),
  );

  server.registerTool(
    'support_submit',
    {
      description: 'The only way a reply to a ticket leaves. You name a published template and its blocks, as in outbound_submit, and the receipt of support_classify. It answers scheduled, waiting_checks, waiting_approval or rejected with reason codes; nothing has left yet at that point.',
      inputSchema: SupportSubmit,
    },
    input => answer(async () => submitSupportReply(ctx, liveCheckPorts(ctx), await supportCallerOf(ctx, job), input)),
  );

  server.registerTool(
    'outbound_status',
    { description: 'Where a message of yours is now, with its reason codes. Never its contact, adapter or provider.', inputSchema: OutboundStatusInput },
    ({ messageId }) => answer(() => outboundStatus(ctx, authorityOf(job), messageId)),
  );

  server.registerTool(
    'outbound_propose',
    {
      description:
        'Proposes a revision of a catalog entry: a template, price, link, claim and so on. No message may use it until it is published: by your department\'s head with outbound_publish, ' +
        'or by a person who runs the department, under Department catalog: in Settings under External messaging, or on the department\'s screen under External messaging. Say in your task what you proposed and why. ' +
        'entryId: the entry this is the next revision of, left out for a new one. Words with a link, markup, a secret or someone\'s address are refused.',
      inputSchema: ProposalInput,
    },
    input => answer(() => proposeAs(ctx, job, input)),
  );
}
