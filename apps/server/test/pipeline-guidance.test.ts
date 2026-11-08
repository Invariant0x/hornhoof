import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const body = (id: string) => templates.skills.get(id)!.body;

describe('pipeline guidance', () => {
  it('chooses author and broader checks from the task without imposing a shared chain', () => {
    expect(body('dev-gates')).toMatch(/assignment, task acceptance, declared risk and actual gates/);
    expect(body('dev-testing-policy')).toMatch(/T2: Select impact explicitly[\s\S]*affected tests through run_tests[\s\S]*exact commit/);
    expect(body('dev-gates')).toMatch(/When broader validation is assigned, one owner freezes the exact candidate/);
    expect(body('dev-implement')).toMatch(/separate branch\/workspace for independent work while a check is pending/);
    expect(body('dev-release-improvements')).toMatch(/assigned|assignment/i);
  });

  it('hands submission to the existing author check and review to its run evidence', () => {
    expect(body('dev-implement')).toMatch(/submit[\s\S]*author check/i);
    expect(body('dev-review-verdict')).toMatch(/run ID and number/);
    for (const id of ['dev-review-diff', 'dev-review-verdict']) {
      expect(body(id), id).toMatch(/commit/);
      expect(body(id), id).toMatch(/instead of rerunning|without rerunning/);
    }
  });

  it('wakes waiters when remote tests or work finish and keeps every wait bounded', () => {
    for (const id of ['hh-task-flow', 'hh-head']) {
      expect(body(id), id).toMatch(/run_tests[\s\S]*run_work/);
      expect(body(id), id).toMatch(/deadline/);
      expect(body(id), id).toMatch(/owner|holder/);
    }
  });

  it('defines ownership locally in each coordinating ability until completion or integration', () => {
    expect(body('hh-lead-tasks')).toMatch(/one owner keeps each work area until its task is done/);
    expect(body('hh-brief-members')).toMatch(/executor owns until its task is done; resolve collisions before assigning another writer/);
    expect(body('dev-lead')).toMatch(/files keep one writer until its work is integrated/);
  });
});
