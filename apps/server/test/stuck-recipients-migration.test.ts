import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';
import { freshPglite } from './helpers-db.js';

const COMPANY = '00000000-0000-4000-8000-000000000101';
const DEPARTMENT = '00000000-0000-4000-8000-000000000102';
const WORKER = '00000000-0000-4000-8000-000000000103';
const HEAD = '00000000-0000-4000-8000-000000000104';
const ORCHESTRATOR = '00000000-0000-4000-8000-000000000105';
const MEMBER_REQUEST = '00000000-0000-4000-8000-000000000106';
const HEAD_REQUEST = '00000000-0000-4000-8000-000000000107';
const ORCHESTRATOR_REQUEST = '00000000-0000-4000-8000-000000000108';
const CLOSED_REQUEST = '00000000-0000-4000-8000-000000000109';
const QUESTION = '00000000-0000-4000-8000-00000000010a';
const HUMAN_REQUEST = '00000000-0000-4000-8000-00000000010b';

it('assigns live recipients and durable wakes to open legacy stuck requests only', async () => {
  const beforeFolder = await migrationsBefore('live_stuck_recipients');
  const throughFolder = await migrationsThrough('live_stuck_recipients');
  const client = await freshPglite(); onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: beforeFolder });
  await client.exec(`
    INSERT INTO companies(id,name) VALUES ('${COMPANY}','Stuck migration fixture');
    INSERT INTO departments(id,company_id,template_key,role_code) VALUES ('${DEPARTMENT}','${COMPANY}','development','DEV');
    INSERT INTO agents(id,company_id,kind,name,model,department_id) VALUES
      ('${WORKER}','${COMPANY}','worker','Member','','${DEPARTMENT}'),
      ('${HEAD}','${COMPANY}','head','Head','','${DEPARTMENT}'),
      ('${ORCHESTRATOR}','${COMPANY}','orchestrator','Orchestrator','',null);
    INSERT INTO tasks(id,company_id,number,title,department_id) VALUES
      ('00000000-0000-4000-8000-000000000110','${COMPANY}',1,'Member task','${DEPARTMENT}'),
      ('00000000-0000-4000-8000-000000000111','${COMPANY}',2,'Head task','${DEPARTMENT}'),
      ('00000000-0000-4000-8000-000000000112','${COMPANY}',3,'Orchestrator task','${DEPARTMENT}'),
      ('00000000-0000-4000-8000-000000000113','${COMPANY}',4,'Closed task','${DEPARTMENT}'),
      ('00000000-0000-4000-8000-000000000114','${COMPANY}',5,'Question task','${DEPARTMENT}');
    INSERT INTO requests(id,company_id,task_id,agent_id,kind,text,status,audience) VALUES
      ('${MEMBER_REQUEST}','${COMPANY}','00000000-0000-4000-8000-000000000110','${WORKER}','stuck','Member stuck','open','internal'),
      ('${HEAD_REQUEST}','${COMPANY}','00000000-0000-4000-8000-000000000111','${HEAD}','stuck','Head stuck','open','internal'),
      ('${ORCHESTRATOR_REQUEST}','${COMPANY}','00000000-0000-4000-8000-000000000112','${ORCHESTRATOR}','stuck','Orchestrator stuck','open','internal'),
      ('${CLOSED_REQUEST}','${COMPANY}','00000000-0000-4000-8000-000000000113','${WORKER}','stuck','Historical stuck','answered','legacy'),
      ('${QUESTION}','${COMPANY}','00000000-0000-4000-8000-000000000114','${WORKER}','question','Separate lifecycle','open','internal'),
      ('${HUMAN_REQUEST}','${COMPANY}','00000000-0000-4000-8000-000000000114','${WORKER}','stuck','Human lifecycle preserved','open','human');
  `);

  await migrate(db, { migrationsFolder: throughFolder });

  expect((await client.query('SELECT id,triage_agent_id FROM requests ORDER BY id')).rows).toEqual([
    { id: MEMBER_REQUEST, triage_agent_id: HEAD },
    { id: HEAD_REQUEST, triage_agent_id: ORCHESTRATOR },
    { id: ORCHESTRATOR_REQUEST, triage_agent_id: HEAD },
    { id: CLOSED_REQUEST, triage_agent_id: null },
    { id: QUESTION, triage_agent_id: null },
    { id: HUMAN_REQUEST, triage_agent_id: null },
  ]);
  expect((await client.query("SELECT agent_id,task_id,why,text FROM pending_wakes ORDER BY text")).rows).toEqual([
    { agent_id: HEAD, task_id: '00000000-0000-4000-8000-000000000110', why: 'explain', text: MEMBER_REQUEST },
    { agent_id: ORCHESTRATOR, task_id: '00000000-0000-4000-8000-000000000111', why: 'explain', text: HEAD_REQUEST },
    { agent_id: HEAD, task_id: '00000000-0000-4000-8000-000000000112', why: 'explain', text: ORCHESTRATOR_REQUEST },
  ]);
});
