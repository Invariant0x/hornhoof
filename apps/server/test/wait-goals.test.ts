import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { agents, departments, people, requests, tasks, taskEvents, turns, waitNotices, waitPolicies, taskWaits } from '../src/db/schema.js';
import { answer, ask, createTask, report, type Task } from '../src/modules/tasks/engine.js';
import { sweepWaits } from '../src/modules/tasks/wait-escalation.js';
import * as goals from '../src/modules/tasks/wait-goals.js';
import { deliverWaitNotices } from '../src/modules/tasks/wait-notices.js';
import { as } from './helpers.js';
import { recorded } from './recorded-fixture.js';
import { waitCompany } from './wait-company.js';

const HOUR = 3_600_000;
type Res = { content: { text: string }[]; isError?: boolean };

async function company() {
  const c = await waitCompany({ turn: false });
  const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
  /* The head holds the department's task, as a head who reports on a goal does. */
  const held = async (title = 'Dept') => (await createTask(c.ctx, { personId: ceo!.id }, { title, brief: '', body: 'Private words of the work.', departmentId: c.dev.id, assigneeAgentId: c.head.id })).task;
  const clients = new Map<string, Client>();
  const clientOf = async (agentId: string) => {
    if (!clients.has(agentId)) clients.set(agentId, (await c.run(agentId)).client as Client);
    return clients.get(agentId)!;
  };
  const tool = async (agentId: string, name: string, args: Record<string, unknown>) => (await (await clientOf(agentId)).callTool({ name, arguments: args })) as Res;
  const say = (t: Task, more: Record<string, unknown> = {}) => tool(c.head.id, 'escalate_missed_goal', { task: t.number, goal: 'First customers', why: 'None came.', ...more });
  const episodes = (t: Pick<Task, 'id'>) => c.db.select().from(requests).where(eq(requests.taskId, t.id));
  const cards = () => c.db.select().from(waitNotices).where(eq(waitNotices.personId, ceo!.id));
  const cardsOf = async () => (await c.app.inject({ url: '/api/wait-cards', ...as(c.ceo) })).json().cards as { about: string; number: number; words: string }[];
  return { ...c, ceoPerson: ceo!, CEO: { personId: ceo!.id }, clientOf, held, tool, say, episodes, cards, cardsOf };
}

