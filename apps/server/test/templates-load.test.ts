import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { say, TEMPLATE_KEYS } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { copyTemplates, loadTemplates } from '../src/modules/templates/load.js';

/* How the role and skill templates are read and copied, apart from what they say: templates.test.ts and
   templates-policy.test.ts check their words. */
const DIR = fileURLToPath(new URL('../../../templates', import.meta.url));
const templates = loadTemplates(DIR);
const roles = [...templates.roles.values()];
const skills = [...templates.skills.values()];

describe('the template loader', () => {
  it('loads every role and skill', () => {
    expect(roles).toHaveLength(75);
    expect(skills).toHaveLength(191);
    expect(templates.roles.has('DEV-GEN')).toBe(false);
    expect(skills.length).toBeGreaterThanOrEqual(40);
    for (const s of skills) expect(s.hash).toMatch(/^[0-9a-f]{12}$/);
    for (const r of roles) expect(r.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  describe('the words of the templates, a locale file per language', () => {
    const copy = () => {
      const dir = mkdtempSync(join(tmpdir(), 'hornhoof-locales-'));
      onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
      cpSync(DIR, dir, { recursive: true });
      return dir;
    };

    it('read every role, skill and team in English and in each other language that has a file', () => {
      for (const item of [...roles, ...skills, ...templates.teams.values()]) {
        expect(item.title.en, item.id).toBeTruthy();
        expect(item.title.ru, item.id).toBeTruthy();
        expect(Object.keys(item.title).sort(), item.id).toEqual(Object.keys(item.description).sort());
      }
    });

    it('take a language from a file named by its id and nothing in the code, a text it lacks reading as English', () => {
      const dir = copy();
      const registry = readFileSync(join(dir, 'locales/ru.yaml'), 'utf8');
      expect(registry).toMatch(/^roles:/m);
      rmSync(join(dir, 'locales/ru.yaml'));
      const loaded = loadTemplates(dir);
      expect(loaded.roles.get('DEV-HEAD')!.title).toEqual({ en: templates.roles.get('DEV-HEAD')!.title.en });
      expect(say(loaded.roles.get('DEV-HEAD')!.title, 'ru')).toBe(templates.roles.get('DEV-HEAD')!.title.en);
    });

    it('refuse a file of a language the registry does not list', () => {
      const dir = copy();
      writeFileSync(join(dir, 'locales/xx.yaml'), 'roles: {}\n');
      expect(() => loadTemplates(dir)).toThrow(/xx\.yaml is a language the registry/);
    });

    it('refuse a template with no English words, as every language falls back to them', () => {
      const dir = copy();
      const file = join(dir, 'locales/en.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/ {2}DEV-HEAD:\n {4}title: .*\n {4}description: .*\n/, ''));
      expect(() => loadTemplates(dir)).toThrow(/DEV-HEAD has no en name and description/);
    });

    it('refuse words for a template that does not exist', () => {
      const dir = copy();
      const file = join(dir, 'locales/ru.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/^roles:\n/m, 'roles:\n  DEV-GONE:\n    title: "x"\n    description: "y"\n'));
      expect(() => loadTemplates(dir)).toThrow(/words for the role DEV-GONE, which does not exist/);
    });

    it('refuse a text the language file leaves empty', () => {
      const dir = copy();
      const file = join(dir, 'locales/ru.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/(DEV-HEAD:\n {4}title: )".*"/, '$1""'));
      expect(() => loadTemplates(dir)).toThrow(/ru\.yaml: roles\.DEV-HEAD\.title/);
    });
  });

  it('rejects an unknown role effort and allows a role to omit it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hornhoof-effort-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    cpSync(DIR, dir, { recursive: true });
    const file = join(dir, 'roles/development/DEV-BE.md');
    const original = readFileSync(file, 'utf8').replace(/^effort:.*\n/m, '');
    writeFileSync(file, original.replace('tier:', 'effort: extreme\ntier:'));
    expect(() => loadTemplates(dir)).toThrow(/DEV-BE\.md: effort/);
    writeFileSync(file, original);
    expect(loadTemplates(dir).roles.get('DEV-BE')!.effort).toBeUndefined();
  });

  it('copies into templates with the same roles, skills and rosters', () => {
    const copy = copyTemplates(templates);
    expect(copy.roles).toEqual(templates.roles);
    expect(copy.skills).toEqual(templates.skills);
    for (const key of TEMPLATE_KEYS) expect(copy.roster(key)).toEqual(templates.roster(key));
  });

  it('copies into templates that change apart from the ones they came from', () => {
    const copy = copyTemplates(templates);
    copy.roles.set('DEV-BE', { ...copy.roles.get('DEV-BE')!, effort: undefined });
    copy.skills.get('hh-tasks')!.title.en = 'Changed';
    expect(templates.roles.get('DEV-BE')!.effort).toBe('xhigh');
    expect(templates.skills.get('hh-tasks')!.title.en).not.toBe('Changed');
  });

  it('copies into templates whose rosters list the roles the copy holds now, in the order of the templates', () => {
    const copy = copyTemplates(templates);
    const [head, ...members] = templates.roster('development');
    copy.roles.set(head!.id, { ...copy.roles.get(head!.id)!, kind: 'member', inDefault: false });
    const inDefault = members.filter(role => role.inDefault).map(role => role.id);
    expect(copy.roster('development').map(role => role.id).slice(0, inDefault.length)).toEqual(inDefault);
    expect(copy.roster('development')).toContain(copy.roles.get(head!.id));
    expect(templates.roster('development')[0]).toBe(head);
  });
});
