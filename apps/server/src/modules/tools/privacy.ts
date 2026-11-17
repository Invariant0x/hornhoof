import type { Ctx } from '../../app.js';
import { markSensitiveTool, sensitiveTurn } from '../events/store.js';
import type { ToolProtection } from './calls.js';
import { privateTurn, rememberPrivateTurn } from './private-turns.js';

export async function turnProtection(ctx: Pick<Ctx, 'db' | 'bus'>, jobId: string): Promise<ToolProtection> {
  const lost = !privateTurn(ctx.db, jobId)?.sensitive && await sensitiveTurn(ctx.db, jobId, true);
  return { lost, ...turnMasks(ctx.db, jobId), sensitive: sensitiveObserver(ctx, jobId) };
}

function turnMasks(db: Ctx['db'], jobId: string): Pick<ToolProtection, 'input' | 'hide' | 'execution'> {
  return {
    input: value => privateTurn(db, jobId)?.values.input(value) ?? value,
    hide: value => privateTurn(db, jobId)?.values.hide(value) ?? value,
    execution: (name, input) => privateTurn(db, jobId)?.execution(name, input) ?? false,
  };
}

function sensitiveObserver(ctx: Pick<Ctx, 'db' | 'bus'>, jobId: string): ToolProtection['sensitive'] {
  return async (name, policy, input, answer) => {
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
  };
}
