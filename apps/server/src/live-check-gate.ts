import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LIVE_CHECK_REFUSALS } from '@hornhoof/protocol/live-check';
import { LIVE_CHECK_UNREAD, liveCheckGate } from './modules/updates/live-check.js';

/* The release workflow's door: exit 0 only for the live check of this exact build. See guide/updates.md.
   live-check-gate --commit SHA [--tag TAG] [--proof FILE] [--image IMAGE] [--registry URL] [--outputs FILE] [--skip-missing]
   With a yes, --outputs adds to FILE the digests it judged, as app=, node= and updater= lines. Without one, the last line it
   writes is its answer in plain words with its reason in brackets, which install.sh shows as it is.
   --skip-missing is how the Images workflow looks before it publishes: a build with no live check at all, not yet published or
   never built, is nothing to publish rather than a failure, so it exits 0 for that no too, and --outputs adds found=false, or
   found=true after the digests of a yes. Every other no still fails. */
const { values } = parseArgs({ options: { commit: { type: 'string' }, tag: { type: 'string' }, proof: { type: 'string' }, image: { type: 'string', default: 'ghcr.io/invariant0x/hornhoof' }, registry: { type: 'string' }, outputs: { type: 'string' }, 'skip-missing': { type: 'boolean', default: false } } });
if (!values.commit) throw new Error('Name the commit with --commit.');
const skipping = values['skip-missing'];
const verdict = await liveCheckGate({ commit: values.commit, tag: values.tag, proof: values.proof ? JSON.parse(readFileSync(values.proof, 'utf8')) as unknown : undefined, image: values.image, base: values.registry }).catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  return null;
});
const output = (lines: string[]) => {
  if (values.outputs) appendFileSync(values.outputs, lines.map(line => `${line}\n`).join(''));
};
if (!verdict) {
  process.stderr.write(`${LIVE_CHECK_UNREAD} (unread)\n`);
  process.exitCode = 1;
} else if (verdict.ok) {
  output([...Object.entries(verdict.images).map(([name, digest]) => `${name}=${digest}`), ...(skipping ? ['found=true'] : [])]);
  process.stdout.write(`The live check speaks of exactly ${values.tag ?? values.commit}.\n`);
} else if (verdict.reason === 'missing' && skipping) {
  output(['found=false']);
  process.stdout.write(`${LIVE_CHECK_REFUSALS.missing} Nothing is published.\n`);
} else {
  process.stderr.write(`${LIVE_CHECK_REFUSALS[verdict.reason]} (${verdict.reason})\n`);
  process.exitCode = 1;
}
