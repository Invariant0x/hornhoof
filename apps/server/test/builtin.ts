import { ownBuiltin } from '../src/modules/nodes/hub.js';

/* The built-in node of a test's server, which runs under no machine id unless the test gives it one. */
export const BUILTIN = ownBuiltin({ machineId: null });
