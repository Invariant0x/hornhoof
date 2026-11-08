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
    expect(body('dev-qa-acceptance')).toMatch(/findings[\s\S]*authors[\s\S]*tasks[\s\S]*small[\s\S]*fast path/);
  });
});
