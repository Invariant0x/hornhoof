import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { geometryServer } from './geometry-fixture.ts';

/* Real HTTP/server and build-artifact contracts only; this file never imports or launches a browser. */
const source = process.cwd();
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const worker = fileURLToPath(new URL('./geometry-server.mjs', import.meta.url));
const oldRoot = process.env.HH_GEOMETRY_SOURCE_ROOT, oldSha = process.env.HH_GEOMETRY_SOURCE_SHA;
process.env.HH_GEOMETRY_SOURCE_ROOT = source; process.env.HH_GEOMETRY_SOURCE_SHA = sha;
after(() => {
  if (oldRoot === undefined) delete process.env.HH_GEOMETRY_SOURCE_ROOT; else process.env.HH_GEOMETRY_SOURCE_ROOT = oldRoot;
  if (oldSha === undefined) delete process.env.HH_GEOMETRY_SOURCE_SHA; else process.env.HH_GEOMETRY_SOURCE_SHA = oldSha;
});

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('real fixture binds API data, actual source dictionaries and built fonts to its pinned source', { timeout: 60000 }, async t => {
  const fixture = await geometryServer();
  t.after(() => fixture.stop());
  assert.equal(fixture.sourceSha, sha);
  const health = await fetch(fixture.origin + '/api/health'); assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const html = await fetch(fixture.origin + '/'); assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(await html.text(), /<html/);
  const response = await fetch(fixture.origin + '/api/notebook', { headers: { cookie: 'hh_session=' + fixture.session } });
  assert.equal(response.status, 200);
  const { notes } = await response.json();
  assert.equal(notes.length, 1); assert.equal(notes[0].number, fixture.number);
  assert.equal(notes[0].text, fixture.note); assert.equal(notes[0].by.name, fixture.author);
  assert.ok(fixture.note.length <= 300 && fixture.author.length <= 80, 'stress content must stay within real API limits');
  assert.ok(fixture.department, 'real fixture must include the isolated department notebook seed');
  assert.equal(fixture.dataSha256, digest(JSON.stringify({ author: fixture.author, note: fixture.note,
    department: { name: fixture.department.name, note: fixture.department.note } })));
  assert.ok(Array.isArray(fixture.fontAssets) && fixture.fontAssets.length > 0, 'report actual built font files');
  for (const font of fixture.fontAssets) {
    assert.match(font.name, /^[a-zA-Z0-9_.-]+\.woff2?$/);
    const bytes = readFileSync(join(source, 'apps/web/dist/assets', font.name));
    assert.equal(font.sha256, digest(bytes)); assert.equal(font.bytes, bytes.length);
  }
  assert.equal(fixture.fontsSha256, digest(JSON.stringify(fixture.fontAssets)));
  assert.equal(fixture.localeKeys.intro, 'notebook.intro');
  assert.equal(fixture.localeKeys.note, 'notebook.note');
  assert.deepEqual(fixture.localeArguments.note, [fixture.number]);
  assert.ok(fixture.locales.length > 0);
  const sorted = [...fixture.locales].sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  assert.ok(fixture.selected.includes(sorted[0].id)); assert.ok(fixture.selected.includes(sorted.at(-1).id));
  for (const locale of fixture.locales) {
    assert.equal(locale.score, Object.values(locale.labels).reduce((sum, text) => sum + [...text].length, 0));
    assert.equal(typeof locale.labels.intro, 'string');
  }
  assert.equal('runtimeReady' in fixture, false);
  console.log('HH_GEOMETRY_FIXTURE ' + JSON.stringify({ sourceSha: fixture.sourceSha, dataSha256: fixture.dataSha256,
    fontsSha256: fixture.fontsSha256, fontAssets: fixture.fontAssets.length, localeKeys: fixture.localeKeys,
    localeArguments: fixture.localeArguments, rankings: fixture.locales.map(({ id, direction, score }) => ({ id, direction, score })),
    selected: fixture.selected, shippedRtl: fixture.shippedRtl, liveBrowsers: false }));
});

test('real department fixture keeps its notebook separate through read, write, change and removal', { timeout: 60000 }, async t => {
  const fixture = await geometryServer();
  t.after(() => fixture.stop());
  assert.ok(fixture.department, 'real fixture must include the isolated department notebook seed');
  const department = fixture.department;
  assert.match(department.id, /^[a-f0-9-]{36}$/);
  assert.ok(department.name.length > 0 && department.name.length <= 60);
  assert.ok(department.note.length > 0 && department.note.length <= 300);
  assert.notEqual(department.note, fixture.note, 'the two real notebooks must be distinguishable');
  const headers = { cookie: 'hh_session=' + fixture.session }, jsonHeaders = { ...headers, 'content-type': 'application/json' };
  const base = fixture.origin + `/api/departments/${department.id}/notebook`;
  const read = async url => { const response = await fetch(url, { headers }); assert.equal(response.status, 200); return (await response.json()).notes; };
  const companyBefore = await read(fixture.origin + '/api/notebook');
  assert.deepEqual((await read(base)).map(n => [n.number, n.text, n.by.name]), [[department.number, department.note, fixture.author]]);
  const added = await fetch(base, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ text: 'Department fixture temporary note' }) });
  assert.equal(added.status, 201);
  const next = (await added.json()).note.number;
  assert.notEqual(next, department.number);
  const changed = await fetch(base + '/' + next, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ text: 'Department fixture changed note' }) });
  assert.equal(changed.status, 200);
  assert.equal((await read(base)).find(n => n.number === next).text, 'Department fixture changed note');
  const removed = await fetch(base + '/' + next, { method: 'DELETE', headers });
  assert.equal(removed.status, 204, await removed.text());
  assert.deepEqual((await read(base)).map(n => [n.number, n.text]), [[department.number, department.note]]);
  assert.deepEqual(await read(fixture.origin + '/api/notebook'), companyBefore);
  console.log('HH_GEOMETRY_DEPARTMENT_FIXTURE ' + JSON.stringify({ sourceSha: fixture.sourceSha,
    dataSha256: fixture.dataSha256, companyNotes: companyBefore.length, departmentNotes: 1, liveBrowsers: false }));
});

test('rejects a mismatched immutable source before listening', { timeout: 15000 }, () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', worker], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HH_GEOMETRY_SOURCE_SHA: '0'.repeat(40) } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Source checkout differs from the pinned geometry input/);
  assert.ok(!result.stdout.includes('HH_GEOMETRY_BOOT'));
});

test('rejects missing UI build artifacts before creating a company', { timeout: 15000 }, () => {
  const original = join(source, 'apps/web/dist'), moved = join(source, 'apps/web/dist.geometry-precondition');
  renameSync(original, moved);
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', worker], { encoding: 'utf8', timeout: 10000, env: process.env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /build the pinned source UI before starting its real server/);
    assert.ok(!result.stdout.includes('HH_GEOMETRY_BOOT'));
  } finally { renameSync(moved, original); }
});
