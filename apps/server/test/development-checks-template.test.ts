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
    for (const check of ['whole suite', 'browser engines', 'mutation', 'coverage', 'CRAP', 'dryer', 'live']) expect(policy, check).toContain(check);
    expect(policy).toMatch(/after a fix rerun failed and affected checks/);
  });

  it('makes author verification the same for ordinary and small tasks', () => {
    const implement = body('dev-implement');
    expect(implement).toMatch(/Run affected checks in your own workspace/);
    expect(implement).toMatch(/submit its exact SHA, requirements-to-tests, observed results/);
    expect(implement).not.toMatch(/Finish[^\n]*(formatter|linter|type checker|crapper|dryer)/);
    const selection = body('dev-testing-policy').split('\n').find(line => line.startsWith('- **T2:'))!;
    expect(selection).toContain('run_tests');
    expect(selection).not.toMatch(/lint|crapper|dryer/);
    const ordinary = body('dev-testing-policy').split('\n').find(line => line.startsWith('- **T3:'))!;
    expect(ordinary).toContain('affected tests');
    expect(ordinary).toMatch(/ordinary implementation uses its affected tests/);
  });

  it('assigns broader checks through the task and keeps each verification ability self-contained', () => {
    expect(body('dev-gates')).toMatch(/When broader validation is assigned/);
    expect(body('dev-testing-policy')).toMatch(/If assigned full candidate validation/);
    expect(body('dev-work-pipeline')).toMatch(/When a full candidate validation is assigned/);
    for (const id of ['dev-language-rules', 'dev-browser-check']) expect(body(id), id).toContain('run_tests');
    expect(body('dev-review-diff')).not.toMatch(/developer runs them before submitting|one reviewer[^.]*runs mutator/);
    expect(templates.roles.get('DEV-REV')!.body).not.toMatch(/runs mutator/);
  });
});

describe('where change checks run and what proves them', () => {
  it('lets an assignment widen what is checked, never move change checks to run_tests', () => {
    for (const id of ['dev-task-flow', 'dev-gates', 'hh-task-flow']) {
      expect(body(id), id).not.toMatch(/stricter[^.]*assignment|assignment can require every check there|takes precedence/i);
    }
    for (const id of ['hh-run-checks', 'dev-task-flow', 'dev-gates', 'hh-task-flow']) {
      expect(body(id), id).toMatch(/assignment can widen what is checked[^.]*never move[^.]*change checks to "?run_tests"?/i);
    }
    for (const id of ['hh-run-checks', 'dev-implement']) {
      expect(body(id), id).not.toMatch(/use\s+`?"?run_tests`?"?\s+(?:for\s+one\s+)?(?:only\s+)?when\s+your\s+(?:own\s+)?workspace\s+cannot\s+run\s+it/i);
      expect(body(id), id).toMatch(/when your workspace cannot run a check[\s\S]*named local tests of the touched area[\s\S]*say what is missing[\s\S]*release owner's `?"?run_tests"?`? run once per release candidate on the combined release candidate before main/i);
    }
  });

  it('tells whoever leads not to order change checks through run_tests', () => {
    for (const id of ['hh-lead-tasks', 'dev-lead', 'hh-brief-members']) expect(body(id), id).toMatch(/never order[^.]*change checks[^.]*run_tests/i);
  });

  it('takes the author\'s check record for the exact commit and asks a run_tests receipt only for a whole suite', () => {
    for (const id of ['dev-review-verdict', 'dev-review-diff']) expect(body(id), id).toMatch(/author's check record for the exact commit/);
    for (const id of ['dev-review-verdict', 'dev-review-diff', 'dev-testing-policy']) {
      expect(body(id), id).toMatch(/run_tests receipt is needed only for a whole suite or declared profile/);
    }
  });
});

describe('who repairs a finding', () => {
  it('keeps the fix loop to work outside a route, where each stage repairs its own findings and nothing goes back', () => {
    const loop = body('hh-fix-loop');
    expect(loop).not.toMatch(/sends back to its author/);
    expect(loop).toMatch(/work outside a route of checking stages/);
    expect(loop).toMatch(/checking stage[^.]*repairs what it finds itself[^.]*forward/);
    expect(loop).toMatch(/nothing goes back to an earlier stage/);
  });

  it('keeps acceptance findings with the head, never sending the candidate back to its author', () => {
    const acceptance = body('dev-qa-acceptance');
    expect(acceptance).not.toMatch(/as tasks|fast path|verification\.defect|back to its author/);
    expect(acceptance).toMatch(/blocking finding[^.]*"blocked"/);
  });

  it('never sends a candidate back to an earlier stage, so nothing is checked again on its way back', () => {
    for (const id of [...templates.skills.keys()].filter(key => /^(dev|hh)-/.test(key))) {
      expect(body(id), id).not.toMatch(/verification\.defect|comes back (to you )?after your verdict|passes the route again|since (their|your) last verdict|sends? (it |the task |the candidate )?back to (its|the) author/);
    }
  });

  it('lets Tests take the main line into a candidate whose own change passed and check it again there', () => {
    for (const id of ['dev-task-flow', 'dev-gates']) {
      expect(body(id), id).toMatch(/own change passed[^.]*main line[^.]*stays at Tests/);
      expect(body(id), id).toMatch(/"submit"[^.]*review\.baseCommit[^.]*main/);
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
  it('tells heads and the orchestrator that a turnkey team\'s task goes through no echelons and that echelons never go into a task\'s text', () => {
    for (const id of ['hh-lead-tasks', 'dev-lead', 'orch-company', 'orch-plan-turn', 'hh-brief-members']) {
      expect(body(id), id).toMatch(/turnkey team[^.]*no echelons/);
      expect(body(id), id).toMatch(/never write the echelons[^.]*into a task's text/i);
    }
  });

  it('teaches heads and the orchestrator that the team sets a task\'s route, and that a quick fix goes to a turnkey team', () => {
    for (const id of ['hh-lead-tasks', 'dev-lead', 'orch-plan-turn', 'orch-company']) {
      expect(body(id), id).toMatch(/team that does it sets (?:a|each) task's route: a member of a turnkey team[^.]*end to end alone[^.]*everybody else's goes through/);
      expect(body(id), id).toMatch(/small, quick fix that need not go through every echelon goes to a member of a turnkey team/);
      expect(body(id), id).not.toMatch(/such work waits for a turn|turn runs in echelons|members who work in the echelons take neither/);
      expect(body(id), id).not.toMatch(/its holder does it end to end alone/);
    }
  });

  it('names no mode of a turn and no tool to plan one', () => {
    for (const id of ['orch-plan-turn', 'orch-company', 'hh-head', 'hh-lead-tasks', 'dev-lead']) expect(body(id), id).not.toMatch(/plan_turn|\bmode\b/);
  });

  it('tells the member of a turnkey team to carry its task end to end alone and close it with report', () => {
    expect(body('dev-task-flow')).toMatch(/turnkey[^.]*end to end alone[^.]*nobody else called onto it[^.]*report done true/);
  });
});
