import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEMPLATE_KEYS } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { copyTemplates, loadTemplates } from '../src/modules/templates/load.js';
import { TEST_SECRET, testApp } from './helpers.js';
import { templateLoads } from './templates-once.js';

/* Every server a test builds reads the role and skill templates, so a file reads them once (templates-once.ts). */
describe('the templates of the servers a test file builds', () => {
  it('are read once for the whole file', async () => {
    await testApp();
    await testApp();
    expect(templateLoads()).toBe(1);
  });

  it('are those a server reads itself', async () => {
    const { app, config } = await testApp();
    const own = loadTemplates(config.templatesDir);
    expect(app.ctx.templates.roles).toEqual(own.roles);
    expect(app.ctx.templates.skills).toEqual(own.skills);
    for (const key of TEMPLATE_KEYS) expect(app.ctx.templates.roster(key)).toEqual(own.roster(key));
  });

  it('are a copy of its own for each server, so what one test changes the next does not see', async () => {
    const { app: first } = await testApp();
    const role = first.ctx.templates.roles.get('DEV-BE');
    first.ctx.templates.roles.delete('DEV-BE');
    first.ctx.templates.skills.get('hh-tasks')!.title.en = 'Changed';
    const { app: second } = await testApp();
    expect(second.ctx.templates.roles.get('DEV-BE')).toEqual(role);
    expect(second.ctx.templates.skills.get('hh-tasks')!.title.en).not.toBe('Changed');
  });

  it('come from the folder a test names, read by the server itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornhoof-templates-once-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    cpSync(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).templatesDir, dir, { recursive: true });
    const file = join(dir, 'roles/development/DEV-BE.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/^effort:.*\n/m, ''));
    const { app } = await testApp({ TEMPLATES_DIR: dir });
    expect(app.ctx.templates.roles.get('DEV-BE')!.effort).toBeUndefined();
  });
});

describe('a server', () => {
  it('works with the templates it is given', async () => {
    const config = loadConfig({ HORNHOOF_SECRET: TEST_SECRET });
    const templates = copyTemplates(loadTemplates(config.templatesDir));
    const app = await buildApp({ db: null as never, config, templates });
    onTestFinished(() => app.close());
    expect(app.ctx.templates).toBe(templates);
  });
});
