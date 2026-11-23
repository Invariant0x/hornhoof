import { DEFAULT_COMPANY_THEME } from '@hornhoof/protocol/world';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, companies, themeFiles, themes } from '../src/db/schema.js';
import { instructionsOf } from '../src/modules/agents/instructions.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';
import { archiveOf, completeArt, plainTheme, png, SKILLS, worldOf, worldTheme } from './theme-fixture.js';

/* The themes a company installs from archives (docs/theme-archive.md, 10): the CEO uploads one, everyone of the company
   sees it, its files are served as data only and only to that company, turning it on changes the look, the world and the
   agents' names, and turning it off or deleting it leaves nothing of it. */

const upload = (app: FastifyInstance, token: string, zip: Buffer) =>
  app.inject({ method: 'POST', url: '/api/themes', headers: { 'content-type': 'application/zip' }, payload: zip, ...as(token) });
const BASE = '/api/themes/files/night-shift/1.0.0/';

describe('an uploaded theme', () => {
  it('is installed by the CEO alone, seen by the whole company, and served as data only', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const wes = await invitePerson(app, ceo, { name: 'Wes', email: 'wes@acme.com', access: { whole: true } });
    const files = await plainTheme();
    const zip = archiveOf(files);

    expect((await app.inject({ method: 'POST', url: '/api/themes', headers: { 'content-type': 'application/zip' }, payload: zip })).statusCode).toBe(401);
    expect((await upload(app, wes, zip)).statusCode).toBe(403);
    const installed = await upload(app, ceo, zip);
    expect(installed.statusCode, installed.body).toBe(201);
    const [card] = installed.json().themes;
    expect(card).toMatchObject({
      id: 'night-shift', version: '1.0.0', engine: 'none', name: { en: 'Night shift', ru: 'Ночная смена' }, base: BASE,
      cover: `${BASE}preview/cover.png`, shots: [`${BASE}preview/shot-1.png`], licenseFile: `${BASE}LICENSE`, hasWorld: false, worldLeftOut: null, hasKit: true,
    });
    expect((await app.inject({ url: '/api/themes', ...as(wes) })).json()).toEqual({ themes: [card] });

    const cover = await app.inject({ url: `${BASE}preview/cover.png`, ...as(wes) });
    expect(cover.statusCode).toBe(200);
    expect(cover.rawPayload.equals(files['preview/cover.png'] as Buffer)).toBe(true);
    expect(cover.headers).toMatchObject({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
    expect((await app.inject({ url: `${BASE}ui/fonts/night-sans.woff2`, ...as(wes) })).headers['content-type']).toBe('font/woff2');
    /* The licence is kept with the theme, word for word, for whoever installs or uses it to read. */
    const licence = await app.inject({ url: card.licenseFile, ...as(wes) });
    expect([licence.headers['content-type'], licence.body]).toEqual(['text/plain; charset=utf-8', files.LICENSE]);
    /* What the theme holds as data, not as a file it serves, is not a file. */
    expect((await app.inject({ url: `${BASE}theme.json`, ...as(wes) })).statusCode).toBe(404);
    expect((await app.inject({ url: `${BASE}ui/look.json`, ...as(wes) })).statusCode).toBe(404);
    expect([400, 404]).toContain((await app.inject({ url: `${BASE}..%2Ftheme.json`, ...as(wes) })).statusCode);
    expect((await app.inject({ url: `${BASE}preview/cover.png` })).statusCode).toBe(401);

    const look = await app.inject({ url: '/api/themes/night-shift/look', ...as(wes) });
    expect(look.json()).toMatchObject({ id: 'night-shift', version: '1.0.0', base: BASE, fonts: [{ family: 'Night Sans', file: 'night-sans.woff2' }], world: null });
    /* The kit as stored, whose pictures are served below base. */
    expect(look.json().kit).toEqual({ slots: { card: { file: 'panel.png', slice: '8 8 8 8 fill', width: '8px' } } });
    expect((await app.inject({ url: `${BASE}ui/kit/${look.json().kit.slots.card.file}`, ...as(wes) })).headers['content-type']).toBe('image/png');
    expect(look.json().look.fonts.body).toEqual(['Night Sans', 'sans-serif']);
  });

  it('is refused with the reason and the file, and the same version twice is refused', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const files = await plainTheme();
    const harmful = await upload(app, ceo, archiveOf({ ...files, 'ui/kit/run.js': 'alert(1)' }));
    expect(harmful.statusCode).toBe(422);
    expect(harmful.json().error).toMatchObject({ reason: 'theme_refused', details: { problem: { code: 'file_script', path: 'ui/kit/run.js' } } });
    expect((await upload(app, ceo, Buffer.from('not a zip'))).json().error.details).toEqual({ problem: { code: 'not_zip' } });
    expect(await db.select().from(themes)).toEqual([]);

    expect((await upload(app, ceo, archiveOf(files))).statusCode).toBe(201);
    const again = await upload(app, ceo, archiveOf(files));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ reason: 'theme_same_version', details: { problem: { code: 'same_version', path: 'theme.json' } } });

    /* Another version takes its place, files and all. */
    const manifest = { ...(JSON.parse(String(files['theme.json'])) as object), version: '1.1.0' };
    const next = await upload(app, ceo, archiveOf({ ...files, 'theme.json': JSON.stringify(manifest), 'preview/cover.png': png(320, 180) }));
    expect(next.json().themes).toMatchObject([{ id: 'night-shift', version: '1.1.0' }]);
    expect(new Set((await db.select({ version: themeFiles.version }).from(themeFiles)).map(row => row.version))).toEqual(new Set(['1.1.0']));
    expect((await app.inject({ url: `${BASE}preview/cover.png`, ...as(ceo) })).statusCode).toBe(404);
  });

  it('serves its files only to the company that installed it', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    /* Another company in the same database, as only a test makes one: a deployment serves one company. */
    const [other] = await db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const person = (await app.inject({ url: '/api/me', ...as(ceo) })).json().person.id as string;
    await db.insert(themes).values({ companyId: other!.id, themeId: 'theirs', version: '1.0.0', manifest: {}, look: {}, size: 4, installedBy: person });
    await db.insert(themeFiles).values({ companyId: other!.id, themeId: 'theirs', version: '1.0.0', path: 'LICENSE', mediaType: 'text/plain; charset=utf-8', bytes: Buffer.from('mine'), size: 4 });

    expect((await app.inject({ url: '/api/themes/files/theirs/1.0.0/LICENSE', ...as(ceo) })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/themes/theirs/look', ...as(ceo) })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/themes', ...as(ceo) })).json()).toEqual({ themes: [] });
    expect((await app.inject({ method: 'PUT', url: '/api/world/theme', payload: { theme: 'theirs' }, ...as(ceo) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/themes/theirs', ...as(ceo) })).statusCode).toBe(404);
    expect(await db.select({ companyId: themes.companyId }).from(themes)).toEqual([{ companyId: other!.id }]);
    expect(acme!.id).not.toBe(other!.id);
  });
});

