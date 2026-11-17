import type { PhoneOperation } from '@hornhoof/protocol';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { viewerOf } from '../../auth/agent-view.js';
import { agents, companyPhones, PHONE_SOCIAL_KINDS, phoneActions, tasks } from '../../db/schema.js';
import { seesTask } from '../tasks/sight.js';
import { activeSession } from './queue.js';
import { phoneById, phoneOwner, type CompanyPhone, type PhoneAgent, type PhoneSession } from './store.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/* Steps after a declaration belong to it for this long, or until the session declares the next action. */
export const DECLARED_MS = 10 * 60_000;

type SocialKind = (typeof PHONE_SOCIAL_KINDS)[number];
/* One person's pace on one account: modest, so a phone never turns into a mailing. */
export const PHONE_LIMITS: Readonly<Record<SocialKind, { hour: number; day: number }>> = {
  post: { hour: 2, day: 6 },
  comment: { hour: 6, day: 30 },
  like: { hour: 20, day: 100 },
  follow: { hour: 6, day: 30 },
  message: { hour: 5, day: 20 },
};
const WITH_TEXT: ReadonlySet<SocialKind> = new Set(['post', 'comment', 'message']);

export const Declaration = z.strictObject({
  account: z.string().trim().min(1).max(200),
  kind: z.enum([...PHONE_SOCIAL_KINDS, 'sign_in']),
  text: z.string().trim().min(1).max(5000).optional(),
});
export type Declaration = z.infer<typeof Declaration>;

export type Declared =
  | { status: 'declared'; id: string; left: { hour: number; day: number } | null }
  | { status: 'wait'; until: string; limit: 'hour' | 'day' }
  | { status: 'repeated' }
  | { status: 'invalid'; reason: 'text_needed' | 'text_not_allowed' };

const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

/* A social action is counted before it is done. One over the limit is not written down: the agent hears when the oldest
   counted one leaves the window, and nothing waits on a clock here. */
export async function declareAction(ctx: Ctx, me: PhoneAgent, sessionId: string, input: Declaration): Promise<Declared> {
  const { phone, session } = await activeSession(ctx, me, sessionId);
  const account = input.account.toLowerCase();
  if (input.kind === 'sign_in') {
    // A sign-in is declared without its values: the login and password stay in the agent's own typing only.
    if (input.text) return { status: 'invalid', reason: 'text_not_allowed' };
    return { status: 'declared', id: await write(ctx, phone, session, { account, kind: 'sign_in', text: null }), left: null };
  }
  const kind = input.kind;
  if (WITH_TEXT.has(kind) !== Boolean(input.text)) return { status: 'invalid', reason: input.text ? 'text_not_allowed' : 'text_needed' };
  return ctx.db.transaction(async tx => {
    await tx.select({ id: companyPhones.id }).from(companyPhones).where(eq(companyPhones.id, phone.id)).for('update');
    const now = ctx.clock();
    const mine = and(eq(phoneActions.phoneId, phone.id), eq(phoneActions.account, account), isNull(phoneActions.declarationId));
    if (input.text) {
      const [last] = await tx.select({ text: phoneActions.text }).from(phoneActions).where(and(mine, isNotNull(phoneActions.text))).orderBy(desc(phoneActions.at)).limit(1);
      if (last?.text && sameText(last.text, input.text)) return { status: 'repeated' } as const;
    }
    const limit = PHONE_LIMITS[kind];
    const counted = await tx.select({ at: phoneActions.at }).from(phoneActions).where(and(mine, eq(phoneActions.kind, kind), gte(phoneActions.at, new Date(now - DAY_MS)))).orderBy(desc(phoneActions.at));
    const inHour = counted.filter(r => r.at.getTime() > now - HOUR_MS);
    if (inHour.length >= limit.hour) return { status: 'wait', limit: 'hour', until: new Date(inHour[limit.hour - 1]!.at.getTime() + HOUR_MS).toISOString() } as const;
    if (counted.length >= limit.day) return { status: 'wait', limit: 'day', until: new Date(counted[limit.day - 1]!.at.getTime() + DAY_MS).toISOString() } as const;
    const [row] = await tx.insert(phoneActions).values({ companyId: phone.companyId, phoneId: phone.id, sessionId: session.id, taskId: session.taskId, agentId: session.agentId, account, kind, text: input.text ?? null, at: new Date(now) }).returning({ id: phoneActions.id });
    return { status: 'declared', id: row!.id, left: { hour: limit.hour - inHour.length - 1, day: limit.day - counted.length - 1 } } as const;
  });
}

