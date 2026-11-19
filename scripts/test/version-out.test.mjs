import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageOf, unknownOf, verdictOf } from '../github-tests/version-out.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const VERSION = '0.34.1';
const PUSH = { event: 'push', sha: SHA, version: VERSION };

test('the published app image of a version goes by its name in the registry', () => {
  assert.equal(imageOf(VERSION), 'ghcr.io/invariant0x/hornhoof:0.34.1');
});

test('a run by hand builds the images of its commit whatever is out', () => {
  for (const facts of [{}, { tag: OTHER, image: OTHER }, { tag: SHA, image: '' }]) {
    assert.deepEqual(verdictOf({ job: 'images', event: 'workflow_dispatch', sha: SHA, version: VERSION, ...facts }), { verdict: 'new', why: 'A run by hand builds the images of its commit under that commit alone.' });
  }
});

test('a tag on another commit stops every job of a push, whatever is published or released', () => {
  for (const job of ['images', 'publish', 'release']) {
    const { verdict, why } = verdictOf({ job, ...PUSH, tag: OTHER, image: null, release: true });
    assert.equal(verdict, 'stop', job);
    assert.match(why, new RegExp(`^The tag v0\\.34\\.1 is on commit ${OTHER}, not on this commit ${SHA}\\. `), job);
  }
});

test('images and publish build and move a version with no published images, with its tag on this commit or none', () => {
  assert.deepEqual(verdictOf({ job: 'images', ...PUSH, tag: SHA, image: null }), { verdict: 'new', why: 'Version 0.34.1 has no published images yet, though its tag v0.34.1 is on this commit, so this push builds them.' });
  assert.deepEqual(verdictOf({ job: 'publish', ...PUSH, tag: null, image: null }), { verdict: 'new', why: 'Version 0.34.1 has no published images yet, so this job moves the version and latest onto the images of this commit.' });
});

test('images and publish leave a version whose published images are those of this commit', () => {
  assert.deepEqual(verdictOf({ job: 'images', ...PUSH, tag: SHA, image: SHA }), { verdict: 'out', why: `Version 0.34.1 is out already: ${imageOf(VERSION)} holds the images of this commit, so this push builds no images.` });
  assert.deepEqual(verdictOf({ job: 'publish', ...PUSH, tag: null, image: SHA }), { verdict: 'out', why: `Version 0.34.1 is out already: ${imageOf(VERSION)} holds the images of this commit, so nothing moves.` });
});

test('images and publish stop at published images of another commit, or of a commit they cannot tell', () => {
  for (const job of ['images', 'publish']) {
    const other = verdictOf({ job, ...PUSH, tag: null, image: OTHER });
    assert.equal(other.verdict, 'stop');
    assert.match(other.why, new RegExp(`^ghcr\\.io/invariant0x/hornhoof:0\\.34\\.1 holds the images of commit ${OTHER}, not of this commit ${SHA}\\. `));
    const unlabeled = verdictOf({ job, ...PUSH, tag: SHA, image: '' });
    assert.equal(unlabeled.verdict, 'stop');
    assert.match(unlabeled.why, /^ghcr\.io\/invariant0x\/hornhoof:0\.34\.1 has no revision label/);
  }
});

test('the release job releases a version with no release, its tag on this commit or none, and leaves a released one', () => {
  assert.deepEqual(verdictOf({ job: 'release', ...PUSH, tag: SHA, release: false }), { verdict: 'new', why: 'The tag v0.34.1 is on this commit and has no release yet, so this job creates its release.' });
  assert.deepEqual(verdictOf({ job: 'release', ...PUSH, tag: null, release: false }), { verdict: 'new', why: 'Version 0.34.1 has no tag yet, so this job tags this commit and creates its release.' });
  assert.deepEqual(verdictOf({ job: 'release', ...PUSH, tag: SHA, release: true }), { verdict: 'out', why: 'v0.34.1 is released already, so this job releases nothing.' });
});

test('the release job goes by the tag and the release alone, not by the images', () => {
  assert.equal(verdictOf({ job: 'release', ...PUSH, tag: SHA, image: OTHER, release: false }).verdict, 'new');
});

test('a lookup that failed is unknown, a third answer beside out and new, and says why the job stops', () => {
  assert.deepEqual(unknownOf(VERSION, 'GitHub could not be reached'), {
    verdict: 'unknown',
    why: 'Could not tell whether version 0.34.1 is out: GitHub could not be reached. This job stops and builds, moves and releases nothing; run it again once that is fixed.',
  });
});

test('no message has an em dash or a dash between words', () => {
  const all = [
    verdictOf({ job: 'images', event: 'workflow_dispatch', sha: SHA, version: VERSION }),
    verdictOf({ job: 'images', ...PUSH, tag: OTHER }),
    verdictOf({ job: 'images', ...PUSH, image: OTHER }),
    verdictOf({ job: 'images', ...PUSH, image: '' }),
    verdictOf({ job: 'publish', ...PUSH, image: SHA }),
    verdictOf({ job: 'release', ...PUSH, release: false }),
    unknownOf(VERSION, 'the registry answered 500 for manifests/0.34.1'),
  ];
  for (const { why } of all) assert.doesNotMatch(why, /[\u2013\u2014]| - /);
});
