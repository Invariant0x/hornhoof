import { describe, expect, it } from 'vitest';
import { submit } from '../src/modules/tasks/engine.js';
import { as, invitePerson, ownPlan } from './helpers.js';
import { BASE, fixture } from './development-echelons-fixture.js';

describe('one public task snapshot', () => {
  it('gives task, list and organization the same current stage and owner', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Changed source and tests.', review: { baseCommit: BASE } });
    const request = (url: string) => f.app.inject({ url, ...as(f.ceoToken) });
    const detail = (await request(`/api/tasks/${f.task.id}`)).json().task;
    const line = (await request(`/api/tasks?department=${f.task.departmentId}`)).json().tasks.find((t: { id: string }) => t.id === f.task.id);
    const org = (await request('/api/org')).json();
    const reviewer = org.departments.flatMap((d: { employees: { id: string; task: unknown }[] }) => d.employees).find((a: { id: string }) => a.id === f.reviewer.id);
    expect(detail.echelons).toMatchObject({ stage: 'review', ownerAgentId: f.reviewer.id });
    expect(line.echelons).toEqual(detail.echelons);
    expect(reviewer.task).toMatchObject({ id: f.task.id, echelons: detail.echelons });
  });
  it('exposes the required route without replaced gate fields in every task projection', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Changed tests.', review: { baseCommit: BASE } });
    const request = (url: string) => f.app.inject({ url, ...as(f.ceoToken) });
    const detail = (await request(`/api/tasks/${f.task.id}`)).json().task;
    const line = (await request(`/api/tasks?department=${f.task.departmentId}`)).json().tasks.find((row: { id: string }) => row.id === f.task.id);
    const org = (await request('/api/org')).json();
    const owner = org.departments.flatMap((d: { employees: { id: string; task: unknown }[] }) => d.employees).find((agent: { id: string }) => agent.id === f.reviewer.id);
    for (const projection of [detail, line, owner.task]) {
      expect(projection.echelons).toMatchObject({ stage: 'review', ownerAgentId: f.reviewer.id });
      for (const field of ['stage', 'gateCount', 'gates', 'panel', 'merging', 'bounces', 'turnReview']) expect(projection).not.toHaveProperty(field);
    }
  });
  it('does not reveal a hidden checker or candidate through the contributor view', async () => {
    const f = await fixture();
    const token = await invitePerson(f.app, f.ceoToken, { name: 'Contributor', email: 'contributor@acme.com', access: { departments: [f.author.departmentId!] } });
    await ownPlan(f.db, 'contributor@acme.com', f.author.id);
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Changed source.', review: { baseCommit: BASE } });
    const reply = await f.app.inject({ url: `/api/tasks/${f.task.id}`, ...as(token) });
    expect(reply.statusCode).toBe(200);
    const route = reply.json().task.echelons;
    expect(route).toMatchObject({ stage: 'review', ownerAgentId: null, candidateId: null, assignment: null });
    expect(JSON.stringify(route)).not.toContain(f.reviewer.id);
  });

});