async function write(ctx: Ctx, phone: CompanyPhone, session: PhoneSession, row: { account: string; kind: 'sign_in'; text: null }): Promise<string> {
  const [made] = await ctx.db.insert(phoneActions).values({ companyId: phone.companyId, phoneId: phone.id, sessionId: session.id, taskId: session.taskId, agentId: session.agentId, ...row, at: new Date(ctx.clock()) }).returning({ id: phoneActions.id });
  return made!.id;
}

/* What a step says in the journal. Typed text is never kept; a coordinate, an app or the site is. */
function stepOf(operation: PhoneOperation, secret: boolean): { kind: (typeof phoneActions.$inferInsert)['kind']; text: string | null } | null {
  switch (operation.kind) {
    case 'capture': return null;
    case 'tap': return { kind: 'tap', text: `${operation.x} ${operation.y}` };
    case 'swipe': return { kind: 'swipe', text: `${operation.x} ${operation.y} ${operation.toX} ${operation.toY}` };
    case 'text': return { kind: secret ? 'secret' : 'text', text: null };
    case 'app': return { kind: 'app', text: operation.package };
    case 'url': { const url = new URL(operation.url); return { kind: 'url', text: `${url.origin}${url.pathname}` }; }
  }
}

/* Steps inside a declared action's window go into the journal under it; navigation outside any window does not. A step
   of a sign-in, or one the agent marked secret, is written as a typed secret and nothing more. */
export async function journalStep(ctx: Ctx, phone: CompanyPhone, session: PhoneSession, operation: PhoneOperation, secret: boolean): Promise<void> {
  const [open] = await ctx.db.select().from(phoneActions).where(and(eq(phoneActions.sessionId, session.id), isNull(phoneActions.declarationId), gte(phoneActions.at, new Date(ctx.clock() - DECLARED_MS)))).orderBy(desc(phoneActions.at)).limit(1);
  const step = stepOf(operation, secret || open?.kind === 'sign_in');
  if (!open || !step) return;
  await ctx.db.insert(phoneActions).values({ companyId: phone.companyId, phoneId: phone.id, sessionId: session.id, taskId: session.taskId, agentId: session.agentId, declarationId: open.id, account: open.account, ...step, at: new Date(ctx.clock()) });
}

/* The owner's journal of a phone: each declared action with its task, when the owner may see that task, and its steps. */
export async function phoneJournal(ctx: Ctx, me: Person, id: string) {
  const phone = await phoneById(ctx, me.companyId, id);
  phoneOwner(me, phone);
  const declared = await ctx.db.select({ action: phoneActions, agent: agents.name, task: tasks }).from(phoneActions).innerJoin(agents, eq(agents.id, phoneActions.agentId)).innerJoin(tasks, eq(tasks.id, phoneActions.taskId))
    .where(and(eq(phoneActions.phoneId, phone.id), isNull(phoneActions.declarationId))).orderBy(desc(phoneActions.at)).limit(100);
  const ids = declared.map(d => d.action.id);
  const steps = ids.length ? await ctx.db.select({ declarationId: phoneActions.declarationId, kind: phoneActions.kind, steps: count() }).from(phoneActions).where(inArray(phoneActions.declarationId, ids)).groupBy(phoneActions.declarationId, phoneActions.kind) : [];
  const viewer = await viewerOf(ctx.db, me);
  return {
    limits: PHONE_LIMITS,
    actions: declared.map(({ action, agent, task }) => {
      const own = steps.filter(s => s.declarationId === action.id);
      return {
        id: action.id, at: action.at.toISOString(), account: action.account, kind: action.kind, text: action.text, agent,
        task: seesTask(viewer, task) ? { id: task.id, number: task.number, title: task.title } : null,
        steps: own.reduce((sum, s) => sum + Number(s.steps), 0), secret: own.some(s => s.kind === 'secret'),
      };
    }),
  };
}