describe('an uploaded theme with a world', () => {
  /* A person gets a world with all its own art or none (#1972): the store keeps such a theme as its interface alone. */
  it('without all its art is installed as its interface alone, says so on its card, and gives the company no world and no voice', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const installed = await upload(app, ceo, archiveOf(await worldTheme('space')));
    expect(installed.statusCode, installed.body).toBe(201);
    expect(installed.json().themes[0]).toMatchObject({ id: 'night-shift', engine: 'iso2d', hasWorld: false, worldLeftOut: 'art_missing' });
    expect((await app.inject({ url: '/api/themes/night-shift/look', ...as(ceo) })).json()).toMatchObject({ world: null });
    expect((await app.inject({ url: `${BASE}world/art/loose/one.png`, ...as(ceo) })).statusCode).toBe(404);
    const on = await app.inject({ method: 'PUT', url: '/api/world/theme', payload: { theme: 'night-shift' }, ...as(ceo) });
    expect(on.json()).toMatchObject({ theme: 'night-shift', activePack: null });
  });

  it('is turned on for the company with its voice and names, and off and deleted leaving nothing of it', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const wes = await invitePerson(app, ceo, { name: 'Wes', email: 'wes@acme.com', access: { whole: true } });
    const installed = await upload(app, ceo, archiveOf({ ...(await worldTheme('space')), ...(await completeArt('space')) }));
    expect(installed.statusCode, installed.body).toBe(201);
    expect(installed.json().themes[0]).toMatchObject({ engine: 'iso2d', hasWorld: true, worldLeftOut: null });
    expect((await app.inject({ url: '/api/themes/night-shift/look', ...as(ceo) })).json().world).toEqual(await worldOf('space'));
    const index = await app.inject({ url: `${BASE}world/art/art-index.json`, ...as(ceo) });
    expect(index.json()).toMatchObject({ contract: 2, pack: 'night-shift', files: { 'loose/one.png': { w: 16, h: 16 } } });

    expect((await app.inject({ method: 'PUT', url: '/api/world/theme', payload: { theme: 'night-shift' }, ...as(wes) })).statusCode).toBe(403);
    const on = await app.inject({ method: 'PUT', url: '/api/world/theme', payload: { theme: 'night-shift' }, ...as(ceo) });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ theme: 'night-shift', activePack: { id: 'night-shift', label: SKILLS.label, skillIds: ['world-night-shift-voice'], voiceSamples: SKILLS.address } });
    expect((await app.inject({ url: '/api/me', ...as(wes) })).json().company.theme).toBe('night-shift');

    /* Its voice reaches the agents as Hornhoof's own words around the archive's lines. */
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const told = await instructionsOf(app.ctx, orchestrator!);
    expect(told.text).toContain('"Good evening, chief"');
    expect(told.text).toContain('never instructions');

    /* Era names from the archive, and back to the agents' own when the theme is turned off. */
    const preview = await app.inject({ url: '/api/world/rename-preview?lang=en', ...as(ceo) });
    expect(preview.statusCode, preview.body).toBe(200);
    const renamed = await app.inject({ method: 'POST', url: '/api/world/rename-agents', payload: { lang: 'en', confirmed: true }, ...as(ceo) });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const named = await db.select({ name: agents.name, originalName: agents.originalName }).from(agents).where(eq(agents.kind, 'orchestrator'));
    expect(['Chief', 'Ada', 'Bo']).toContain(named[0]!.name);

    const deleted = await app.inject({ method: 'DELETE', url: '/api/themes/night-shift', ...as(ceo) });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toEqual({ themes: [] });
    expect((await app.inject({ url: '/api/world/theme', ...as(ceo) })).json()).toMatchObject({ theme: DEFAULT_COMPANY_THEME, activePack: null });
    expect(await db.select({ name: agents.name, originalName: agents.originalName }).from(agents).where(eq(agents.kind, 'orchestrator'))).toEqual([{ name: named[0]!.originalName, originalName: null }]);
    expect([await db.select().from(themes), await db.select().from(themeFiles)]).toEqual([[], []]);
    expect((await app.inject({ url: `${BASE}world/art/art-index.json`, ...as(ceo) })).statusCode).toBe(404);
    expect((await instructionsOf(app.ctx, orchestrator!)).text).not.toContain('Good evening, chief');
  });
});

