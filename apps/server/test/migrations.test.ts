import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';

/* A copy of the migrations folder that stops after the given tag, as an older install would have it. */
async function migrationsUpTo(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hh-migrations-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await cp(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex(e => e.tag === tag);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

describe('migration 0003', () => {
  it('renames the chief of an older install to the orchestrator', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0002_indexes') });

    await db.execute(sql`insert into companies (id, name) values ('00000000-0000-4000-8000-000000000001', 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind)
      values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Ivan', 'ivan@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, owner_person_id, status, target_kind)
      values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'anthropic_api', 'api_key', 'Chief',
        '00000000-0000-4000-8000-000000000002', 'ready', 'chief')`);
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, owner_person_id, status, target_kind)
      values ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'anthropic_api', 'api_key', 'Chief of staff',
        '00000000-0000-4000-8000-000000000002', 'ready', 'any')`);
    await db.execute(sql`insert into agents (company_id, kind, name, model, subscription_id)
      values ('00000000-0000-4000-8000-000000000001', 'chief', 'Chief', 'claude-opus-5-5', '00000000-0000-4000-8000-000000000003')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const agents = await db.execute<{ kind: string; name: string }>(sql`select kind, name from agents`);
    expect(agents.rows).toEqual([{ kind: 'orchestrator', name: 'Orchestrator' }]);
    const subs = await db.execute<{ label: string; target_kind: string }>(sql`select label, target_kind from subscriptions order by id`);
    expect(subs.rows).toEqual([
      { label: 'Orchestrator', target_kind: 'orchestrator' },
      { label: 'Chief of staff', target_kind: 'any' },
    ]);
  });
});

describe('migration 0005', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const DEPT = '00000000-0000-4000-8000-0000000000d1';
  const TEAM = '00000000-0000-4000-8000-0000000000e1';

  async function at0004() {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0004_conversations') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into departments (id, company_id, name, role_code) values (${DEPT}, ${C}, 'Sales', 'SAL')`);
    await db.execute(sql`insert into teams (id, company_id, department_id, name) values (${TEAM}, ${C}, ${DEPT}, 'Outbound')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind, scope_id, is_owner) values
      ('00000000-0000-4000-8000-000000000002', ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company', null, true),
      ('00000000-0000-4000-8000-000000000003', ${C}, 'Maria', 'maria@acme.com', 'active', 'department', ${DEPT}, false),
      ('00000000-0000-4000-8000-000000000004', ${C}, 'Sasha', 'sasha@acme.com', 'invited', 'team', ${TEAM}, false)`);
    return db;
  }

  it('moves single scopes into access lists', async () => {
    const db = await at0004();
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const people = await db.execute<{ name: string; scope_kind: string }>(sql`select name, scope_kind from people order by email`);
    expect(people.rows).toEqual([
      { name: 'Ivan', scope_kind: 'company' },
      { name: 'Maria', scope_kind: 'listed' },
      { name: 'Sasha', scope_kind: 'listed' },
    ]);
    const access = await db.execute<{ name: string; department_id: string | null; team_id: string | null }>(
      sql`select p.name, a.department_id, a.team_id from person_access a join people p on p.id = a.person_id order by p.email`,
    );
    expect(access.rows).toEqual([
      { name: 'Maria', department_id: DEPT, team_id: null },
      { name: 'Sasha', department_id: null, team_id: TEAM },
    ]);
  });

  it('keeps the orchestrator and his conversation', async () => {
    const db = await at0004();
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, owner_person_id, status, target_kind)
      values ('00000000-0000-4000-8000-000000000005', ${C}, 'anthropic_api', 'api_key', 'Orchestrator', '00000000-0000-4000-8000-000000000002', 'ready', 'orchestrator')`);
    await db.execute(sql`insert into agents (id, company_id, kind, name, model, subscription_id)
      values ('00000000-0000-4000-8000-000000000006', ${C}, 'orchestrator', 'Orchestrator', 'claude-opus-5-5', '00000000-0000-4000-8000-000000000005')`);
    await db.execute(sql`insert into agent_events (company_id, agent_id, kind, data) values (${C}, '00000000-0000-4000-8000-000000000006', 'text', '{"text":"Hello"}')`);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const agents = await db.execute<{ kind: string; skills: unknown; overrides: unknown; role_key: string | null }>(sql`select kind, skills, overrides, role_key from agents`);
    expect(agents.rows).toEqual([{ kind: 'orchestrator', skills: [], overrides: {}, role_key: null }]);
    expect((await db.execute(sql`select kind from agent_events`)).rows).toEqual([{ kind: 'text' }]);
  });
});

describe('migration 0007', () => {
  const C = '00000000-0000-4000-8000-000000000001';

  it('adds tasks to an older install and keeps one open turn per company', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0006_access_lists') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind)
      values ('00000000-0000-4000-8000-000000000002', ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    await db.execute(sql`insert into turns (company_id, number, goal, started_by) values (${C}, 1, 'Payments', '00000000-0000-4000-8000-000000000002')`);
    await expect(db.execute(sql`insert into turns (company_id, number, goal, started_by) values (${C}, 2, 'More', '00000000-0000-4000-8000-000000000002')`)).rejects.toThrow();
    await db.execute(sql`update turns set status = 'closed'`);
    await db.execute(sql`insert into turns (company_id, number, goal, started_by) values (${C}, 2, 'More', '00000000-0000-4000-8000-000000000002')`);
    await db.execute(sql`insert into tasks (company_id, number, title) values (${C}, 1, 'Build the payment page')`);
    await expect(db.execute(sql`insert into tasks (company_id, number, title) values (${C}, 1, 'Again')`)).rejects.toThrow();
    const cols = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'departments' and column_name like 'repo_%' order by column_name`);
    expect(cols.rows.map(r => r.column_name)).toEqual(['repo_author_email', 'repo_author_name', 'repo_branch', 'repo_token_enc', 'repo_token_last4', 'repo_url']);
  });
});

