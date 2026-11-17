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
        "Starts one-shot calls for a task on your own plan, on its machine: each runs your plan's program once, headless, with the brief and its own input, answers and ends. " +
        'A call has no inbox and no memory and nobody answers its questions midway, so the brief says everything it needs. ' +
        'They suit work that splits into independent pieces or wants several tries at once: a review or security pass by several calls with a judge, strings into many languages, a check of many files, research fanned out, variants. ' +
        "They start as many at once as the machine's memory holds, and the rest wait for it. When the whole batch has ended you are woken on the task with every answer; calls shows them before that. " +
        `inputs: one call per input. count: copies of the brief when there are no inputs, 1 by default. At a one-shot stage of a task's echelons that you hold, count and judge come from the stage when you leave them out.`,
      inputSchema: {
        brief: z.string().trim().min(1).max(100_000).describe('Everything a call needs to do its work: the goal, where to look, what to return and in what form.'),
        inputs: z.array(z.string().max(100_000)).min(1).optional().describe("Each call's own part: a file, a text, a language, a question."),
        count: z.number().int().min(1).optional().describe('How many calls run the same brief, when there are no inputs.'),
        task: TaskRef,
        branch: Branch.optional().describe("A branch of the task's repository each call gets a fresh clone of. Left out, a call starts in an empty folder."),
        verdict: z.boolean().optional().describe('true: each call ends its answer with a verdict, pass or not, and why.'),
        judge: z.string().trim().min(1).max(100_000).optional().describe('The brief of a judge call that runs once the others have ended, reads every answer and gives the verdict.'),
        minutes: z.number().int().min(1).max(Math.floor(MAX_JOB_TIMEOUT_MS / 60_000)).optional().describe('The time limit of each call in minutes. Leave it out to run until the call answers or is stopped.'),
        wait: z.boolean().optional().describe('true: this tool call waits for the whole batch and returns every answer itself, and no wake follows. A program that stops waiting first still hears on the task.'),
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
