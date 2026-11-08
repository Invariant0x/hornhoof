import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, teams } from '../src/db/schema.js';
import { submit } from '../src/modules/tasks/engine.js';
import { BASE, fixture } from './development-echelons-fixture.js';

describe('observers outside the development route', () => {
  it('does not dispatch Review to a sub-unit even when its employee has the checking ability', async () => {
    const f = await fixture({ autoReviewer: true });
    const [team] = await f.db.insert(teams).values({ companyId: f.author.companyId, departmentId: f.author.departmentId!, name: 'Matrix' }).returning();
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, f.reviewer.id));
    const moved = await submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Changed tests.', review: { baseCommit: BASE } });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null });
    expect(moved.wakes.map(wake => wake.agentId)).toEqual([f.head.id]);
  });
});
