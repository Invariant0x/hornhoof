import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API_MODELS, CLAUDE_ALIASES, effortFor, isApiProvider, modelsFor, PROVIDER_IDS, ROLE_EFFORTS, type ProviderId } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { loadTemplates, type Role } from '../src/modules/templates/load.js';
import { runsTier } from '../src/modules/tools/staff.js';

const GUIDE = fileURLToPath(new URL('../../../guide/departments-and-employees.md', import.meta.url));
const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const LEVELS = [...ROLE_EFFORTS];
const PROGRAMS: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', kimi: 'Kimi Code', glm: 'GLM', antigravity: 'Antigravity', anthropic_api: 'Claude API', openai_api: 'OpenAI API', openrouter: 'OpenRouter', custom_api: 'Compatible API' };
const REPORTED = 'what its machine reports';
const CONNECTED = 'what its connection names';

const table = (head: string[], rows: string[][]) => [head, head.map(() => '---'), ...rows].map(cells => `| ${cells.join(' | ')} |`).join('\n');
const unique = (lists: string[][]) => [...new Set(lists.flat())];

/* What each program can run, from the same lists Hornhoof runs on: the ones a machine reports are not known before it does,
   and an API connection with no list of Hornhoof's own runs the models the person named for it. */
const reported = (id: ProviderId, names: string[]) => names.join(', ') || (isApiProvider(id) ? CONNECTED : REPORTED);
const levelsOf = (models: { efforts?: string[] }[]) => unique(models.map(m => m.efforts ?? []));
const runsDeep = (id: ProviderId) => (runsTier(id, 'deep') ? 'yes' : 'no');
const programRow = (id: ProviderId) => {
  const models = modelsFor(id, null);
  return [PROGRAMS[id], reported(id, models.map(m => m.name)), reported(id, levelsOf(models)), runsDeep(id)];
};
const programs = () => table(['Program', 'Models', 'Levels', 'Deep roles'], PROVIDER_IDS.map(programRow));

/* Every echelon uses the configured level supported by the selected model. */
function stages(): string {
  return table(['Level of the role or card', 'Every echelon, including repairs'], LEVELS.map(level => [level, effortFor(level, LEVELS, level)!]));
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

/* A title several departments share, as their product manager's, is named once. */
const ofTier = (tier: Role['tier']) => unique([[...templates.roles.values()].filter(r => r.tier === tier).sort(byTitle).map(r => r.title.en)]).join(', ');

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

  it('names the roles that ask for the strongest, a strong and the lightest model', () => {
    expect(guide).toContain(`for work nobody checks after: ${ofTier('top')}.`);
    expect(guide).toContain(`or leads risky work: ${ofTier('deep')}.`);
    expect(guide).toContain(`for simple work that comes in a stream: ${ofTier('fast')}.`);
  });

  it('claims no list for a program whose machine reports its own', () => {
    expect(modelsFor('codex', null)).toEqual([]);
    expect(modelsFor('kimi', null)).toEqual([]);
    expect(modelsFor('antigravity', null)).toEqual([]);
    expect(modelsFor('claude', null)).toBe(CLAUDE_ALIASES);
    expect(modelsFor('openai_api', null)).toBe(API_MODELS.openai_api);
  });
});
