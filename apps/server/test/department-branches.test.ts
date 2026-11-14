import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { departments, tasks } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import type { RepoAddress } from '../src/modules/testruns/refs.js';
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
  return { ...c, numbers: { leads, merged, handed, dropped, noBranch, theirs }, open, asked };
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
