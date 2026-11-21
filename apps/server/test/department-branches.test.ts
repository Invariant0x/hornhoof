import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { departments, tasks } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import type { RepoAddress } from '../src/modules/testruns/refs.js';
import { COMPARES_PER_READ, UNSETTLED_MS } from '../src/modules/departments/branches.js';
import { mergedIn, readMerged } from '../src/modules/testruns/compare.js';
import { company } from './department-owner-fixture.js';
import { as } from './helpers.js';

/* Work a department did before waits in its repository on the branches of its tasks, and not always in main yet. Who goes on
   with it reads which of them are accepted or handed in and not in main, and so do the people who run the department. The
   repository and GitHub are not ours: their answers come from recorded samples. */

type C = Awaited<ReturnType<typeof company>>;
type Res = { content: { type: string; text: string }[]; isError?: boolean };
const sha = (n: number) => n.toString(16).padStart(40, 'a');

/* Development keeps https://github.com/acme/shop.git; Sales keeps its own repository. */
async function staged() {
  const c = await company();
  await c.db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git', repoBranch: 'main' }).where(eq(departments.id, c.dev.id));
  await c.db.update(departments).set({ repoUrl: 'https://github.com/acme/sales.git', repoBranch: 'main' }).where(eq(departments.id, c.sales.id));
  const task = async (title: string, status: 'done' | 'review' | 'cancelled', departmentId = c.dev.id, head = c.head, assignee = c.worker) => {
    const made = (await createTask(c.app.ctx, { agentId: head.id }, { title, brief: '', body: '', departmentId, assigneeAgentId: assignee.id, executor: true, resultKind: 'code' })).task;
    await c.db.update(tasks).set({ status, ...(status === 'review' ? {} : { closedAt: new Date('2026-11-13T17:20:00.000Z') }) }).where(eq(tasks.id, made.id));
    return made.number;
  };
  const leads = await task('Collect leads', 'done');
  const merged = await task('Landing page', 'done');
  const handed = await task('Lead scoring', 'review');
  const dropped = await task('Old idea', 'cancelled');
  const noBranch = await task('Plan the pilot', 'done');
  const theirs = await task('Deal desk', 'done', c.sales.id, c.salesHead, c.seller);
  const heads: Record<string, string> = {
    main: sha(1),
    [`task-${leads}`]: sha(leads),
    [`task-${merged}`]: sha(merged),
    [`task-${handed}-scoring`]: sha(handed),
    [`task-${dropped}`]: sha(dropped),
    [`task-${theirs}`]: sha(theirs),
    [`task-${c.task.number}`]: sha(c.task.number),
  };
  const asked: string[] = [];
  c.app.ctx.readBranches = async (repo: RepoAddress) => {
    asked.push(repo.url);
    return repo.url.endsWith('/shop.git') ? { heads } : { heads: { main: sha(2), [`task-${theirs}`]: sha(theirs) } };
  };
  /* GitHub's compare of main with each branch head: the landing page went in, the rest did not. */
  c.app.ctx.readMerged = async (_repo, refs) => {
    expect(refs.base).toBe('main');
    return refs.head === sha(merged);
  };
  const open = [
    { task: handed, title: 'Lead scoring', status: 'review', branch: `task-${handed}-scoring`, commit: sha(handed), merged: false },
    { task: leads, title: 'Collect leads', status: 'done', branch: `task-${leads}`, commit: sha(leads), merged: false },
  ];
  return { ...c, numbers: { leads, merged, handed, dropped, noBranch, theirs }, open, asked, heads };
}

const send = (c: C, token: string, url: string) => c.app.inject({ method: 'GET', url, ...as(token) });
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Res;

