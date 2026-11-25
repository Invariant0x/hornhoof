import { and, eq, isNull, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, approvalPolicies, departments, jobs, tasks, teams, turns } from '../src/db/schema.js';
import { answer, ask, loadTask, report } from '../src/modules/tasks/engine.js';
import { BASE, fixture } from './development-echelons-fixture.js';
import { as, listen, mcp, SETUP, testApp } from './helpers.js';
import { recorded } from './recorded-fixture.js';
import { sessionFrom } from './helpers-basic.js';
import { readyInTurn, serve, type Repository } from './turn-release-fixture.js';

const MERGED = 'd'.repeat(40);
const PAST = 'e'.repeat(40);
const START = '9'.repeat(40);

const reportOf = async (f: Awaited<ReturnType<typeof readyInTurn>>, id = f.task.id) => (await f.detail(id)).log.findLast(event => event.kind === 'report')?.data;

describe('a department that releases its work has one open turn, the release it gets ready', () => {
  it('opens none for a top-level department that keeps no repository: the one setup makes and one built later', async () => {
    const { app, db } = await testApp();
    const ceo = sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }));
    const built = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'support', checked: true, note: 'Answers customers.' }] }, ...as(ceo) });
    expect(built.statusCode).toBeLessThan(300);
    const tops = await db.select().from(departments).where(isNull(departments.parentId));
    expect(tops.map(top => top.templateKey).sort()).toEqual(['operations', 'support']);
    for (const top of tops) expect(await db.select().from(turns).where(and(eq(turns.departmentId, top.id), eq(turns.status, 'open')))).toHaveLength(0);
  });

  it('offers no tools to plan, merge or switch the mode of turns', async () => {
    const f = await fixture();
    await listen(f.app);
    const token = 'turn-tools-head-token-0123456789abcdef0123456';
    await f.db.insert(jobs).values({ companyId: f.task.companyId, subscriptionId: f.head.subscriptionId!, agentId: f.head.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    const tools = (await (await mcp(f.app, token)).listTools()).tools;
    const names = tools.map(tool => tool.name);
    expect(names).not.toContain('plan_turn');
    expect(names).not.toContain('merge_turn');
    expect(names).toContain('release_turn');
    const edit = tools.find(tool => tool.name === 'edit_turn');
    expect(Object.keys((edit?.inputSchema.properties ?? {}) as object)).not.toContain('mode');
    const add = tools.find(tool => tool.name === 'add_tasks');
    expect(Object.keys((add?.inputSchema.properties ?? {}) as object)).not.toContain('turn');
  });
});

describe('the team of its holder, not a turn, decides the route of a task', () => {
  it('sends the work of a department with a repository through the echelons with no turn', async () => {
    const f = await fixture({ turn: null });
    expect((await loadTask(f.db, f.task.id)).turnId).toBeNull();
    const route = (await f.detail()).echelons;
    expect(route.resultKind).toBe('code');
    expect(route.stages.map(step => step.stage)).toContain('review');
  });

  it('keeps the work of a member of a turnkey team turnkey', async () => {
    const f = await fixture({ turn: null });
    const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, f.author.id));
    const { task } = await f.create({ reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
    expect((await f.detail(task.id)).echelons).toMatchObject({ resultKind: 'turnkey', stages: [] });
    expect(task.turnId).toBeNull();
  });
});

