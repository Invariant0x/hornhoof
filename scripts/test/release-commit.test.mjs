import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beyondVersionAndNotes } from '../github-tests/release-commit.mjs';

/* Files as npm and release:version write them. */
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const bump = (value, version) => ({ ...value, version });

const ROOT = { name: 'shop', version: '0.5.0', workspaces: ['packages/*'], scripts: { test: 'node --test' } };
const CART = { name: '@shop/cart', version: '0.5.0', dependencies: { 'left-pad': '^1.3.0' } };
const PAD = { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: 'sha512-pad' };
function lock({ root = '0.5.0', top = root, cart = '0.5.0', pad = PAD, cartEntry = CART } = {}) {
  return {
    name: 'shop',
    version: top,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'shop', version: root, workspaces: ['packages/*'] },
      'node_modules/@shop/cart': { resolved: 'packages/cart', link: true },
      'node_modules/left-pad': pad,
      'packages/cart': bump(cartEntry, cart),
      /* A package of the repository with a version of its own, which a release leaves as it was. */
      'packages/tools': { name: '@shop/tools', version: '1.0.0' },
    },
  };
}

const NOTES_BEFORE = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A cart keeps its items.\n';
const NOTES_AFTER = '# Changelog\n\n## [Unreleased]\n\n## [0.6.0] - 2026-11-18\n\n### Fixed\n\n- A cart keeps its items.\n';
const change = (before, after) => ({ before: typeof before === 'string' ? before : json(before), after: typeof after === 'string' ? after : json(after) });

/* What `npm run release:version -- turn 6` writes, with the notes of 0.6.0 under their heading. */
const RELEASE = {
  'CHANGELOG.md': change(NOTES_BEFORE, NOTES_AFTER),
  'package.json': change(ROOT, bump(ROOT, '0.6.0')),
  'packages/cart/package.json': change(CART, bump(CART, '0.6.0')),
  'package-lock.json': change(lock(), lock({ root: '0.6.0', cart: '0.6.0' })),
};

const without = (files, path) => Object.fromEntries(Object.entries(files).filter(([key]) => key !== path));

/* A commit as git names it: each changed path with its status letter, M unless given, and the texts of each. */
function beyond(files, statuses = {}) {
  const changes = Object.keys(files).map(path => ({ status: statuses[path] ?? 'M', path }));
  return beyondVersionAndNotes(changes, path => files[path]);
}

test('a release commit changes nothing but the versions and the notes', () => {
  assert.equal(beyond(RELEASE), null);
});

test('the notes alone, or nothing at all, are nothing more either', () => {
  assert.equal(beyond({ 'CHANGELOG.md': RELEASE['CHANGELOG.md'] }), null);
  assert.equal(beyond({}), null);
});

test('reads no file before every path is one of a release', () => {
  const changes = [{ status: 'M', path: 'package.json' }, { status: 'M', path: 'packages/cart/index.js' }];
  assert.match(beyondVersionAndNotes(changes, () => assert.fail('read a file')), /packages\/cart\/index\.js/);
});

test('one more changed line in a source file is more', () => {
  assert.match(beyond({ ...RELEASE, 'packages/cart/index.js': change('export const cart = [];\n', 'export const cart = [1];\n') }), /packages\/cart\/index\.js/);
});

test('one more changed line in a package.json is more', () => {
  const scripts = { ...bump(ROOT, '0.6.0'), scripts: { test: 'node --test --test-concurrency=1' } };
  assert.match(beyond({ ...RELEASE, 'package.json': change(ROOT, scripts) }), /^package\.json /);
});

test('a dependency bump in package.json is more, with its lock or without', () => {
  const bumped = { ...bump(CART, '0.6.0'), dependencies: { 'left-pad': '^1.3.1' } };
  const lockBumped = lock({ root: '0.6.0', cart: '0.6.0', cartEntry: bumped, pad: { ...PAD, version: '1.3.1' } });
  assert.match(beyond({ ...RELEASE, 'packages/cart/package.json': change(CART, bumped) }), /packages\/cart\/package\.json/);
  assert.match(beyond({ ...RELEASE, 'packages/cart/package.json': change(CART, bumped), 'package-lock.json': change(lock(), lockBumped) }), /package\.json/);
});

