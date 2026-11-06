import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AuthorCheckInput } from '../src/modules/tasks/review-quality.js';

/* The command of scripts/author-check prints this record; only the backend knows the run and part it adds. */
describe('the record of the author check', () => {
  const printed = JSON.parse(readFileSync(new URL('../../../scripts/test/fixtures/author-check-record.json', import.meta.url), 'utf8')) as { stages: object[] };
  const runId = '00000000-0000-4000-8000-000000000001', partId = '00000000-0000-4000-8000-000000000002';

  it('parses as the input of the consumer with the run and part added', () => {
    const input = { ...printed, runId, stages: printed.stages.map(stage => ({ ...stage, partId })) };
    expect(AuthorCheckInput.parse(input)).toEqual(input);
  });

  it('is refused without the run, so the backend cannot forget it', () => {
    expect(AuthorCheckInput.safeParse(printed).success).toBe(false);
  });
});
