import { defineConfig } from 'vitest/config';

// The lab builds images and runs computers with a Docker of their own, so it runs apart from every other test, one
// scenario at a time, and takes as long as that takes on the machine at hand. Its files are named .lab.ts, not
// .test.ts: the list of tests a turn's machines run names every .test.ts of the server, and those machines cannot run
// privileged containers.
export default defineConfig({
  test: {
    include: ['test/lab/**/*.lab.ts'],
    testTimeout: 0,
    hookTimeout: 0,
    fileParallelism: false,
  },
});