test('a dependency that moves only in the lock is more, though its line is a version line', () => {
  const moved = lock({ root: '0.6.0', cart: '0.6.0', pad: { ...PAD, version: '1.3.1' } });
  assert.match(beyond({ ...RELEASE, 'package-lock.json': change(lock(), moved) }), /package-lock\.json/);
});

test("the lock moves a package's version only with its package.json, and to the same version", () => {
  assert.match(beyond(without(RELEASE, 'packages/cart/package.json')), /packages\/cart/);
  assert.match(beyond({ ...RELEASE, 'package-lock.json': change(lock(), lock({ root: '0.6.0', cart: '0.6.1' })) }), /packages\/cart/);
  assert.match(beyond(without(RELEASE, 'package.json')), /root/);
  assert.match(beyond({ ...RELEASE, 'package-lock.json': change(lock(), lock({ root: '0.6.0', top: '0.6.1', cart: '0.6.0' })) }), /package-lock\.json/);
  const topAlone = { ...without(RELEASE, 'package.json'), 'package-lock.json': change(lock(), lock({ top: '0.6.0', cart: '0.6.0' })) };
  assert.match(beyond(topAlone), /package-lock\.json changes its own version/);
});

test('a package.json version without the lock is more', () => {
  assert.match(beyond(without(RELEASE, 'package-lock.json')), /package-lock\.json/);
});

test('a package.json the lock names as no package of the repository is more', () => {
  const fixture = { name: 'fixture', version: '1.0.0' };
  assert.match(beyond({ ...RELEASE, 'apps/server/test/fixtures/pkg/package.json': change(fixture, bump(fixture, '1.0.1')) }), /apps\/server\/test\/fixtures\/pkg\/package\.json/);
  assert.match(beyond({ ...RELEASE, 'node_modules/left-pad/package.json': change(PAD, bump(PAD, '1.3.1')) }), /node_modules\/left-pad\/package\.json/);
});

test('a reformatted file is more, though its JSON reads the same', () => {
  const fourSpaces = `${JSON.stringify(bump(ROOT, '0.6.0'), null, 4)}\n`;
  assert.match(beyond({ ...RELEASE, 'package.json': change(json(ROOT), fourSpaces) }), /^package\.json /);
  const tight = json(bump(ROOT, '0.6.0')).replace('"version": "0.6.0"', '"version":"0.6.0"');
  assert.match(beyond({ ...RELEASE, 'package.json': change(json(ROOT), tight) }), /^package\.json /);
  const trailing = `${json(bump(ROOT, '0.6.0'))}\n`;
  assert.match(beyond({ ...RELEASE, 'package.json': change(json(ROOT), trailing) }), /^package\.json /);
});

test('a version line that is not JSON of an object is more', () => {
  assert.match(beyond({ ...RELEASE, 'package.json': change('"version": "0.5.0"\n', '"version": "0.6.0"\n') }), /^package\.json /);
  assert.match(beyond({ ...RELEASE, 'package.json': change('[]\n', '[]\n') }), /^package\.json /);
});

test('a lock with no packages, or no JSON object at all, is more', () => {
  const bare = version => json({ name: 'shop', version, lockfileVersion: 3 });
  assert.match(beyond({ ...RELEASE, 'package-lock.json': change(bare('0.5.0'), bare('0.6.0')) }), /package-lock\.json/);
  const notJson = change('"version": "0.5.0"\n', '"version": "0.6.0"\n');
  assert.match(beyond({ ...RELEASE, 'package-lock.json': notJson }), /^package\.json is no package of the repository in package-lock\.json/);
  assert.match(beyond({ 'package-lock.json': notJson }), /^package-lock\.json is not a lockfile/);
});

test('a notes file or package.json added, deleted or turned into another kind of file is more', () => {
  for (const [status, what] of [['A', 'added'], ['D', 'deleted'], ['T', 'turned into another kind of file']]) {
    assert.equal(beyond(RELEASE, { 'CHANGELOG.md': status }), `CHANGELOG.md is ${what}`);
    assert.equal(beyond(RELEASE, { 'packages/cart/package.json': status }), `packages/cart/package.json is ${what}`);
  }
});

test("a lockfile other than the repository's own is more", () => {
  assert.match(beyond({ ...RELEASE, 'packages/cart/package-lock.json': change(lock(), lock({ root: '0.6.0', cart: '0.6.0' })) }), /packages\/cart\/package-lock\.json/);
});
