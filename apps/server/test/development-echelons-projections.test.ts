import { describe, expect, it } from 'vitest';
import { submit } from '../src/modules/tasks/engine.js';
import { as } from './helpers.js';
import { BASE, fixture } from './development-echelons-fixture.js';

describe('one public task snapshot', () => {
  it('gives task, list and organization the same current stage and owner', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Changed source and tests.', review: { baseCommit: BASE } });
    const request = (url: string) => f.app.inject({ url, ...as(f.ceoToken) });
    const detail = (await request(`/api/tasks/${f.task.id}`)).json().task;
    const line = (await request('/api/tasks')).json().tasks.find((t: { id: string }) => t.id === f.task.id);
    const org = (await request('/api/org')).json();
    const reviewer = org.departments.flatMap((d: { employees: { id: string; task: unknown }[] }) => d.employees).find((a: { id: string }) => a.id === f.reviewer.id);
    expect(detail.echelons).toMatchObject({ stage: 'review', ownerAgentId: f.reviewer.id });
    expect(line.echelons).toEqual(detail.echelons);
    expect(reviewer.task.echelons).toEqual(detail.echelons);
  });
});
