import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, people, tasks, teams } from '../src/db/schema.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { checkTestTimes } from '../src/modules/testruns/runs.js';
import { as, until, type FakeNode, ownPlan } from './helpers.js';
import { company, done, gets, GIB, idle, nextOf } from './test-runs-company.js';

describe('a run of other work', () => {
  it("runs a command with no branch on a free machine, hands its node the task's files it names, and puts what it made on the task", async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await c.putFile('data.csv', 'a,b\n');
    const started = await call('run_work', { command: 'python3 make.py', files: ['data.csv'] });
    expect(started).toMatchObject({ error: false, text: expect.stringMatching(/^Work run 1 of #1 runs on dev-mac\./) });
    const run = await nextOf(ivan.node, 'tests.run');
    expect(run).toMatchObject({ kind: 'work', repo: null, branch: null, files: ['data.csv'], command: 'python3 make.py', part: 1, parts: 1, timeoutMs: 30 * 60_000 });
    const node = { authorization: `Bearer ${ivan.key}` };
    const fetched = await c.app.inject({ url: `/api/parts/${run.partId}/files/data.csv`, headers: node });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.body).toBe('a,b\n');
    const put = await c.app.inject({ method: 'PUT', url: `/api/parts/${run.partId}/files/report.txt`, headers: { ...node, 'content-type': 'application/octet-stream' }, payload: Buffer.from('made') });
    expect(put.statusCode).toBe(201);
    const listed = (await c.app.inject({ url: '/api/machines', ...as(c.ceo) })).json().machines;
    expect(listed).toEqual([expect.objectContaining({ hostname: 'dev-mac', kind: 'computer', running: expect.objectContaining({ parts: [expect.objectContaining({ run: 1, part: 1, kind: 'work' })] }) })]);
    ivan.node.send(done(run, { commit: null, log: 'Put on the task: report.txt.\n' }));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toMatch(/^The work you ran on #1/);
    expect(prompt).toMatch(/Work run 1 is done[\s\S]*Part 1 of 1 done on dev-mac/);
    expect(prompt).toMatch(/What it made is on #1: work-1-1-report\.txt/);
    expect(prompt).toContain('work-1-1.log');
    expect((await c.filesOn()).map(f => f.name).sort()).toEqual(['data.csv', 'work-1-1-report.txt', 'work-1-1.log']);
    expect((await c.filesOn()).find(f => f.name === 'work-1-1-report.txt')!.text).toBe('made');
    expect(JSON.parse((await call('work_run', { run: 1 })).text)).toMatchObject({
      run: 1,
      kind: 'work',
      branch: null,
      files: ['data.csv'],
      status: 'done',
      parts: [{ part: 1, status: 'done', machine: 'dev-mac', log: 'work-1-1.log', made: ['work-1-1-report.txt'] }],
    });
  });

  it('drops what a lost attempt put on the task, so the part that runs again makes its own files', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_work', { command: 'make report' });
    const first = await nextOf(ivan.node, 'tests.run');
    const node = { authorization: `Bearer ${ivan.key}`, 'content-type': 'application/octet-stream' };
    const put = (partId: string, name: string) => c.app.inject({ method: 'PUT', url: `/api/parts/${partId}/files/${name}`, headers: node, payload: Buffer.from(name) });
    for (let i = 1; i <= 20; i++) expect((await put(first.partId, `old-${i}.txt`)).statusCode).toBe(201);
    ivan.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [], work: true });
    const again = await nextOf(ivan.node, 'tests.run');
    expect(await c.filesOn()).toEqual([]);
    expect((await put(again.partId, 'new.txt')).statusCode).toBe(201);
    ivan.node.send(done(again, { commit: null }));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/What it made is on #1: work-1-1-new\.txt\./);
  });

  it('runs a part again after its machine went offline only when the run said it may run twice, and says why it did not', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const ann = await c.machine(c.ann, 'ann-pc', idle({ load: 6 }));
    const { call } = await c.turn(c.bruno);
    const away = async (m: { node: FakeNode; nodeId: string }) => {
      m.node.close();
      await until(() => !c.app.ctx.hub.isOnline(nodeIdentity(m.nodeId)));
      await checkTestTimes(c.app.ctx, new Date(Date.now() + 60_000));
      await checkTestTimes(c.app.ctx, new Date(Date.now() + 4 * 60_000));
    };
    await call('run_work', { command: 'make deploy' });
    await nextOf(ivan.node, 'tests.run');
    await away(ivan);
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Work run 1 failed[\s\S]*Part 1 of 1 failed on dev-mac[^:]*: its machine went offline, and it did not run again elsewhere, as it may still run there and run_work did not say it is repeatable/);
    expect(await gets(c.app.ctx, ann.node, 'tests.run')).toBe(false);

    await call('run_work', { command: 'make report', repeatable: true });
    expect(await nextOf(ann.node, 'tests.run')).toMatchObject({ command: 'make report' });
    await away(ann);
    expect(JSON.parse((await call('work_run', { run: 2 })).text)).toMatchObject({ repeatable: true, parts: [{ status: 'queued', ranAgain: ['ann-pc went offline'] }] });
  });

  it('clones a branch first when one is named, and splits into parts like a test run', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    expect((await call('run_work', { command: 'render --frames {part}/{parts}', branch: 'main', parts: 2, minutes: 90 })).error).toBe(false);
    const runs = [await nextOf(ivan.node, 'tests.run'), await nextOf(ann.node, 'tests.run')].sort((a, b) => a.part - b.part);
    expect(runs[0]).toMatchObject({ kind: 'work', repo: { url: 'https://github.com/acme/shop.git', token: 'ghp_shop0123456789' }, branch: 'main', command: 'render --frames 1/2', files: [], timeoutMs: 90 * 60_000 });
    expect(runs[1]).toMatchObject({ command: 'render --frames 2/2' });
  });

  it("is refused a file its task lacks, a branch with no repository and a split command without {part}, and a part's files reach only the node that runs it", async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const ann = await c.machine(c.ann, 'ann-pc', idle({ load: 7.5 }));
    const { call } = await c.turn(c.bruno);
    await c.putFile('data.csv', 'a,b\n');
    await c.putFile('secret.txt', 'not for this run');
    expect(await call('run_work', { command: 'x', files: ['nope.csv'] })).toMatchObject({ error: true, text: expect.stringContaining('#1 has no file nope.csv') });
    expect(await call('run_work', { command: 'x', parts: 2 })).toMatchObject({ error: true, text: expect.stringContaining('{part}') });
    await call('run_work', { command: 'x', files: ['data.csv'] });
    const run = await nextOf(ivan.node, 'tests.run');
    const file = (name: string, key?: string) => c.app.inject({ url: `/api/parts/${run.partId}/files/${name}`, headers: key ? { authorization: `Bearer ${key}` } : {} });
    expect((await file('data.csv', ann.key)).statusCode).toBe(404);
    expect((await file('secret.txt', ivan.key)).statusCode).toBe(404);
    expect((await file('data.csv')).statusCode).toBe(401);
    expect((await file('data.csv', ivan.key)).statusCode).toBe(200);
    ivan.node.send(done(run, { commit: null }));
    await nextOf(ivan.node, 'tests.ack');
    const late = await c.app.inject({ method: 'PUT', url: `/api/parts/${run.partId}/files/late.txt`, headers: { authorization: `Bearer ${ivan.key}`, 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(late.statusCode).toBe(404);
    expect((await c.filesOn()).map(f => f.name)).not.toContain('work-1-1-late.txt');
    const [pitch] = await c.db.insert(tasks).values({ companyId: c.task.companyId, number: 99, title: 'Pitch', brief: '', body: '', departmentId: c.sales.id, assigneeAgentId: c.sam.id, status: 'working' }).returning();
    const sam = await c.turn(c.sam, pitch!.id);
    expect(await sam.call('run_work', { command: 'x', branch: 'main' })).toMatchObject({ error: true, text: expect.stringMatching(/no repository/) });
    expect((await sam.call('run_work', { command: 'x' })).error).toBe(false);
  });

  it('goes only to machines whose node runs work, waits for the free memory it asks for, and stops on stop_work', async () => {
    const c = await company();
    const old = await c.machine(c.ceo, 'old-mac', idle(), { work: false });
    const { call } = await c.turn(c.bruno);
    expect((await call('run_work', { command: 'small' })).text).toMatch(/waits for a free machine/);
    expect(await gets(c.app.ctx, old.node, 'tests.run')).toBe(false);
    const ann = await c.machine(c.ann, 'ann-pc', idle({ memFree: 6 * GIB }));
    const small = await nextOf(ann.node, 'tests.run');
    expect(small).toMatchObject({ kind: 'work', command: 'small' });
    ann.node.send(done(small, { commit: null }));
    await nextOf(ann.node, 'tests.ack');
    expect((await call('run_work', { command: 'big', memory: 8 })).text).toMatch(/waits for a free machine/);
    expect(await gets(c.app.ctx, ann.node, 'tests.run')).toBe(false);
    ann.node.send({ type: 'load', ...idle({ memFree: 9 * GIB }) });
    const big = await nextOf(ann.node, 'tests.run');
    expect(big.command).toBe('big');
    /* Test runs still go to a node that knows only them. */
    await call('run_tests', { branch: 'main', command: 'make test' });
    expect((await nextOf(old.node, 'tests.run')).kind ?? 'tests').toBe('tests');
    expect(await call('stop_work', { run: 2 })).toEqual({ text: 'Work run 2 is stopped.', error: false });
    expect(await nextOf(ann.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: big.partId });
  });
});

