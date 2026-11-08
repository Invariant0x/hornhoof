import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents } from '../src/db/schema.js';
import { leaveWork, submit } from '../src/modules/tasks/engine.js';
import { backOn } from '../src/modules/tasks/wake.js';
import { as } from './helpers.js';
import { BASE, fixture } from './development-echelons-fixture.js';

const code = { summary: 'Keep totals.', evidence: 'Changed tests.', review: { baseCommit: BASE } };

describe('staff changes keep the current required stage', () => {
  it('waits at Review when its checker is switched off instead of skipping the stage', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    const candidateId = (await f.detail()).echelons.candidateId;
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id));
    const moved = await leaveWork(f.ctx, { agentId: f.head.id }, f.reviewer);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null, candidateId });
    expect(moved.wakes.map(wake => wake.agentId)).toEqual([f.head.id]);
  });
  it('resumes an eligible Review owner after the subscription becomes available', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id));
    await leaveWork(f.ctx, { agentId: f.head.id }, f.reviewer);
    await f.db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, f.reviewer.id));
    await backOn(f.ctx, { agentId: f.head.id }, f.reviewer.id);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id });
  });
  it('allows removing the former author after ownership has moved to Review', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    const reply = await f.app.inject({ method: 'DELETE', url: `/api/agents/${f.author.id}`, ...as(f.ceoToken) });
    expect(reply.statusCode).toBe(204);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id });
  });
});
