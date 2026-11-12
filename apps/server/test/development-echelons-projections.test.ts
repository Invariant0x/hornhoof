import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, tasks } from '../src/db/schema.js';
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
    /* A person of a product alone runs nothing of the department: they see the author on their plan and not the checker. */
    const [product] = await f.db.insert(departments).values({ companyId: f.task.companyId, name: 'Shop', parentId: f.author.departmentId!, roleCode: 'DEV', position: 1 }).returning();
    await f.db.update(agents).set({ productId: product!.id }).where(eq(agents.id, f.author.id));
    await f.db.update(tasks).set({ productId: product!.id }).where(eq(tasks.id, f.task.id));
    const token = await invitePerson(f.app, f.ceoToken, { name: 'Contributor', email: 'contributor@acme.com', access: { departments: [product!.id] } });
    const listed = await invitePerson(f.app, f.ceoToken, { name: 'Lee', email: 'lee@acme.com', access: { departments: [f.author.departmentId!] } });
    await ownPlan(f.db, 'contributor@acme.com', f.author.id);
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Changed source.', review: { baseCommit: BASE } });
    const reply = await f.app.inject({ url: `/api/tasks/${f.task.id}`, ...as(token) });
    expect(reply.statusCode).toBe(200);
    const route = reply.json().task.echelons;
    expect(route).toMatchObject({ stage: 'review', ownerAgentId: null, candidateId: null, assignment: null });
    expect(JSON.stringify(route)).not.toContain(f.reviewer.id);
    expect((await f.app.inject({ url: `/api/tasks/${f.task.id}`, ...as(listed) })).json().task.echelons).toMatchObject({ ownerAgentId: f.reviewer.id, candidateId: expect.any(String) });
  });
  it('gives the owner of the task\'s department its checker and candidate, as the CEO reads them, in every projection', async () => {
    const f = await fixture();
    const token = await invitePerson(f.app, f.ceoToken, { name: 'Owner', email: 'owner@acme.com', access: { departments: [f.author.departmentId!] } });
    const people = (await f.app.inject({ url: '/api/people', ...as(f.ceoToken) })).json().people as { id: string; name: string }[];
    const owner = await f.app.inject({ method: 'PUT', url: `/api/departments/${f.author.departmentId}/owner`, payload: { personId: people.find(p => p.name === 'Owner')!.id }, ...as(f.ceoToken) });
    expect(owner.statusCode).toBe(200);
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Changed source.', review: { baseCommit: BASE } });
    const read = async (as_: string) => {
      const request = (url: string) => f.app.inject({ url, ...as(as_) });
      const detail = (await request(`/api/tasks/${f.task.id}`)).json().task;
      const line = (await request(`/api/tasks?department=${f.task.departmentId}`)).json().tasks.find((row: { id: string }) => row.id === f.task.id);
      const org = (await request('/api/org')).json();
      const reviewer = org.departments.flatMap((d: { employees: { id: string; task: { echelons: unknown } }[] }) => d.employees).find((a: { id: string }) => a.id === f.reviewer.id);
      return [detail.echelons, line.echelons, reviewer.task.echelons];
    };
    const ceo = await read(f.ceoToken);
    expect(ceo[0]).toMatchObject({ stage: 'review', ownerAgentId: f.reviewer.id, candidateId: expect.any(String) });
    expect(await read(token)).toEqual(ceo);
  });

});
