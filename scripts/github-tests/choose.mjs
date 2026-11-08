import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fastSuites, isWholeSuite, selectTests } from '../author-check/select.mjs';
import { selectionPorts } from '../author-check/wired.mjs';
import { trackedIn } from '../test/tracked-files.mjs';
import { planOf } from './parts.mjs';

const MANIFEST = '.hornhoof/test-environment.json';

/* The tests a change since a passed commit reaches, chosen as an author's check chooses them: .hornhoof/author-check.md. It
   needs the protocol and the node built, and the dependencies to read the import graph with. */
export async function chooseTests(base, changes, root) {
  const { parseTestEnvironment } = await import('@hornhoof/protocol');
  const manifest = parseTestEnvironment(readFileSync(join(root, MANIFEST), 'utf8'));
  const suites = fastSuites(manifest), since = base.slice(0, 12);
  const selection = await selectTests({ changes, manifest, tracked: trackedIn(root), allowWhole: false }, await selectionPorts(root));
  /* A selection that cannot tell, or takes every suite whole, leaves the whole suite to run as it always has. */
  const whole = selection.unavailable ?? (isWholeSuite(selection.packages, suites) ? 'every suite whole' : null);
  if (whole) return { plan: null, notes: selection.notes, why: `The change since ${since} takes the whole suite: ${whole}.` };
  const plan = planOf(base, changes, selection, suites);
  const files = plan.parts.flatMap(part => Object.values(part)).flat().length, parts = plan.parts.length;
  return { plan, notes: selection.notes, why: `The change since ${since} reaches ${files} test ${files === 1 ? 'file' : 'files'}, run in ${parts} ${parts === 1 ? 'part' : 'parts'}.` };
}
