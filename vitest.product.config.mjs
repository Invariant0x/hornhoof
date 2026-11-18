import { availableParallelism, freemem, loadavg } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { namedWorkers, partShare, vitestWorkers } from './apps/node/src/vitest-workers.ts';
import PlannedVitestSequencer from './apps/server/test/planned-vitest-sequencer.ts';
import base from './vitest.config.mjs';

const serverRoot = fileURLToPath(new URL('./apps/server/', import.meta.url));
const serverAlias = base.test.projects.find(project => project.test.name === '@hornhoof/server').test.alias;
const cwdSetup = fileURLToPath(new URL('./scripts/test/workspace-cwd.mjs', import.meta.url));

/* Explicit product execution keeps ordinary manual configs independent of HH_TEST_FILES and --shard. */
export default {
  ...base,
  test: {
    ...base.test,
    /* The count the machine or the node that runs the part names, else as many workers as a part's share of this machine takes,
       so a part does not run one per core into swap. */
    maxWorkers: namedWorkers(process.env) ?? vitestWorkers(partShare({ cpus: availableParallelism(), load: loadavg()[0], memFree: process.availableMemory?.() ?? freemem() })),
    sequence: { sequencer: PlannedVitestSequencer },
    projects: [
      ...base.test.projects,
      {
        extends: fileURLToPath(new URL('./apps/server/vitest.postgres.config.ts', import.meta.url)), root: serverRoot,
        test: { name: '@hornhoof/server:postgres', pool: 'forks', alias: serverAlias, setupFiles: [cwdSetup], provide: { workspaceRoot: serverRoot } },
      },
      /* Only the final and full runs of a release candidate take these: the list of every change's tests has no project of them. */
      {
        extends: fileURLToPath(new URL('./apps/server/vitest.slow.config.ts', import.meta.url)), root: serverRoot,
        test: { name: '@hornhoof/server:slow', pool: 'forks', alias: serverAlias, setupFiles: [cwdSetup], provide: { workspaceRoot: serverRoot } },
      },
    ],
  },
};
