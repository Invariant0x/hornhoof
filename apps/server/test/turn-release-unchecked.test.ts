import { and, desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, approvalPolicies, departments, requests } from '../src/db/schema.js';
import { answer, ask } from '../src/modules/tasks/engine.js';
import { BASE } from './development-echelons-fixture.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { prepareTemplates } from './templates-once.js';
import { releasing } from './turn-release-fixture.js';

await prepareSharedDatabase();
prepareTemplates();

/* The shape of #1540's N2 as a release meets it: main went on to MAIN, and BASE, the commit the turn's one candidate started
   from, came into the turn with no accepted candidate, as a base named past commits nobody checked brings them. Before, the
   release took any approval of its commit, or none where the department sets no commit rule, and the list of what nobody
   checked went only into a refusal to the agent recording it or onto the record. */
const MAIN = '7'.repeat(40);
const UNCHECKED = `${BASE} came in with no accepted candidate.`;
/* The same as Hornhoof keeps it on the card, apart from the words of whoever asked. */
const UNCHECKED_ITEM = { kind: 'commit', commit: BASE };
/* The block #1544 put into the words of the card, which the explanation people read first could leave out. */
const wordsBlock = (lines: string[]) => `What this release brings that no check covers (${lines.length}):\n${lines.map(line => `- ${line}`).join('\n')}\nApprove it only if you accept each of these.`;

type Releasing = Awaited<ReturnType<typeof releasing>>;

function bringsUnchecked(f: Releasing): void {
  f.repo.heads.main = MAIN;
  f.repo.holds[f.R] = [BASE, MAIN];
  f.repo.between[`${MAIN}..${f.R}`] = [{ sha: BASE, parents: [MAIN] }, { sha: f.R, parents: [BASE] }];
}

const requireApproval = (f: Releasing) =>
  f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });
const autonomous = (f: Releasing) => f.db.update(departments).set({ autonomousRelease: true }).where(eq(departments.id, f.task.departmentId!));
const recorded = (text: string) => JSON.parse(text) as Record<string, unknown>;

/* The open question on the release task, as the person reads it. */
const card = async (f: Releasing) => (await f.db.select().from(requests).where(and(eq(requests.taskId, f.release.id), eq(requests.status, 'open'))).orderBy(desc(requests.createdAt)).limit(1))[0];
/* The release holder asks for the approval of R with a tool, and the person approves the card it opened. */
async function askedAndApproved(f: Releasing, tool: 'ask_person' | 'request_approval' = 'ask_person') {
  const asked = tool === 'ask_person'
    ? await f.call('ask_person', { task: f.release.number, question: `Release turn ${f.turn.number}: main to ${f.R}.`, commit: f.R })
    : await f.call('request_approval', { task: f.release.number, channel: 'commit', kind: 'commit', commit: f.R, text: `Release turn ${f.turn.number}: main to ${f.R}.` });
  expect(asked).toMatchObject({ isError: false, text: expect.stringContaining('Asked.') as unknown });
  const shown = (await card(f))!;
  await answer(f.ctx, { personId: f.claude.ownerPersonId }, shown.id, { approve: true });
  return shown;
}

