import { Branch, MAX_TEST_PARTS } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import type { ToolJob } from '../tools/job.js';
import { runState, startRun, stopRun, TEST_MINUTES, TEST_MINUTES_MAX } from './runs.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const answer = (fn: () => Promise<string>) =>
  fn().then(
    text => say(text),
    (err: unknown) => {
      if (err instanceof ApiError) return say(err.message, true);
      throw err;
    },
  );

const Run = z.number().int().positive().describe('The test run number run_tests gave.');

/* An employee runs a task's full test suite on whichever machines of the company are free, not on its own machine. */
export function registerTestTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'run_tests',
    {
      description:
        "Runs a branch's full test suite on whichever machine of the company is free now, not on yours, and returns at once with the run's number. " +
        "The branch is cloned into a fresh folder there and the command runs in it as in CI, so it installs what it needs first. When every part has ended you are woken on the task " +
        `with the result: passed or failed, each part's machine and time, and the last lines of what failed; each part's full log goes on the task as tests-<run>-<part>.log. ` +
        `parts splits the run into up to ${MAX_TEST_PARTS} parts on several machines at once, for a runner that can split: the command says which part with {part} and how many with {parts}, ` +
        'as in --shard={part}/{parts}, and HH_TEST_PART and HH_TEST_PARTS hold them too.',
      inputSchema: {
        command: z.string().trim().min(1).max(4000).describe('What runs the suite in the fresh clone, for example installing and then testing.'),
        task: z
          .union([z.number().int().positive(), z.string().max(40)])
          .optional()
          .describe('The task whose branch it tests, by number; by default the one this turn is on.'),
        branch: Branch.optional().describe("By default the task's own: task-<number>, or the only branch that starts with task-<number>-."),
        parts: z.number().int().min(1).max(MAX_TEST_PARTS).optional().describe('How many parts to split it into; 1 by default.'),
        minutes: z.number().int().min(1).max(TEST_MINUTES_MAX).optional().describe(`The time limit of each part, ${TEST_MINUTES} minutes by default.`),
      },
    },
    async input => answer(() => startRun(ctx, job, input)),
  );
  server.registerTool(
    'test_run',
    { description: "How a test run goes: its state, and each part's state, machine, commit, exit code, log file and, for a failed one, the end of its log.", inputSchema: { run: Run } },
    async ({ run }) => answer(async () => JSON.stringify(await runState(ctx, job, run))),
  );
  server.registerTool(
    'stop_tests',
    { description: 'Stops a test run: every part of it that waits or runs. Whoever started it hears of it when that was someone else.', inputSchema: { run: Run } },
    async ({ run }) => answer(() => stopRun(ctx, job, run)),
  );
}