describe('a result joins the open turn of its department as its head accepts it', () => {
  it('gives the task the open turn and keeps the fast-forward commit as its integration', async () => {
    const f = await readyInTurn();
    const moved = await f.accept();
    expect(moved.task).toMatchObject({ status: 'done', turnId: f.turn.id });
    expect(await reportOf(f)).toMatchObject({ acceptedCandidate: { integration: { branch: f.branch, commit: f.finalCommit } } });
  });

  it('takes the candidate when the turn branch has already gone past it', async () => {
    const f = await readyInTurn();
    f.repo.heads[f.branch] = PAST;
    f.repo.holds[PAST] = [f.finalCommit, ...f.repo.holds[f.finalCommit]!];
    const moved = await f.accept();
    expect(moved.task).toMatchObject({ status: 'done', turnId: f.turn.id });
  });

  it('refuses a merge on the turn branch: the turn takes a candidate only by fast-forward', async () => {
    const f = await readyInTurn();
    f.repo.heads[f.branch] = MERGED;
    f.repo.holds[MERGED] = [f.finalCommit, ...f.repo.holds[f.finalCommit]!];
    await expect(f.accept({ integrationCommit: MERGED })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('fast-forward') as unknown });
    expect(await loadTask(f.db, f.task.id)).toMatchObject({ status: 'open', turnId: null });
  });

  it('refuses the first result of a turn whose branch does not hold the commit the turn started from', async () => {
    const f = await readyInTurn();
    await f.db.execute(sql`update turns set start_commit = ${START} where id = ${f.turn.id}`);
    await expect(f.accept()).rejects.toMatchObject({ status: 409, message: expect.stringContaining(START) as unknown });
    /* A refusal of a pair of commits stays proved, so the turn branch goes on to a new head that holds the start commit. */
    f.repo.heads[f.branch] = PAST;
    f.repo.holds[PAST] = [f.finalCommit, START, ...f.repo.holds[f.finalCommit]!];
    expect((await f.accept()).task).toMatchObject({ status: 'done', turnId: f.turn.id });
  });

  it('refuses when the turn closed between reading its branch and accepting, and says that the same commit needs no new check', async () => {
    const f = await readyInTurn();
    const read = f.ctx.readCommit;
    f.ctx.readCommit = async (repo, want) => {
      const at = await read(repo, want);
      if ('branch' in want && want.branch === f.branch) {
        await f.db.update(turns).set({ status: 'closed', closedAt: new Date() }).where(eq(turns.id, f.turn.id));
        await f.db.insert(turns).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, number: f.turn.number + 1, goal: 'Next release', status: 'open', openedAt: new Date() });
      }
      return at;
    };
    const refused = f.accept().then(() => null, (err: { status: number; message: string }) => err);
    expect(await refused).toMatchObject({ status: 409, message: expect.stringContaining(`turn-${f.turn.number + 1}`) as unknown });
    expect((await refused)!.message).toMatch(/same commit/);
    expect(await loadTask(f.db, f.task.id)).toMatchObject({ status: 'open', turnId: null });
  });

  /* A product has no rules of its own: the department that holds it decides whether its main needs a person's yes. */
  const productOnMain = async () => {
    const f = await readyInTurn();
    const [product] = await f.db.insert(departments).values({ companyId: f.task.companyId, parentId: f.task.departmentId!, roleCode: 'DEV', repoUrl: 'https://github.com/acme/app.git' }).returning();
    await f.db.update(tasks).set({ productId: product!.id }).where(eq(tasks.id, f.task.id));
    f.repo.heads.main = f.finalCommit;
    return f;
  };

  it('sends the result of a product with a repository of its own to main and into no turn with no approval while its department sets no commit rule', async () => {
    const f = await productOnMain();
    expect((await f.accept()).task).toMatchObject({ status: 'done', turnId: null });
    expect(await reportOf(f)).toMatchObject({ acceptedCandidate: { integration: { branch: 'main', commit: f.finalCommit, approval: null } } });
  });

  it('sends the result of a product with a repository of its own to main, with a person approving it under its department\'s every rule, and into no turn', async () => {
    const f = await productOnMain();
    await f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });
    await expect(f.accept()).rejects.toMatchObject({ status: 403 });
    expect(await loadTask(f.db, f.task.id)).toMatchObject({ status: 'open', turnId: null });
    const asked = await ask(f.ctx, f.head.id, f.task.id, { kind: 'approval', text: 'Approve this exact main integration.', commit: f.finalCommit });
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, asked.request.id, { approve: true });
    expect((await f.accept()).task).toMatchObject({ status: 'done', turnId: null });
    expect(await reportOf(f)).toMatchObject({ acceptedCandidate: { integration: { branch: 'main', commit: f.finalCommit, approval: asked.request.id } } });
  });
});

