import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, jobs, turnTokens } from '../src/db/schema.js';
import { submit } from '../src/modules/tasks/engine.js';
import { BASE, fixture } from './development-echelons-fixture.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const submitted = { summary: 'Keep totals.', evidence: 'The changed source and tests are on the task branch.', review: { baseCommit: BASE } };
const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 5, minute));

/* A turn the agent ran on a plan, with the model its program said it ran on, as its node told Hornhoof. */
async function ranOn(f: Fixture, agentId: string, subscriptionId: string, model: string | null, when: Date): Promise<void> {
  const [job] = await f.db.insert(jobs).values({ companyId: f.task.companyId, subscriptionId, agentId, kind: 'conversation', prompt: 'A turn.', timeoutMs: 900_000, status: 'done', startedAt: when, finishedAt: when }).returning();
  await f.db.insert(turnTokens).values({ jobId: job!.id, companyId: f.task.companyId, agentId, subscriptionId, at: when, totalTokens: 10, model });
}

const onDefault = (f: Fixture, agentId: string) => f.db.update(agents).set({ model: '' }).where(eq(agents.id, agentId));

describe('an employee on its program\'s Default model', () => {
  it.each([
    ['codex', 'gpt-6.1-sol'],
    ['claude', 'claude-opus-5-5'],
  ] as const)('on %s hands in as the model its program last ran on', async (provider, model) => {
    const f = await fixture({ authorProvider: provider });
    await onDefault(f, f.author.id);
    const plan = provider === 'claude' ? f.claude.id : f.codex.id;
    await ranOn(f, f.author.id, plan, 'claude-haiku-5-5', at(1));
    await ranOn(f, f.author.id, plan, model, at(2));
    /* Claude Code names its own notices "<synthetic>", which is no model. */
    await ranOn(f, f.author.id, plan, '<synthetic>', at(3));
    await ranOn(f, f.author.id, plan, null, at(4));
    const moved = await submit(f.ctx, f.author.id, f.task.id, submitted);
    expect(moved.task).toMatchObject({ status: 'review', assigneeAgentId: f.reviewer.id });
  });

  it('is chosen to check as the model its program last ran on, and not when that model is weaker', async () => {
    const f = await fixture();
    await onDefault(f, f.reviewer.id);
    await ranOn(f, f.reviewer.id, f.claude.id, 'claude-haiku-5-5', at(1));
    const waits = await submit(f.ctx, f.author.id, f.task.id, submitted);
    expect(waits.task).toMatchObject({ status: 'waiting', assigneeAgentId: null });

    const g = await fixture();
    await onDefault(g, g.reviewer.id);
    await ranOn(g, g.reviewer.id, g.claude.id, 'claude-opus-5-5', at(1));
    const moved = await submit(g.ctx, g.author.id, g.task.id, submitted);
    expect(moved.task).toMatchObject({ status: 'review', assigneeAgentId: g.reviewer.id });
  });

  it.each([
    ['no turn that names a model', [[null, 1], ['<synthetic>', 2]]],
    ['a model with no known capability', [['gpt-6.2-unclassified', 1]]],
  ] as const)('is refused a hand-in with %s', async (_, turns) => {
    const f = await fixture();
    await onDefault(f, f.author.id);
    for (const [model, minute] of turns) await ranOn(f, f.author.id, f.codex.id, model, at(minute));
    await expect(submit(f.ctx, f.author.id, f.task.id, submitted)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('known capability policy') });
  });

  it('counts only the turns of the plan it is on now', async () => {
    const f = await fixture();
    await onDefault(f, f.author.id);
    await ranOn(f, f.author.id, f.claude.id, 'claude-opus-5-5', at(1));
    await expect(submit(f.ctx, f.author.id, f.task.id, submitted)).rejects.toMatchObject({ status: 409 });
  });
});
