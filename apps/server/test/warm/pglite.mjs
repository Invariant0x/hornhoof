#!/usr/bin/env node
/* The pieces of the machine's PGlite template for the server's tests (#2091), as .hornhoof/warm-services.json declares it.
   The template is only files, built once for each digest (pglite-build.ts), and every run reads them in place: a run's piece
   is the path to them, so there is nothing to make or drop for one run, and none to list. A build pruned since the node
   built it is built again here. Run from apps/server: pglite.mjs create|drop|list STATE [DIGEST PIECE]. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const [what, state, digest] = process.argv.slice(2);
const builds = join(state ?? '', 'pglite');

switch (what) {
  case 'create': {
    const output = join(builds, digest ?? '');
    if (!existsSync(join(output, 'READY.json'))) {
      execFileSync(process.execPath, ['--import', 'tsx', 'test/warm/pglite-build.ts', builds, digest ?? ''], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
    process.stdout.write(`HH_PGLITE_TEMPLATE=${output}\n`);
    break;
  }
  case 'drop':
  case 'list':
    break;
  default:
    throw new Error('Usage: pglite.mjs create|drop|list STATE [DIGEST PIECE]');
}
