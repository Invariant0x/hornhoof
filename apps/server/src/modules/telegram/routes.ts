import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireDepartmentChanger } from '../../auth/departments.js';
import { changedBy, type Person } from '../../auth/session.js';
import { encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import { agentChanges, telegramBots, telegramReplies } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { agentFor, type AgentRow } from '../agents/find.js';
import { deleteWebhook, getMe, TelegramError, type TelegramUser } from './api.js';

/* What a token from @BotFather looks like: the bot's number, a colon and its secret part. */
const TokenBody = z.object({ token: z.string().trim().regex(/^\d{1,20}:[A-Za-z0-9_-]{20,200}$/, 'Paste the whole token @BotFather gave, like 123456789:AAH...') }).strict();

export type TelegramView = { username: string } | null;

/* The bot an agent's card shows: its name in Telegram, never its token. */
export async function telegramOf(db: Db, agentId: string): Promise<TelegramView> {
  const [bot] = await db.select(only(telegramBots, 'username')).from(telegramBots).where(eq(telegramBots.agentId, agentId));
  return bot ?? null;
}

/* People with the whole company give an agent a bot or take it off, and so does the person responsible for a head's
   department, who runs it as the CEO does; the orchestrator is in no department. From their own screen, or through the
   orchestrator, never a head. */
async function requireBotKeeper(db: Db, me: Person, agent: AgentRow): Promise<void> {
  await requireDepartmentChanger(db, me, agent.kind === 'orchestrator' ? null : agent.departmentId);
  if (me.viaHead) throw new ApiError(403, 'forbidden', 'Only a person sets a Telegram bot, from their own screen, or the orchestrator.', 'company_scope_only');
}

const unreachable = () => new ApiError(503, 'unavailable', 'Telegram does not answer now. Try again in a few minutes.', 'telegram_unreachable');

/* The bot the token opens, as Telegram says, ready to be read by polling. */
async function botOf(ctx: Ctx, token: string): Promise<TelegramUser & { username: string }> {
  let bot: TelegramUser;
  try {
    bot = await getMe(ctx.config.telegramApiUrl, token);
  } catch (err) {
    if (err instanceof TelegramError && err.code !== null && err.code >= 400 && err.code < 500 && err.code !== 429) {
      throw new ApiError(400, 'validation', 'Telegram does not take this token. Copy it again from @BotFather.', 'telegram_token');
    }
    throw unreachable();
  }
  if (!bot.is_bot || !bot.username) throw new ApiError(400, 'validation', 'Telegram does not take this token. Copy it again from @BotFather.', 'telegram_token');
  await deleteWebhook(ctx.config.telegramApiUrl, token).catch(() => {
    throw unreachable();
  });
  return { ...bot, username: bot.username };
}

/* The agent's bot from now on. Another bot in its place starts reading from its own first update, and the answers the old
   one still owed go nowhere: its chats are not the new bot's. */
async function keepBot(ctx: Ctx, me: Person, agent: AgentRow, token: string, bot: { id: number; username: string }): Promise<void> {
  const values = { companyId: agent.companyId, agentId: agent.id, tokenEnc: encryptSecret(token, ctx.config.secret), botUserId: bot.id, username: bot.username, createdBy: me.id };
  try {
    await ctx.db.transaction(async tx => {
      const [before] = await tx.select().from(telegramBots).where(eq(telegramBots.agentId, agent.id)).for('update');
      if (!before) await tx.insert(telegramBots).values(values);
      else {
        const same = before.botUserId === bot.id;
        await tx.update(telegramBots).set({ ...values, updateOffset: same ? before.updateOffset : 0 }).where(eq(telegramBots.id, before.id));
        if (!same) await tx.delete(telegramReplies).where(eq(telegramReplies.botId, before.id));
      }
      await tx.insert(agentChanges).values({ companyId: agent.companyId, agentId: agent.id, ...changedBy(me), field: 'telegram', before: before ? `@${before.username}` : null, after: `@${bot.username}` });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, 'conflict', 'This bot belongs to another employee already. Make a new bot for this one with @BotFather.', 'telegram_taken');
    throw err;
  }
}

/* A head's or the orchestrator's Telegram bot: people of the company write to it there as they would in its window. */
export function telegramRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.put('/api/agents/:id/telegram', async req => {
    const { me, agent } = await agentFor(ctx, req);
    await requireBotKeeper(ctx.db, me, agent);
    if (agent.kind === 'worker' || agent.kind === 'assistant') throw new ApiError(409, 'conflict', 'Only department heads and the orchestrator have a Telegram bot.', 'telegram_heads_only');
    const { token } = TokenBody.parse(req.body);
    const bot = await botOf(ctx, token);
    await keepBot(ctx, me, agent, token, bot);
    await ctx.telegram.refresh([agent.id]);
    ctx.bus.publish(agent.companyId, { type: 'org' });
    return { telegram: { username: bot.username } };
  });

  app.delete('/api/agents/:id/telegram', async (req, reply) => {
    const { me, agent } = await agentFor(ctx, req);
    await requireBotKeeper(ctx.db, me, agent);
    const removed = await ctx.db.transaction(async tx => {
      const [gone] = await tx.delete(telegramBots).where(eq(telegramBots.agentId, agent.id)).returning({ username: telegramBots.username });
      if (gone) await tx.insert(agentChanges).values({ companyId: agent.companyId, agentId: agent.id, ...changedBy(me), field: 'telegram', before: `@${gone.username}`, after: null });
      return Boolean(gone);
    });
    await ctx.telegram.refresh([agent.id]);
    if (removed) ctx.bus.publish(agent.companyId, { type: 'org' });
    return reply.code(204).send();
  });
}
