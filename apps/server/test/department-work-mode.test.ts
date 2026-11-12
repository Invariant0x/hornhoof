import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { departments, people } from '../src/db/schema.js';
import { company } from './department-owner-fixture.js';
import { as, SETUP, testApp } from './helpers.js';
import { ensureOperations } from '../src/modules/operations/ensure.js';

type C = Awaited<ReturnType<typeof company>>;
const mode = (c: C, token: string, id = c.dev.id) => c.app.inject({ url: `/api/departments/${id}/work-mode`, ...as(token) });
const setMode = (c: C, token: string, body: object, id = c.dev.id) => c.app.inject({ method: 'PUT', url: `/api/departments/${id}/work-mode`, payload: body, ...as(token) });

describe('department work mode settings', () => {
  it('lets the CEO save the mode and reads it from storage on the next request', async () => {
    const c = await company();
    expect((await mode(c, c.ceoToken)).json()).toEqual({ departmentId: c.dev.id, workMode: 'turns', canChangeWorkMode: true });
    const saved = await setMode(c, c.ceoToken, { workMode: 'continuous' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ departmentId: c.dev.id, workMode: 'continuous', canChangeWorkMode: true });
    expect((await mode(c, c.ceoToken)).json()).toEqual(saved.json());
    expect((await c.db.select().from(departments).where(eq(departments.id, c.dev.id)))[0]!.workMode).toBe('continuous');
  });

  it('lets the current department owner and CEO delegate change it', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    expect((await setMode(c, c.danaToken, { workMode: 'continuous' })).statusCode).toBe(200);
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.id, c.ids.wes));
    expect((await setMode(c, c.wholeToken, { workMode: 'turns' })).statusCode).toBe(200);
  });

  it('lets a reader of the whole company read it without write authority, and everyone given the department change it', async () => {
    const c = await company();
    expect((await mode(c, c.wholeToken)).json()).toEqual({ departmentId: c.dev.id, workMode: 'turns', canChangeWorkMode: false });
    for (const token of [c.samToken, c.wholeToken]) {
      expect((await setMode(c, token, { workMode: 'continuous' })).statusCode).toBe(403);
    }
    expect((await mode(c, c.samToken)).statusCode).toBe(404);
    expect((await mode(c, c.ceoToken)).json().workMode).toBe('turns');
    expect((await mode(c, c.danaToken)).json()).toEqual({ departmentId: c.dev.id, workMode: 'turns', canChangeWorkMode: true });
    expect((await setMode(c, c.danaToken, { workMode: 'continuous' })).statusCode).toBe(200);
  });

  it('revokes a former owner immediately when their access is taken away', async () => {
    const c = await company();
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    expect((await setMode(c, c.danaToken, { workMode: 'continuous' })).statusCode).toBe(200);
    await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.dana}`, payload: { access: { departments: [c.sales.id] } }, ...as(c.ceoToken) });
    expect((await setMode(c, c.danaToken, { workMode: 'turns' })).statusCode).toBe(403);
    expect((await mode(c, c.ceoToken)).json().workMode).toBe('continuous');
  });

  it('rejects forged authority and unknown modes atomically', async () => {
    const c = await company();
    for (const body of [{ workMode: 'weekly' }, { workMode: null }, { workMode: 'continuous', owner: c.ids.dana }, { workMode: 'continuous', companyId: c.companyId }]) {
      expect((await setMode(c, c.ceoToken, body)).statusCode).toBe(400);
    }
    expect((await mode(c, c.ceoToken)).json().workMode).toBe('turns');
  });

  it('refuses products, missing departments and signed-out callers', async () => {
    const c = await company();
    expect((await setMode(c, c.ceoToken, { workMode: 'continuous' }, c.product.id)).statusCode).toBe(400);
    expect((await mode(c, c.ceoToken, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await c.app.inject({ url: `/api/departments/${c.dev.id}/work-mode` })).statusCode).toBe(401);
    expect((await c.app.inject({ method: 'PUT', url: `/api/departments/${c.dev.id}/work-mode`, payload: { workMode: 'continuous' } })).statusCode).toBe(401);
  });
});

describe('work mode defaults on real department creation paths', () => {
  it('sets Operations continuous and Development turns during template setup', async () => {
    const { app, db } = await testApp();
    expect((await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, template: 'studio' } })).statusCode).toBe(201);
    const rows = await db.select().from(departments);
    expect(rows.find(d => d.templateKey === 'operations')!.workMode).toBe('continuous');
    expect(rows.find(d => d.templateKey === 'development')!.workMode).toBe('turns');
  });

  it('sets the template default when Operations is recreated by its service', async () => {
    const c = await company();
    await ensureOperations(c.app.ctx, c.companyId);
    const [ops] = await c.db.select().from(departments).where(eq(departments.templateKey, 'operations'));
    expect(ops!.workMode).toBe('continuous');
    await c.db.update(departments).set({ workMode: 'turns' }).where(eq(departments.id, ops!.id));
    await ensureOperations(c.app.ctx, c.companyId);
    expect((await c.db.select().from(departments).where(eq(departments.id, ops!.id)))[0]!.workMode).toBe('turns');
  });

  it('sets the default when a person builds a template department', async () => {
    const c = await company();
    const made = await c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'operations' }] }, ...as(c.ceoToken) });
    expect(made.statusCode).toBe(201);
    expect((await c.db.select().from(departments).where(eq(departments.templateKey, 'operations')))[0]!.workMode).toBe('continuous');
  });
});
