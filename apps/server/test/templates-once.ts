import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import { copyTemplates, loadTemplates, type StageRoute, type Templates } from '../src/modules/templates/load.js';

/* Reading, checking and assembling the role and skill templates took every server a test builds a few milliseconds, the
   same work each time. A test file reads the repository's templates once and gives each server a copy of its own, so what
   one test changes in them the next does not see. A server on a folder a test names reads it itself, as a test may change
   the files there. */
const OWN = fileURLToPath(new URL('../../../templates', import.meta.url));
let read: Templates | undefined;
let loads = 0;

export const templateLoads = (): number => loads;

function shipped(): Templates {
  if (!read) {
    read = loadTemplates(OWN);
    loads += 1;
  }
  return read;
}

/* A file may read them while it is collected, as it may prepare its database, so that its first scenario does not spend
   its deadline on a cold read. */
export function prepareTemplates(): void {
  shipped();
}

export function templatesFor(config: Pick<Config, 'templatesDir'>): Templates | undefined {
  return config.templatesDir === OWN ? copyTemplates(shipped()) : undefined;
}

/* The stages of Development, for a test that makes the route of a task by hand. */
export const developmentStages = (): StageRoute => shipped().stagesOf('development');
