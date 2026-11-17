import type { Ctx } from '../../app.js';
import { markSensitiveTool, sensitiveTurn } from '../events/store.js';
import type { ToolProtection } from './calls.js';
import { privateTurn, rememberPrivateTurn } from './private-turns.js';

export async function turnProtection(ctx: Pick<Ctx, 'db' | 'bus'>, jobId: string): Promise<ToolProtection> {
  const lost = !privateTurn(ctx.db, jobId)?.sensitive && await sensitiveTurn(ctx.db, jobId, true);
  return {
    lost,
    input: value => privateTurn(ctx.db, jobId)?.values.input(value) ?? value,
    hide: value => privateTurn(ctx.db, jobId)?.values.hide(value) ?? value,
    execution: (name, input) => privateTurn(ctx.db, jobId)?.execution(name, input) ?? false,
    async sensitive(name, policy, input, answer) {
      const state = rememberPrivateTurn(ctx.db, jobId);
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
