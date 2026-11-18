import { Branch, MAX_RUN_FILES, MAX_TEST_PARTS, RunFile } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import { endOwnWait } from '../tasks/external-wait.js';
import { taskByRef } from '../tasks/lookup.js';
import { refuse } from '../tasks/state.js';
import type { ToolJob } from '../tools/job.js';
import { queuedRunState } from '../nodes/check-slot-view.js';
import { repoAt } from '../departments/repository.js';
import { harnessState } from './harness.js';
import { FULL_RUN_MINUTES } from './describe.js';
import { startRun, stopRun } from './runs.js';
import { taskFor } from './run-records.js';
import { TEST_MINUTES, TEST_MINUTES_MAX, WORK_MEMORY_GB } from './constants.js';

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
const WorkRun = z.number().int().positive().describe('The work run number run_work gave.');
const TaskRef = (what: string) =>
  z
    .union([z.number().int().positive(), z.string().max(40)])
    .optional()
    .describe(`The task ${what}, by number; by default the one this turn is on.`);
const Parts = z.number().int().min(1).max(MAX_TEST_PARTS).optional().describe('How many parts to split it into; 1 by default.');
const Minutes = z.number().int().min(1).max(TEST_MINUTES_MAX).optional().describe(`The time limit of each part, ${TEST_MINUTES} minutes by default.`);
const TestMinutes = z.number().int().min(1).max(TEST_MINUTES_MAX).optional()
  .describe(`The time limit of each part, ${TEST_MINUTES} minutes by default and ${FULL_RUN_MINUTES} for the first run of a release. A run goes out in as many parts as keep each within three quarters of it by what its files took before, the first run of a release in 2 at least: at once on free machines, one after another on one.`);

