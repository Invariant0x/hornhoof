import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Lab, type LabMachine } from './lab.js';
import { http, installServer, ok, PASSWORD, quoted, setUp, signIn, sql, within, type Server } from './steps.js';

/* One scenario on a lab computer, with nothing standing in for a part of Hornhoof: the company is restored from a
   backup, and what it did after that backup comes back from the database the restore set aside, which is then saved
   and removed; a second restore leaves such work out. */
type Bundle = { id: string; reason: string; recovery: string | null; dumpedAt: string };

describe('the lab, merges', () => {
  let lab: Lab;
  let m1: LabMachine;

  beforeAll(async () => {
    lab = await Lab.start({ machines: 1 });
    m1 = lab.machine(1);
  });

  /* HH_LAB_KEEP=1 leaves the machine for a person to look at; the label printed at the start finds it. */
  afterAll(async () => {
    if (!process.env.HH_LAB_KEEP) await lab?.stop();
  });

  const bundles = async (): Promise<Bundle[]> =>
    JSON.parse((await sql(m1, `SELECT coalesce(json_agg(json_build_object('id', id, 'reason', reason, 'recovery', recovery, 'dumpedAt', dumped_at) ORDER BY made_at DESC), '[]') FROM net.backups`)) || '[]') as Bundle[];
  const kept = async (): Promise<string[]> => (await sql(m1, `SELECT datname FROM pg_database WHERE datname LIKE 'hornhoof_before_%'`)).split('\n').filter(Boolean);
  const merges = async (): Promise<{ source: string; status: string; error: string | null }[]> =>
    JSON.parse((await sql(m1, `SELECT coalesce(json_agg(json_build_object('source', source, 'status', status, 'error', error) ORDER BY created_at), '[]') FROM net.merges`)) || '[]') as { source: string; status: string; error: string | null }[];
  const inside = (service: string, cmd: string) => m1.exec(`cd /root/hornhoof && docker compose exec -T ${service} sh -c ${quoted(cmd)}`);
  const log = async (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
  /* The restore as the updater says it went. */
  const restored = async (server: Server, id: string, bringBack: boolean) => {
    /* A backup is restored from a machine that says it holds it, which the server's keeper says in its next report. */
    await within(3, 'the server reports that it holds the backup', async () => (await sql(m1, `SELECT count(*) FROM machines WHERE '${id}' = ANY(held_backups)`)) !== '0');
    expect(await signIn(m1, server.url, PASSWORD)).toBe(200);
    const asked = await http(m1, 'POST', `${server.url}/api/backups/${id}/restore`, { body: { bringBack } });
    expect(asked.status, asked.body).toBe(202);
    const attempt = asked.json<{ attempt: string }>().attempt;
    const status = async () => JSON.parse(ok(await inside('keeper', 'cat /control/restore-status.json'), 'the status')) as { attempt: string; state: string; step: string; line: string; kept: string | null; dumpedAt?: string };
    const ended = await within(4, 'the restore ended', async () => {
      const said = await status().catch(() => null);
      return said && said.attempt === attempt && said.state !== 'running' ? said : null;
    });
    expect(ended, ended.line).toMatchObject({ state: 'done', step: 'start' });
    await within(1, 'the restored company answers', async () => (await http(m1, 'GET', `${server.url}/api/health`)).status === 200);
    return ended;
  };
  /* A bundle of the database in use made after this moment, which the recovery file opens. */
  const bundleAfter = async (since: Date, recipient: string) =>
    within(3, 'a bundle of the company as it is now is recorded', async () => (await bundles()).find(row => row.reason !== 'fork' && row.recovery === recipient && new Date(row.dumpedAt) > since));

  it('brings back what came after a restore, saves the database from before and removes it, and leaves it out when told to', async () => {
    /* 1. A server, set up, with a plan for its orchestrator so that he can take a task, a department and a task. */
    const server: Server = await installServer(m1);
    await setUp(server);
    await sql(m1, `WITH plan AS (INSERT INTO subscriptions (company_id, provider, kind, label, owner_person_id, status) SELECT c.id, 'claude', 'personal', 'Lab plan', p.id, 'needs_login' FROM companies c, people p WHERE p.is_owner RETURNING id)
      UPDATE agents SET subscription_id = (SELECT id FROM plan) WHERE kind = 'orchestrator'`);
    await sql(m1, `INSERT INTO departments (company_id, name, role_code) SELECT id, 'Before', 'BEF' FROM companies`);
    await sql(m1, `INSERT INTO tasks (company_id, number, title, department_id) SELECT c.id, 1, 'Of before', d.id FROM companies c, departments d WHERE d.name = 'Before'`);
    const before = new Date();
    /* The company's certificate authority is made a moment after the setup; the recovery file needs it. */
    const saved = await within(2, 'the recovery file is saved', async () => {
      const answer = await http(m1, 'POST', `${server.url}/api/backups/recovery`);
      return answer.status === 200 ? answer : null;
    });
    const file = JSON.parse(saved.json<{ text: string }>().text.split('\n')[1]!) as { recipient: string };
    const first = await bundleAfter(before, file.recipient);
    await log('1. the server is set up, and a backup of the company is made');

    /* 2. The company goes on: a department, a task in it, and a new title for the task of before. Then the owner
       restores the backup, and asks for what came after to be brought back. */
    await sql(m1, `INSERT INTO departments (company_id, name, role_code) SELECT id, 'Later', 'LAT' FROM companies`);
    await sql(m1, `INSERT INTO tasks (company_id, number, title, department_id) SELECT c.id, 2, 'Of later', d.id FROM companies c, departments d WHERE d.name = 'Later'`);
    await sql(m1, `UPDATE tasks SET title = 'Renamed later' WHERE number = 1`);
    const ended = await restored(server, first.id, true);
    /* The status says from when the restored database is, which marks the restore in it. */
    expect(new Date(ended.dumpedAt!).getTime()).toBe(new Date(first.dumpedAt).getTime());
    expect(ended.kept).toMatch(/^hornhoof_before_\d{8}_\d{6}$/);
    await log('2. the company is restored to the backup');

    /* 3. What came after comes back: the department and its task as additions. The title differs, so the restored one
       stays and the orchestrator has a task with both. The database from before is saved as a backup and removed. */
    await within(3, 'the department made later is back', async () => (await sql(m1, `SELECT count(*) FROM departments WHERE name = 'Later'`)) === '1');
    expect(await sql(m1, `SELECT title FROM tasks WHERE number = 2`)).toBe('Of later');
    expect(await sql(m1, `SELECT title FROM tasks WHERE number = 1`)).toBe('Of before');
    const task = await within(3, 'the orchestrator has the task of the merge', async () => {
      const found = await sql(m1, `SELECT json_build_object('title', t.title, 'body', t.body) FROM tasks t JOIN agents a ON a.id = t.assignee_agent_id WHERE a.kind = 'orchestrator' AND t.title LIKE 'Bring back what the database from before the restore%'`);
      return found ? (JSON.parse(found) as { title: string; body: string }) : null;
    });
    expect(task.body).toContain('title: here "Of before", there "Renamed later"');
    await within(4, 'the database from before is saved and removed', async () => {
      const [state, left, forks] = [await merges(), await kept(), (await bundles()).filter(row => row.reason === 'fork')];
      await log(`   merges: ${state.map(merge => `${merge.status}${merge.error ? ` (${merge.error.slice(0, 160)})` : ''}`).join(', ')}; kept: ${left.length}; forks: ${forks.length}`);
      return state.length === 1 && state[0]!.status === 'done' && left.length === 0 && forks.length === 1;
    });
    expect((await merges())[0]).toMatchObject({ source: `kept:${ended.kept}`, status: 'done', error: null });
    await log('3. what came after is back, and the database from before is a backup');

    /* 4. Once more, and this time the owner leaves out what came after: nothing of it comes back, and the database
       from before is saved and removed all the same. */
    /* A recovery file saved anew soon has a backup it opens, of the company as it is now, with what came back in it. */
    expect(await signIn(m1, server.url, PASSWORD)).toBe(200);
    const since = new Date();
    const renewed = await http(m1, 'POST', `${server.url}/api/backups/recovery`);
    expect(renewed.status, renewed.body).toBe(200);
    const again = await bundleAfter(since, (JSON.parse(renewed.json<{ text: string }>().text.split('\n')[1]!) as { recipient: string }).recipient);
    await sql(m1, `INSERT INTO departments (company_id, name, role_code) SELECT id, 'Second', 'SEC' FROM companies`);
    const second = await restored(server, again.id, false);
    await within(5, 'the second database from before is saved and removed', async () => {
      const [state, left, forks] = [await merges(), await kept(), (await bundles()).filter(row => row.reason === 'fork')];
      await log(`   merges: ${state.map(merge => merge.status).join(', ')}; kept: ${left.length}; forks: ${forks.length}`);
      return state.length === 2 && state[1]!.status === 'done' && left.length === 0 && forks.length === 2;
    });
    expect((await merges())[1]).toMatchObject({ source: `kept:${second.kept}`, status: 'done' });
    expect(await sql(m1, `SELECT count(*) FROM departments WHERE name = 'Second'`)).toBe('0');
    expect(await sql(m1, `SELECT count(*) FROM departments WHERE name = 'Later'`)).toBe('1');
    await log('4. a restore that leaves out what came after brings nothing back');
  });
});
