import { ToolPrivacy } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { markSensitiveTool, sensitiveTurn } from '../events/store.js';
import type { ToolProtection } from './calls.js';

/* No value is written here or recovered from replay. A finished turn drops its values. */
const turns = new WeakMap<Db, Map<string, ToolPrivacy>>();
export const privateTurn = (db: Db, jobId: string): ToolPrivacy | undefined => turns.get(db)?.get(jobId);
export const forgetPrivateTurn = (db: Db, jobId: string): void => { turns.get(db)?.delete(jobId); };

export async function turnProtection(ctx: Pick<Ctx, 'db' | 'bus'>, jobId: string): Promise<ToolProtection> {
  const lost = !privateTurn(ctx.db, jobId)?.sensitive && await sensitiveTurn(ctx.db, jobId, true);
  return {
    lost,
    input: value => privateTurn(ctx.db, jobId)?.values.input(value) ?? value,
    hide: value => privateTurn(ctx.db, jobId)?.values.hide(value) ?? value,
    execution: (name, input) => privateTurn(ctx.db, jobId)?.execution(name, input) ?? false,
    async sensitive(name, policy, input, answer) {
      let state = privateTurn(ctx.db, jobId);
      if (!state) {
        state = new ToolPrivacy();
        if (!turns.has(ctx.db)) turns.set(ctx.db, new Map());
        turns.get(ctx.db)!.set(jobId, state);
      }
      if (!answer) {
        state.input(name, input, policy);
        await markSensitiveTool(ctx, jobId, name);
      } else for (const content of answer.content) {
        if (content.type !== 'text') continue;
        let value: unknown = content.text;
        try { value = JSON.parse(content.text); } catch { /* A sensitive tool may return plain text. */ }
        state.result(value, policy);
      }
    },
  };
}
