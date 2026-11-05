import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const read = name => readFileSync(fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url)), 'utf8');

/* Each job of a workflow as its text, by name. */
function jobs(workflow) {
  const body = workflow.slice(workflow.indexOf('\njobs:\n'));
  const parts = body.split(/^ {2}(?=[a-z][a-z-]*:$)/m).slice(1);
  return Object.fromEntries(parts.map(part => [part.slice(0, part.indexOf(':')), part]));
}

const images = jobs(read('images.yml'));
const proofs = jobs(read('live-check.yml'));

test('only the publish job can move a tag every machine reads', () => {
  for (const [name, text] of Object.entries(images)) {
    if (name !== 'publish') assert.doesNotMatch(text, /:latest\b|steps\.build\.outputs\.version\)?\s*\|\|.*tags|imagetools/, name);
  }
  assert.match(images.publish, /:latest/);
});

test('the publish job asks the live check before it moves a tag, and looks again after', () => {
  const asked = images.publish.indexOf('live-check-gate.js --commit "$GITHUB_SHA" --outputs');
  const moved = images.publish.indexOf('imagetools create');
  const again = images.publish.indexOf('live-check-gate.js --commit "$GITHUB_SHA" --tag latest');
  assert.ok(asked > 0 && moved > asked && again > moved, `${asked} ${moved} ${again}`);
});

test('the publish job moves exactly the images the gate judged, by digest, and the app image last', () => {
  assert.match(images.publish, /live-check-gate\.js --commit "\$GITHUB_SHA" --outputs "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(images.publish, /:\$GITHUB_SHA"/);
  const moved = ['hornhoof-updater "', 'hornhoof-node "', 'hornhoof "'].map(name => images.publish.indexOf(`move ${name}`));
  assert.ok(moved[0] > 0 && moved[1] > moved[0] && moved[2] > moved[1], moved.join(' '));
});

test('the publish job runs only for a push to main, after the tests', () => {
  assert.match(images.publish, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(images.publish, /needs: test/);
});

test('images are built by hand only, under the tag of their commit alone', () => {
  assert.match(images.images, /if: github\.event_name == 'workflow_dispatch'/);
  assert.match(images.images, /tags: ghcr\.io\/invariant0x\/\$\{\{ matrix\.name \}\}:\$\{\{ github\.sha \}\}\n/);
});

test('a version is released only after its images went out', () => {
  assert.match(images.release, /needs: publish/);
});

test('a proof is published only from main, and only after the same door said yes', () => {
  assert.match(proofs.publish, /if: github\.ref == 'refs\/heads\/main'/);
  const judged = proofs.publish.indexOf('live-check-gate.js --commit');
  const pushed = proofs.publish.indexOf('--push');
  assert.ok(judged > 0 && pushed > judged, `${judged} ${pushed}`);
});

test('the words of a proof never become part of a command', () => {
  assert.match(proofs.publish, /PROOF: \$\{\{ inputs\.proof \}\}/);
  assert.doesNotMatch(proofs.publish.replace(/PROOF: \$\{\{ inputs\.proof \}\}/, ''), /inputs\.proof/);
});

test('the jobs that may write to the registry build code without keeping the checkout token', () => {
  for (const job of [images.publish, proofs.publish]) {
    assert.match(job, /actions\/checkout@[0-9a-f]{40} # v[\d.]+\n\s+with:\n\s+persist-credentials: false\n/);
  }
});
