import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderInstructions } from '../src/modules/agents/instructions.js';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const body = (id: string) => templates.skills.get(id)!.body;
const filesFor = (id: string) => {
  const role = templates.roles.get(id)!;
  return renderInstructions(templates, {
    id: 'a', companyId: 'c', kind: 'worker', name: 'Alex', roleKey: id,
    skills: role.skills.filter(skill => skill.on).map(skill => skill.id), overrides: {}, templateHashes: {},
  } as Parameters<typeof renderInstructions>[1], { company: 'Acme', department: 'Development', product: null }).skills;
};

describe('development check ownership', () => {
  it.each(['DEV-ENG', 'DEV-BE', 'DEV-FE'])('delivers %s its selected implementation method separately from identity', id => {
    const implement = filesFor(id).find(file => file.name === 'dev-implement')!.body;
    expect(implement).toMatch(/failing test/i);
    expect(implement).toMatch(/Run affected checks in your own workspace/);
    expect(implement).toMatch(/submit its exact SHA[\s\S]*observed results and concerns/);
  });

  it.each(['DEV-TEST', 'DEV-QA'])('delivers %s broader checks only for an assigned full validation', id => {
    const policy = filesFor(id).find(file => file.name === 'dev-testing-policy')!.body;
    expect(policy).toMatch(/If assigned full candidate validation/);
    for (const check of ['whole suite', 'browser engines', 'mutation', 'coverage', 'quality measurements', 'live']) expect(policy, check).toContain(check);
    expect(policy).toMatch(/after a fix rerun failed and affected checks/);
  });

  it('makes author verification the same for ordinary and small tasks', () => {
    const implement = body('dev-implement');
    expect(implement).toMatch(/Run affected checks in your own workspace/);
    expect(implement).toMatch(/submit its exact SHA, requirements-to-tests, observed results/);
    expect(implement).not.toMatch(/Finish[^\n]*(formatter|linter|type checker|crapper|dryer)/);
    const selection = body('dev-testing-policy').split('\n').find(line => line.startsWith('- **T2:'))!;
    expect(selection).toMatch(/configured integration branch or an eligible release candidate branch/i);
    expect(selection).not.toMatch(/lint|crapper|dryer/);
    const ordinary = body('dev-testing-policy').split('\n').find(line => line.startsWith('- **T3:'))!;
    expect(ordinary).toContain('affected tests');
    expect(ordinary).toMatch(/ordinary implementation uses its affected tests/);
  });

  it('assigns broader checks through the task and keeps each verification ability self-contained', () => {
    expect(body('dev-gates')).toMatch(/When broader validation is assigned/);
    expect(body('dev-testing-policy')).toMatch(/If assigned full candidate validation/);
    expect(body('dev-work-pipeline')).toMatch(/When a full candidate validation is assigned/);
    expect(body('dev-language-rules')).toContain('run_tests');
    expect(body('dev-review-diff')).not.toMatch(/developer runs them before submitting|one reviewer[^.]*runs mutator/);
    expect(templates.roles.get('DEV-REV')!.body).not.toMatch(/runs mutator/);
  });
});

describe('where change checks run and what proves them', () => {
  it('selects workspace checks and expands to the affected package when needed', () => {
    for (const id of ['hh-run-checks', 'dev-implement']) {
      expect(body(id), id).toMatch(/affected checks|affected tests/i);
      expect(body(id), id).toMatch(/expand(?:ing)? to the affected package/i);
      expect(body(id), id).toMatch(/unproved scope/i);
    }
  });

  it('reads the author\'s description of the local checks they ran and reruns what the reviewer doubts', () => {
    for (const id of ['dev-review-verdict', 'dev-review-diff']) expect(body(id), id).toMatch(/author's description of the local checks they ran[^.]*rerun what you doubt in your own workspace/);
  });
});

describe('who repairs a finding', () => {
  it('repairs work through the assigned owner and preserves independent evidence', () => {
    expect(body('hh-fix-loop')).toMatch(/assigned repair owner[\s\S]*preserve the checked version for independent review/i);
    expect(body('hh-check-work')).toMatch(/independent verdict[\s\S]*preserve the candidate[\s\S]*findings to the repair owner/i);
  });

  it('keeps acceptance findings with the head, never sending the candidate back to its author', () => {
    const acceptance = body('dev-qa-acceptance');
    expect(acceptance).not.toMatch(/as tasks|fast path|verification\.defect|back to its author/);
    expect(acceptance).toMatch(/blocking finding[^.]*"blocked"/);
  });

  it('returns a source defect to Development and leaves test-only fixes with Tests', () => {
    for (const id of ['dev-task-flow', 'dev-gates']) {
      expect(body(id), id).toMatch(/source defect to Development[\s\S]*failing evidence/);
      expect(body(id), id).toMatch(/test-only repairs in Tests/i);
    }
  });

  it('lets Tests take the main line or the turn of its own department into a candidate whose own change passed and check it again there', () => {
    for (const id of ['dev-task-flow', 'dev-gates']) {
      expect(body(id), id).toMatch(/own change passed[^.]*main line or the open turn branch of its own department[^.]*stays at Tests/);
      expect(body(id), id).toMatch(/"submit"[^.]*review\.baseCommit naming the commit (you took|taken) in/);
    }
  });
});

describe('the base a review compares with', () => {
  it.each(['dev-review-diff', 'dev-security-review'])('%s compares the candidate with its own base, not the main line', id => {
    expect(body(id)).not.toMatch(/<main line>/);
    expect(body(id)).toMatch(/task\.review[^.]*`source\.baseCommit`[^.]*`commit`/);
  });
});

describe('turnkey work', () => {
  it('uses the assigned route and keeps its echelons out of the task text', () => {
    expect(body('orch-company')).toMatch(/actual route[\s\S]*other teams use their department's selected route/i);
    expect(body('hh-brief-members')).toMatch(/never write the echelons[^.]*into a task's text/i);
  });

  it('uses a route with an eligible checker when independent proof is required', () => {
    for (const id of ['hh-lead-tasks', 'orch-plan-turn', 'orch-company']) {
      expect(body(id), id).toMatch(/turnkey[\s\S]*independent check|turnkey[\s\S]*independent work/i);
      expect(body(id), id).toMatch(/eligible checker|required independent checker/i);
    }
  });

  it('names no mode of a turn and no tool to plan one', () => {
    for (const id of ['orch-plan-turn', 'orch-company', 'hh-head', 'hh-lead-tasks', 'dev-lead']) expect(body(id), id).not.toMatch(/plan_turn|\bmode\b/);
  });

  it('tells the member of a turnkey team to carry its task end to end alone and close it with report', () => {
    expect(body('dev-task-flow')).toMatch(/turnkey[^.]*end to end alone[^.]*nobody else called onto it[^.]*report done true/);
  });
});
