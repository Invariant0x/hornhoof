import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { migrationsBefore } from './migrations-before.js';
import { freshPglite } from './helpers-db.js';

const REFUSAL = 'запусти через run_tests\nHornhoof stopped this command before it started. This runs over more than one package. A whole test suite runs through run_tests once per release, on its release branch. Name the test files of your change to run them here. A refusal is not a result.';

/* The runs a company kept before refusals had a status of their own, as #1944's work run 587 was kept. */
it('turns the refusals kept as failed runs into refused ones, and leaves every run that started and failed as it was', async () => {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: await migrationsBefore('refused_runs') });
  await db.execute(sql`insert into companies (name) values ('Acme')`);
  await db.execute(sql`insert into people (company_id, name, email, status, scope_kind) select id, 'Ivan', 'ivan@acme.com', 'active', 'company' from companies`);
  await db.execute(sql`insert into subscriptions (company_id, provider, kind, label, status, owner_person_id) select company_id, 'claude', 'personal', 'Claude', 'ready', id from people`);
  await db.execute(sql`insert into agents (company_id, kind, name, model) select id, 'worker', 'Tank', '' from companies`);
  await db.execute(sql`insert into jobs (company_id, subscription_id, agent_id, kind, prompt, timeout_ms) select s.company_id, s.id, a.id, 'conversation', 'hi', 900000 from subscriptions s join agents a on a.company_id = s.company_id`);
  await db.execute(sql`insert into tasks (company_id, number, title) select id, 1944, 'Release check' from companies`);
  const run = (number: number, kind: string) => db.execute(sql`insert into test_runs (company_id, number, task_id, agent_id, job_id, kind, command, timeout_ms, status, finished_at)
    select j.company_id, ${number}, t.id, j.agent_id, j.id, ${kind}, 'npm test', 60000, 'failed', now() from jobs j join tasks t on t.company_id = j.company_id`);
  const part = (number: number, n: number, values: { status: string; error: string | null; exit: number | null; started: boolean; tail: string }) =>
    db.execute(sql`insert into test_parts (company_id, run_id, part, status, error, exit_code, started_at, tail)
      select company_id, id, ${n}, ${values.status}, ${values.error}, ${values.exit}, ${values.started ? sql`now()` : null}, ${values.tail} from test_runs where number = ${number}`);
  const refused = { status: 'failed', error: 'failed', exit: null, started: false, tail: REFUSAL };
  /* 587: its one part refused by the node. */
  await run(587, 'work'); await part(587, 1, refused);
  /* 588: a product with no test environment at its commit. */
  await run(588, 'tests'); await part(588, 1, { status: 'failed', error: 'environment_missing', exit: null, started: false, tail: 'No test environment exists at the pinned commit.' });
  /* 589: one part refused, another started and failed: a real failure. */
  await run(589, 'work'); await part(589, 1, refused); await part(589, 2, { status: 'failed', error: 'failed', exit: 1, started: true, tail: 'Error 1' });
  /* 590: a check that ran and printed the same words as part of its own output, with an exit code: it ran. */
  await run(590, 'tests'); await part(590, 1, { status: 'failed', error: 'failed', exit: 2, started: true, tail: REFUSAL });
  /* 591: a part that never started for want of a machine. */
  await run(591, 'tests'); await part(591, 1, { status: 'failed', error: 'no_machine', exit: null, started: false, tail: '' });

  await migrate(db, { migrationsFolder: MIGRATIONS });
  await migrate(db, { migrationsFolder: MIGRATIONS });

  expect((await db.execute(sql`select number, status from test_runs order by number`)).rows).toEqual([
    { number: 587, status: 'refused' }, { number: 588, status: 'refused' }, { number: 589, status: 'failed' }, { number: 590, status: 'failed' }, { number: 591, status: 'failed' },
  ]);
  expect((await db.execute(sql`select r.number, p.part, p.status, p.error from test_parts p join test_runs r on r.id = p.run_id order by r.number, p.part`)).rows).toEqual([
    { number: 587, part: 1, status: 'refused', error: 'refused' },
    { number: 588, part: 1, status: 'refused', error: 'environment_missing' },
    { number: 589, part: 1, status: 'refused', error: 'refused' },
    { number: 589, part: 2, status: 'failed', error: 'failed' },
    { number: 590, part: 1, status: 'failed', error: 'failed' },
    { number: 591, part: 1, status: 'failed', error: 'no_machine' },
  ]);
});
