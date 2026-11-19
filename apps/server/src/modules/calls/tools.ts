import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Branch, MAX_JOB_TIMEOUT_MS } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import type { ToolJob } from '../tools/job.js';
import { callsView, startCalls, stopCalls } from './calls.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const answer = (fn: () => Promise<string>) =>
  fn().then(
    text => say(text),
    (err: unknown) => {
      if (err instanceof ApiError) return say(err.message, true);
      throw err;
    },
  );

const TaskRef = z.union([z.number().int().positive(), z.string().max(40)]).optional().describe('The task, by number; by default the one this turn is on.');
const Batch = z.uuid().describe('The batch start_calls gave.');

/* One-shot calls for every agent: many short runs of its own plan's program at once, each with a brief and its input. */
export function registerCallTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'start_calls',
    {
      description:
        'Runs independent one-shot calls on a ready machine serving your plan when its provider supports one-shot mode. Include all instructions and material each call needs. Use a branch argument for a repository checkout. ' +
        'When the batch ends, its summary can wake you on an open task. Inspect progress and read full answers with calls. ' +
        `inputs: one call per input. count: copies of the brief when there are no inputs, 1 by default. At a one-shot stage of a task's echelons that you hold, count and judge come from the stage when you leave them out.`,
      inputSchema: {
        brief: z.string().trim().min(1).describe('Everything a call needs to do its work: the goal, where to look, what to return and in what form.'),
        inputs: z.array(z.string()).min(1).optional().describe("Each call's own part: a file, a text, a language, a question."),
        count: z.number().int().min(1).optional().describe('How many calls run the same brief, when there are no inputs.'),
        task: TaskRef,
        branch: Branch.optional().describe("A branch of the task's repository each call gets a fresh clone of. Left out, a call starts in an empty folder."),
        verdict: z.boolean().optional().describe('true: each call ends its answer with a verdict, pass or not, and why.'),
        judge: z.string().trim().min(1).optional().describe('Instructions for the judge. It sees the workers\' inputs and answers after the batch ends. It has no repository checkout.'),
        minutes: z.number().int().min(1).max(Math.floor(MAX_JOB_TIMEOUT_MS / 60_000)).optional().describe('The time limit of each call in minutes. Leave it out to run until the call answers or is stopped.'),
        wait: z.boolean().optional().describe('true returns the batch summary in this call when work finishes. If the caller stops listening first, the summary can wake it on the open task.'),
      },
    },
    async (input, extra) => answer(() => startCalls(ctx, job, input, extra.signal)),
  );
  server.registerTool(
    'calls',
    {
      description: 'How one-shot calls go: each call of a batch with its input, state, answer, verdict and times. Without batch, every batch on the task.',
      inputSchema: { batch: Batch.optional(), task: TaskRef },
    },
    async input => answer(async () => JSON.stringify(await callsView(ctx, job, input))),
  );
  server.registerTool(
    'stop_calls',
    { description: 'Stops every call of a batch that waits or runs. The batch then ends, and you hear how it went.', inputSchema: { batch: Batch } },
    async ({ batch }) => answer(() => stopCalls(ctx, job, batch)),
  );
}