describe('a release that brings what no check covers', () => {
  it.each([
    ['sets no commit rule', async () => undefined],
    ['requires approval with autonomous release off', requireApproval],
    ['requires approval with autonomous release on', async (f: Releasing) => { await requireApproval(f); await autonomous(f); }],
  ])('is not recorded where the department %s before a person approves it, and the refusal names what nobody checked', async (_rule, rule) => {
    const f = await releasing();
    await rule(f);
    bringsUnchecked(f);
    const run = await f.fullRun();
    const result = await f.recordRelease({ runId: run.id });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('ask_person') as unknown });
    expect(result.text).toContain(UNCHECKED);
  });

  it.each([['ask_person' as const], ['request_approval' as const]])('opens a card with %s that names exactly what nobody checked, also where the department sets no commit rule', async tool => {
    const f = await releasing();
    bringsUnchecked(f);
    const shown = await askedAndApproved(f, tool);
    expect(shown).toMatchObject({ kind: 'approval', commit: f.R, unchecked: [UNCHECKED_ITEM] });
    expect(shown.text).not.toContain('no check covers');
  });

  it('is recorded once a person approved the card that named it, with what it brings unchecked on its record', async () => {
    const f = await releasing();
    bringsUnchecked(f);
    const run = await f.fullRun();
    const shown = await askedAndApproved(f);
    const result = await f.recordRelease({ runId: run.id });
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({ approvalRequestId: shown.id, autonomousReleaseId: null, covered: false, uncovered: [UNCHECKED] });
  });

  it('is never approved by autonomous release, and a card a person approved records it there too', async () => {
    const f = await releasing();
    await requireApproval(f);
    await autonomous(f);
    bringsUnchecked(f);
    const run = await f.fullRun();
    const shown = await askedAndApproved(f);
    expect(shown.unchecked).toEqual([UNCHECKED_ITEM]);
    const result = await f.recordRelease({ runId: run.id });
    expect(recorded(result.text)).toMatchObject({ approvalRequestId: shown.id, autonomousReleaseId: null, covered: false });
  });

  it('takes no approval of its commit that did not name what nobody checked: one asked before that came, or in words of its own', async () => {
    const f = await releasing();
    await requireApproval(f);
    const run = await f.fullRun();
    await askedAndApproved(f);
    bringsUnchecked(f);
    const { request } = await ask(f.ctx, f.head.id, f.release.id, { kind: 'approval', text: `Release turn ${f.turn.number}: main to ${f.R}, all checked.`, commit: f.R });
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, request.id, { approve: true });
    const result = await f.recordRelease({ runId: run.id });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining(UNCHECKED) as unknown });
  });

  /* H4 of #1569: the holder writes the words of its card, and could write a block that reads as Hornhoof's. */
  it('takes no approval of a card whose holder wrote, in its own words, exactly the block Hornhoof would', async () => {
    const f = await releasing();
    bringsUnchecked(f);
    const run = await f.fullRun();
    const { request } = await ask(f.ctx, f.head.id, f.release.id, { kind: 'approval', text: `Release turn ${f.turn.number}: main to ${f.R}.\n\n${wordsBlock([UNCHECKED])}`, commit: f.R });
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, request.id, { approve: true });
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true, text: expect.stringContaining(UNCHECKED) as unknown });
  });

  /* B2 of #1569: people read the orchestrator's explanation in place of the words of a card, and it may leave the list out. */
  it('is not recorded from a card whose list was only in its words, under an explanation that left it out', async () => {
    const f = await releasing();
    bringsUnchecked(f);
    const run = await f.fullRun();
    const { request } = await ask(f.ctx, f.head.id, f.release.id, { kind: 'approval', text: `Release turn ${f.turn.number}: main to ${f.R}.\n\n${wordsBlock([UNCHECKED])}`, commit: f.R });
    await f.db.update(requests).set({ explained: 'The release of the turn is ready. Approve it to let it go to main.' }).where(eq(requests.id, request.id));
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, request.id, { approve: true });
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true, text: expect.stringContaining(UNCHECKED) as unknown });
  });

  it('is recorded from the card Hornhoof put the list on, which shows next to Approve whatever the explanation says', async () => {
    const f = await releasing();
    bringsUnchecked(f);
    const run = await f.fullRun();
    await f.call('ask_person', { task: f.release.number, question: `Release turn ${f.turn.number}: main to ${f.R}.`, commit: f.R });
    const shown = (await card(f))!;
    await f.db.update(requests).set({ explained: 'The release of the turn is ready. Approve it to let it go to main.' }).where(eq(requests.id, shown.id));
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, shown.id, { approve: true });
    expect(recorded((await f.recordRelease({ runId: run.id })).text)).toMatchObject({ approvalRequestId: shown.id, covered: false, uncovered: [UNCHECKED] });
  });

  it('asks again where what it brings unchecked changed since the card the person approved', async () => {
    const f = await releasing();
    bringsUnchecked(f);
    const run = await f.fullRun();
    await askedAndApproved(f);
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id));
    const result = await f.recordRelease({ runId: run.id });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining(`#${f.task.number}`) as unknown });
    const again = await askedAndApproved(f);
    expect(again.unchecked).toContainEqual({ kind: 'checker', task: f.task.number, commit: f.R });
    expect((await f.recordRelease({ runId: run.id })).isError).toBe(false);
  });

  it('fails closed where its commits could not all be read: a person sees that and approves it', async () => {
    const f = await releasing();
    f.repo.cut.add(`${BASE}..${f.R}`);
    const run = await f.fullRun();
    const refused = await f.recordRelease({ runId: run.id });
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining('could not all be read') as unknown });
    const shown = await askedAndApproved(f);
    expect(shown.unchecked).toEqual([{ kind: 'unread', base: BASE, commit: f.R }]);
    expect(recorded((await f.recordRelease({ runId: run.id })).text)).toMatchObject({ approvalRequestId: shown.id, covered: false });
  });

  it('still records a release every commit of which was checked, with no approval where the department sets no commit rule', async () => {
    const f = await releasing();
    const run = await f.fullRun();
    const result = await f.recordRelease({ runId: run.id });
    expect(recorded(result.text)).toMatchObject({ approvalRequestId: null, covered: true, uncovered: [] });
  });
});
