import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LIVE_CHECK_REFUSALS } from '@hornhoof/protocol/live-check';
import { liveCheckGate } from './modules/updates/live-check.js';

/* The release workflow's door: exit 0 only for the live check of this exact build. See guide/updates.md.
   live-check-gate --commit SHA [--tag TAG] [--proof FILE] [--image IMAGE] [--registry URL] [--outputs FILE]
   With a yes, --outputs adds to FILE the digests it judged, as app=, node= and updater= lines. */
const { values } = parseArgs({ options: { commit: { type: 'string' }, tag: { type: 'string' }, proof: { type: 'string' }, image: { type: 'string', default: 'ghcr.io/invariant0x/hornhoof' }, registry: { type: 'string' }, outputs: { type: 'string' } } });
if (!values.commit) throw new Error('Name the commit with --commit.');
const verdict = await liveCheckGate({ commit: values.commit, tag: values.tag, proof: values.proof ? JSON.parse(readFileSync(values.proof, 'utf8')) as unknown : undefined, image: values.image, base: values.registry });
if (verdict.ok) {
  if (values.outputs) appendFileSync(values.outputs, Object.entries(verdict.images).map(([name, digest]) => `${name}=${digest}\n`).join(''));
  process.stdout.write(`The live check speaks of exactly ${values.tag ?? values.commit}.\n`);
} else {
  process.stderr.write(`${LIVE_CHECK_REFUSALS[verdict.reason]} (${verdict.reason})\n`);
  process.exitCode = 1;
}