describe('a goal in danger', () => {
  it('opens one episode as a head says it, with one card for the CEO that says where to look', async () => {
    const c = await company();
    const work = await c.held();
    const res = await c.say(work);
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    const [episode] = await c.episodes(work);
    expect(episode).toMatchObject({ goalRefKind: 'task', goalRefId: work.id, goalImpact: 'missed', goalRevision: 1, goalState: 'open', status: 'open', kind: 'question' });
    expect(episode!.goalEpisodeId).toEqual(expect.any(String));
    await deliverWaitNotices(c.ctx);
    const shown = await c.cardsOf();
    expect(shown).toMatchObject([{ about: 'goal_risk', number: work.number }]);
    expect(shown[0]!.words).not.toContain('First customers');
    expect(shown[0]!.words).not.toContain('Private words');
  });

  it('goes through where the department set dates and none for questions: no date is what stops the CEO hearing', async () => {
    const c = await company();
    await c.db.insert(waitPolicies).values({ companyId: c.companyId, departmentId: c.dev.id, kind: 'review', stage: '', version: 1, ownerMs: HOUR, headMs: 2 * HOUR, decisionMs: 3 * HOUR, reviewIntervalMs: 4 * HOUR, createdByPersonId: c.ceoPerson.id });
    const work = await c.held();
    expect((await c.say(work)).isError).toBeFalsy();
    expect(await c.cards()).toHaveLength(1);
  });

  it('is opened by no text and no date: a question that says it, or a wait long past, tells the CEO nothing', async () => {
    const c = await company();
    await c.db.insert(waitPolicies).values({ companyId: c.companyId, departmentId: c.dev.id, kind: 'person', stage: '', version: 1, ownerMs: HOUR, headMs: 2 * HOUR, decisionMs: 3 * HOUR, reviewIntervalMs: 4 * HOUR, createdByPersonId: c.ceoPerson.id });
    const work = await c.held();
    await ask(c.ctx, c.head.id, work.id, { kind: 'question', text: 'Missed goal: first customers. The goal is at risk!', topic: 'task' });
    await sweepWaits(c.ctx, new Date(Date.now() + 1000 * HOUR));
    await sweepWaits(c.ctx, new Date(Date.now() + 1000 * HOUR));
    expect(await c.episodes(work)).toMatchObject([{ goalEpisodeId: null, goalState: null }]);
    expect(await c.cards()).toEqual([]);
  });

  it('coalesces the same report, and at risk becoming missed is one revision and one new alert', async () => {
    const c = await company();
    const work = await c.held();
    await c.say(work, { impact: 'at_risk' });
    await c.say(work, { impact: 'at_risk' });
    expect(await c.episodes(work)).toHaveLength(1);
    expect(await c.cards()).toHaveLength(1);
    await c.say(work, { impact: 'missed' });
    await c.say(work, { impact: 'missed' });
    await c.say(work, { impact: 'at_risk' });
    const [episode] = await c.episodes(work);
    expect(episode).toMatchObject({ goalImpact: 'missed', goalRevision: 2, goalState: 'open' });
    expect((await c.cards()).map(n => n.purpose).sort()).toEqual(['goal_risk:1', 'goal_risk:2']);
  });

  it('joins the episode of one who said it at the same moment', async () => {
    const c = await company();
    const work = await c.held();
    await c.say(work, { impact: 'at_risk' });
    const notYetSeen = vi.spyOn(goals, 'openGoal').mockResolvedValueOnce(null);
    const res = await c.say(work, { impact: 'missed' });
    notYetSeen.mockRestore();
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    expect(await c.episodes(work)).toMatchObject([{ goalImpact: 'missed', goalRevision: 2, goalState: 'open' }]);
    expect(await c.cards()).toHaveLength(2);
  });

  it('allows one open episode for a goal in the schema itself', async () => {
    const c = await company();
    const work = await c.held();
    await c.say(work);
    const [episode] = await c.episodes(work);
    const copy = { ...episode!, id: randomUUID() };
    await expect(c.db.insert(requests).values({ ...copy, goalEpisodeId: randomUUID() })).rejects.toThrow();
    await expect(c.db.insert(requests).values({ ...copy, goalEpisodeId: null, goalImpact: null, goalRevision: null, goalState: null, goalRefKind: null })).rejects.toThrow();
  });

  it('does not end with an answer: saying it again joins the same episode', async () => {
    const c = await company();
    const work = await c.held();
    await c.say(work, { impact: 'at_risk' });
    const [episode] = await c.episodes(work);
    await answer(c.ctx, c.CEO, episode!.id, { answer: 'Do what you can.' });
    expect((await c.episodes(work))[0]).toMatchObject({ status: 'answered', goalState: 'open' });
    expect((await c.say(work, { impact: 'at_risk' })).isError).toBeFalsy();
    expect(await c.episodes(work)).toHaveLength(1);
  });

  it('ends as the head records it, with a card not yet shown going with it, and a later threat is a new episode', async () => {
    const c = await company();
    const work = await c.held();
    await c.say(work);
    const res = await c.tool(c.head.id, 'resolve_goal_risk', { task: work.number, why: 'Two customers signed.' });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    const [first] = await c.episodes(work);
    expect(first).toMatchObject({ goalState: 'resolved' });
    await deliverWaitNotices(c.ctx);
    expect((await c.cards())[0]).toMatchObject({ deliveredAt: null, cancelledAt: expect.any(Date) as Date });
    await answer(c.ctx, c.CEO, first!.id, { answer: 'Good.' });
    await c.say(work);
    const all = await c.episodes(work);
    expect(all).toHaveLength(2);
    expect(new Set(all.map(e => e.goalEpisodeId)).size).toBe(2);
    expect(await c.cards()).toHaveLength(2);
  });

  it('is ended only by who may say so', async () => {
    const c = await company();
    const work = await c.held();
    await c.say(work);
    const other = (await c.db.select().from(departments).where(eq(departments.templateKey, 'operations')))[0]!;
    const [outsider] = await c.db.insert(agents).values({ companyId: c.companyId, departmentId: other.id, kind: 'head', roleKey: 'OPS-HEAD', name: 'Olga', model: '', subscriptionId: c.sub.id }).returning();
    expect((await c.tool(outsider!.id, 'resolve_goal_risk', { task: work.number, why: 'Fine.' })).isError).toBe(true);
    expect((await c.episodes(work))[0]).toMatchObject({ goalState: 'open' });
    expect((await (await c.clientOf(c.agent.id)).listTools()).tools.map(t => t.name)).not.toContain('resolve_goal_risk');
    expect((await c.tool(c.orchestrator.id, 'resolve_goal_risk', { task: work.number, why: 'Checked with the head.' })).isError).toBeFalsy();
  });

  it('can be about the turn, and needs one to be', async () => {
    const c = await company();
    const none = await c.held();
    expect((await c.say(none, { on: 'turn' })).isError).toBe(true);
    const [turn] = await c.db.insert(turns).values({ companyId: c.companyId, departmentId: c.dev.id, number: 5, goal: 'Launch', status: 'open', openedAt: new Date() }).returning();
    const work = await c.held('In the turn');
    expect((await c.say(work, { on: 'turn' })).isError).toBeFalsy();
    expect((await c.episodes(work))[0]).toMatchObject({ goalRefKind: 'turn', goalRefId: turn!.id });
  });
});