describe("a department's branches not in main yet", () => {
  it('come with the task an agent of the department reads, newest first, without merged, cancelled, other departments or its own task', async () => {
    const c = await staged();
    const bruno = await c.tools(c.worker);
    const read = await call(bruno, 'task', { task: c.task.number });
    expect(read.isError).toBeFalsy();
    expect(JSON.parse(read.content[0]!.text).departmentBranches).toEqual(c.open);
  });

  it('go to no agent of another department, even one the task is given to, nor why they cannot be read; the orchestrator reads them', async () => {
    const c = await staged();
    await c.db.update(tasks).set({ assigneeAgentId: c.seller.id, executorAgentId: c.seller.id }).where(eq(tasks.id, c.task.id));
    const read = async (agent: { id: string }) => JSON.parse((await call(await c.tools(agent), 'task', { task: c.task.number })).content[0]!.text);
    const sid = await read(c.seller);
    expect(sid.title).toBe('Checkout');
    expect(sid).not.toHaveProperty('departmentBranches');
    expect(JSON.stringify(sid)).not.toContain(sha(c.numbers.leads));
    expect((await read(c.orchestrator)).departmentBranches).toEqual(c.open);
    expect((await send(c, c.samToken, `/api/tasks/${c.task.id}`)).body).not.toContain(sha(c.numbers.leads));
    c.app.ctx.readBranches = async () => ({ problem: 'Hornhoof could not read the branches of https://github.com/acme/shop.git: it answered 404.' });
    expect(await read(c.seller)).not.toHaveProperty('departmentBranchesProblem');
    expect((await read(c.head)).departmentBranchesProblem).toContain('it answered 404');
  });

  it('say the merge is unknown where the repository cannot tell, and say why when its branches cannot be read', async () => {
    const c = await staged();
    c.app.ctx.readMerged = async () => null;
    const bruno = await c.tools(c.worker);
    const unknown = JSON.parse((await call(bruno, 'task', { task: c.task.number })).content[0]!.text).departmentBranches as { merged: boolean | null }[];
    expect(unknown.map(b => b.merged)).toEqual([null, null, null]);
    c.app.ctx.readBranches = async () => ({ problem: 'Hornhoof could not read the branches of https://github.com/acme/shop.git: it answered 404.' });
    const page = await send(c, c.danaToken, `/api/departments/${c.dev.id}/branches`);
    expect(page.json()).toEqual({ branches: [], problem: 'Hornhoof could not read the branches of https://github.com/acme/shop.git: it answered 404.' });
  });

  it('show to the people who run the department and to the CEO, and to nobody of another department', async () => {
    const c = await staged();
    const dana = await send(c, c.danaToken, `/api/departments/${c.dev.id}/branches`);
    expect(dana.statusCode).toBe(200);
    expect(dana.json()).toEqual({ branches: c.open, problem: null });
    expect((await send(c, c.ceoToken, `/api/departments/${c.dev.id}/branches`)).json().branches).toEqual(c.open);
    expect((await send(c, c.samToken, `/api/departments/${c.dev.id}/branches`)).statusCode).toBe(403);
    expect((await send(c, c.samToken, `/api/departments/${c.sales.id}/branches`)).json().branches).toEqual([
      { task: c.numbers.theirs, title: 'Deal desk', status: 'done', branch: `task-${c.numbers.theirs}`, commit: sha(c.numbers.theirs), merged: false },
    ]);
  });

  it('are none for a department without a repository, which reads nothing', async () => {
    const c = await staged();
    await c.db.update(departments).set({ repoUrl: null }).where(eq(departments.id, c.dev.id));
    expect((await send(c, c.danaToken, `/api/departments/${c.dev.id}/branches`)).json()).toEqual({ branches: [], problem: null });
    expect(c.asked).toEqual([]);
  });
});

/* Every task read of every agent of the department asks this, so GitHub's request limit, which the whole server shares, would
   not last an hour. A commit in the main line stays there; one that is not, or that GitHub could not tell of, can change only
   as the main line moves, which its refs say without GitHub's API, and is asked again then, or after a few minutes. */
