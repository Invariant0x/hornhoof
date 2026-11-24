import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, departments, jobs, requests, turns, waitNotices } from '../src/db/schema.js';
import { answer, ask, createTask } from '../src/modules/tasks/engine.js';
import { recordRelease, releaseRound } from '../src/modules/tasks/releases.js';
import { ensureOpenTurn } from '../src/modules/tasks/turn-department.js';
import { BASE } from './development-echelons-fixture.js';
import { ownDatabases } from './helpers.js';
import { approvalCard, releasing, serveEach, type Repository } from './turn-release-fixture.js';

ownDatabases();

/* Each department keeps its own repository and its own line of versions: its turns close on the tags of its own repository,
   the next one goes on from its own last tag, and nothing compares it with Hornhoof's version or another department's. */

const SITE = 'https://github.com/acme/characters.git';
const SITE_MAIN = '7'.repeat(40);
const SITE_R = '8'.repeat(40);
const SITE_LATER = '9'.repeat(40);
const LATER = '4'.repeat(40);
const OTHER = '3'.repeat(40);

type Releasing = Awaited<ReturnType<typeof releasing>>;

/* The open turn of a department, read now. */
const openOf = async (f: Releasing, departmentId: string) =>
  (await f.db.select().from(turns).where(and(eq(turns.departmentId, departmentId), eq(turns.status, 'open'))))[0]!;
const turnById = async (f: Releasing, id: string) => (await f.db.select().from(turns).where(eq(turns.id, id)))[0]!;
/* What the head of a department and the CEO were told of a version tag that released nothing. */
const toldOfTags = async (f: Releasing) => (await f.db.select().from(waitNotices)).filter(n => n.dedupKey.startsWith('release_tag:'));

/* A second top-level department with a repository of its own and its head, its open turn, its release task and the head's job. */
async function siteDepartment(f: Releasing) {
  const companyId = f.task.companyId;
  const [department] = await f.db.insert(departments).values({ companyId, name: 'Characters site', templateKey: 'development', roleCode: 'SITE', repoUrl: SITE }).returning();
  const [head] = await f.db.insert(agents).values({ companyId, departmentId: department!.id, name: 'Site head', kind: 'head', roleKey: 'DEV-HEAD', subscriptionId: f.claude.id, model: 'claude-opus-5-5' }).returning();
  const turn = (await f.db.transaction(tx => ensureOpenTurn(tx, companyId, department!.id)))!;
  const { task: release } = await createTask(f.ctx, { agentId: head!.id }, {
    title: 'Release the site', brief: 'Release the open turn of the site.', body: 'Fast-forward main to the turn and tag it.',
    departmentId: department!.id, assigneeAgentId: head!.id, executor: false, resultKind: 'coordination', small: true, riskClass: 'none',
  });
  await f.db.insert(jobs).values({ companyId, agentId: head!.id, subscriptionId: f.claude.id, taskId: release.id, kind: 'conversation', prompt: 'Release', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken('site-head-tool-token-0123456789abcdef01234') });
  const repo: Repository = { heads: { main: SITE_MAIN, [`turn-${turn.number}`]: SITE_R }, tags: {}, holds: { [SITE_R]: [SITE_MAIN] }, between: { [`${SITE_MAIN}..${SITE_R}`]: [{ sha: SITE_R, parents: [SITE_MAIN] }] }, cut: new Set() };
  /* The release of the site's open turn at commit, recorded by its head before main moves: the CEO's approval of it, and the
     repository's CI, which says what the fixture says. */
  const releaseAt = async (commit: string) => {
    const asked = await ask(f.ctx, head!.id, release.id, await approvalCard(f.ctx, release, `Release the site: main to ${commit}.`, commit));
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, asked.request.id, { approve: true });
    return recordRelease(f.ctx, head!.id, companyId, { task: release.number, commit });
  };
  return { department: department!, head: head!, turn, release, repo, releaseAt };
}

/* The release of the fixture department's open turn at commit, recorded with release_turn before main moves. */
async function releaseShopAt(f: Releasing, commit: string) {
  await f.approve(commit);
  const recorded = await f.recordRelease({ commit });
  expect(recorded.isError, recorded.text).toBe(false);
  return recorded;
}