describe('the summary of a turn', () => {
  const inTurn = async () => {
    const c = await company();
    const [turn] = await c.db.insert(turns).values({ companyId: c.companyId, departmentId: c.dev.id, number: 5, title: 'Launch', goal: 'Ship the launch', status: 'open', openedAt: new Date() }).returning();
    const reported = await c.held('Reported');
    const silent = await c.held('Closed with no word');
    return { ...c, turn: turn!, reported, silent };
  };
  /* Both results go into the turn as they are accepted, and the tag of its release closes it, as releaseRound does. */
  const close = async (c: Awaited<ReturnType<typeof inTurn>>) => {
    await report(c.ctx, c.head.id, c.reported.id, { done: true, summary: 'Shipped.', ...(await recorded(c.ctx, c.reported.id, c.head.id)) });
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, c.silent.id));
    await c.db.update(tasks).set({ turnId: c.turn.id }).where(inArray(tasks.id, [c.reported.id, c.silent.id]));
    await c.db.transaction(async tx => {
      const [released] = await tx.update(turns).set({ status: 'closed', closedAt: new Date(), version: 'v1.0.0' }).where(eq(turns.id, c.turn.id)).returning();
      await goals.recordTurnSummary(tx, released!);
    });
  };

  it('tells the CEO once what is on record of it, and calls nothing a success that has no result', async () => {
    const c = await inTurn();
    await close(c);
    expect((await c.db.select().from(turns).where(eq(turns.id, c.turn.id)))[0]!.status).toBe('closed');
    expect(await c.cards()).toHaveLength(1);
    await deliverWaitNotices(c.ctx);
    const [card] = await c.cardsOf();
    expect(card).toMatchObject({ about: 'turn_summary', number: c.reported.number });
    expect(card!.words).toContain('Ship the launch');
    expect(card!.words).toContain(`#${c.reported.number} done: result recorded`);
    expect(card!.words).toContain(`#${c.silent.number} done: no result recorded`);
    expect(card!.words).toContain('No goal risk is open.');
    expect(card!.words).not.toContain('Private words');
    expect(await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.reported.id), eq(taskEvents.kind, 'wait_card')))).toHaveLength(1);
  });

  it('says which goal risks are still open as it closes, of the work it took in and of the release itself', async () => {
    const c = await inTurn();
    await c.say(c.silent, { impact: 'at_risk' });
    /* Said of the release by work that is still going and was not in it. */
    const going = await c.held('Still going');
    await c.say(going, { on: 'turn', impact: 'missed' });
    const later = await c.held('Later work');
    await c.say(later, { impact: 'at_risk' });
    await close(c);
    await deliverWaitNotices(c.ctx);
    const summary = (await c.cardsOf()).find(card => card.about === 'turn_summary')!;
    expect(summary.words).toContain(`Goal risks still open: #${c.silent.number} at risk, #${going.number} missed.`);
    expect(summary.words).not.toContain(`#${later.number}`);
  });

  it('is kept while the card waits to be seen, and goes when it is acknowledged, deciding nothing', async () => {
    const c = await inTurn();
    await close(c);
    await deliverWaitNotices(c.ctx);
    const [row] = await c.cards();
    expect((await c.app.inject({ method: 'POST', url: `/api/wait-cards/${row!.id}/ack`, ...as(c.ceo) })).statusCode).toBe(200);
    expect(await c.cardsOf()).toEqual([]);
    expect((await c.db.select().from(turns).where(eq(turns.id, c.turn.id)))[0]!.status).toBe('closed');
  });

  it('asks for no ordinary lateness: a wait past all its dates in a closed turn brings the CEO nothing more', async () => {
    const c = await inTurn();
    const [wait] = await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, c.reported.id));
    expect(wait).toBeUndefined();
    await close(c);
    await sweepWaits(c.ctx, new Date(Date.now() + 1000 * HOUR));
    expect((await c.cards()).filter(n => n.guard.turn === undefined)).toEqual([]);
  });
});