describe('asking GitHub no more than it must of the branches a read shows', () => {
  /* What each read asks GitHub, and the clock of the server, which a test moves. */
  function counted(c: Awaited<ReturnType<typeof staged>>, answer?: (head: string) => boolean | null) {
    const compared: string[] = [];
    const recorded = c.app.ctx.readMerged!;
    c.app.ctx.readMerged = async (repo, refs, ms) => { compared.push(refs.head); return answer ? answer(refs.head) : recorded(repo, refs, ms); };
    const base = Date.now();
    let shift = 0;
    c.app.ctx.clock = () => base + shift;
    const asked = () => compared.splice(0).sort();
    return { asked, later: (ms: number) => { shift += ms; } };
  }
  const taskRead = async (c: Awaited<ReturnType<typeof staged>>) =>
    JSON.parse((await call(await c.tools(c.worker), 'task', { task: c.task.number })).content[0]!.text).departmentBranches;
  const page = async (c: Awaited<ReturnType<typeof staged>>) => (await send(c, c.danaToken, `/api/departments/${c.dev.id}/branches`)).json().branches;

  it('asks nothing again on a second read of the same branches, a task read or the department page', async () => {
    const c = await staged();
    const { asked } = counted(c);
    expect(await taskRead(c)).toEqual(c.open);
    expect(asked()).toEqual([sha(c.numbers.leads), sha(c.numbers.merged), sha(c.numbers.handed)].sort());
    expect(await taskRead(c)).toEqual(c.open);
    expect(await page(c)).toEqual(c.open);
    expect(asked()).toEqual([]);
  });

  it('asks again only of the branches not in main or not told of, once main moved, and once a few minutes passed', async () => {
    const c = await staged();
    const { leads, merged, handed } = c.numbers;
    const { asked, later } = counted(c, head => head === sha(merged) ? true : head === sha(leads) ? null : false);
    const notTold = [{ ...c.open[0], merged: false }, { ...c.open[1], merged: null }];
    expect(await taskRead(c)).toEqual(notTold);
    expect(asked()).toHaveLength(3);
    c.heads.main = sha(99);
    expect(await taskRead(c)).toEqual(notTold);
    expect(asked()).toEqual([sha(leads), sha(handed)].sort());
    later(UNSETTLED_MS - 1_000);
    expect(await page(c)).toEqual(notTold);
    expect(asked()).toEqual([]);
    later(1_000);
    expect(await page(c)).toEqual(notTold);
    expect(asked()).toEqual([sha(leads), sha(handed)].sort());
  });

  it('asks of a few branches at most in one read and cannot tell of the others yet, which the next read asks of', async () => {
    const c = await staged();
    const { leads, merged, handed } = c.numbers;
    const branch = (n: number, title: string, merged: false | null) => ({ task: n, title, status: 'done', branch: `task-${n}`, commit: sha(n), merged });
    const steps: ReturnType<typeof branch>[] = [];
    for (let i = 0; i < 12; i++) {
      const made = (await createTask(c.app.ctx, { agentId: c.head.id }, { title: `Step ${i}`, brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.worker.id, executor: true, resultKind: 'code' })).task;
      await c.db.update(tasks).set({ status: 'done', closedAt: new Date('2026-11-13T17:20:00.000Z') }).where(eq(tasks.id, made.id));
      c.heads[`task-${made.number}`] = sha(made.number);
      steps.unshift(branch(made.number, `Step ${i}`, false));
    }
    const { asked } = counted(c);
    const first = await taskRead(c);
    expect(asked()).toEqual(steps.slice(0, COMPARES_PER_READ).map(s => s.commit).sort());
    const untold = steps.slice(COMPARES_PER_READ);
    expect(first).toEqual([...steps.slice(0, COMPARES_PER_READ), ...untold.map(s => ({ ...s, merged: null })), { ...c.open[0], merged: null }, branch(merged, 'Landing page', null), { ...c.open[1], merged: null }]);
    expect(await taskRead(c)).toEqual([...steps, ...c.open]);
    expect(asked()).toEqual([...untold.map(s => s.commit), sha(leads), sha(merged), sha(handed)].sort());
  });

  it("asks GitHub nothing more once it answered that the request limit is used up, until the limit's reset, then asks again", async () => {
    const c = await staged();
    const { leads, merged } = c.numbers;
    const base = Date.now();
    const reset = Math.floor((base + 30 * 60_000) / 1000);
    const real = globalThis.fetch;
    const github: string[] = [];
    let limited = true;
    /* GitHub's answer once the account's 5000 requests of the hour are spent (recorded, trimmed). */
    const spent = () => new Response('{"message":"API rate limit exceeded for user ID 1.","documentation_url":"https://docs.github.com/rest/overview/rate-limits-for-the-rest-api"}', {
      status: 403, headers: { 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-used': '5000', 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'core' },
    });
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const at = String(url instanceof Request ? url.url : url);
      if (!at.startsWith('https://api.github.com/')) return real(url, init);
      github.push(at);
      if (limited) return spent();
      const head = at.split('...')[1]!.split('?')[0]!;
      return new Response(JSON.stringify({ status: head === sha(merged) ? 'behind' : 'ahead', ahead_by: 1, behind_by: 0 }));
    });
    try {
      c.app.ctx.readMerged = readMerged;
      let shift = 0;
      c.app.ctx.clock = () => base + shift;
      const unknown = c.open.map(b => ({ ...b, merged: null }));
      expect(await taskRead(c)).toEqual([unknown[0], { task: merged, title: 'Landing page', status: 'done', branch: `task-${merged}`, commit: sha(merged), merged: null }, unknown[1]]);
      expect(github).toHaveLength(3);
      expect(new Set(github).size).toBe(3);
      github.length = 0;
      shift = 20 * 60_000;
      expect((await taskRead(c)).map((b: { merged: unknown }) => b.merged)).toEqual([null, null, null]);
      expect(await page(c)).toHaveLength(3);
      expect(github).toEqual([]);
      limited = false;
      shift = reset * 1000 - base + 1_000;
      expect(await taskRead(c)).toEqual(c.open);
      expect(github).toHaveLength(3);
      expect(github.some(at => at.endsWith(`${sha(leads)}?per_page=1`))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});

/* GitHub's compare of the main line with a branch head, as GitHub answers it (recorded, trimmed to what is read). */
describe("whether GitHub's compare says a branch is in the main line", () => {
  it.each([
    [{ status: 'behind', ahead_by: 0, behind_by: 3 }, true],
    [{ status: 'identical', ahead_by: 0, behind_by: 0 }, true],
    [{ status: 'ahead', ahead_by: 2, behind_by: 0 }, false],
    [{ status: 'diverged', ahead_by: 2, behind_by: 5 }, false],
    [{ message: 'Not Found' }, null],
    [null, null],
  ])('reads %j as %s', (body, merged) => {
    expect(mergedIn(body)).toBe(merged);
  });
});

describe('asking GitHub whether a branch is in the main line', () => {
  const repo = { url: 'https://github.com/acme/shop.git', token: 'fixture-token-never-output' };
  afterEach(() => vi.unstubAllGlobals());

  it('compares the main line with the branch head and reads the answer GitHub gave', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'behind', ahead_by: 0, behind_by: 3 })));
    vi.stubGlobal('fetch', fetcher);
    expect(await readMerged(repo, { base: 'main', head: 'b'.repeat(40) })).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.github.com/repos/acme/shop/compare/main...${'b'.repeat(40)}?per_page=1`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual', headers: { authorization: `Bearer ${repo.token}` } });
  });

  it('cannot tell for a repository off GitHub, nor when GitHub refuses, and asks nothing off GitHub', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"message":"Bad credentials"}', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await readMerged({ ...repo, url: 'https://gitlab.com/acme/shop.git' }, { base: 'main', head: 'task-7' })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readMerged(repo, { base: 'main', head: 'task-7' })).toBeNull();
  });
});
