import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const body = (id: string) => templates.skills.get(id)!.body;

describe('pipeline guidance', () => {
  it('chooses author and broader checks from the task without imposing a shared chain', () => {
    expect(body('dev-gates')).toMatch(/assignment, task acceptance, declared risk and actual gates/);
    expect(body('dev-testing-policy')).toMatch(/T2: Select impact explicitly[\s\S]*affected tests in your own workspace[\s\S]*run_tests/);
    expect(body('dev-gates')).toMatch(/When broader validation is assigned, one owner freezes the exact candidate/);
    expect(body('dev-implement')).toMatch(/separate branch\/workspace for independent work while a check is pending/);
    expect(body('dev-release-improvements')).toMatch(/assigned|assignment/i);
  });

  it('checks a change in the author\'s own workspace before the submit, which starts no run, and review reruns only what it doubts', () => {
    expect(body('dev-implement')).toMatch(/author check[\s\S]*own workspace[\s\S]*before you submit/i);
    expect(body('dev-implement')).toMatch(/submitting starts no test run/i);
    expect(body('dev-implement')).not.toMatch(/selector plan|automatic author checks/i);
    for (const id of ['dev-review-diff', 'dev-review-verdict']) {
      expect(body(id), id).toMatch(/commit/);
      expect(body(id), id).toMatch(/rerun what you doubt in your own workspace/);
    }
  });

  it('tracks remote checks and work in progress and waits only for a named person', () => {
    for (const id of ['hh-task-flow', 'hh-head']) {
      expect(body(id), id).toMatch(/run_tests[^.]*test_run[^.]*run_work[^.]*work_run/);
      expect(body(id), id).toMatch(/in progress[\s\S]*owner[\s\S]*next (?:check|observation)/i);
      expect(body(id), id).toMatch(/record a wait only[^.]*named person/i);
      expect(body(id), id).toMatch(/assign[^.]*fail[^.]*repair/i);
      expect(body(id), id).not.toMatch(/deadline|within two hours/i);
    }
  });

  it('defines ownership locally in each coordinating ability until completion or integration', () => {
    expect(body('hh-lead-tasks')).toMatch(/one owner keeps each work area until its task is done/);
    expect(body('hh-brief-members')).toMatch(/executor owns until its task is done; resolve collisions before assigning another writer/);
    expect(body('dev-lead')).toMatch(/files keep one writer until its work is integrated/);
  });
});
