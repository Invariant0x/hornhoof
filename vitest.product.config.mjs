import { fileURLToPath, URL } from 'node:url';
import base from './vitest.config.mjs';
import PlannedVitestSequencer from './apps/server/test/planned-vitest-sequencer.ts';
import { vitestWorkers } from './scripts/test/vitest-workers.mjs';

const serverRoot = fileURLToPath(new URL('./apps/server/', import.meta.url));
const serverAlias = base.test.projects.find(project => project.test.name === '@hornhoof/server').test.alias;
const cwdSetup = fileURLToPath(new URL('./scripts/test/workspace-cwd.mjs', import.meta.url));

/* Explicit product execution keeps ordinary manual configs independent of HH_TEST_FILES and --shard. */
export default {
  ...base,
  test: {
    ...base.test,
    /* As many workers as the machine's free memory holds, so a part does not run one per core into swap. */
    maxWorkers: vitestWorkers(),
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
