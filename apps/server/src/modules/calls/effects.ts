import type { Ctx } from '../../app.js';
import type { Wake } from '../tasks/state.js';

/* Completion and cancellation share the app's task commands without importing their dispatcher. */
export interface CallEffects {
  wakeAll(ctx: Ctx, wakes: Wake[]): Promise<void>;
  cancelJob(ctx: Ctx, jobId: string): Promise<void>;
}
