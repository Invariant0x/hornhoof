import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API_MODELS, CLAUDE_ALIASES, modelsFor, PROVIDER_IDS, ROLE_EFFORTS, type ProviderId } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { turnEffort } from '../src/modules/conversation/turn-effort.js';
import { loadTemplates, type Role } from '../src/modules/templates/load.js';
import { runsTier } from '../src/modules/tools/staff.js';

const GUIDE = fileURLToPath(new URL('../../../guide/departments-and-employees.md', import.meta.url));
const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const LEVELS = [...ROLE_EFFORTS];
const PROGRAMS: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi Code', glm: 'GLM', antigravity: 'Antigravity', anthropic_api: 'Claude API', openai_api: 'OpenAI API' };
const REPORTED = 'what its machine reports';

const table = (head: string[], rows: string[][]) => [head, head.map(() => '---'), ...rows].map(cells => `| ${cells.join(' | ')} |`).join('\n');
const unique = (lists: string[][]) => [...new Set(lists.flat())];

/* What each program can run, from the same lists Hornhoof runs on: the ones a machine reports are not known before it does. */
function programs(): string {
  return table(['Program', 'Models', 'Levels', 'Deep roles'], PROVIDER_IDS.map(id => {
    const models = modelsFor(id, null);
    return [PROGRAMS[id], models.length ? models.map(m => m.name).join(', ') : REPORTED, models.length ? unique(models.map(m => m.efforts ?? [])).join(', ') : REPORTED, runsTier(id, 'deep') ? 'yes' : 'no'];
  }));
}

/* What each stage runs at, from the policy itself. */
function stages(): string {
  const full = [{ why: 'assigned' }, { why: 'review' }, { why: 'turn_review' }, { why: 'changes' }];
  const light = [{ why: 'review', again: true }, { why: 'merge' }, { why: 'changes', mechanical: true }];
  const same = (level: string, wakes: { why: string }[]) => {
    const got = unique(wakes.map(w => [turnEffort(level, LEVELS, [w])!]));
    expect(got).toHaveLength(1);
    return got[0]!;
  };
  return table(['Level of the role or card', 'Plans, first looks, security, work, other fixes', 'Second look, clean merge, mechanical fix'], LEVELS.map(level => [level, same(level, full), same(level, light)]));
}

const byTitle = (a: Role, b: Role) => a.title.en.localeCompare(b.title.en);
const departmentName = (key: string) => key[0]!.toUpperCase() + key.slice(1).replaceAll('_', ' ');

/* Each role's own level, by department. */
function roles(): string {
  const all = [...templates.roles.values()];
  const shown = [...LEVELS].reverse().filter(level => all.some(r => r.effort === level));
  const inDepartment = (key: string) => all.filter(r => r.department === key).sort(byTitle);
  return table(['Department', ...shown], [...new Set(all.map(r => r.department))].sort().map(key => [departmentName(key), ...shown.map(level => inDepartment(key).filter(r => r.effort === level).map(r => r.title.en).join(', ') || '-')]));
}

const deep = () => [...templates.roles.values()].filter(r => r.tier === 'deep').sort(byTitle).map(r => r.title.en).join(', ');

describe('the guide on programs, models and levels', () => {
  const guide = readFileSync(GUIDE, 'utf8');

  it('names every program as Hornhoof runs it', () => {
    expect(guide).toContain(programs());
  });

  it('gives each stage the level the policy gives it', () => {
    expect(guide).toContain(stages());
  });

  it('gives each role the level of its template', () => {
    expect(guide).toContain(roles());
  });

  it('names the roles that need a deep model', () => {
    expect(guide).toContain(`Deep roles: ${deep()}.`);
  });

  it('claims no list for a program whose machine reports its own', () => {
    expect(modelsFor('codex', null)).toEqual([]);
    expect(modelsFor('kimi', null)).toEqual([]);
    expect(modelsFor('antigravity', null)).toEqual([]);
    expect(modelsFor('claude', null)).toBe(CLAUDE_ALIASES);
    expect(modelsFor('openai_api', null)).toBe(API_MODELS.openai_api);
  });
});
