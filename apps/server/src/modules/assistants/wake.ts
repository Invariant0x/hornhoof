import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { assistants } from '../../db/schema.js';
import { loggable } from '../../errors.js';

/* A wake that fails is tried again after a pause that doubles from the first up to the longest, this many times in all. */
export const FIRST_PAUSE_MS = 1_000;
export const LONGEST_PAUSE_MS = 300_000;
export const TRIES = 12;
const SEND_MS = 10_000;

export const pauseAfter = (failures: number): number => Math.min(FIRST_PAUSE_MS * 2 ** (failures - 1), LONGEST_PAUSE_MS);

/* What a wake is signed with: HMAC-SHA256 of the exact body under the assistant's signing secret, in hex. */
export const signature = (secret: string, body: string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/* One stretch between a start and a stop: a stop aborts what was sent in it, and ends its pauses. */
class Run {
  readonly abort = new AbortController();
  readonly over = new Promise<void>(done => this.abort.signal.addEventListener('abort', () => done(), { once: true }));
}

/* The small signed POSTs that tell an assistant at its events address that new events wait after a number. A wake never
   holds anything up: it goes on its own, and a newer one for the same assistant joins one still waiting. It sends only
   between a start and a stop, and starts again after a stop. */
export class Wakes {
  /* What waits to go, by assistant: the number the events wait after. */
  private readonly due = new Map<string, number>();
  private readonly running = new Map<string, Promise<void>>();
  private run = new Run();
  /* The pause between tries; a test puts its own here. A stop ends it. */
  delay = (ms: number): Promise<void> => sleep(ms, undefined, { signal: this.run.abort.signal }).catch(() => {});

  constructor(private readonly ctx: Ctx) {}

  /* Sends again after a stop. */
  start(): void {
    if (this.run.abort.signal.aborted) this.run = new Run();
  }

  wake(assistantId: string, after: number): void {
    if (this.run.abort.signal.aborted) return;
    const earlier = this.due.get(assistantId);
    this.due.set(assistantId, earlier === undefined ? after : Math.min(earlier, after));
    if (!this.running.has(assistantId)) this.running.set(assistantId, this.send(assistantId, this.run).finally(() => this.running.delete(assistantId)));
  }

  /* Ends every send and pause, and forgets what waited to go: a wake is only a hint, and the events wait to be read. */
  async stop(): Promise<void> {
    this.run.abort.abort();
    await Promise.all(this.running.values());
    this.due.clear();
  }

  private async send(assistantId: string, run: Run): Promise<void> {
    let failures = 0;
    while (this.due.has(assistantId) && !run.abort.signal.aborted) {
      const after = this.due.get(assistantId)!;
      this.due.delete(assistantId);
      if (await this.post(assistantId, after, run)) {
        failures = 0;
        continue;
      }
      failures += 1;
      if (failures >= TRIES) continue;
      if (!this.due.has(assistantId)) this.due.set(assistantId, after);
      await Promise.race([this.delay(pauseAfter(failures)), run.over]);
    }
  }

  /* One try; false when it should be tried again. An assistant with no events address or no key is not woken. */
  private async post(assistantId: string, after: number, run: Run): Promise<boolean> {
    const [to] = await this.ctx.db.select({ url: assistants.eventsUrl, secret: assistants.wakeSecretEnc }).from(assistants).where(eq(assistants.personId, assistantId));
    if (!to?.url || !to.secret) return true;
    const body = JSON.stringify({ type: 'wake', after });
    try {
      const res = await fetch(to.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hornhoof-signature': signature(decryptSecret(to.secret, this.ctx.config.secret), body) },
        body,
        redirect: 'manual',
        signal: AbortSignal.any([run.abort.signal, AbortSignal.timeout(SEND_MS)]),
      });
      await res.body?.cancel();
      return res.status >= 200 && res.status < 300;
    } catch (err) {
      if (!run.abort.signal.aborted) this.ctx.log.warn({ error: loggable(err), assistantId }, 'Could not wake an assistant at its events address.');
      return false;
    }
  }
}
