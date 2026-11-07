import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const body = (id: string) => templates.skills.get(id)!.body;

describe('development check ownership', () => {
  it.each(['DEV-ENG', 'DEV-BE', 'DEV-FE'])('gives %s the affected-test handoff', id => {
    const role = templates.roles.get(id)!;
    expect(role.body).toMatch(/failing test/i);
    expect(role.body).toMatch(/only affected tests[\s\S]*run_tests/);
    expect(role.body).toMatch(/tests[\s\S]*green[\s\S]*SHA/);
  });

  it.each(['DEV-TEST', 'DEV-QA'])('gives %s the final-candidate checks', id => {
    const role = templates.roles.get(id)!;
    expect(role.body).toMatch(/once per turn[\s\S]*final/i);
    for (const check of ['full suite', 'browser engines', 'mutation', 'coverage', 'CRAP', 'dryer', 'live']) expect(role.body, check).toContain(check);
    expect(role.body).toMatch(/findings[\s\S]*authors[\s\S]*tasks/);
    expect(role.body).toMatch(/small[\s\S]*fast path/);
  });

  it('makes author verification the same for ordinary and small tasks', () => {
    const implement = body('dev-implement');
    expect(implement).toMatch(/only affected tests[\s\S]*run_tests/);
    expect(implement).toMatch(/tests (written|you wrote)[\s\S]*green[\s\S]*SHA/);
    expect(implement).not.toMatch(/Finish[^\n]*(formatter|linter|type checker|crapper|dryer)/);
    const selection = body('dev-testing-policy').split('\n').find(line => line.startsWith('- T2.'))!;
    expect(selection).toContain('run_tests');
    expect(selection).not.toMatch(/types|lint|crapper|dryer|whole package/);
    const ordinary = body('dev-testing-policy').split('\n').find(line => line.startsWith('| In work'))!;
    expect(ordinary).toContain('affected tests');
    expect(ordinary).not.toMatch(/types|lint|crapper|dryer/);
  });

  it('keeps final checks with testers instead of restoring author or reviewer runs', () => {
    for (const id of ['dev-gates', 'dev-testing-policy', 'dev-work-pipeline', 'dev-review-diff']) {
      expect(body(id), id).toMatch(/test engineer|QA/);
    }
    for (const id of ['dev-language-rules', 'dev-browser-check']) expect(body(id), id).toContain('dev-testing-policy');
    expect(body('dev-review-diff')).not.toMatch(/developer runs them before submitting|one reviewer[^.]*runs mutator/);
    expect(templates.roles.get('DEV-REV')!.body).not.toMatch(/runs mutator/);
    expect(body('dev-qa-acceptance')).toMatch(/findings[\s\S]*authors[\s\S]*tasks[\s\S]*small[\s\S]*fast path/);
  });
});
