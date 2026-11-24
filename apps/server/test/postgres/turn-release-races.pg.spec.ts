import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Ctx } from '../../src/app.js';
import * as schema from '../../src/db/schema.js';
import { minuteRound } from '../../src/modules/agents/timers.js';
import { createTask, loadTask, report, submit } from '../../src/modules/tasks/engine.js';
import { routeOf } from '../../src/modules/tasks/echelons-store.js';
import { until } from '../helpers-basic.js';
import { appContext, backendPid, privatePostgres, type PostgresFixture } from './helpers.js';

const MAIN = 'a'.repeat(40);
const OWN = 'c'.repeat(40);
const RELEASE = '5'.repeat(40);
const LATER = '4'.repeat(40);

/* A repository as the tests say it is: branch and tag heads, and which commit holds which. */
type Repo = { heads: Record<string, string>; tags: Record<string, string>; holds: Record<string, string[]> };
function serve(ctx: Ctx, repo: Repo): void {
  ctx.readCommit = async (_at, want) => {
    const branch = 'branch' in want ? want.branch : `task-${want.task}`;
    const commitSha = repo.heads[branch] ?? repo.tags[branch];
    return commitSha ? { branch, commitSha } : { problem: `No branch ${branch}.` };
  };
  ctx.readCompare = async (_at, want) => {
    const held = want.head === want.base || (repo.holds[want.head] ?? []).includes(want.base);
    return { complete: true, baseSha: want.base, headSha: held ? want.head : 'f'.repeat(40), paths: ['screens/tasks.fig'], diff: '@@ -1 +1 @@\n-a\n+b', commits: held ? [{ sha: want.head, parents: [want.base] }] : [] };
  };
  ctx.readMerged = async (_at, want) => want.base === want.head || (repo.holds[want.base] ?? []).includes(want.head);
  ctx.readTags = async () => ({ tags: { ...repo.tags } });
}

/* Design keeping its work in a repository, nobody there to check it, so a submitted result goes straight to its head; a
   member of a turnkey team; the department's open turn, its release recorded and main tagged on it. */