describe('each department repository keeps its own line of versions', () => {
  it('releases two departments with their own repositories and lines of versions independently', async () => {
    const f = await releasing();
    const site = await siteDepartment(f);
    serveEach(f.ctx, url => (url === SITE ? site.repo : f.repo));
    const failed = vi.spyOn(f.ctx.log, 'error');
    /* Development goes on 0.N.0 from v0.31.0; the site has no version tag yet, so its first release is its first tag. */
    f.repo.tags['v0.31.0'] = BASE;
    await releaseRound(f.ctx);
    expect(await openOf(f, f.task.departmentId!)).toMatchObject({ id: f.turn.id, baseVersion: 'v0.31.0', baseCommit: BASE });
    expect(await openOf(f, site.department.id)).toMatchObject({ id: site.turn.id, baseVersion: null });

    await releaseShopAt(f, f.R);
    await site.releaseAt(SITE_R);

    /* The site comes out first, on its own tag: Development's turn stays open where it started. */
    site.repo.heads.main = SITE_R;
    site.repo.tags['v2026.11.0'] = SITE_R;
    await releaseRound(f.ctx);
    expect(await turnById(f, site.turn.id)).toMatchObject({ status: 'closed', version: 'v2026.11.0', commit: SITE_R });
    const siteNext = await openOf(f, site.department.id);
    expect(siteNext).toMatchObject({ baseVersion: 'v2026.11.0', baseCommit: SITE_R, startCommit: SITE_R });
    expect(await openOf(f, f.task.departmentId!)).toMatchObject({ id: f.turn.id, baseVersion: 'v0.31.0' });

    /* Then Development, on its own tag: the site's next turn goes on from its own last tag, untouched. */
    f.repo.heads.main = f.R;
    f.repo.tags['v0.32.0'] = f.R;
    await releaseRound(f.ctx);
    expect(await turnById(f, f.turn.id)).toMatchObject({ status: 'closed', version: 'v0.32.0', commit: f.R });
    const shopNext = await openOf(f, f.task.departmentId!);
    expect(shopNext).toMatchObject({ baseVersion: 'v0.32.0', baseCommit: f.R });
    expect(await openOf(f, site.department.id)).toMatchObject({ id: siteNext.id, baseVersion: 'v2026.11.0' });

    /* Each next turn's branch is made in its own repository only. */
    expect(site.repo.made).toEqual([{ branch: `turn-${siteNext.number}`, commit: SITE_R }]);
    expect(f.repo.made).toEqual([{ branch: `turn-${shopNext.number}`, commit: f.R }]);

    /* The site's second release goes on from its own last tag, whatever Development's version is. */
    site.repo.heads[`turn-${siteNext.number}`] = SITE_LATER;
    site.repo.holds[SITE_LATER] = [SITE_R, SITE_MAIN];
    site.repo.between[`${SITE_R}..${SITE_LATER}`] = [{ sha: SITE_LATER, parents: [SITE_R] }];
    await site.releaseAt(SITE_LATER);
    site.repo.heads.main = SITE_LATER;
    site.repo.tags['v2026.11.1'] = SITE_LATER;
    await releaseRound(f.ctx);
    expect(await turnById(f, siteNext.id)).toMatchObject({ status: 'closed', version: 'v2026.11.1', commit: SITE_LATER });
    expect(await openOf(f, site.department.id)).toMatchObject({ baseVersion: 'v2026.11.1', baseCommit: SITE_LATER });
    expect(await openOf(f, f.task.departmentId!)).toMatchObject({ id: shopNext.id, baseVersion: 'v0.32.0' });

    /* No release went wrong, and nobody heard of a tag that released nothing. */
    expect(await toldOfTags(f)).toEqual([]);
    expect(failed).not.toHaveBeenCalled();
  });

  it.each([
    ['v1.4.0', 'v1.5.0'],
    ['v2026.11.0', 'v2026.11.1'],
  ])('closes the turn of a repository whose first version tag is its first release, %s, and the next one on %s', async (first, second) => {
    const f = await releasing();
    await releaseRound(f.ctx);
    expect(await openOf(f, f.task.departmentId!)).toMatchObject({ id: f.turn.id, baseVersion: null });

    const recorded = await releaseShopAt(f, f.R);
    expect(recorded.text).toContain('first version tag');
    f.repo.heads.main = f.R;
    f.repo.tags[first] = f.R;
    await releaseRound(f.ctx);
    expect(await turnById(f, f.turn.id)).toMatchObject({ status: 'closed', version: first, commit: f.R });
    const next = await openOf(f, f.task.departmentId!);
    expect(next).toMatchObject({ baseVersion: first, baseCommit: f.R, startCommit: f.R });

    /* The next turn goes on from that first tag, and its own release tag closes it. */
    f.repo.heads[`turn-${next.number}`] = LATER;
    f.repo.holds[LATER] = [f.R, BASE];
    f.repo.between[`${f.R}..${LATER}`] = [{ sha: LATER, parents: [f.R] }];
    const again = await releaseShopAt(f, LATER);
    expect(again.text).toContain(`after ${first}`);
    f.repo.heads.main = LATER;
    f.repo.tags[second] = LATER;
    await releaseRound(f.ctx);
    expect(await turnById(f, next.id)).toMatchObject({ status: 'closed', version: second, commit: LATER });
    expect(await openOf(f, f.task.departmentId!)).toMatchObject({ baseVersion: second, baseCommit: LATER });
    expect(await toldOfTags(f)).toEqual([]);
  });

  it('takes a first tag on a commit no release of the turn was recorded on as where the turn starts, and tells nobody', async () => {
    const f = await releasing();
    await releaseRound(f.ctx);
    await releaseShopAt(f, f.R);
    f.repo.holds[OTHER] = [BASE];
    f.repo.tags['v1.4.0'] = OTHER;
    await releaseRound(f.ctx);
    expect(await openOf(f, f.task.departmentId!)).toMatchObject({ id: f.turn.id, status: 'open', baseVersion: 'v1.4.0', baseCommit: OTHER });
    expect(await toldOfTags(f)).toEqual([]);
  });

  it('keeps the turn open on a first tag whose approval no longer stands, and tells its head it is the first version tag', async () => {
    const f = await releasing();
    await releaseRound(f.ctx);
    await releaseShopAt(f, f.R);
    await f.db.update(requests).set({ status: 'declined' }).where(eq(requests.taskId, f.release.id));
    f.repo.heads.main = f.R;
    f.repo.tags['v1.4.0'] = f.R;
    await releaseRound(f.ctx);
    expect(await openOf(f, f.task.departmentId!)).toMatchObject({ id: f.turn.id, status: 'open', baseVersion: null });
    const head = (await toldOfTags(f)).find(n => n.agentId === f.head.id)!;
    expect(head.message.text).toContain('the first version tag');
    expect(head.message.text).not.toContain('null');
  });
});
