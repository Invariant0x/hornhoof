import { eq, inArray, type SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agentChanges, agentEvents, agents, companies, departments, jobs, people, pipelines, pipelineStages, turns } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { ensureOperations } from '../src/modules/operations/ensure.js';
import { appOn, createTestDb, SETUP, statements } from './helpers.js';
import { company, FOUR, opsDepartments, roles, staff, staffedLike } from './operations-required-fixture.js';

/* Every department has its open turn, which ends before the department goes, as when the structure removes one. */
async function removeDepartments(db: Db, where: SQL): Promise<void> {
  const places = db.select(idOnly(departments)).from(departments).where(where);
  const inPlaces = inArray(pipelines.departmentId, places);
  await db.delete(pipelineStages).where(inArray(pipelineStages.pipelineId, db.select(idOnly(pipelines)).from(pipelines).where(inPlaces)));
  await db.delete(pipelines).where(inPlaces);
  await db.update(turns).set({ status: 'closed', closedAt: new Date() }).where(inArray(turns.departmentId, places));
  await db.delete(departments).where(where);
}

describe('a company that lives already', () => {
  it('gets who is missing when the server starts, with its one head kept', async () => {
    const db = await createTestDb();
    const first = await appOn(db.$client);
    expect((await first.app.inject({ method: 'POST', url: '/api/setup', payload: SETUP })).statusCode).toBe(201);
    const [acme] = await db.select().from(companies);
    await staffedLike(db as unknown as Db, acme!.id, a => a.kind === 'head');
    const [head] = await staff(db as unknown as Db);
    await db.update(agents).set({ name: 'Hanna', model: 'claude-sonnet-5-5' }).where(eq(agents.id, head!.id));
    await first.app.close();

    const second = await appOn(db.$client);
    await second.app.ready();
    const after = await staff(db as unknown as Db);
    expect(after.map(a => a.roleKey).sort()).toEqual(FOUR);
    expect(after.find(a => a.id === head!.id)).toMatchObject({ name: 'Hanna', model: 'claude-sonnet-5-5', kind: 'head' });
    expect(after.filter(a => a.kind === 'head')).toHaveLength(1);
  });

  it('creates Operations when it has none, first in a company without departments', async () => {
    const { app, db, companyId } = await company();
    await staffedLike(db, companyId, () => false);
    await removeDepartments(db, eq(departments.companyId, companyId));
    await ensureOperations(app.ctx, companyId);
    const [ops] = await opsDepartments(db);
    expect(ops!.position).toBe(0);
    expect(await roles(db)).toEqual(FOUR);
  });

  it('puts an Operations it creates after the departments the company has', async () => {
    const { app, db, companyId } = await company();
    await staffedLike(db, companyId, () => false);
    await removeDepartments(db, eq(departments.companyId, companyId));
    await db.insert(departments).values({ companyId, templateKey: 'sales', roleCode: 'SAL', position: 0 });
    await ensureOperations(app.ctx, companyId);
    expect((await opsDepartments(db))[0]!.position).toBe(1);
    await staffedLike(db, companyId, () => false);
    await removeDepartments(db, eq(departments.templateKey, 'operations'));
    await db.update(departments).set({ position: 4 }).where(eq(departments.templateKey, 'sales'));
    await ensureOperations(app.ctx, companyId);
    expect((await opsDepartments(db))[0]!.position).toBe(5);
  });

  it('counts an old head with no role key as the head, and does not break the one head rule', async () => {
    const { app, db, companyId } = await company();
    await staffedLike(db, companyId, a => a.kind === 'head');
    const [head] = await staff(db);
    await db.update(agents).set({ roleKey: null, name: 'Old head' }).where(eq(agents.id, head!.id));
    await ensureOperations(app.ctx, companyId);
    const after = await staff(db);
    expect(after.filter(a => a.kind === 'head').map(a => a.name)).toEqual(['Old head']);
    expect(after.map(a => a.roleKey ?? 'none').sort()).toEqual(['OPS-BUGS', 'OPS-PROGRAM', 'OPS-WATCH', 'none']);
  });

  it('leaves extra employees, and the names, models and switches of those it finds, alone', async () => {
    const { app, db, companyId } = await company();
    const [ops] = await opsDepartments(db);
    const watch = (await staff(db)).find(a => a.roleKey === 'OPS-WATCH')!;
    const switchedOff = new Date('2026-01-02T03:04:05Z');
    await db.update(agents).set({ name: 'Argus', model: 'claude-opus-5-5', switchedOffAt: switchedOff }).where(eq(agents.id, watch.id));
    const [extra] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Fixer', model: '', departmentId: ops!.id, roleKey: 'OPS-FIX' }).returning();
    const [second] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Second watchdog', model: '', departmentId: ops!.id, roleKey: 'OPS-WATCH' }).returning();
    const before = await db.select().from(agentChanges);
    await ensureOperations(app.ctx, companyId);
    const after = await staff(db);
    expect(after.find(a => a.id === watch.id)).toMatchObject({ name: 'Argus', model: 'claude-opus-5-5', switchedOffAt: switchedOff });
    expect(after.find(a => a.id === extra!.id)).toMatchObject({ name: 'Fixer', subscriptionId: null });
    expect(after.find(a => a.id === second!.id)).toMatchObject({ name: 'Second watchdog', subscriptionId: null });
    expect(after).toHaveLength(6);
    expect(await db.select().from(agentChanges)).toEqual(before);
  });

  it('counts a switched off employee as there, and does not bring one back who was removed', async () => {
    const { app, db, companyId } = await company();
    const all = await staff(db);
    const watch = all.find(a => a.roleKey === 'OPS-WATCH')!;
    const bugs = all.find(a => a.roleKey === 'OPS-BUGS')!;
    await db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, watch.id));
    await db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, bugs.id));
    await ensureOperations(app.ctx, companyId);
    const after = await staff(db);
    expect(after.filter(a => a.roleKey === 'OPS-WATCH').map(a => a.id)).toEqual([watch.id]);
    const collectors = after.filter(a => a.roleKey === 'OPS-BUGS');
    expect(collectors).toHaveLength(1);
    expect(collectors[0]!.id).not.toBe(bugs.id);
    expect((await db.select().from(agents).where(eq(agents.id, bugs.id)))[0]!.removedAt).toBeInstanceOf(Date);
  });

  it('hires no one twice, run again or run at once', async () => {
    const { app, db, companyId } = await company();
    await staffedLike(db, companyId, a => a.kind === 'head');
    await Promise.all([ensureOperations(app.ctx, companyId), ensureOperations(app.ctx, companyId), ensureOperations(app.ctx, companyId)]);
    expect(await roles(db)).toEqual(FOUR);
    await ensureOperations(app.ctx, companyId);
    expect(await roles(db)).toEqual(FOUR);
    /* The head's from the setup, and one for each of the three it found missing. */
    expect(await db.select().from(agentChanges).where(eq(agentChanges.field, 'hired'))).toHaveLength(4);
  });

  it('holds the company while it looks at who is there, so another server waits its turn', async () => {
    const { app, companyId } = await company();
    const seen = statements();
    await ensureOperations(app.ctx, companyId);
    const lock = seen.findIndex(s => /from "companies".*for update/i.test(s.sql));
    const look = seen.findIndex(s => /from "agents"/i.test(s.sql));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(look);
  });

  it('tells the orchestrator in his window who came, once his conversation has begun', async () => {
    const { app, db, companyId } = await company();
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    await staffedLike(db, companyId, a => a.kind === 'head');
    /* The very first thing in his window counts. */
    await db.insert(agentEvents).values({ companyId, agentId: orchestrator!.id, seq: 1, kind: 'text', data: { text: 'Hello' } });
    await ensureOperations(app.ctx, companyId);
    const told = await db.select().from(agentEvents).where(eq(agentEvents.kind, 'applied'));
    expect(told).toHaveLength(1);
    expect(told[0]!.personId).toBeNull();
    expect(told[0]!.data).toMatchObject({ proposalId: null, kind: 'staff', hired: [{ role: 'OPS-WATCH' }, { role: 'OPS-BUGS' }, { role: 'OPS-PROGRAM' }] });
    await ensureOperations(app.ctx, companyId);
    expect(await db.select().from(agentEvents).where(eq(agentEvents.kind, 'applied'))).toHaveLength(1);
  });

  it('changes nothing and tells no map when Operations is whole', async () => {
    const { app, db, companyId } = await company();
    const before = await staff(db);
    const seen = statements();
    const told = vi.spyOn(app.ctx.bus, 'publish');
    await ensureOperations(app.ctx, companyId);
    expect(await staff(db)).toEqual(before);
    expect(seen.filter(s => /^(insert|update|delete)/i.test(s.sql))).toEqual([]);
    expect(told).not.toHaveBeenCalled();
  });

  it('tells the map when it hires someone', async () => {
    const { app, db, companyId } = await company();
    await staffedLike(db, companyId, a => a.kind === 'head');
    const told = vi.spyOn(app.ctx.bus, 'publish');
    await ensureOperations(app.ctx, companyId);
    expect(told).toHaveBeenCalledWith(companyId, { type: 'org' });
  });

  it('does not touch people or jobs', async () => {
    const { app, db, companyId } = await company();
    await staffedLike(db, companyId, a => a.kind === 'head');
    const before = { people: await db.select().from(people), jobs: await db.select().from(jobs) };
    await ensureOperations(app.ctx, companyId);
    expect({ people: await db.select().from(people), jobs: await db.select().from(jobs) }).toEqual(before);
  });
});
