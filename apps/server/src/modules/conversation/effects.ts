import type { Ctx } from '../../app.js';
import type { jobs } from '../../db/schema.js';

/* The app supplies follow-up commands; queue records and dispatch do not own their implementations. */
export interface ConversationEffects {
  beforeDispatch(ctx: Ctx, agentId: string): Promise<boolean>;
  resumeProgram(ctx: Ctx, agentId: string, nodeId: string): Promise<boolean>;
  notifyHold(ctx: Ctx, job: typeof jobs.$inferSelect, text: string, caseId: string): Promise<void>;
}
