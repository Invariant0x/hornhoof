import { OutboundPolicyValue } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { orchestratorHeaders } from '../../auth/internal.js';
import { decisionPrincipal, withInputLock } from '../conversation/decision-context.js';
import type { ToolJob } from '../tools/job.js';

/* What the orchestrator does for the person its turn answers, the CEO or the delegate, or else the company's owner,
   through the route the screen calls and within what that person may. There is deliberately no tool here to publish a
   word, add an address or read one: a department publishes its own words, and addresses stay with people. An account is
   connected only with the settings of one the company has, so no password passes through the orchestrator. */

const NO_PERSON = 'This company has no active owner, and nobody acts as the CEO in this turn. Nothing was changed. Ask the CEO or the CEO delegate.';
const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const Channel = z.uuid().describe('The channel\'s id.');
const Name = z.string().trim().min(1).max(200);

export function registerOutboundControlTools(server: McpServer, ctx: Ctx, app: FastifyInstance, job: ToolJob): void {
  const asPerson = (url: string, payload: object) =>
    withInputLock(ctx, job.agentId, async () => {
      const personId = (await decisionPrincipal(ctx.db, job.id))?.personId;
      if (!personId) return say(NO_PERSON, true);
      const res = await app.inject({ method: 'POST', url, headers: orchestratorHeaders(personId, job.agentId), payload });
      if (res.statusCode < 400) return say(res.body);
      return say((JSON.parse(res.body) as { error?: { message?: string } }).error?.message ?? `Hornhoof answered ${res.statusCode}.`, true);
    });

  server.registerTool(
    'outbound_channel_create',
    {
      description: 'Makes a way out of the company for a department, or a product of it. It starts new: every message is reviewed, and it takes nothing until it has a policy and its check passes. adapter: smtp or webhook. purpose: what contacts agree to, like first_contact. audience: direct to contacts, or public. In any turn.',
      inputSchema: { department: z.uuid(), product: z.uuid().optional(), name: Name, adapter: z.enum(['smtp', 'webhook']), purpose: Name, audience: z.enum(['direct', 'public']) },
    },
    ({ department, product, ...rest }) => asPerson('/api/outbound/channels', { departmentId: department, ...(product === undefined ? {} : { productId: product }), ...rest }),
  );

  server.registerTool(
    'outbound_policy_set',
    {
      description: 'Sets the next revision of a channel\'s limits: its time zone, daily limits per account and per sender domain, how messages are sampled for review and when it stops itself. All are the person\'s numbers: none has a default. In any turn.',
      inputSchema: { channel: Channel, value: OutboundPolicyValue },
    },
    ({ channel, value }) => asPerson(`/api/outbound/channels/${channel}/policies`, value),
  );

  server.registerTool(
    'outbound_channel_stop',
    {
      description: 'Stops a channel at once: nothing new goes through it, and what waits stays. What already left cannot be called back. In any turn.',
      inputSchema: { channel: Channel },
    },
    ({ channel }) => asPerson(`/api/outbound/channels/${channel}/stop`, {}),
  );

  server.registerTool(
    'outbound_channel_reopen',
    {
      description: 'Opens a stopped channel, once its check passes, as new: every message is reviewed again and what was admitted before the stop does not go. In any turn.',
      inputSchema: { channel: Channel },
    },
    ({ channel }) => asPerson(`/api/outbound/channels/${channel}/reopen`, {}),
  );

  server.registerTool(
    'outbound_contact_suppress',
    {
      description: 'Records that a contact must not be written to, for good: their permissions end and what waits for them is cancelled. evidence: how they said so. In any turn.',
      inputSchema: { contact: z.uuid(), evidence: z.string().trim().min(1).max(2000) },
    },
    ({ contact, evidence }) => asPerson(`/api/outbound/contacts/${contact}/suppress`, { evidence }),
  );

  server.registerTool(
    'outbound_account_add',
    {
      description: 'Connects one more mail account to a channel with the settings of an account the company already has: the same server, user name and password, sending from its own address, like kate@ next to hello@. The settings go from one account to the other inside Hornhoof and never through you. A new password or another server a person gives on the channel\'s screen. Read the accounts with view of /api/outbound. In any turn.',
      inputSchema: {
        channel: Channel,
        label: Name,
        sameAs: z.uuid().describe('The id of the account whose settings it takes.'),
        from: z.string().trim().min(3).max(320).optional().describe('The address it sends from, when not the same as that account\'s.'),
      },
    },
    ({ channel, label, sameAs, from }) => asPerson('/api/outbound/accounts', { channelId: channel, label, sameAs, ...(from === undefined ? {} : { from }) }),
  );

  server.registerTool(
    'outbound_account_bind',
    {
      description: 'Makes an employee the one who writes from an account, in place of whoever wrote from it before. One employee writes from one account. In any turn.',
      inputSchema: { account: z.uuid().describe('The account\'s id, from view of /api/outbound.'), employee: z.uuid().describe('The employee\'s id.') },
    },
    ({ account, employee }) => asPerson(`/api/outbound/accounts/${account}/bind`, { agentId: employee }),
  );
}
