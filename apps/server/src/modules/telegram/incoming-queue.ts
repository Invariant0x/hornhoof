import { and, eq, lte, sql } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { telegramBots, telegramIncoming } from '../../db/schema.js';
import type { TelegramUpdate } from './api.js';

type Delivery = (group: TelegramUpdate[]) => Promise<void>;
type Row = typeof telegramIncoming.$inferSelect;
const RETRY_MAX = 60_000;

/* One listener owns the bot on the leader. Keeping the poll offset and its message together also covers a lost commit acknowledgement. */
export async function keepUpdates(db: Db, key: Buffer, botId: string, group: TelegramUpdate[]): Promise<void> {
  const first = group[0]!;
  await db.transaction(async tx => {
    const advanced = await tx.update(telegramBots).set({ updateOffset: group.at(-1)!.update_id + 1 })
      .where(and(eq(telegramBots.id, botId), lte(telegramBots.updateOffset, first.update_id))).returning({ id: telegramBots.id });
    if (!advanced.length || !first.message?.from || first.message.from.is_bot || first.message.chat.type !== 'private') return;
    await tx.insert(telegramIncoming).values({
      botId, updateId: first.update_id, chatId: first.message.chat.id, payloadEnc: encryptSecret(JSON.stringify(group), key),
    });
  });
}

export class IncomingQueue {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private requested = false;
  private stopped = false;

  constructor(private db: Db, private key: Buffer, private botId: string, private deliver: Delivery, private warn: (error: unknown) => void) {}

  wake(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.requested = true;
    if (this.running) return;
    this.running = this.drain().catch(err => {
      this.warn(err);
      this.later(1000);
    }).finally(() => {
      this.running = null;
      if (this.requested) this.wake();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private later(ms: number): void {
    if (!this.stopped) this.timer = setTimeout(() => this.wake(), ms);
  }

  /* A waiting chat keeps its order. Another chat to this bot can go ahead while the first one backs off. */
  private async next(): Promise<Row | undefined> {
    const [row] = await this.db.select().from(telegramIncoming).where(and(eq(telegramIncoming.botId, this.botId),
      sql`NOT EXISTS (SELECT 1 FROM telegram_incoming earlier WHERE earlier.bot_id = ${telegramIncoming.botId}
        AND earlier.chat_id = ${telegramIncoming.chatId} AND earlier.update_id < ${telegramIncoming.updateId})`))
      .orderBy(telegramIncoming.availableAt, telegramIncoming.updateId).limit(1);
    return row;
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      this.requested = false;
      const row = await this.next();
      if (!row || this.stopped) return;
      const wait = row.availableAt.getTime() - Date.now();
      if (wait > 0) { this.later(Math.min(wait, RETRY_MAX)); return; }
      await this.tryOne(row);
    }
  }

  private async tryOne(row: Row): Promise<void> {
    const claim = new Date(Date.now() + 120_000);
    const [held] = await this.db.update(telegramIncoming).set({ availableAt: claim, attempts: row.attempts + 1 })
      .where(and(eq(telegramIncoming.id, row.id), eq(telegramIncoming.attempts, row.attempts))).returning({ id: telegramIncoming.id });
    if (!held) return;
    const ours = and(eq(telegramIncoming.id, row.id), eq(telegramIncoming.attempts, row.attempts + 1));
    try {
      const group: TelegramUpdate[] = JSON.parse(decryptSecret(row.payloadEnc, this.key));
      await this.deliver(group);
      await this.db.delete(telegramIncoming).where(ours);
    } catch (err) {
      this.warn(err);
      const delay = Math.min(RETRY_MAX, 1000 * 2 ** Math.min(row.attempts, 6));
      await this.db.update(telegramIncoming).set({ availableAt: new Date(Date.now() + delay) }).where(ours);
    }
  }
}
