import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PhoneOperation, PRIVATE_TOOLS, type PhoneReply } from '@hornhoof/protocol';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { companyPhones } from '../../db/schema.js';
import { refusal } from '../../errors.js';
import { acquirePhone, finishPhoneSession, phoneAction, reconcilePhone, sessionFor, sessionView, type PhoneAgent } from './queue.js';
import { phoneView } from './store.js';
import { phoneConnections } from './presence.js';

type ToolAnswer = { value: unknown; jpeg?: string | null };
async function answer(work: () => Promise<ToolAnswer>) {
  try {
    const result = await work();
    const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [{ type: 'text', text: JSON.stringify(result.value) }];
    if (result.jpeg) content.push({ type: 'image', data: result.jpeg, mimeType: 'image/jpeg' });
    return { content };
  }
  catch (error) {
    const rejected = refusal(error);
    if (!rejected) throw error;
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(rejected.body) }] };
  }
}

function actionAnswer({ status, capture, typing }: PhoneReply): ToolAnswer {
  const result = { status, typing };
  if (!capture) return { value: { ...result, capture: null } };
  const { jpeg, ...screen } = capture;
  return { value: { ...result, capture: screen }, jpeg };
}

export function registerPhoneTools(server: McpServer, ctx: Ctx, me: PhoneAgent): void {
  server.registerTool('phones', { description: 'The company Android phones you may borrow, their owners, whether each is busy and how many agents wait. state offline: its computer is offline, or the computer does not see the phone (connection not_connected) and it cannot be borrowed until its owner connects it again.' }, () => answer(async () => {
    const phones = await ctx.db.select().from(companyPhones).where(and(eq(companyPhones.companyId, me.companyId), isNull(companyPhones.removedAt))).orderBy(asc(companyPhones.createdAt), asc(companyPhones.id));
    const connections = await phoneConnections(ctx, phones);
    return { value: { phones: await Promise.all(phones.map(p => phoneView(ctx, p, undefined, connections.get(p.id)))) } };
  }));
  server.registerTool('phone_acquire', {
    description: 'Borrow one company phone for this turn and task. Returns an active session or a FIFO queue receipt immediately. A phone serves one agent at a time. Poll phone_session while queued; release when finished. The owner may stop it at any time.',
    inputSchema: { phone: z.uuid(), task: z.union([z.string().max(100), z.number().int().positive()]).optional().describe('The task for the recording, when this turn has no task yet.') },
  }, input => answer(async () => ({ value: await acquirePhone(ctx, me, input.phone, input.task) })));
  server.registerTool('phone_session', { description: 'The phone session you hold, or your place in its queue.', inputSchema: { session: z.uuid() } }, input => answer(async () => {
    const session = await sessionFor(ctx, me, input.session);
    await reconcilePhone(ctx, session.phoneId);
    return { value: await sessionView(ctx, await sessionFor(ctx, me, input.session)) };
  }));
  server.registerTool('phone_release', { description: 'Release your phone session or leave its queue. No more actions from this session run after release.', inputSchema: { session: z.uuid() } }, input => answer(async () => {
    await sessionFor(ctx, me, input.session);
    await finishPhoneSession(ctx, input.session, 'completed');
    return { value: await sessionView(ctx, await sessionFor(ctx, me, input.session)) };
  }));
  server.registerTool(PRIVATE_TOOLS.phone.name, {
    _meta: PRIVATE_TOOLS.phone._meta,
    description: 'Work on the real Android phone you hold as a person would, one screen and one app or site at a time, never bulk messages. capture gives the screen as a picture and its element tree; tap and swipe use coordinates on that picture; key presses back or home; text types any text into the field you tapped, Russian and emoji too, a login and password you hold as well. It types line breaks with Enter. Each call types within its time limit. A longer text ends with status partial, and typing.next is where its untyped rest starts. On partial, call text again with the text from position next. Positions count Unicode code points of the text you sent, from zero, where \\r and \\n count one each. Status failed comes with typing_failed (with next as well), typing_dropped (missing gives the start and count of each span not in the field) or typing_mismatch (the field differs from what was typed). On partial and failed typing, check tells what the field read back shows for the part already typed. typing_unverified comes with status ok when the field could not be read back, as with every password field: capture before you type the text again. The app operation opens an installed app; url opens a page in Chrome. If a site\'s robot check stops you, do not bypass it: stop and write in the task what did not pass. A lost reply has an unknown outcome: capture before the next action.',
    inputSchema: { session: z.uuid(), operation: PhoneOperation },
  }, input => answer(async () => actionAnswer(await phoneAction(ctx, me, input.session, input.operation))));
}
