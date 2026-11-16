import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanProjects, project } from './project.mjs';

afterEach(cleanProjects);

test('extracts exactly the requested release, its list under Fixed, Added and Changed', () => {
  const p = project();
  const want = '## [0.5.0] - 2026-11-04\n\n### Fixed\n\n- Preserve a cart.\n\n### Changed\n\n- Before you update: back up first.\n';
  writeFileSync(join(p.root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\nNext work.\n\n' + want + '\n## [0.4.0] - 2026-10-01\nOld work.\n');
  const result = p.run('release-notes.mjs', '0.5.0');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, want);
});

test('gives a GitHub release no notes in another language', () => {
  const p = project();
  writeFileSync(join(p.root, 'CHANGELOG.md'), '## [0.5.0] - 2026-11-04\n\n### Fixed\n\n- Preserve a cart.\n\n### Russian\n\n- Корзина сохраняется.\n');
  const result = p.run('release-notes.mjs', '0.5.0');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CHANGELOG\.md notes for 0\.5\.0 may only have ### Fixed, ### Added and ### Changed, not "### Russian"/);
  assert.equal(result.stdout, '');
});

test('defaults to the root version', () => {
  const p = project();
  const result = p.run('release-notes.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^## \[0\.5\.0\]/);
});

test('a malformed older heading cannot fill empty notes with another release', () => {
  const p = project();
  writeFileSync(join(p.root, 'CHANGELOG.md'), '## [0.5.0] - 2026-11-04\n\n### Fixed\n\n## [0.4.0] - 2026-10-3\nOld notes.\n');
  const result = p.run('release-notes.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CHANGELOG\.md.*heading/);
  assert.equal(result.stdout, '');
});

for (const text of ['# Changelog\n', '## [0.5.0] - 2026-11-04\n\n### Fixed\n', '## [0.5.0]\nMissing date.\n']) {
  test(`rejects absent or empty dated notes: ${JSON.stringify(text)}`, () => {
    const p = project();
    writeFileSync(join(p.root, 'CHANGELOG.md'), text);
    const result = p.run('release-notes.mjs');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CHANGELOG\.md/);
    assert.equal(result.stdout, '');
  });
}
