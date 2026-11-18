import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_KEYS } from '@hornhoof/protocol';
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
    expect(roles).toHaveLength(64);
    expect(skills).toHaveLength(188);
    expect(templates.roles.has('DEV-GEN')).toBe(false);
    expect(skills.length).toBeGreaterThanOrEqual(40);
    for (const s of skills) expect(s.hash).toMatch(/^[0-9a-f]{12}$/);
    for (const r of roles) expect(r.hash).toMatch(/^[0-9a-f]{12}$/);
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
