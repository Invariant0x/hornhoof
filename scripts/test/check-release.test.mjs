import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanProjects, project, readJson, writeJson } from './project.mjs';

afterEach(cleanProjects);

test('the first release may equal origin/main when its tag does not exist', () => {
  const p = project();
  const result = p.run('check-release.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0\.5\.0/);
});

test('rejects a workspace version that differs from the root', () => {
  const p = project();
  writeJson(join(p.root, 'apps/web/package.json'), { version: '0.0.0' });
  const result = p.run('check-release.mjs', '--local');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /apps\/web\/package\.json.*0\.0\.0.*0\.5\.0/);
});

for (const text of ['# Changelog\n', '## [0.4.0] - 2026-11-04\nOlder notes.\n', '## [0.5.0] - 2026-11-04\n### Fixed\n']) {
  test(`rejects missing, mismatched or empty release notes: ${JSON.stringify(text)}`, () => {
    const p = project();
    writeFileSync(join(p.root, 'CHANGELOG.md'), text);
    const result = p.run('check-release.mjs');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CHANGELOG|notes/i);
  });
}

/* A release's notes are one short list in English: one-line entries under Fixed, Added and Changed, in that order. */
const HEAD = '## [0.5.0] - 2026-11-04\n\n';
const LIST = `${HEAD}### Fixed\n\n- A checkout issue.\n\n### Added\n\n- Gift cards.\n\n### Changed\n\n- Before you update: back up the database.\n`;

for (const text of [LIST, `${HEAD}### Changed\n\n- Faster search.\n`, `${HEAD}### Fixed\n- A crash.\n- A typo.\n### Added\n- Gift cards.\n`]) {
  test(`passes notes that are one English list: ${JSON.stringify(text)}`, () => {
    const p = project();
    writeFileSync(join(p.root, 'CHANGELOG.md'), `# Changelog\n\n${text}\n## [0.4.0] - 2026-10-01\nOlder notes in any form.\n`);
    const result = p.run('check-release.mjs');
    assert.equal(result.status, 0, result.stderr);
  });
}

