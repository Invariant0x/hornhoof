import { Branch, MAX_RUN_FILES, MAX_TEST_PARTS, RunFile } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import { EchelonRun } from '../tasks/echelons-run.js';
import { endOwnWait } from '../tasks/external-wait.js';
import { taskByRef } from '../tasks/views.js';
import { refuse } from '../tasks/engine.js';
import type { ToolJob } from '../tools/job.js';
import { queuedRunState } from '../nodes/check-slot-view.js';
import { repoAt } from '../departments/repository.js';
import { harnessState } from './harness.js';
import { FULL_RUN_MINUTES } from './describe.js';
import { startRun, stopRun, taskFor, TEST_MINUTES, TEST_MINUTES_MAX, WORK_MEMORY_GB } from './runs.js';

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
  .describe(`The time limit of each part, ${TEST_MINUTES} minutes by default and ${FULL_RUN_MINUTES} for the full run, which goes out in 2 to 4 parts that each fit in it.`);

/* Whole suites and assigned non-check work use the free machines. Checks of a change stay in its owner's workspace. */
export function registerTestTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'run_tests',
    {
      description:
        "Runs the whole test suite or a declared profile, split into groups over the free machines. It runs only on a release branch of the task's repository: main or the main line the repository names, a turn's branch turn-<number> or a release-<name> branch, any branch of a repository whose results go to its main line straight, and the candidate's branch for a product run bound to a Tests candidate; the server refuses any other with tests_not_release, as a change is checked in its author's own workspace by the test files it reaches. " +
        'Without command, runs the pinned product manifest suite/profile with reusable isolated preparation, splits it over the free machines and collects the result. Without profile a run checks the manifest\'s default profile, which may leave suites out. ' +
        "Where the manifest declares a full run, a test file whose fingerprint (the file, the code it depends on, the environment) already has a green result does not run again and a failed file always does; the profile the full run replaces takes a result only from the repository's main branch or the turn's, or from a commit the main branch holds now. " +
        'The check of a release is a run of the profile the manifest names for its full run (execution.fullRun.profile), with no suite and no candidate: it runs every suite and every test file anew and keeps no earlier result. It starts only once the profile it replaces passed on the same pinned commit, and otherwise ends at once with full_run_early: a release that failed is mended by running that profile again, which runs only what failed or changed. The result says what a run left out. ' +
        "With command, runs the manual whole-suite command and returns at once with the run's number; a command that names a test file the pinned commit does not have is refused before any part goes out. " +
        'Hornhoof pins the commit the branch is at now before any part goes out, and says which: every part checks exactly that commit in a fresh folder, whatever is pushed meanwhile, and a part that checked another one fails the run. ' +
        "The product's harness is ready there before the command starts, so a command needs no installation or build. When every part has ended, however it ended, you are woken on the task, even in a wait_for of yours there, and a wait_for that named this run ends. " +
        `The result says passed or failed, the pinned commit, each part's machine and time, and the last lines of what failed; each part's full log goes on the task as tests-<run>-<part>.log. ` +
        `parts splits a command into up to ${MAX_TEST_PARTS} parts on several machines at once, for a runner that can split: the command says which part with {part} and how many with {parts}, ` +
        'as in --shard={part}/{parts}, and HH_TEST_PART and HH_TEST_PARTS hold them too. ' +
        "A run of the whole product (no suite, with the profile a turn ends with or the full run) sets the GitHub status hornhoof/tests on the pinned commit as it ends, files that kept a green result counting as checked, and so does a run of exactly the command its repository declared as its full test command: GitHub then need not run the tests again.",
      inputSchema: {
        command: z.string().trim().min(1).max(4000).optional().describe('Manual command. Dependencies are in place already; omit it for the pinned product environment.'),
        suite: z.string().min(1).max(64).optional().describe('Product suite ID; omit to run the profile required suites.'),
        profile: z.string().min(1).max(64).optional().describe('Product profile ID; defaults to defaultProfile in the pinned manifest.'),
        task: TaskRef('whose branch it tests'),
        candidate: EchelonRun.optional().describe('At Tests, name the exact current candidateId and route revision. The server binds this run to that assignment and pins its branch and commit.'),
        branch: Branch.optional().describe("The release branch to test: main, turn-<number> or release-<name>. By default the task's own: task-<number>, or the only branch that starts with task-<number>-."),
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
      description: "Ends your own wait_for on a task you hold, when what it waited for is over: when a run's result reached you and the wait did not name that run, say. Nobody is woken; you go on in this turn.",
      inputSchema: { task: z.union([z.number().int().positive(), z.string().max(40)]).describe('The task number, like 12 or "#12", or its id.') },
    },
    async ({ task: ref }) => answer(async () => {
      const task = await taskByRef(ctx, job.companyId, ref);
      if (!task) throw refuse(404, 'task_unknown', `There is no task ${ref} you can act on.`);
      const { reason } = await endOwnWait(ctx, job.agentId, task.id);
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
        "Where the test harness of a product stands: everything a test needs before it starts, which Hornhoof builds once per architecture and keeps ready on all machines. Shows the head of the branch, the last commit that was good, each machine's word, the builds and what is wrong. " +
        'Nobody installs or builds it by hand; a failed update leaves the last good version in use and tries again by itself.',
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
        `the task as work-<run>-<part>-<name>, at most ${MAX_RUN_FILES} files of up to 50 MB per part, and each part's log as work-<run>-<part>.log. When every part has ended, however it ended, you are woken on the task, even in a wait_for of yours there, and a wait_for that named this run ends. You hear of ` +
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
