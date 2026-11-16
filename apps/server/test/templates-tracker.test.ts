import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANY_TEMPLATES, DEPARTMENT_TEMPLATES, TEMPLATE_KEYS } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

/* Every department has a product manager who keeps its goals, pipelines and task texts clear in the tracker. These tests
   read the templates; they show what each product manager is hired with, not what a model does with it. */
const DIR = fileURLToPath(new URL('../../../templates', import.meta.url));
const templates = loadTemplates(DIR);
const managers = (key: (typeof TEMPLATE_KEYS)[number]) => templates.roster(key).filter(role => role.id.endsWith('-PM'));

describe('the product manager of every department', () => {
  it.each([...TEMPLATE_KEYS])('%s has exactly one, a fast default member on a slow timer that skips a company with no open work, with the tracker skill on', key => {
    const code = DEPARTMENT_TEMPLATES.find(d => d.key === key)!.roleCode;
    const found = managers(key);
    expect(found.map(role => role.id)).toEqual([`${code}-PM`]);
    const pm = found[0]!;
    expect(pm).toMatchObject({ department: key, kind: 'member', tier: 'fast', inDefault: true, perProduct: false });
    expect(pm.title).toEqual({ en: 'Product manager', ru: 'Продакт-менеджер' });
    expect(pm.timer?.minutes).toBe(240);
    expect(pm.timer?.forWork).toBe(true);
    expect(pm.skills.find(skill => skill.id === 'hh-keep-tracker')).toMatchObject({ on: true });
  });

  it('stands after the other default members of its department', () => {
    for (const key of TEMPLATE_KEYS) {
      const inDefault = templates.roster(key).filter(role => role.inDefault).map(role => role.id);
      expect(inDefault.at(-1), key).toMatch(/-PM$/);
    }
  });

  it('has the same short body in every department', () => {
    const bodies = new Set(TEMPLATE_KEYS.map(key => managers(key)[0]!.body));
    expect(bodies.size).toBe(1);
  });
});

describe('the skill that keeps the tracker', () => {
  const skill = templates.skills.get('hh-keep-tracker');

  it('grants the tracker tools and nothing else', () => {
    expect(skill?.grants).toEqual(['tracker']);
  });

  it('names the tools it gives and the ones every employee has', () => {
    for (const tool of ['goals', 'set_goal', 'set_pipeline', 'tidy_task', 'tasks', 'task', 'company']) expect(skill?.body, tool).toMatch(new RegExp(`\`${tool}\``));
  });

  it('leaves giving out work to the head', () => {
    expect(skill?.body).toMatch(/ask the head/i);
  });

  it('follows the copy rules: no em dashes, and no "\u0451" in Russian', () => {
    for (const text of [skill!.body, skill!.title.en, skill!.title.ru, skill!.description.en, skill!.description.ru]) expect(text).not.toContain('\u2014');
    for (const text of [skill!.title.ru, skill!.description.ru]) expect(text).not.toMatch(/[\u0451\u0401]/);
  });
});

describe('the sources of the tracker templates', () => {
  const sources = readFileSync(join(DIR, 'SOURCES.md'), 'utf8');

  it('name the skill and every product manager role file', () => {
    expect(sources).toContain('| `skills/hh-keep-tracker.md` |');
    for (const dept of DEPARTMENT_TEMPLATES) expect(sources, dept.key).toContain(`| \`roles/${dept.key}/${dept.roleCode}-PM.md\` |`);
  });
});

describe('the company templates', () => {
  it('hire exactly one product manager into every department', () => {
    for (const template of COMPANY_TEMPLATES) {
      for (const dept of template.departments) {
        const code = DEPARTMENT_TEMPLATES.find(d => d.key === dept.template)!.roleCode;
        expect(dept.staff.filter(line => line.role.endsWith('-PM')), `${template.key}: ${dept.template}`).toEqual([{ role: `${code}-PM`, count: 1 }]);
      }
    }
  });
});
