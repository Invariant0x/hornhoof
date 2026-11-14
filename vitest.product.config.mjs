import { fileURLToPath, URL } from 'node:url';
import base from './vitest.config.mjs';
import PlannedVitestSequencer from './apps/server/test/planned-vitest-sequencer.ts';
import { vitestWorkers } from './scripts/test/vitest-workers.mjs';

const postgresRoot = fileURLToPath(new URL('./apps/server/', import.meta.url));

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
        extends: fileURLToPath(new URL('./apps/server/vitest.postgres.config.ts', import.meta.url)), root: postgresRoot,
        test: {
          name: '@hornhoof/server:postgres', pool: 'forks',
          alias: base.test.projects.find(project => project.test.name === '@hornhoof/server').test.alias,
          setupFiles: [fileURLToPath(new URL('./scripts/test/workspace-cwd.mjs', import.meta.url))],
          provide: { workspaceRoot: postgresRoot },
        },
      },
    ],
  },
};
