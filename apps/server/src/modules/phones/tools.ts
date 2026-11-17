import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PhoneOperation } from '@hornhoof/protocol';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { companyPhones, phoneSessions } from '../../db/schema.js';
import { refusal } from '../../errors.js';
import { Declaration, declareAction, journalStep, PHONE_LIMITS } from './journal.js';
import { acquirePhone, finishPhoneSession, phoneAction, reconcilePhones, sessionFor, sessionView } from './queue.js';
import { phoneView, type PhoneAgent } from './store.js';

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

const HONEST = 'If a robot check or another check of the site does not pass, stop that action and write in the task what did not pass; do not ask a person to sign in or to pass it.';

export function registerPhoneTools(server: McpServer, ctx: Ctx, actor: () => Promise<PhoneAgent>): void {
  server.registerTool('phones', { description: `The company's Android phones, their owners, whether each is free, how many turns wait and the limits of one account on a phone. ${HONEST}` }, () => answer(async () => {
    const me = await actor();
    const phones = await ctx.db.select().from(companyPhones).where(and(eq(companyPhones.companyId, me.companyId), isNull(companyPhones.removedAt))).orderBy(asc(companyPhones.createdAt), asc(companyPhones.id));
    const anyPhone = await ctx.db.select({ id: phoneSessions.id }).from(phoneSessions).where(and(eq(phoneSessions.companyId, me.companyId), eq(phoneSessions.status, 'queued'), isNull(phoneSessions.phoneId)));
    return { value: { phones: await Promise.all(phones.map(p => phoneView(ctx, p))), waitingForAny: anyPhone.length, limits: PHONE_LIMITS } };
  }));
  server.registerTool('phone_acquire', {
    description: 'Borrow a company phone for this turn and task: the one you name, or without phone the first free one. Returns an active session or your place in the company queue at once. A phone serves one agent at a time and a turn holds one phone. Poll phone_session while queued; release when finished. The owner may stop it at any time.',
    inputSchema: { phone: z.uuid().optional(), task: z.union([z.string().max(100), z.number().int().positive()]).optional().describe('The task for the recording, when this turn has no task yet.') },
  }, input => answer(async () => ({ value: await acquirePhone(ctx, await actor(), input.phone ?? null, input.task) })));
  server.registerTool('phone_session', { description: 'The phone session you hold, or your place in the queue.', inputSchema: { session: z.uuid() } }, input => answer(async () => {
    const me = await actor();
    await sessionFor(ctx, me, input.session);
    await reconcilePhones(ctx, me.companyId);
    return { value: await sessionView(ctx, await sessionFor(ctx, me, input.session)) };
  }));
  server.registerTool('phone_release', { description: 'Release your phone session or leave the queue. No more actions from this session run after release.', inputSchema: { session: z.uuid() } }, input => answer(async () => {
    const me = await actor();
    await sessionFor(ctx, me, input.session);
    await finishPhoneSession(ctx, input.session, 'completed');
    return { value: await sessionView(ctx, await sessionFor(ctx, me, input.session)) };
  }));
  server.registerTool('phone_declare', {
    description: 'Say what you are about to do on an account before you do it: sign_in, or a post, comment, like, follow or message with its text. Hornhoof counts each post, comment, like, follow and message of an account per hour and per day and writes it in the phone journal with the task. Status wait says when the limit lets the next one go: do not do the action before then. Status repeated means the same text went from this account just before: never send one text to several people in a row. Taps and swipes that only move around need no declaration; every step after a declaration goes into the journal under it.',
    inputSchema: { session: z.uuid(), ...Declaration.shape },
  }, ({ session, ...declared }) => answer(async () => ({ value: await declareAction(ctx, await actor(), session, declared) })));
  server.registerTool('phone_action', {
    description: `Observe or operate the real Android phone you hold, as a person does: one screen and one app or site at a time, never bulk messages. capture gives a sanitized PNG and element tree; tap and swipe use screen coordinates; text types into the focused field; url opens ordinary Chrome. To sign in, declare sign_in, tap the field and type the login, password and one-time code you took from the company vault as text, with secret true: Hornhoof keeps them out of the journal. Text accepts printable ASCII. A lost reply has an unknown outcome: inspect before another action. ${HONEST}`,
    inputSchema: { session: z.uuid(), operation: PhoneOperation, secret: z.boolean().optional().describe('True when the text is a login, password or code.') },
  }, input => answer(async () => {
    const { phone, session, reply } = await phoneAction(ctx, await actor(), input.session, input.operation);
    if (reply.status === 'ok') await journalStep(ctx, phone, session, input.operation, input.secret === true);
    if (!reply.capture) return { value: { status: reply.status, capture: null } };
    const { png, ...capture } = reply.capture;
    return { value: { status: reply.status, capture }, png };
  }));
}