describe('migration 0011', () => {
  const C = '00000000-0000-4000-8000-000000000001';

  it('puts the reviewer of a task at a gate on its panel, also while the task waits for a person', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0010_turn_plans') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    const gates = JSON.stringify(['rita', 'sam']);
    await db.execute(sql`insert into tasks (company_id, number, title, status, stage, gates) values
      (${C}, 1, 'At gate one', 'review', 1, ${gates}::jsonb),
      (${C}, 2, 'Asking at gate two', 'waiting', 2, ${gates}::jsonb),
      (${C}, 3, 'Asking before its gates', 'waiting', 0, ${gates}::jsonb),
      (${C}, 4, 'Being done', 'working', 0, ${gates}::jsonb)`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const rows = await db.execute<{ number: number; panel: string[] }>(sql`select number, panel from tasks order by number`);
    expect(rows.rows).toEqual([
      { number: 1, panel: ['rita'] },
      { number: 2, panel: ['sam'] },
      { number: 3, panel: [] },
      { number: 4, panel: [] },
    ]);
  });
});

describe('migration 0020', () => {
  const C = '00000000-0000-4000-8000-000000000001';

  it('takes the threat model off the red team and leaves it with security', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0019_agent_event_jobs') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    const red = JSON.stringify(['hh-task-flow', 'dev-adversarial', 'dev-threat-model']);
    const sec = JSON.stringify(['hh-task-flow', 'dev-security-review', 'dev-threat-model']);
    await db.execute(sql`insert into agents (company_id, kind, name, model, role_key, skills) values
      (${C}, 'worker', 'Red team', '', 'DEV-RED', ${red}::jsonb),
      (${C}, 'worker', 'Security engineer', '', 'DEV-SEC', ${sec}::jsonb)`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const rows = await db.execute<{ name: string; skills: string[] }>(sql`select name, skills from agents order by name`);
    expect(rows.rows).toEqual([
      { name: 'Red team', skills: ['hh-task-flow', 'dev-adversarial'] },
      { name: 'Security engineer', skills: ['hh-task-flow', 'dev-security-review', 'dev-threat-model'] },
    ]);
  });
});

describe('migration 0021', () => {
  it('adds missing command reports and keeps the subscriptions already there', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0020_red_team_skills') });
    const company = '00000000-0000-4000-8000-000000000001';
    const person = '00000000-0000-4000-8000-000000000002';
    await db.execute(sql`insert into companies (id, name) values (${company}, 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind) values (${person}, ${company}, 'Ivan', 'ivan@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status) values (${company}, 'claude', 'personal', 'Claude', ${person}, 'ready')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const rows = await db.execute<{ label: string; missing: null }>(sql`select label, missing from subscriptions`);
    expect(rows.rows).toEqual([{ label: 'Claude', missing: null }]);
  });
});
