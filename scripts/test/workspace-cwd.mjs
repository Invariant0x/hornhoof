import { inject } from 'vitest';

/* Every test worker is a fork. Relative fixture reads keep the same cwd as a standalone workspace run. */
const folder = inject('workspaceRoot');
if (typeof folder !== 'string') throw new Error('The root test project must provide its workspace directory.');
process.chdir(folder);
