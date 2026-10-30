import type { Ctx } from '../../app.js';
import type { Wake } from './engine.js';

/* Queues a turn for every agent a task move needs. */
export async function wakeAll(_ctx: Ctx, _wakes: Wake[]): Promise<void> {}
