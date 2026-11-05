/* Test-only fixture. It loads the exact source under test and serves its built UI and real API on one origin. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

const source = resolve(process.env.HH_GEOMETRY_SOURCE_ROOT ?? '');
const want = process.env.HH_GEOMETRY_SOURCE_SHA ?? '';
assert.match(want, /^[a-f0-9]{40}$/, 'NOT_RUN: supply the exact source40SHA from the approved resource handoff');
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
assert.equal(actual, want, 'Source checkout differs from the pinned geometry input');
assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'apps/web/src', 'apps/server/src', 'packages/protocol/src'], { cwd: source, encoding: 'utf8' }).trim(), '', 'The source under test has local product changes');
const moduleAt = path => import(pathToFileURL(join(source, path)).href);
const { buildApp } = await moduleAt('apps/server/src/app.ts');
const { loadConfig } = await moduleAt('apps/server/src/config.ts');
const { applyMissingMigrations, MIGRATIONS } = await moduleAt('apps/server/src/db/client.ts');
const { setupCode } = await moduleAt('apps/server/src/modules/setup/code.ts');
const schema = await moduleAt('apps/server/src/db/schema.ts');
const { LANGUAGES } = await moduleAt('apps/web/src/i18n/index.tsx');
const webDist = join(source, 'apps/web/dist');
assert.ok(existsSync(join(webDist, 'index.html')), 'NOT_RUN: build the pinned source UI before starting its real server');

/* The same small fixture data go through real setup/notebook routes in each source and engine. No external plan or job. */
const author = 'Geometry Test Person With A Long Legal Name To Exercise The Real Notebook';
const note = 'https://example.test/' + 'unbroken_identifier_'.repeat(13);
const secret = randomBytes(32).toString('base64');
const client = new PGlite();
const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: MIGRATIONS });
await applyMissingMigrations(db, { migrationsFolder: MIGRATIONS });
const config = loadConfig({ HORNHOOF_SECRET: secret, UPDATE_CHECK_MS: '0', WEB_DIST: webDist });
const app = await buildApp({ db, config });
const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: {
  code: setupCode(Buffer.from(secret, 'base64')), companyName: 'Geometry Test Company',
  name: author, email: 'geometry@example.test', password: 'geometry fixture only', orchestrator: { mode: 'later' },
} });
assert.equal(setup.statusCode, 201, 'Real setup must succeed: ' + setup.body);
const session = setup.cookies.find(c => c.name === 'hh_session')?.value;
assert.ok(session, 'Real setup must issue its session');
const added = await app.inject({ method: 'POST', url: '/api/notebook', cookies: { hh_session: session }, payload: { text: note } });
assert.equal(added.statusCode, 201, 'Real notebook seed must succeed: ' + added.body);
const number = added.json().note.number;

const locales = [];
for (const language of LANGUAGES) {
  const imported = await moduleAt(`apps/web/src/i18n/${language.id}.ts`);
  const t = imported[language.id] ?? imported.default;
  assert.ok(t, 'Registered locale has no matching dictionary export: ' + language.id);
  const labels = {
    openOrchestrator: t.map.openOrchestrator, title: t.notebook.title, intro: t.notebook.intro,
    newNote: t.notebook.newNote, placeholder: t.notebook.placeholder, add: t.notebook.add,
    note: t.notebook.note(number), change: t.notebook.change, changeNote: t.notebook.changeNote(number),
    remove: t.notebook.remove, removeNote: t.notebook.removeNote(number), save: t.notebook.save, cancel: t.notebook.cancel,
    empty: t.notebook.empty, close: t.window.close, full: t.window.fullScreen, restore: t.window.restoreSize,
    minimize: t.window.minimize, notebook: t.window.notebook,
  };
  assert.ok(Object.values(labels).every(x => typeof x === 'string'), 'All rendered geometry labels must be real dictionary strings');
  const intl = new Intl.Locale(language.id);
  const direction = intl.getTextInfo?.().direction ?? intl.textInfo?.direction;
  assert.ok(direction === 'ltr' || direction === 'rtl', 'Registered locale direction is unavailable: ' + language.id);
  locales.push({ id: language.id, direction, score: Object.values(labels).reduce((n, text) => n + [...text].length, 0), labels });
}
locales.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
const selected = [...new Set([locales[0].id, locales.at(-1).id, ...locales.filter(x => x.direction === 'rtl').slice(0, 1).map(x => x.id)])];
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
process.stdout.write('HH_GEOMETRY_BOOT ' + JSON.stringify({ origin, session, sourceSha: actual, author, note, number, locales, selected,
  dictionaryKeys: Object.keys(locales[0].labels), scoreUnit: 'Unicode code points in the actual strings of these two regression flows',
  shippedRtl: locales.some(x => x.direction === 'rtl'), lockfileBytes: readFileSync(join(source, 'package-lock.json')).length }) + '\n');
let stopping;
const stop = () => { stopping ??= app.close().then(() => client.close()).then(() => process.exit(0)); };
process.stdin.resume();
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