describe('the pool of machines', () => {
  it('shows the orchestrator every machine with its load, the parts it runs and why each waiting part waits', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    await c.machine(c.ann, 'ann-pc', idle({ load: 7.6 }));
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'npm test -- --shard={part}/{parts}', parts: 2 });
    const first = await nextOf(ivan.node, 'tests.run');
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const boss = await c.turn(orchestrator!, null);

    const pool = JSON.parse((await boss.call('pool')).text);
    expect(pool.machines).toEqual([
      expect.objectContaining({ name: 'dev-mac', owner: 'Ivan', kind: 'computer', online: true, lent: true, loaded: false, load: expect.objectContaining({ cpus: 8 }), parts: [expect.objectContaining({ run: 1, kind: 'tests', task: c.task.number, part: 1, parts: 2, agent: 'Bruno', command: 'npm test -- --shard=1/2', ranAgain: [] })] }),
      expect.objectContaining({ name: 'ann-pc', owner: 'Ann', online: true, lent: true, loaded: true, parts: [] }),
    ]);
    expect(pool.builtin).toMatchObject({ online: false, parts: [] });
    expect(pool.waiting).toEqual([expect.objectContaining({ run: 1, kind: 'tests', task: c.task.number, part: 2, parts: 2, agent: 'Bruno', why: 'Running another part: dev-mac. Loaded: ann-pc.' })]);

    /* Once the first part is done, the second goes out, and nothing waits. */
    ivan.node.send(done(first));
    await nextOf(ivan.node, 'tests.run');
    const after = JSON.parse((await boss.call('pool')).text);
    expect(after.waiting).toEqual([]);
    expect(after.machines[0].parts).toEqual([expect.objectContaining({ part: 2 })]);
  });

  it('says a part waits for a lent machine, for one its department reaches, for one that runs work, or for free memory', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac', idle({ memFree: 1 * GIB }), { work: false });
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const boss = await c.turn(orchestrator!, null);
    const why = async () => JSON.parse((await boss.call('pool')).text).waiting.map((w: { why: string }) => w.why);
    const lend = (machineId: string, lendsTests: boolean) => c.app.inject({ method: 'PATCH', url: `/api/machines/${machineId}`, payload: { lendsTests }, ...as(c.ceo) });

    await lend(ivan.machineId, false);
    await (await c.turn(c.bruno)).call('run_tests', { branch: 'main', command: 'npm test' });
    expect(await why()).toEqual(['No computer lent to runs is online.']);
    await lend(ivan.machineId, true);
    expect(await why()).toEqual(['Short of the 4 GB of free memory it needs: dev-mac.']);

    /* Ann's machine takes the test run; it reaches development only, and its node knows test runs alone. */
    await lend(ivan.machineId, false);
    const ann = await c.machine(c.ann, 'ann-pc', idle(), { work: false });
    await nextOf(ann.node, 'tests.run');
    const [pitch] = await c.db.insert(tasks).values({ companyId: c.task.companyId, number: 99, title: 'Pitch', brief: '', body: '', departmentId: c.sales.id, assigneeAgentId: c.sam.id, status: 'working' }).returning();
    await (await c.turn(c.sam, pitch!.id)).call('run_work', { command: 'make report' });
    expect(await why()).toEqual(['No lent machine online belongs to someone who reaches its department.']);
    await lend(ivan.machineId, true);
    expect(await why()).toEqual(['The lent machines online that may take it run a node too old for work: update their node.']);
  });

  it('shows a person who does not see the whole company only their own machines and what runs there', async () => {
    const c = await company();
    await c.machine(c.ceo, 'dev-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'npm test' });
    const part = await nextOf(ann.node, 'tests.run');
    /* Ann has only Bruno's team of Development: the department itself would show her Bruno on any plan. */
    const [core] = await c.db.insert(teams).values({ companyId: c.bruno.companyId, departmentId: c.dev.id, name: 'Core' }).returning();
    await c.db.update(agents).set({ teamId: core!.id }).where(eq(agents.id, c.bruno.id));
    const [annRow] = await c.db.select().from(people).where(eq(people.name, 'Ann'));
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${annRow!.id}`, payload: { access: { teams: [core!.id] } }, ...as(c.ceo) })).statusCode).toBe(200);
    /* A part on her own machine stays nameless to her while the agent who runs it is on someone else's plan. */
    expect((await c.app.inject({ method: 'GET', url: '/api/pool', ...as(c.ann) })).json().machines[0].parts).toEqual([]);
    await ownPlan(c.db, annRow!.email!, c.bruno.id);
    const seen = (await c.app.inject({ method: 'GET', url: '/api/pool', ...as(c.ann) })).json();
    expect(seen.machines.map((m: { name: string }) => m.name)).toEqual(['ann-pc']);
    expect(seen.machines[0].parts).toEqual([expect.objectContaining({ run: 1, part: 1 })]);
    expect(seen).toMatchObject({ builtin: null, waiting: [] });
    void part;
  });

  it('shows each machine online and as busy as the machines screen does, a removed plan left out of both', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac', idle({ load: 3 }));
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const boss = await c.turn(orchestrator!, null);
    const both = async () => {
      const pool = JSON.parse((await boss.call('pool')).text).machines[0];
      const screen = (await c.app.inject({ url: '/api/machines', ...as(c.ceo) })).json().machines[0];
      return { pool: { online: pool.online, load: pool.load }, screen: { online: screen.online, load: screen.load } };
    };
    const now = await both();
    expect(now.pool).toEqual(now.screen);
    expect(now.pool).toMatchObject({ online: true, load: { load: 3 } });
    expect((await c.app.inject({ method: 'DELETE', url: `/api/subscriptions/${ivan.subscriptionId}`, ...as(c.ceo) })).statusCode).toBe(204);
    const after = await both();
    expect(after.pool).toEqual(after.screen);
    expect(after.pool).toEqual({ online: false, load: null });
  });

  it('gives no part to a machine whose node has no user of its own for runs, and shows why', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac', idle(), { noRuns: 'This node runs without a user of its own for runs.' });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'npm test' });
    expect(await gets(c.app.ctx, ivan.node, 'tests.run')).toBe(false);
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const pool = JSON.parse((await (await c.turn(orchestrator!, null)).call('pool')).text);
    expect(pool.machines).toEqual([expect.objectContaining({ name: 'dev-mac', online: true, noRuns: 'This node runs without a user of its own for runs.' })]);
    expect(pool.waiting).toEqual([expect.objectContaining({ part: 1, why: 'No computer lent to runs is online.' })]);
  });

  it('gives no part to a phone or a browser, which run no commands, and shows what kind each machine is', async () => {
    const c = await company();
    const phone = await c.machine(c.ceo, 'dev-phone', idle(), { kind: 'phone' });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'npm test' });
    expect(await gets(c.app.ctx, phone.node, 'tests.run')).toBe(false);
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const pool = JSON.parse((await (await c.turn(orchestrator!, null)).call('pool')).text);
    expect(pool.machines).toEqual([expect.objectContaining({ name: 'dev-phone', kind: 'phone', online: true, lent: true, parts: [] })]);
    expect((await c.app.inject({ url: '/api/machines', ...as(c.ceo) })).json().machines).toEqual([expect.objectContaining({ hostname: 'dev-phone', kind: 'phone' })]);
    expect(pool.waiting).toEqual([expect.objectContaining({ part: 1, why: 'No computer lent to runs is online.' })]);
    const box = await c.planless(c.ceo, 'build-box');
    expect(await nextOf(box.node, 'tests.run')).toMatchObject({ command: 'npm test' });
    expect((await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: 'x', machineId: 'odd-0001-abcd', hostname: 'odd', os: 'linux', arch: 'x86_64', kind: 'toaster' } })).statusCode).toBe(400);
  });
});
