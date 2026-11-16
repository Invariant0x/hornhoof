import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PhoneOperation } from '@hornhoof/protocol';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { companyPhones } from '../../db/schema.js';
import { refusal } from '../../errors.js';
import type { VaultAgent } from '../vault/access.js';
import { acquirePhone, finishPhoneSession, phoneAction, reconcilePhone, sessionFor, sessionView } from './queue.js';
import { phoneView } from './store.js';

type ToolAnswer = { value: unknown; png?: string | null };
async function answer(work: () => Promise<ToolAnswer>) {
  try {
    const result = await work();
    const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [{ type: 'text', text: JSON.stringify(result.value) }];
    if (result.png) content.push({ type: 'image', data: result.png, mimeType: 'image/png' });
    return { content };
  }
  catch (error) {
    const rejected = refusal(error);
    if (!rejected) throw error;
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(rejected.body) }] };
  }
}

export function registerPhoneTools(server: McpServer, ctx: Ctx, actor: () => Promise<VaultAgent>): void {
  server.registerTool('phones', { description: 'The company Android phones you may borrow, their owners, whether each is busy and how many agents wait. For a robot check ask the phone owner; never bypass it.' }, () => answer(async () => {
    const me = await actor();
    const phones = await ctx.db.select().from(companyPhones).where(and(eq(companyPhones.companyId, me.companyId), isNull(companyPhones.removedAt))).orderBy(asc(companyPhones.createdAt), asc(companyPhones.id));
    return { value: { phones: await Promise.all(phones.map(p => phoneView(ctx, p))) } };
  }));
  server.registerTool('phone_acquire', {
    description: 'Borrow one company phone for this turn and task. Returns an active session or a FIFO queue receipt immediately. A phone serves one agent at a time. Poll phone_session while queued; release when finished. The owner may stop it at any time.',
    inputSchema: { phone: z.uuid(), task: z.union([z.string().max(100), z.number().int().positive()]).optional().describe('The task for the recording, when this turn has no task yet.') },
  }, input => answer(async () => ({ value: await acquirePhone(ctx, await actor(), input.phone, input.task) })));
  server.registerTool('phone_session', { description: 'The phone session you hold, or your place in its queue.', inputSchema: { session: z.uuid() } }, input => answer(async () => {
    const me = await actor();
    const session = await sessionFor(ctx, me, input.session);
    await reconcilePhone(ctx, session.phoneId);
    return { value: await sessionView(ctx, await sessionFor(ctx, me, input.session)) };
  }));
  server.registerTool('phone_release', { description: 'Release your phone session or leave its queue. No more actions from this session run after release.', inputSchema: { session: z.uuid() } }, input => answer(async () => {
    const me = await actor();
    await sessionFor(ctx, me, input.session);
    await finishPhoneSession(ctx, input.session, 'completed');
    return { value: await sessionView(ctx, await sessionFor(ctx, me, input.session)) };
  }));
  server.registerTool('phone_action', {
    description: 'Observe or operate the real Android phone you hold. capture gives a sanitized PNG and element tree; tap and swipe use screen coordinates; url opens ordinary Chrome. Text accepts printable ASCII; ask the owner for other scripts. Never pass a password or code here: use vault_fill for the focused phone field. A lost reply has an unknown outcome: inspect before another action.',
    inputSchema: { session: z.uuid(), operation: PhoneOperation },
  }, input => answer(async () => {
    const reply = await phoneAction(ctx, await actor(), input.session, input.operation);
    if (!reply.capture) return { value: { status: reply.status, capture: null } };
    const { png, ...capture } = reply.capture;
    return { value: { status: reply.status, capture }, png };
  }));
}