async function released(pg: PostgresFixture) {
  const secret = randomBytes(32).toString('base64');
  const a = await appContext(pg, 'actor_a', secret, {});
  const b = await appContext(pg, 'actor_b', secret, {});
  const [company] = await pg.db.insert(schema.companies).values({ name: 'Races' }).returning();
  const [person] = await pg.db.insert(schema.people).values({ companyId: company!.id, name: 'Owner', email: 'races@example.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const [plan] = await pg.db.insert(schema.subscriptions).values({ companyId: company!.id, ownerPersonId: person!.id, provider: 'anthropic_api', kind: 'api_key', label: 'Plan', status: 'ready' }).returning();
  const [dept] = await pg.db.insert(schema.departments).values({ companyId: company!.id, templateKey: 'design', roleCode: 'DSN', repoUrl: 'https://github.com/acme/hornhoof-design.git' }).returning();
  const skills = (role: string) => a.ctx.templates.roles.get(role)!.skills.filter(s => s.on).map(s => s.id);
  const hire = async (name: string, kind: 'head' | 'worker', role: string) => (await pg.db.insert(schema.agents).values({ companyId: company!.id, departmentId: dept!.id, subscriptionId: plan!.id, name, kind, roleKey: role, model: 'claude-opus-5-5', skills: skills(role) }).returning())[0]!;
  const head = await hire('Head', 'head', 'DSN-HEAD');
  const author = await hire('Designer', 'worker', 'DSN-UI');
  const [team] = await pg.db.insert(schema.teams).values({ companyId: company!.id, departmentId: dept!.id, name: 'Lane', turnkey: true }).returning();
  const player = await hire('Player', 'worker', 'DSN-UI');
  await pg.db.update(schema.agents).set({ teamId: team!.id }).where(eq(schema.agents.id, player.id));
  const [turn] = await pg.db.insert(schema.turns).values({ companyId: company!.id, departmentId: dept!.id, number: 1, goal: 'Release', status: 'open', openedAt: new Date(), baseVersion: 'v1.6.0', baseCommit: MAIN }).returning();
  const branch = `turn-${turn!.number}`;
  const repo: Repo = { heads: { main: RELEASE, [branch]: RELEASE }, tags: { 'v1.6.0': MAIN, 'v1.7.0': RELEASE }, holds: { [RELEASE]: [MAIN], [OWN]: [MAIN], [LATER]: [OWN, RELEASE, MAIN] } };
  serve(a.ctx, repo);
  serve(b.ctx, repo);
  /* The release of the turn as the release tool keeps it, recorded before main moved: its release task, what the repository's CI
     said of its commit (green, with three checks), and the person's approval of it. */
  const [release] = await pg.db.insert(schema.tasks).values({ companyId: company!.id, number: 100, title: 'Release', status: 'open', departmentId: dept!.id, assigneeAgentId: head.id }).returning();
  const [approval] = await pg.db.insert(schema.requests).values({ companyId: company!.id, taskId: release!.id, agentId: head.id, kind: 'approval', text: 'Release turn 1.', commit: RELEASE, status: 'approved', answeredBy: person!.id, answeredAt: new Date() }).returning();
  await pg.db.insert(schema.turnReleases).values({ companyId: company!.id, turnId: turn!.id, commit: RELEASE, baseCommitSha: MAIN, ciState: 'green', ciChecks: 3, tasks: [], taskId: release!.id, approvalRequestId: approval!.id, requestedByAgentId: head.id, covered: true, uncovered: [] });
  const designTask = async () => {
    const { task } = await createTask(a.ctx, { agentId: head.id }, { title: 'Screen', brief: 'Lay out a screen.', body: 'Lay it out.', departmentId: dept!.id, assigneeAgentId: author.id, executor: true, small: false, riskClass: 'none', paths: ['screens/**'] });
    repo.heads[`task-${task.number}`] = OWN;
    await submit(a.ctx, author.id, task.id, { summary: 'The screen.', evidence: 'Every skin.', review: { baseCommit: MAIN } });
    const route = await routeOf(pg.db, await loadTask(pg.db, task.id));
    return { task, acceptance: { candidateId: route.state.candidateId!, revision: route.revision, integrationCommit: OWN } };
  };
  const turnkeyTask = async () => {
    const { task } = await createTask(a.ctx, { agentId: head.id }, { title: 'Icons', brief: 'Draw the icons.', body: 'Draw them.', departmentId: dept!.id, assigneeAgentId: player.id, executor: true, small: true, riskClass: 'none', paths: ['icons/**'] });
    repo.heads[`task-${task.number}`] = OWN;
    return task;
  };
  const openTurn = async () => (await pg.db.select().from(schema.turns).where(and(eq(schema.turns.departmentId, dept!.id), eq(schema.turns.status, 'open'))))[0]!;
  return { a, b, company: company!, dept: dept!, head, author, player, turn: turn!, branch, repo, designTask, turnkeyTask, openTurn };
}

/* Holds the company row the way a transaction of the other side does, until the test lets it go. */
async function holdCompany(pg: PostgresFixture, companyId: string) {
  const locker = await pg.pool('locker').connect();
  const pid = (await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM companies WHERE id = $1 FOR NO KEY UPDATE', [companyId]);
  const blocks = async (waiter: number) => (await pg.admin.query<{ blocked: boolean }>('SELECT $1::int = ANY(pg_blocking_pids($2)) AS blocked', [pid, waiter])).rows[0]?.blocked === true;
  return { locker, blocks, done: async () => { await locker.query('COMMIT'); locker.release(); } };
}

describe('closing a turn by its tag races the results that join it', () => {
  it('turns down an accepted result when the turn closed between its push and its transaction, saying it needs no new check for the same commit', async () => {
    const pg = await privatePostgres();
    const f = await released(pg);
    const { task, acceptance } = await f.designTask();
    f.repo.heads[f.branch] = OWN;
    f.repo.holds[OWN] = [MAIN];
    const held = await holdCompany(pg, f.company.id);
    const waiter = await backendPid(f.a.pool);
    const accepting = report(f.a.ctx, f.head.id, task.id, { done: true, summary: 'Fast-forwarded the turn.', acceptance }).then(() => null, (err: { status: number; message: string }) => err);
    await until(() => held.blocks(waiter));
    await held.locker.query(`UPDATE turns SET status = 'closed', closed_at = now(), version = 'v1.7.0', commit = $2 WHERE id = $1`, [f.turn.id, RELEASE]);
    await held.locker.query(`INSERT INTO turns(company_id, department_id, number, goal, status, opened_at, base_version, base_commit, start_commit) VALUES ($1, $2, 2, 'Next', 'open', now(), 'v1.7.0', $3, $3)`, [f.company.id, f.dept.id, RELEASE]);
    await held.done();
    expect(await accepting).toMatchObject({ status: 409, message: expect.stringContaining('turn-2') as unknown });
    expect((await accepting)!.message).toMatch(/same commit/);
    expect(await loadTask(pg.db, task.id)).toMatchObject({ turnId: null });
  });

  it.each(['echelons', 'turnkey'] as const)('waits a minute to close when a %s result joins the turn as the repository is read, then starts the next turn from a head that holds it', async kind => {
    const pg = await privatePostgres();
    const f = await released(pg);
    const ready = kind === 'echelons' ? await f.designTask() : null;
    const turnkey = kind === 'turnkey' ? await f.turnkeyTask() : null;
    const read = f.b.ctx.readCommit;
    let joined = null as Promise<unknown> | null;
    f.b.ctx.readCommit = async (repo, want) => {
      const at = await read(repo, want);
      if (!joined && 'branch' in want && want.branch === f.branch) {
        f.repo.heads[f.branch] = LATER;
        joined = ready
          ? report(f.a.ctx, f.head.id, ready.task.id, { done: true, summary: 'Fast-forwarded the turn.', acceptance: ready.acceptance })
          : report(f.a.ctx, f.player.id, turnkey!.id, { done: true, summary: 'Fast-forwarded the turn to task-N.', turnkey: { commit: OWN, baseCommit: MAIN } });
        await joined;
      }
      return at;
    };
    await minuteRound(f.b.ctx, new Date(), () => () => undefined);
    expect(joined).not.toBeNull();
    /* The join happens inside the read of the head, whose failure the release round swallows: a report the server turned
       down has to say so here, in its own words, and not show up below as a task still open. */
    await joined;
    const id = (ready?.task ?? turnkey!).id;
    expect(await loadTask(pg.db, id)).toMatchObject({ status: 'done', turnId: f.turn.id });
    expect(await f.openTurn()).toMatchObject({ id: f.turn.id });
    await minuteRound(f.b.ctx, new Date(), () => () => undefined);
    const next = await f.openTurn();
    expect(next.id).not.toBe(f.turn.id);
    expect(next).toMatchObject({ startCommit: LATER, baseVersion: 'v1.7.0' });
    expect(f.repo.holds[LATER]).toContain(OWN);
    expect(await loadTask(pg.db, id)).toMatchObject({ turnId: next.id });
  });
});
