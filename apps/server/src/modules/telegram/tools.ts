import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { canViewAgent } from '../../auth/agent-view.js';
import { personColumns, type Person } from '../../auth/session.js';
import { decryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { agents, departments, people, telegramBots } from '../../db/schema.js';
import { attachmentBytesForPerson } from '../tasks/attachments.js';
import type { ToolJob } from '../tools/job.js';
import { sendDocument, TELEGRAM_CAPTION_MAX, TelegramError } from './api.js';
import { markTelegramFileSent } from './bots.js';

type AgentRow = typeof agents.$inferSelect;
type BotRow = typeof telegramBots.$inferSelect;
type TelegramPerson = Person & { telegramUserId: number | null };

const recipientColumns = { ...personColumns, telegramUserId: people.telegramUserId };
const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

async function findRecipient(db: Db, companyId: string, ref: string): Promise<{ person: TelegramPerson } | { error: string }> {
  if (z.uuid().safeParse(ref).success) {
    const [person] = await db
      .select(recipientColumns)
      .from(people)
      .where(and(eq(people.companyId, companyId), eq(people.id, ref), eq(people.isAgent, false)));
    if (!person || person.status !== 'active') return { error: 'There is no active person with that id in this company.' };
    return { person };
  }
  const active = await db
    .select(recipientColumns)
    .from(people)
    .where(and(eq(people.companyId, companyId), eq(people.status, 'active'), eq(people.isAgent, false)));
  const matches = active.filter(p => p.name.trim().toLowerCase() === ref.toLowerCase());
  if (matches.length > 1) return { error: `More than one person is named "${ref}". Pass the exact person id.` };
  if (!matches[0]) return { error: `There is no active person named "${ref}" in this company.` };
  return { person: matches[0] };
}

async function topDepartmentId(db: Db, companyId: string, departmentId: string | null): Promise<string | null> {
  if (!departmentId) return null;
  const [dept] = await db
    .select({ id: departments.id, parentId: departments.parentId })
    .from(departments)
    .where(and(eq(departments.id, departmentId), eq(departments.companyId, companyId)));
  return dept ? (dept.parentId ?? dept.id) : null;
}

function rankBot(botAgent: AgentRow, sender: AgentRow, topDeptId: string | null): number {
  if (botAgent.id === sender.id) return 0;
  if (topDeptId && botAgent.kind === 'head' && (botAgent.departmentId === sender.departmentId || botAgent.departmentId === topDeptId)) return 1;
  if (botAgent.kind === 'orchestrator') return 2;
  return -1;
}

async function pickAuthorizedBot(db: Db, companyId: string, sender: AgentRow, recipient: Person): Promise<BotRow | null> {
  const rows = await db
    .select({ bot: telegramBots, agent: agents })
    .from(telegramBots)
    .innerJoin(agents, eq(agents.id, telegramBots.agentId))
    .where(and(eq(telegramBots.companyId, companyId), isNull(agents.removedAt)));
  const topDeptId = await topDepartmentId(db, companyId, sender.departmentId);
  const ranked = rows
    .map(r => ({ ...r, rank: rankBot(r.agent, sender, topDeptId) }))
    .filter(r => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  for (const candidate of ranked) {
    if (await canViewAgent(db, recipient, candidate.agent)) return candidate.bot;
  }
  return null;
}

export function registerTelegramTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'send_telegram_file',
    {
      description:
        'Sends an attached file (such as an .xlsx or .csv spreadsheet uploaded with hh-attach) to an authorized person on Telegram through the company or department bot. ' +
        'Checks that the person connected Telegram and has permission to see both you and the file.',
      inputSchema: {
        person: z.string().trim().min(1).max(200).describe('Person id (UUID) or exact name of the active recipient in the company.'),
        attachment: z.uuid().describe('Attachment id returned by hh-attach (--task N FILE or --chat FILE).'),
        caption: z.string().max(TELEGRAM_CAPTION_MAX).optional().describe('Optional plain-text caption sent with the document.'),
      },
    },
    async ({ person: personRef, attachment, caption }) => {
      const resolved = await findRecipient(ctx.db, job.companyId, personRef);
      if ('error' in resolved) return say(resolved.error, true);
      const { person } = resolved;
      if (person.telegramUserId === null) {
        return say(`${person.name} has not connected Telegram yet. Attach the file to the task or chat with hh-attach instead.`, true);
      }
      const [sender] = await ctx.db
        .select()
        .from(agents)
        .where(and(eq(agents.id, job.agentId), eq(agents.companyId, job.companyId), isNull(agents.removedAt)));
      if (!sender || !(await canViewAgent(ctx.db, person, sender))) {
        return say('That person is not allowed to receive files from you.', true);
      }
      const file = await attachmentBytesForPerson(ctx.db, person, attachment);
      if (!file) return say('That file does not exist or that person is not allowed to see it.', true);
      const bot = await pickAuthorizedBot(ctx.db, job.companyId, sender, person);
      if (!bot) {
        return say(
          'No Telegram bot is connected on your card, your department head, or the orchestrator that this person may access. Attach the file with hh-attach instead.',
          true,
        );
      }
      const token = decryptSecret(bot.tokenEnc, ctx.config.secret);
      try {
        await sendDocument(
          ctx.config.telegramApiUrl,
          token,
          person.telegramUserId,
          { bytes: file.bytes, name: file.name, mediaType: file.mediaType },
          caption,
        );
      } catch (err) {
        const reason = err instanceof TelegramError ? err.message : 'Telegram did not accept the document.';
        return say(`Could not send ${file.name} to Telegram: ${reason}`, true);
      }
      markTelegramFileSent(job.id, person.telegramUserId, attachment);
      return say(JSON.stringify({ sent: true, file: file.name, recipient: person.name }));
    },
  );
}