/* Whole suites and assigned non-check work use the free machines. Checks of a change stay in its owner's workspace. */
export function registerTestTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'run_tests',
    {
      description:
        'Runs release checks on main, the repository’s configured main line, a turn branch or a release branch. Use selected local tests to check a change during a task. ' +
        'A full release run can reuse passing results from the same release with matching reusable evidence. Without that evidence it runs the selected profile. A whole product run or the exact declared full command can publish hornhoof/tests on the pinned commit. ' +
        `Hornhoof pins the commit the branch is at now, readies the product's harness, and wakes you on the task with the result; with command it runs that command instead, split into up to ${MAX_TEST_PARTS} parts with {part} and {parts} in it.`,
      inputSchema: {
        command: z.string().trim().min(1).max(4000).optional().describe('Manual command. Prepare what it requires. Omit it for the product test environment.'),
        suite: z.string().min(1).max(64).optional().describe('Product suite ID; omit to run every suite of the release.'),
        task: TaskRef('the run is for'),
        branch: Branch.describe('The branch to test: main, the configured main line, turn-<number> or release-<name>.'),
        parts: Parts,
        minutes: TestMinutes,
      },
    },
    async input => answer(() => startRun(ctx, job, input)),
  );
  server.registerTool(
    'test_run',
    { description: "How a test run goes: its state, the commit it pinned (commitSha), and each part's state, machine, the commit it checked, exit code, log file and, for a failed one, the end of its log. A product run that reuses results also says in reuse how many it reused, which test files failed, any mismatch with the kept results and what results came to, as mutation's survivors.", inputSchema: { run: Run } },
    async ({ run }) => answer(async () => JSON.stringify(await queuedRunState(ctx, job, run))),
  );
  server.registerTool(
    'end_wait',
    {
      description: 'Clears your scheduled progress check or an older external wait on a task you hold. Continue in your current turn.',
      inputSchema: { task: z.union([z.number().int().positive(), z.string().max(40)]).describe('The task number, like 12 or "#12", or its id.') },
    },
    async ({ task: ref }) => answer(async () => {
      const task = await taskByRef(ctx, job.companyId, ref);
      if (!task) throw refuse(404, 'task_unknown', `There is no task ${ref} you can act on.`);
      const { reason, work } = await endOwnWait(ctx, job.agentId, task.id);
      if (work) return `Cleared the progress check for "${reason}" on #${task.number}. Go on with the task.`;
      return `The wait for "${reason}" on #${task.number} is over. Go on with the task.`;
    }),
  );
  server.registerTool(
    'stop_tests',
    { description: 'Stops a test run: every part of it that waits or runs. Whoever started it hears of it when that was someone else.', inputSchema: { run: Run } },
    async ({ run }) => answer(() => stopRun(ctx, job, run)),
  );
  server.registerTool(
    'test_harness',
    {
      description:
        'Reports the product test environment, the head of its branch, the last usable commit, which machines have it and the state of its builds. Check the report for missing configuration or preparation.',
      inputSchema: { task: TaskRef('whose product it shows') },
    },
    async input => answer(async () => {
      const task = await taskFor(ctx, job, input.task, 'tests'), found = await repoAt(ctx, [task.productId, task.departmentId]);
      return found ? JSON.stringify(await harnessState(ctx, found.department)) : `#${task.number} has no repository, so it has no test harness.`;
    }),
  );
  server.registerTool(
    'run_work',
    {
      description:
        "Runs any command for a task on whichever machine of the company is free now, not on yours, and returns at once with the run's number: a build, a render, a data job, a long " +
        'check, whatever the task needs done away from your own machine. The command runs in a fresh empty folder, or in a fresh clone of branch when you name one. ' +
        `The task's files you name in files are put in the folder first ($HH_IN holds them; beside a clone it is a folder of its own). Every plain file the command leaves in $HH_OUT goes on ` +
        `the task as work-<run>-<part>-<name>, at most ${MAX_RUN_FILES} files of up to 50 MB per part, and each part's log as work-<run>-<part>.log. When every part has ended, however it ended, you are woken on the task. You hear of ` +
        "it with the result. parts splits it into up to " +
        `${MAX_TEST_PARTS} parts on several machines at once: the command says which part with {part} and how many with {parts}, and HH_PART and HH_PARTS hold them too. ` +
        'A machine whose processors are busy takes no new part. A part whose machine restarts runs again on another one, at most twice. A part whose machine goes offline may ' +
        'still be running there, so it runs again elsewhere only when repeatable is true; otherwise it ends and the result says so.',
      inputSchema: {
        command: z.string().trim().min(1).max(4000).describe('What runs, for example installing what it needs and then the work itself.'),
        task: TaskRef('the work is for'),
        branch: Branch.optional().describe("A branch of the task's repository to clone into the folder first. Left out, the folder starts empty."),
        files: z.array(RunFile).max(MAX_RUN_FILES).optional().describe('Names of files on the task the command takes in.'),
        parts: Parts,
        minutes: Minutes,
        memory: z.number().int().min(1).max(512).optional().describe(`The free memory each part needs, in GB; ${WORK_MEMORY_GB} by default.`),
        repeatable: z
          .boolean()
          .optional()
          .describe(
            'true only when the command may run twice, even two copies at once, without harm: it publishes, deploys, sends, pays or changes nothing outside its folder. ' +
              'false by default: a part whose machine goes offline is then not run again.',
          ),
      },
    },
    async input => answer(() => startRun(ctx, job, input, 'work')),
  );
  server.registerTool(
    'work_run',
    { description: "How a work run goes: its state, and each part's state, machine, exit code, log file, the files it made and, for a failed one, the end of its log.", inputSchema: { run: WorkRun } },
    async ({ run }) => answer(async () => JSON.stringify(await queuedRunState(ctx, job, run, 'work'))),
  );
  server.registerTool(
    'stop_work',
    { description: 'Stops a work run: every part of it that waits or runs. Whoever started it hears of it when that was someone else.', inputSchema: { run: WorkRun } },
    async ({ run }) => answer(() => stopRun(ctx, job, run, 'work')),
  );
}