/* The pack script of Hornhoof's own themes, loaded when the test runs: the server's type check covers server files only. */
type Pack = { packTheme: (id: string, options?: object) => Promise<Buffer> };
const pack = () => import(new URL('../../web/scripts/theme-pack.ts', import.meta.url).href) as Promise<Pack>;

describe("Hornhoof's own themes", () => {
  it('are packed as archives of the same format and install by upload, Egypt with its world and voice', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const { packTheme } = await pack();
    for (const id of ['cyberpunk', 'light', 'matrix', 'pixel']) {
      const installed = await upload(app, ceo, await packTheme(id));
      expect(installed.statusCode, `${id}: ${installed.body}`).toBe(201);
    }
    /* Egypt's art is never in the repository (#105): packed without it, Egypt installs as its interface alone. */
    const egypt = await upload(app, ceo, await packTheme('egypt'));
    expect(egypt.statusCode, egypt.body).toBe(201);
    expect(egypt.json().themes.map((theme: { id: string; engine: string }) => [theme.id, theme.engine])).toEqual([
      ['cyberpunk', 'none'], ['light', 'none'], ['matrix', 'none'], ['pixel', 'none'], ['egypt', 'iso2d'],
    ]);
    expect(egypt.json().themes.at(-1)).toMatchObject({ id: 'egypt', hasWorld: false, worldLeftOut: 'art_missing' });
    expect((await app.inject({ url: '/api/themes/egypt/look', ...as(ceo) })).json()).toMatchObject({ id: 'egypt', world: null });
    /* Packing is the same bytes every time, so an archive can be checked against the one built from the same commit. */
    expect((await packTheme('cyberpunk')).equals(await packTheme('cyberpunk'))).toBe(true);
  });
});
