import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_KEYS } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

const DIR = fileURLToPath(new URL('../../../templates', import.meta.url));
const templates = loadTemplates(DIR);

/* A copy of the templates with the route of one department written anew. */
function withRoute(key: string, stages: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hornhoof-route-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(DIR, dir, { recursive: true });
  writeFileSync(join(dir, 'echelons', `${key}.md`), `---\ndepartment: ${key}\nstages:\n${stages}\n---\n`);
  return dir;
}

describe('the route of every department template', () => {
  it('loads one default and two to five complete alternatives for every department', () => {
    for (const department of TEMPLATE_KEYS) {
      const catalog = templates.catalogs?.get(department);
      expect(catalog, department).toBeDefined();
      expect(catalog!.pipelines.length).toBeGreaterThanOrEqual(3);
      expect(catalog!.pipelines.length).toBeLessThanOrEqual(6);
      expect(catalog!.pipelines.filter(p => p.key === catalog!.default)).toHaveLength(1);
      for (const pipeline of catalog!.pipelines) {
        expect(pipeline.why).not.toBe('');
        expect(pipeline.stages.length).toBeGreaterThan(1);
        for (const stage of pipeline.stages) expect(templates.roles.get(stage.ownerRole)?.department).toBe(department);
      }
    }
  });

  it('lists exactly the available pipelines and their uses in the orchestrator skill', () => {
    const body = templates.skills.get('orch-pipelines')?.body ?? '';
    const entries = [...body.matchAll(/^- `([a-z-]+)` (.+)$/gm)].map(([, key, line]) => [key, line]);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.sort()).toEqual([...templates.catalogs.values()].flatMap(catalog => catalog.pipelines.map(p => [p.key, `${p.name}. ${p.why}`])).sort());
  });

  it('keeps the stages of Development and the skill of each of its checks', () => {
    expect(templates.stagesOf('development').stages.map(({ stage, ability }) => ({ stage, ability }))).toEqual([
      { stage: 'architecture', ability: null }, { stage: 'development', ability: null }, { stage: 'review', ability: 'dev-review-diff' },
      { stage: 'cleanup', ability: 'dev-cleanup' }, { stage: 'security', ability: 'dev-security-review' }, { stage: 'tests', ability: 'dev-test-environment' },
    ]);
  });

  it('declares stock one-shot stages only for independent drafting, research and checks', () => {
    expect(Object.fromEntries(TEMPLATE_KEYS.map(key => [key, templates.stagesOf(key).stages.flatMap(({ stage, oneShot }) =>
      oneShot ? [{ stage, fanOut: oneShot.fanOut, judge: oneShot.judge !== null }] : [],
    )]))).toEqual({
      operations: [{ stage: 'review', fanOut: 3, judge: true }],
      development: [{ stage: 'review', fanOut: 3, judge: true }, { stage: 'security', fanOut: 3, judge: true }],
      marketing: [{ stage: 'development', fanOut: 5, judge: true }, { stage: 'review', fanOut: 3, judge: true }],
      sales: [{ stage: 'review', fanOut: 3, judge: true }],
      business_development: [{ stage: 'development', fanOut: 5, judge: false }],
      design: [{ stage: 'development', fanOut: 3, judge: true }],
      support: [{ stage: 'review', fanOut: 3, judge: true }],
      finance: [{ stage: 'review', fanOut: 3, judge: true }],
      home_devices: [],
      household: [],
    });
  });

  it.each(['hh-task-flow', 'hh-check-work', 'dev-review-diff', 'dev-security-review'])('points stage owners to one-shot briefing and how to use the judge in %s', id => {
    const calls = templates.skills.get('hh-one-shot-calls')!;
    const guidance = templates.skills.get(id)!.body.split('\n\n').find(part => part.includes(`the ability "${calls.title.en}"`));
    expect(guidance).toMatch(/one-shot.*brief.*judge/);
  });

  it('gives every department a route of its own, each with the work stage', () => {
    for (const key of TEMPLATE_KEYS) {
      expect(templates.echelons.get(key)?.department, key).toBe(key);
      expect(templates.stagesOf(key).stages.map(step => step.stage), key).toContain('development');
    }
  });

  it('has an employee of the default roster who carries the skill of every check, where the route has a check', () => {
    for (const key of TEMPLATE_KEYS) {
      for (const { stage, ability } of templates.stagesOf(key).stages) {
        if (!ability || stage === 'cleanup') continue;
        const carriers = templates.roster(key).filter(role => role.kind === 'member' && role.inDefault && role.skills.some(skill => skill.id === ability && skill.on));
        expect(carriers.map(role => role.id), `${key} ${stage}`).not.toEqual([]);
      }
    }
  });

  it('gives a member of a turnkey team the skill of every check of its department, as it does them alone', () => {
    for (const team of [...templates.teams.values()].filter(t => t.turnkey)) {
      for (const { role } of team.members) {
        const carried = new Set([...templates.roles.get(role)!.skills.filter(skill => skill.on).map(skill => skill.id), ...team.skills]);
        for (const { stage, ability } of templates.stagesOf(team.department).stages) {
          if (ability && stage !== 'cleanup') expect([...carried], `${team.id} ${role} ${stage}`).toContain(ability);
        }
      }
    }
  });

  it('gives the turnkey team of Development the skills of every echelon: plan, review, security, tests and release', () => {
    expect(templates.teams.get('DEV-TEAM')!.skills).toEqual([
      'dev-plan-review', 'dev-api-design', 'dev-review-diff', 'dev-review-fix', 'dev-review-verdict', 'dev-security-review', 'dev-security-fix',
      'dev-threat-model', 'dev-test-gaps', 'dev-e2e-tests', 'dev-test-environment', 'dev-ci-release', 'dev-release-notes',
    ]);
  });

  it('tells every member how a document is handed in, and every head how a result that passed its stages is accepted', () => {
    expect(templates.skills.get('hh-task-flow')!.body).toMatch(/task\.echelons says document[\s\S]*hh-attach[\s\S]*name no commit/);
    expect(templates.skills.get('hh-lead-tasks')!.body).toMatch(/stages of your department's route[\s\S]*reaches you once they passed[\s\S]*a document[\s\S]*"report" done true/);
    expect(templates.skills.get('orch-company')!.body).toMatch(/every department's work goes through the stages of that department's own route[^.]*hands in a document in place of a commit/);
  });

  it('tells every member to push each commit and branch at once, and leaves the main branch and the layout to the head', () => {
    expect(templates.skills.get('hh-task-flow')!.body).toMatch(/Push every commit and every branch[^.]*as soon as[^.]*only on your machine[^.]*merges nothing into the main branch/);
    expect(templates.skills.get('hh-head')!.body).toMatch(/push every branch at once[^.]*pushed branches go into the main branch[^.]*how the repository is laid out, you decide/);
  });

  it('marks a stage one-shot: how many calls run it at once, and the brief of the judge that reads their answers', () => {
    const marked = '  - { stage: development }\n  - { stage: review, ability: hh-check-work, oneShot: { fanOut: 3, judge: "Keep only the findings that are real." } }';
    expect(loadTemplates(withRoute('marketing', marked)).stagesOf('marketing').stages).toEqual([
      { stage: 'development', ability: null },
      { stage: 'review', ability: 'hh-check-work', oneShot: { fanOut: 3, judge: 'Keep only the findings that are real.' } },
    ]);
    expect(loadTemplates(withRoute('marketing', '  - { stage: development, oneShot: { fanOut: 2 } }')).stagesOf('marketing').stages).toEqual([{ stage: 'development', ability: null, oneShot: { fanOut: 2, judge: null } }]);
    expect(() => loadTemplates(withRoute('marketing', '  - { stage: development, oneShot: { fanOut: 0 } }'))).toThrow(/marketing\.md/);
    expect(() => loadTemplates(withRoute('marketing', '  - { stage: development, oneShot: { judge: "Pick one." } }'))).toThrow(/marketing\.md/);
  });

  it('takes a department made from no template through the route of Development', () => {
    expect(templates.stagesOf(null)).toBe(templates.stagesOf('development'));
  });

  it('refuses stages out of their order, a check with no skill, and a skill that does not exist', () => {
    expect(() => loadTemplates(withRoute('marketing', '  - { stage: review, ability: hh-check-work }\n  - { stage: development }'))).toThrow(/marketing\.md: stages go in the order/);
    expect(() => loadTemplates(withRoute('marketing', '  - { stage: development }\n  - { stage: review }'))).toThrow(/marketing\.md: review needs the ability of its checker/);
    expect(() => loadTemplates(withRoute('marketing', '  - { stage: development, ability: hh-check-work }'))).toThrow(/marketing\.md: development takes no ability/);
    expect(() => loadTemplates(withRoute('marketing', '  - { stage: development }\n  - { stage: review, ability: mkt-none }'))).toThrow(/names the skill mkt-none/);
    expect(() => loadTemplates(withRoute('marketing', '  - { stage: review, ability: hh-check-work }'))).toThrow(/a route needs the development stage/);
  });
});
