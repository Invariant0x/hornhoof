import { EventEmitter } from 'node:events';
import type pg from 'pg';

export type FakeAnswer = { notice?: unknown; error?: Error; during?: () => void; result?: unknown };

type Callback = (err: Error | null, result?: unknown) => void;
const isCallback = (value: unknown): value is Callback => typeof value === 'function';
const textOf = (config: unknown): string => (typeof config === 'string' ? config : ((config as { text?: string }).text ?? ''));

/* The part of pg's client that db/confirm.ts stands on. Its next query hears what `answer` holds, and a transaction moves
   its status the way ReadyForQuery does. `sent` holds what reached it. */
export class FakePgClient extends EventEmitter {
  status: 'I' | 'T' | 'E' | null = 'I';
  answer: FakeAnswer = {};
  sent: unknown[] = [];

  getTransactionStatus(): string | null {
    return this.status;
  }

  query(config: unknown, values?: unknown, callback?: unknown): Promise<unknown> | undefined {
    const told = [values, callback, (config as { callback?: unknown }).callback].find(isCallback);
    const result = this.run(config);
    if (!told) return result;
    result.then(
      answer => told(null, answer),
      (err: Error) => told(err),
    );
    return undefined;
  }

  private async run(config: unknown): Promise<unknown> {
    const { notice, error, during, result } = this.answer;
    this.answer = {};
    this.sent.push(config);
    during?.();
    if (notice !== undefined) this.emit('notice', notice);
    if (error) throw error;
    this.moveStatus(textOf(config));
    return result ?? { rows: [] };
  }

  private moveStatus(text: string): void {
    if (/^\s*begin/i.test(text)) this.status = 'T';
    if (/^\s*(commit|end|rollback)/i.test(text)) this.status = 'I';
  }

  get asPg(): pg.ClientBase {
    return this as unknown as pg.ClientBase;
  }
}
