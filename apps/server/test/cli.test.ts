import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { runCli } from '../src/cli.js';
import { companies, people, themes } from '../src/db/schema.js';
import { as, SETUP, setUpCompany, testApp } from './helpers.js';
import { archiveOf, plainTheme } from './theme-fixture.js';

const NEW_PASSWORD = 'a brand new password';

async function cli(args: string[], deps: Omit<Parameters<typeof runCli>[1], 'print'>) {
  const lines: string[] = [];
  const code = await runCli(args, { ...deps, print: line => lines.push(line) });
  return { code, out: lines.join('\n') };
}

describe('cli', () => {
  it('owner-link prints a one-time link that lets the owner set a new password', async () => {
    const { app, db, config } = await testApp({ PUBLIC_URL: 'https://hq.acme.com' });
    await setUpCompany(app);
    const res = await cli(['owner-link'], { db, config });
    expect(res.code).toBe(0);
    const token = res.out.match(/https:\/\/hq\.acme\.com\/invite\/([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeDefined();
    expect(res.out).toContain('7 days');

    const opened = await app.inject({ url: `/api/invites/${token}` });
    expect(opened.json()).toMatchObject({ name: 'Ivan', email: 'ivan@acme.com' });
    const accepted = await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: NEW_PASSWORD } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().person).toMatchObject({ isOwner: true, status: 'active' });

    const login = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ivan@acme.com', password } });
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login(SETUP.password)).statusCode).toBe(401);
  });

  it('setup-link prints the link that sets a fresh Hornhoof up, and only until it is set up', async () => {
    const { app, db, config } = await testApp({ PUBLIC_URL: 'https://hq.acme.com' });
    const res = await cli(['setup-link'], { db, config });
    expect(res.code).toBe(0);
    expect(res.out).toBe(`https://hq.acme.com/setup?code=${SETUP.code}`);
    await setUpCompany(app);
    const after = await cli(['setup-link'], { db, config });
    expect(after.code).toBe(1);
    expect(after.out).toBe('Hornhoof is set up already.');
  });

  it('owner-link explains that a fresh Hornhoof has no owner yet', async () => {
    const { db, config } = await testApp();
    const res = await cli(['owner-link'], { db, config });
    expect(res.code).toBe(1);
    expect(res.out).toContain('not set up yet');
  });

  it('lists the commands for an unknown one', async () => {
    const { db, config } = await testApp();
    const res = await cli(['dance'], { db, config });
    expect(res.code).toBe(1);
    expect(res.out).toContain('owner-link');
  });
});

describe('cli theme-install', () => {
  /* An archive on disk, as the orchestrator would be handed one, and the log of what the command did. */
  async function onDisk(zip: Buffer) {
    const folder = await mkdtemp(join(tmpdir(), 'hh-theme-cli-'));
    onTestFinished(() => rm(folder, { recursive: true, force: true }));
    const archive = join(folder, 'night-shift.zip');
    await writeFile(archive, zip);
    const log = join(folder, 'installs.log');
    const lines = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    return { archive, log, lines, sha256: createHash('sha256').update(zip).digest('hex') };
  }

  it('installs an archive for the one company it names, by the same check, and logs each attempt', async () => {
    const { app, db, config } = await testApp();
    const ceo = await setUpCompany(app);
    const [acme] = await db.select({ id: companies.id }).from(companies);
    /* Another company with an owner of its own, as only a test makes one. */
    const [other] = await db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    await db.insert(people).values({ companyId: other!.id, name: 'Olga', email: 'olga@other.test', status: 'active', scopeKind: 'company', isOwner: true });
    const file = await onDisk(archiveOf(await plainTheme()));
    const at = new Date('2026-11-23T15:00:00Z');

    const installed = await cli(['theme-install', file.archive, '--company', other!.id, '--log', file.log], { db, config, now: () => at });
    expect(installed.code).toBe(0);
    expect((await app.inject({ url: '/api/themes', ...as(ceo) })).json().themes).toEqual([]);
    expect(await db.select({ companyId: themes.companyId, themeId: themes.themeId }).from(themes)).toEqual([{ companyId: other!.id, themeId: 'night-shift' }]);

    expect((await cli(['theme-install', file.archive, '--company', acme!.id, '--log', file.log], { db, config, now: () => at })).code).toBe(0);
    expect((await app.inject({ url: '/api/themes', ...as(ceo) })).json().themes).toMatchObject([{ id: 'night-shift', version: '1.0.0' }]);
    /* The same version again is refused, as an upload of it is. */
    const again = await cli(['theme-install', file.archive, '--company', acme!.id, '--log', file.log], { db, config, now: () => at });
    expect(again.code).toBe(1);
    expect(again.out).toContain('"same_version"');
    expect(await file.lines()).toEqual([
      expect.objectContaining({ at: at.toISOString(), companyId: other!.id, archive: file.archive, sha256: file.sha256, result: 'installed', theme: 'night-shift', version: '1.0.0' }),
      expect.objectContaining({ companyId: acme!.id, sha256: file.sha256, result: 'installed' }),
      expect.objectContaining({ companyId: acme!.id, result: 'refused', problem: { code: 'same_version', path: 'theme.json' } }),
    ]);
  });

  it('refuses an archive its check refuses, a company that is not there and a call that names none, installing nothing', async () => {
    const { app, db, config } = await testApp();
    await setUpCompany(app);
    const [acme] = await db.select({ id: companies.id }).from(companies);
    const file = await onDisk(archiveOf({ ...(await plainTheme()), 'ui/kit/run.js': 'alert(1)' }));
    const refused = await cli(['theme-install', file.archive, '--company', acme!.id, '--log', file.log], { db, config });
    expect(refused.code).toBe(1);
    const missing = await cli(['theme-install', file.archive, '--company', randomUUID(), '--log', file.log], { db, config });
    expect(missing.code).toBe(1);
    /* An archive that is not there is logged as an attempt too. */
    const gone = await cli(['theme-install', `${file.archive}.gone`, '--company', acme!.id, '--log', file.log], { db, config });
    expect(gone.code).toBe(1);
    expect(await file.lines()).toEqual([
      expect.objectContaining({ companyId: acme!.id, sha256: file.sha256, result: 'refused', problem: { code: 'file_script', path: 'ui/kit/run.js' } }),
      expect.objectContaining({ result: 'refused', reason: 'There is no such company.' }),
      expect.objectContaining({ companyId: acme!.id, archive: `${file.archive}.gone`, result: 'refused', reason: 'The archive cannot be read: ENOENT.' }),
    ]);
    /* With no company named it does nothing and writes nothing: it says how it is called. */
    const unnamed = await cli(['theme-install', file.archive, '--log', file.log], { db, config });
    expect([unnamed.code, unnamed.out]).toEqual([1, expect.stringContaining('theme-install <archive.zip> --company <company id>')]);
    expect(await file.lines()).toHaveLength(3);
    expect(await db.select().from(themes)).toEqual([]);
  });
});
