import type { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { ToolJob } from '../tools/job.js';
import { submit, type Moved } from './engine.js';
import type { ReviewSubmission } from './review-context.js';

export type AuthorCheckSubmission = { summary: string; evidence: string; review?: z.infer<typeof ReviewSubmission> };

export async function submitWithAuthorCheck(ctx: Ctx, job: ToolJob, taskId: string, input: AuthorCheckSubmission): Promise<Moved> {
  return submit(ctx, job.agentId, taskId, input);
}