describe('a turn whose branch the repository does not have yet', () => {
  const refusal = (moving: Promise<unknown>) => moving.then(() => null, (err: { status: number; message: string }) => err);

  it('makes it from the head of main for a first turn and says to fast-forward it, then the result joins it', async () => {
    const f = await readyInTurn();
    delete f.repo.heads[f.branch];
    const refused = await refusal(f.accept());
    expect(refused).toMatchObject({ status: 409, message: expect.stringContaining('fast-forward') as unknown });
    expect(refused!.message).not.toMatch(/could not be read/);
    expect(f.repo.made).toEqual([{ branch: f.branch, commit: BASE }]);
    expect(await f.openTurn()).toMatchObject({ id: f.turn.id, startCommit: BASE });
    f.repo.heads[f.branch] = f.finalCommit;
    expect((await f.accept()).task).toMatchObject({ status: 'done', turnId: f.turn.id });
    expect(f.repo.made).toHaveLength(1);
  });

  it('makes it from where the turn starts, before the release the turn came from or main', async () => {
    const f = await readyInTurn();
    delete f.repo.heads[f.branch];
    await f.db.update(turns).set({ startCommit: START, baseCommit: MERGED }).where(eq(turns.id, f.turn.id));
    await refusal(f.accept());
    expect(f.repo.made).toEqual([{ branch: f.branch, commit: START }]);
    await f.db.update(turns).set({ startCommit: null }).where(eq(turns.id, f.turn.id));
    delete f.repo.heads[f.branch];
    await refusal(f.accept());
    expect(f.repo.made!.at(-1)).toEqual({ branch: f.branch, commit: MERGED });
  });

  it('never makes or moves a turn branch that is there, and refuses as before what it does not hold', async () => {
    const f = await readyInTurn();
    f.repo.heads[f.branch] = PAST;
    const refused = await refusal(f.accept());
    expect(refused).toMatchObject({ status: 409, message: expect.stringContaining(`does not hold ${f.finalCommit}`) as unknown });
    expect(f.repo.heads[f.branch]).toBe(PAST);
    expect(f.repo.made).toBeUndefined();
    expect(await f.openTurn()).toMatchObject({ startCommit: null });
  });

  it('says why it could not make the branch, not that it could not be read, and changes nothing', async () => {
    const f = await readyInTurn();
    delete f.repo.heads[f.branch];
    f.repo.refusing = `Hornhoof could not create the branch ${f.branch} in https://github.com/acme/app.git: it answered 403, so its token may not push to it.`;
    const refused = await refusal(f.accept());
    expect(refused).toMatchObject({ status: 409, message: expect.stringContaining('it answered 403') as unknown });
    expect(refused!.message).not.toMatch(/could not be read/);
    expect(f.repo.heads[f.branch]).toBeUndefined();
    expect(await f.openTurn()).toMatchObject({ startCommit: null });
    expect(await loadTask(f.db, f.task.id)).toMatchObject({ status: 'open', turnId: null });
  });

  it('says what the repository said when its branches cannot be read', async () => {
    const f = await readyInTurn();
    delete f.repo.heads[f.branch];
    f.ctx.readBranches = async () => ({ problem: 'Hornhoof could not read the branches of https://github.com/acme/app.git: it could not be reached.' });
    const refused = await refusal(f.accept());
    expect(refused).toMatchObject({ status: 409, message: expect.stringContaining('it could not be reached') as unknown });
    expect(f.repo.made).toBeUndefined();
  });

  it('lets one of two results that come at once make it; the other finds it made and goes the usual way', async () => {
    const f = await turnkeyInTurn();
    const second = await f.create({ assigneeAgentId: f.player.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
    const theirs = 'b'.repeat(40);
    f.repo.heads[`task-${second.task.number}`] = theirs;
    f.repo.holds[theirs] = ['a'.repeat(40)];
    delete f.repo.heads[`turn-${f.turn.number}`];
    let release: () => void = () => undefined;
    const both = new Promise<void>(done => { release = done; });
    let pushes = 0;
    f.repo.hold = async () => { if (++pushes === 2) release(); await both; };
    const doneOf = (id: string) => report(f.ctx, f.player.id, id, { done: true, summary: 'Fast-forwarded the turn to task-N, checks in the log.', turnkey: { commit: theirs, baseCommit: 'a'.repeat(40) } });
    const answers = await Promise.all([refusal(f.done()), refusal(doneOf(second.task.id))]);
    expect(pushes).toBe(2);
    expect(f.repo.made).toEqual([{ branch: `turn-${f.turn.number}`, commit: 'a'.repeat(40) }]);
    for (const refused of answers) {
      expect(refused).toMatchObject({ status: 409, message: expect.stringContaining('fast-forward') as unknown });
      expect(refused!.message).not.toMatch(/could not be (read|created)/);
    }
    f.repo.hold = undefined;
    const both2 = 'f'.repeat(40);
    f.repo.heads[`turn-${f.turn.number}`] = both2;
    f.repo.holds[both2] = [f.own, theirs, 'a'.repeat(40)];
    expect((await f.done()).task).toMatchObject({ status: 'done', turnId: f.turn.id });
    expect((await doneOf(second.task.id)).task).toMatchObject({ status: 'done', turnId: f.turn.id });
    expect(f.repo.made).toHaveLength(1);
  });
});

/* A member of a turnkey team in a department with a repository, its task-N branch and the department's open turn. */
async function turnkeyInTurn() {
  const f = await fixture();
  const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
  const player = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, player.id));
  const { task } = await f.create({ assigneeAgentId: player.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
  const [turn] = await f.db.select().from(turns).where(and(eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open')));
  const own = 'c'.repeat(40);
  const repo: Repository = { heads: { main: 'a'.repeat(40), [`turn-${turn!.number}`]: PAST, [`task-${task.number}`]: own }, tags: {}, holds: { [PAST]: [own, 'a'.repeat(40)], [own]: ['a'.repeat(40)] }, between: {}, cut: new Set<string>() };
  serve(f.ctx, repo);
  const done = async () => report(f.ctx, player.id, task.id, { done: true, summary: 'Fast-forwarded the turn to task-N, checks in the log.', turnkey: { commit: own, baseCommit: 'a'.repeat(40) }, ...(await recorded(f.ctx, task.id, player.id)) });
  const lastReport = async () => (await f.detail(task.id)).log.findLast(event => event.kind === 'report')?.data;
  return { ...f, player, task, turn: turn!, own, repo, done, lastReport };
}

describe('turnkey work of a department with a repository', () => {
  it('joins the open turn when the turn branch holds its own branch, with its integration commit', async () => {
    const f = await turnkeyInTurn();
    expect((await f.done()).task).toMatchObject({ status: 'done', turnId: f.turn.id });
    expect(await f.lastReport()).toMatchObject({ integration: { branch: `turn-${f.turn.number}`, commit: f.own } });
  });

  it('is refused while the turn branch does not hold its own branch', async () => {
    const f = await turnkeyInTurn();
    f.repo.holds[PAST] = ['a'.repeat(40)];
    await expect(f.done()).rejects.toMatchObject({ status: 409, message: expect.stringContaining(`turn-${f.turn.number}`) as unknown });
    expect(await loadTask(f.db, f.task.id)).toMatchObject({ status: expect.not.stringMatching(/done/) as unknown, turnId: null });
  });

  it('closes outside every release when it has no branch of its own', async () => {
    const f = await turnkeyInTurn();
    delete f.repo.heads[`task-${f.task.number}`];
    expect((await f.done()).task).toMatchObject({ status: 'done', turnId: null });
  });
});
