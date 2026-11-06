import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

const templates = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url)));
const body = (id: string) => templates.skills.get(id)!.body;

describe('pipeline guidance', () => {
  it('separates author checks, shared turn checks and nonblocking improvements', () => {
    expect(body('dev-gates')).toMatch(/affected tests[\s\S]*pinned commit/);
    expect(body('dev-gates')).toMatch(/Improvement lanes[\s\S]*ordinary next-turn tasks/i);
    expect(body('dev-implement')).toMatch(/next independent piece of work/i);
  });

  it('hands submission to the existing author check and review to its run evidence', () => {
    expect(body('dev-implement')).toMatch(/submit[\s\S]*author check/i);
    for (const id of ['dev-review-diff', 'dev-review-verdict']) {
      expect(body(id), id).toMatch(/ID\/number|run ID and number/);
      expect(body(id), id).toMatch(/commit/);
      expect(body(id), id).toMatch(/instead of rerunning|without rerunning/);
    }
  });

  it('wakes waiters when remote tests or work finish and keeps every wait bounded', () => {
    for (const id of ['hh-task-flow', 'hh-lead-tasks']) {
      expect(body(id), id).toMatch(/run_tests[\s\S]*run_work/);
      expect(body(id), id).toMatch(/deadline/);
      expect(body(id), id).toMatch(/owner|holder/);
    }
  });

  it('assigns each area to one owner and refuses a second task until it merges', () => {
    for (const id of ['hh-lead-tasks', 'hh-brief-members', 'orch-plan-turn']) {
      expect(body(id), id).toMatch(/one owner|same member/);
      expect(body(id), id).toMatch(/hot files?/);
      expect(body(id), id).toMatch(/second task[\s\S]*(not|never)[\s\S]*until[\s\S]*merg/i);
    }
  });
});