for (const [why, text, said] of [
  ['a section in another language', `${LIST}\n### Russian\n\n- Корзина сохраняется.\n`, /notes for 0\.5\.0 may only have ### Fixed, ### Added and ### Changed, not "### Russian"/],
  ['letters of another script in an entry', `${HEAD}### Fixed\n\n- Корзина сохраняется.\n`, /notes for 0\.5\.0 are in English only: "Корзина сохраняется\." has letters of another script/],
  ['a summary above the list', `${HEAD}A release for people.\n\n### Fixed\n\n- A checkout issue.\n`, /are one list with no summary: "A release for people\." stands above ### Fixed/],
  ['an entry wrapped onto a second line', `${HEAD}### Fixed\n\n- A checkout issue that\n  spans two lines.\n`, /give each entry one line starting with "- ": "spans two lines\." is not one/],
  ['Changed before Fixed', `${HEAD}### Changed\n\n- Faster.\n\n### Fixed\n\n- A crash.\n`, /has ### Fixed after ### Changed; the list goes Fixed, Added, Changed, each once/],
  ['the same kind twice', `${HEAD}### Fixed\n\n- A crash.\n\n### Fixed\n\n- A typo.\n`, /has ### Fixed after ### Fixed; the list goes Fixed, Added, Changed, each once/],
  ['a kind with no entries', `${HEAD}### Fixed\n\n### Added\n\n- Gift cards.\n`, /has no entries under ### Fixed/],
  ['a last kind with no entries', `${HEAD}### Fixed\n\n- A crash.\n\n### Changed\n`, /has no entries under ### Changed/],
  ['Before you update as a section of its own', `${HEAD}### Fixed\n\n- A crash.\n\n### Before you update\n\n- Back up first.\n`, /not "### Before you update"/],
]) {
  test(`rejects release notes with ${why}`, () => {
    const p = project();
    writeFileSync(join(p.root, 'CHANGELOG.md'), `# Changelog\n\n${text}`);
    const result = p.run('check-release.mjs');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, said);
  });
}

test('rejects an existing tag even when origin/main still has the same version', () => {
  const p = project();
  p.git('tag', 'v0.5.0');
  const result = p.run('check-release.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /v0\.5\.0.*already/);
});

test('compares numeric components rather than strings', () => {
  const p = project('0.10.0', 'turn-9');
  const data = readJson(join(p.root, 'package.json'));
  writeJson(join(p.root, 'package.json'), { ...data, version: '0.9.0' });
  p.run('release-version.mjs', 'turn');
  writeFileSync(join(p.root, 'CHANGELOG.md'), '## [0.9.0] - 2026-11-04\n### Fixed\n- A release.\n');
  const result = p.run('check-release.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /0\.9\.0.*(?:older|less).*0\.10\.0/);
});

test('a numerically newer turn release passes', () => {
  const p = project('0.9.0', 'turn-10');
  p.run('release-version.mjs', 'turn');
  writeFileSync(join(p.root, 'CHANGELOG.md'), '## [0.10.0] - 2026-11-04\n### Fixed\n- A release.\n');
  const result = p.run('check-release.mjs');
  assert.equal(result.status, 0, result.stderr);
});

test('a lower first digit is older even when its turn is higher', () => {
  const p = project('1.5.0', 'turn-150');
  const data = readJson(join(p.root, 'package.json'));
  writeJson(join(p.root, 'package.json'), { ...data, version: '0.150.0' });
  p.run('release-version.mjs', 'turn');
  writeFileSync(join(p.root, 'CHANGELOG.md'), '## [0.150.0] - 2026-11-04\n### Fixed\n- A release.\n');
  const result = p.run('check-release.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /0\.150\.0.*older.*1\.5\.0/);
});

test('a turn release must match its branch or explicit turn number', () => {
  const p = project('0.5.0', 'turn-7');
  const result = p.run('check-release.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /turn.*5.*7/i);
  assert.equal(p.run('check-release.mjs', '--turn', '5').status, 0);
});

test('an explicit turn supports feature branches; fixes do not need a turn', () => {
  const p = project('0.5.0', 'task-164');
  assert.notEqual(p.run('check-release.mjs').status, 0);
  assert.equal(p.run('check-release.mjs', '--turn', '5').status, 0);
  p.run('release-version.mjs', 'fix');
  writeFileSync(join(p.root, 'CHANGELOG.md'), '## [0.5.1] - 2026-11-04\n### Fixed\n- Three fixes in one release.\n');
  const result = p.run('check-release.mjs');
  assert.equal(result.status, 0, result.stderr);
});

test('local checks permit Unreleased and skip release-only git checks', () => {
  const p = project('0.5.0', 'task-164');
  p.git('tag', 'v0.5.0');
  writeFileSync(join(p.root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\nWork in progress.\n');
  assert.equal(p.run('check-release.mjs', '--local').status, 0);
  const full = p.run('check-release.mjs', '--turn', '5');
  assert.notEqual(full.status, 0);
  assert.match(full.stderr, /CHANGELOG/);
});

test('local checks explain a missing changelog section', () => {
  const p = project();
  writeFileSync(join(p.root, 'CHANGELOG.md'), '# Changelog\n');
  const result = p.run('check-release.mjs', '--local');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CHANGELOG\.md needs a dated section/);
});

test('a missing origin/main is an actionable failure in full mode', () => {
  const p = project();
  p.git('update-ref', '-d', 'refs/remotes/origin/main');
  const result = p.run('check-release.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /origin\/main/);
});

test('a malformed newer heading cannot hide the actual top release', () => {
  const p = project();
  writeFileSync(join(p.root, 'CHANGELOG.md'), '## [0.6.0] - 2026-11-5\nNew notes.\n\n## [0.5.0] - 2026-11-04\nPrevious notes.\n');
  const result = p.run('check-release.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CHANGELOG\.md.*heading/);
});

for (const args of [['--other'], ['--other', '5'], ['--turn'], ['--turn', '05'], ['--turn', '5', 'extra'], ['--local', '--turn', '5']]) {
  test(`rejects check-release arguments ${JSON.stringify(args)}`, () => {
    const p = project();
    const result = p.run('check-release.mjs', ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage|turn number/i);
  });
}
