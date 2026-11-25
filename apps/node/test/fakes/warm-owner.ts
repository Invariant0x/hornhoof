/* Another node on the machine, for the warm-services tests (#2091): it takes a piece for a run, says its name, and waits
   until it is killed, as a node killed in the middle of a run would. */
import { WarmServices } from '../../src/warm-services.js';

const [root, cwd] = process.argv.slice(2);
const warm = new WarmServices({ root: root!, user: null, sweepMs: 0 });
const piece = await warm.pieceFor(cwd!, ['node', '/repo/node_modules/vitest/vitest.mjs', 'run'], 'lease-other', new AbortController().signal);
process.stdout.write(`${piece!.env.FAKE_PIECE}\n`);
setInterval(() => {}, 1000);
