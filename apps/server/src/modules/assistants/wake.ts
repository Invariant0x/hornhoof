import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { assistants, type AssistantEventKind } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { wakeRequest, wakesModel, WORTH_A_TURN } from './programs.js';

/* A wake that fails is tried again after a pause that doubles from the first up to the longest, this many times in all. */
export const FIRST_PAUSE_MS = 1_000;
export const LONGEST_PAUSE_MS = 300_000;
export const TRIES = 12;
const SEND_MS = 10_000;

const pauseAfter = (failures: number): number => Math.min(FIRST_PAUSE_MS * 2 ** (failures - 1), LONGEST_PAUSE_MS);

/* What waits to go: the number the events wait after, and whether an event among them is worth a turn of a model. */
type Due = { after: number; worth: boolean };

/* One stretch between a start and a stop: a stop aborts what was sent in it, and ends its pauses. */
class Run {
  readonly abort = new AbortController();
  readonly over = new Promise<void>(done => this.abort.signal.addEventListener('abort', () => done(), { once: true }));
}

/* The small signed POSTs that tell an assistant at its events address that new events wait after a number. A wake never
   holds anything up: it goes on its own, and a newer one for the same assistant joins one still waiting. A program whose
   model a wake starts waits for an event worth its turn. It sends only between a start and a stop, and starts again after
   a stop. */
export class Wakes {
  /* What waits to go, by assistant. */
  private readonly due = new Map<string, Due>();
  private readonly running = new Map<string, Promise<void>>();
  private run = new Run();
  /* The pause between tries; a test puts its own here. A stop ends it. */
  delay = (ms: number): Promise<void> => sleep(ms, undefined, { signal: this.run.abort.signal }).catch(() => {});

  constructor(private readonly ctx: Ctx) {}

  /* Sends again after a stop. */
  start(): void {
    if (this.run.abort.signal.aborted) this.run = new Run();
  }

  /* A new event of this kind waits after the number; worth: it is worth a turn of the program's model whatever its kind. */
  wake(assistantId: string, after: number, kind: AssistantEventKind, worth = WORTH_A_TURN.has(kind)): void {
    if (this.run.abort.signal.aborted) return;
    this.join(assistantId, { after, worth });
    if (!this.running.has(assistantId)) this.running.set(assistantId, this.send(assistantId, this.run).finally(() => this.running.delete(assistantId)));
  }

  /* One wake for what waits and what comes, from the smallest number. */
  private join(assistantId: string, due: Due): void {
    const earlier = this.due.get(assistantId);
    this.due.set(assistantId, earlier ? { after: Math.min(earlier.after, due.after), worth: earlier.worth || due.worth } : due);
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
      const due = this.due.get(assistantId)!;
      this.due.delete(assistantId);
      const tried = await this.post(assistantId, due, run);
      if (tried === 'held') {
        /* It goes with the next event worth a turn, which starts a send of its own. */
        this.join(assistantId, due);
        if (!this.due.get(assistantId)!.worth) return;
        continue;
      }
      if (tried === 'done') {
        failures = 0;
        continue;
      }
      failures += 1;
      if (failures >= TRIES) continue;
      this.join(assistantId, due);
      await Promise.race([this.delay(pauseAfter(failures)), run.over]);
    }
  }

  /* One try: done, to be tried again, or held for an event worth a turn of the program's model. An assistant with no events
     address or no key is not woken. */
  private async post(assistantId: string, due: Due, run: Run): Promise<'done' | 'again' | 'held'> {
    const [to] = await this.ctx.db
      .select({ url: assistants.eventsUrl, secret: assistants.wakeSecretEnc, program: assistants.program })
      .from(assistants)
      .where(eq(assistants.personId, assistantId));
    if (!to?.url || !to.secret) return 'done';
    if (!due.worth && wakesModel(to.program)) return 'held';
    const { headers, body } = wakeRequest(to.program, { assistantId, after: due.after, secret: decryptSecret(to.secret, this.ctx.config.secret), now: Date.now() });
    try {
      const res = await fetch(to.url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.any([run.abort.signal, AbortSignal.timeout(SEND_MS)]),
      });
      await res.body?.cancel();
      return res.status >= 200 && res.status < 300 ? 'done' : 'again';
    } catch (err) {
      if (!run.abort.signal.aborted) this.ctx.log.warn({ error: loggable(err), assistantId }, 'Could not wake an assistant at its events address.');
      return 'again';
    }
  }
}
