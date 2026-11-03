import type { jobs } from '../../db/schema.js';

/* Older turns kept only the sent prompt, so they run again as they did before. */
export const requestedPromptOf = (job: Pick<typeof jobs.$inferSelect, 'requestedPrompt' | 'prompt'>): string => job.requestedPrompt ?? job.prompt;
