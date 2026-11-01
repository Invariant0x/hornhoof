import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { TEST_SECRET, as, invitePerson, setUpCompany, testApp } from './helpers.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, jobs, people, sessions, subscriptions, tasks } from '../src/db/schema.js';
import { createIncidentMetadataOperation, type IncidentMetadataResult, type ProtectedInstallation } from '../src/modules/installation/incident-metadata-entrypoint.js';

const TASK_ID = '25256ddc-66ce-4a4d-9198-093fc4ca4fd6';
const AGENT_ID = '7f038470-9455-432f-a113-0d7f72bd87cd';
const ORCHESTRATOR_TOKEN = 'task79-orchestrator-tool-token-0123456789';
const EMPLOYEE_TOKEN = 'task79-employee-tool-token-0123456789ab';
const NODE_KEY = 'k'.repeat(40);
const ENV = {
  HORNHOOF_SECRET: TEST_SECRET,
  UPDATE_CHECK_MS: '0',
  NODE_KEY,
  DATABASE_URL: 'postgres://task79-fixture-user:task79-fixture-password@127.0.0.1:1/task79',
  HORNHOOF_COMMIT: 'task79-fixture-commit',
  HORNHOOF_IMAGE: 'fixture/task79',
  HORNHOOF_CONTROL_DIR: '/fixture/task79-control',
};
const DB_CANARY = 'postgres://fake-user:fake-password@fake-host/fake-db';
const DB_CAUSE = 'task79-nested-cause-canary';
const DB_DETAIL = 'task79-driver-detail-canary';
const FORBIDDEN = ['hidden prompt canary', 'hidden result canary', 'hidden tail canary', DB_CANARY, DB_CAUSE, DB_DETAIL];
const JOB_KEYS = [
  'id',
  'kind',
  'status',
  'error',
  'subscription_id',
  'session_id',
  'instructions_hash',
  'created_by',
  'task_id',
  'created_at',
  'started_at',
  'finished_at',
  'prompt_characters',
  'prompt_md5',
  'empty_start',
  'recovery_prefix',
  'predecessor_before_window',
];

const bundleSha256 = (): string => {
  const hash = createHash('sha256');
  for (const name of ['incident-metadata-entrypoint.ts', 'incident-metadata.ts']) {
    hash.update(readFileSync(fileURLToPath(new URL(`../src/modules/installation/${name}`, import.meta.url))));
    hash.update([0]);
  }
  return hash.digest('hex');
};

const metadataRow = () => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'conversation',
  status: 'running',
  error: null,
  subscription_id: '00000000-0000-4000-8000-000000000002',
  session_id: 'session-current',
  instructions_hash: 'hash-current',
  created_by: '00000000-0000-4000-8000-000000000003',
  task_id: TASK_ID,
  created_at: '2026-11-01T00:17:00.123456Z',
  started_at: null,
  finished_at: null,
  prompt_characters: 19,
  prompt_md5: createHash('md5').update('hidden prompt canary').digest('hex'),
  empty_start: false,
  recovery_prefix: false,
  predecessor_before_window: false,
});

type ClientControl = {
  client: pg.PoolClient;
  queries: string[];
  released: number;
  fail: (error: unknown) => void;
  hang: () => void;
};

function diagnosticClient(rows: unknown[]): ClientControl {
  const queries: string[] = [];
  let failure: unknown;
  let hanging = false;
  const control = {
    queries,
    released: 0,
    fail(error: unknown) {
      failure = error;
    },
    hang() {
      hanging = true;
    },
  } as ClientControl;
  const query = async (input: string | { text: string }) => {
    const text = typeof input === 'string' ? input : input.text;
    queries.push(text);
    if (/WITH bounds/i.test(text)) {
      if (failure) throw failure;
      if (hanging) return new Promise(() => {});
      process.stderr.write(DB_DETAIL);
      console.warn(DB_CAUSE);
      return { rows };
    }
    return { rows: [] };
  };
  control.client = { query, release: () => void control.released++ } as unknown as pg.PoolClient;
  return control;
}

function mockPool(control: ClientControl): { ended: () => number } {
  let ended = 0;
  vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation(async () => control.client);
  vi.spyOn(pg.Pool.prototype, 'end').mockImplementation(async () => {
    ended += 1;
  });
  return { ended: () => ended };
}

async function company(options: { installation?: Partial<ProtectedInstallation>; env?: NodeJS.ProcessEnv; logger?: Parameters<typeof testApp>[1] } = {}) {
  const { app, db, config } = await testApp(ENV, options.logger);
  let operation: ReturnType<typeof createIncidentMetadataOperation>;
  app.get('/__task79_incident_metadata', async req => operation.invoke(req));
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [incident] = await db.insert(tasks).values({ id: TASK_ID, companyId: acme!.id, number: 29, title: 'Incident' }).returning();
  const [otherTask] = await db.insert(tasks).values({ companyId: acme!.id, number: 79, title: 'Other task' }).returning();
  const [target] = await db.insert(agents).values({ id: AGENT_ID, companyId: acme!.id, kind: 'worker', name: 'Incident target', roleKey: 'DEV-BE', model: '', subscriptionId: sub!.id }).returning();
  const [employee] = await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name: 'Employee', roleKey: 'DEV-BE', model: '', subscriptionId: sub!.id }).returning();
  const [currentJob] = await db
    .insert(jobs)
    .values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, taskId: incident!.id, kind: 'conversation', prompt: 'current turn', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(ORCHESTRATOR_TOKEN) })
    .returning();
  await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: employee!.id, taskId: incident!.id, kind: 'conversation', prompt: 'employee turn', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(EMPLOYEE_TOKEN) });
  const installation: ProtectedInstallation = {
    companyId: acme!.id,
    commit: config.commit,
    image: config.image,
    controlDir: config.controlDir,
    approvedBundleSha256: bundleSha256(),
    ...options.installation,
  };
  operation = createIncidentMetadataOperation(app.ctx, installation, { ...ENV, ...options.env });
  const invoke = async (options: { headers?: Record<string, string>; cookies?: Record<string, string> } = {}, url = '/__task79_incident_metadata') => {
    const response = await app.inject({ method: 'GET', url, ...options });
    return { response, body: response.json() as IncidentMetadataResult };
  };
  const asOrchestrator = () => ({ headers: { authorization: `Bearer ${ORCHESTRATOR_TOKEN}` } });
  return { app, db, config, ceo, acme: acme!, sub: sub!, owner: owner!, orchestrator: orchestrator!, incident: incident!, otherTask: otherTask!, target: target!, employee: employee!, currentJob: currentJob!, invoke, asOrchestrator };
}

const expectDenied = (body: IncidentMetadataResult) => {
  expect(body).toEqual({ error: { code: 'unauthorized', message: 'This incident metadata read is not authorized.' } });
  expect(JSON.stringify(body)).not.toContain('complete');
  expect(JSON.stringify(body)).not.toContain('jobs');
};

const expectUnavailable = (body: IncidentMetadataResult) => {
  expect(body).toEqual({ error: { code: 'unavailable', message: 'Incident metadata is temporarily unavailable.' } });
  expect(JSON.stringify(body)).not.toContain('complete');
  expect(JSON.stringify(body)).not.toContain('jobs');
};

const dbFailure = () => Object.assign(new Error(DB_CANARY, { cause: new Error(DB_CAUSE) }), { detail: DB_DETAIL, stack: `stack-${DB_DETAIL}` });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fixed incident metadata authority', () => {
  it('accepts an active owner session and the original orchestrator running job without caller-selected input', async () => {
    const c = await company();
    const row = metadataRow();
    const pool = diagnosticClient([row]);
    const lifecycle = mockPool(pool);
    const before = await c.db.select().from(jobs).orderBy(asc(jobs.id));
    const owner = await c.invoke(as(c.ceo), '/__task79_incident_metadata?task=79&agent=00000000-0000-4000-8000-000000000099&dsn=postgres%3A%2F%2Fcaller');
    expect(owner.body).toEqual({ jobs: [row], complete: true });
    expect(Object.keys(owner.body.jobs[0]!).sort()).toEqual([...JOB_KEYS].sort());
    const orchestrator = await c.invoke(c.asOrchestrator());
    expect(orchestrator.body).toEqual(owner.body);
    expect(pool.queries[0]).toBe('BEGIN READ ONLY');
    expect(pool.queries.at(-1)).toBe('ROLLBACK');
    expect(pool.released).toBe(2);
    expect(lifecycle.ended()).toBe(2);
    expect(await c.db.select().from(jobs).orderBy(asc(jobs.id))).toEqual(before);
  });

  it('rejects inactive sessions and non-owner company deputies before opening a diagnostic pool', async () => {
    const c = await company();
    const pool = diagnosticClient([metadataRow()]);
    const lifecycle = mockPool(pool);
    const deputy = await invitePerson(c.app, c.ceo, { name: 'Deputy', email: 'deputy@acme.test', access: { whole: true } });
    expectDenied((await c.invoke(as(deputy))).body);
    await c.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.tokenHash, hashToken(c.ceo)));
    expectDenied((await c.invoke(as(c.ceo))).body);
    expect(pool.released).toBe(0);
    expect(lifecycle.ended()).toBe(0);
  });

  it('rejects employee, node, foreign-company and forged internal-owner callers', async () => {
    const c = await company();
    const pool = diagnosticClient([metadataRow()]);
    const lifecycle = mockPool(pool);
    expectDenied((await c.invoke({ headers: { authorization: `Bearer ${EMPLOYEE_TOKEN}` } })).body);
    expectDenied((await c.invoke({ headers: { authorization: `Bearer ${NODE_KEY}` } })).body);
    expectDenied((await c.invoke({ headers: { authorization: 'Bearer unknown-token' } })).body);
    const [otherCompany] = await c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const [foreignOwner] = await c.db.insert(people).values({ companyId: otherCompany!.id, name: 'Foreign owner', email: 'foreign@acme.test', title: '', status: 'active', scopeKind: 'company', isOwner: true }).returning();
    await c.db.insert(sessions).values({ tokenHash: hashToken('foreign-session'), personId: foreignOwner!.id, expiresAt: new Date(Date.now() + 60_000) });
    expectDenied((await c.invoke(as('foreign-session'))).body);
    expectDenied((await c.invoke({ headers: orchestratorHeaders(c.owner.id, c.orchestrator.id) })).body);
    expect(pool.released).toBe(0);
    expect(lifecycle.ended()).toBe(0);
  });

  it('rejects ended jobs, wrong task, wrong agent and installation mismatch', async () => {
    const c = await company();
    const pool = diagnosticClient([metadataRow()]);
    const lifecycle = mockPool(pool);
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.currentJob.id));
    expectDenied((await c.invoke(c.asOrchestrator())).body);
    await c.db.update(jobs).set({ status: 'running', finishedAt: null, taskId: c.otherTask.id }).where(eq(jobs.id, c.currentJob.id));
    expectDenied((await c.invoke(c.asOrchestrator())).body);
    await c.db.update(jobs).set({ taskId: c.incident.id, agentId: c.employee.id }).where(eq(jobs.id, c.currentJob.id));
    expectDenied((await c.invoke(c.asOrchestrator())).body);
    await c.db.update(jobs).set({ agentId: c.orchestrator.id }).where(eq(jobs.id, c.currentJob.id));
    expect((await c.invoke(c.asOrchestrator())).body).toMatchObject({ complete: true });
    expect(lifecycle.ended()).toBe(1);
    const wrongInstallation = await company({ installation: { companyId: '00000000-0000-4000-8000-000000000099' } });
    mockPool(diagnosticClient([metadataRow()]));
    expectDenied((await wrongInstallation.invoke(wrongInstallation.asOrchestrator())).body);
  });
});

describe('fixed incident metadata runtime', () => {
  it('refuses a missing anchor, config drift and an unapproved bundle before a diagnostic connection', async () => {
    for (const options of [
      { installation: { commit: 'different-commit' } },
      { installation: { approvedBundleSha256: '0'.repeat(64) } },
      { env: { DATABASE_URL: 'postgres://drifted@127.0.0.1/task79' } },
    ]) {
      const c = await company(options);
      const pool = diagnosticClient([metadataRow()]);
      const lifecycle = mockPool(pool);
      expectUnavailable((await c.invoke(as(c.ceo))).body);
      expect(pool.released).toBe(0);
      expect(lifecycle.ended()).toBe(0);
    }
  });

  it('bounds rows and output characters without returning partial metadata', async () => {
    const forty = await company();
    mockPool(diagnosticClient(Array.from({ length: 40 }, () => metadataRow())));
    expect((await forty.invoke(as(forty.ceo))).body).toMatchObject({ complete: true });
    const fortyOne = await company();
    mockPool(diagnosticClient(Array.from({ length: 41 }, () => metadataRow())));
    expect((await fortyOne.invoke(as(fortyOne.ceo))).body).toEqual({ error: { code: 'conflict', message: 'Incident metadata cannot be returned safely.' } });
    const exact = metadataRow();
    const base = JSON.stringify({ jobs: [exact], complete: true }).length;
    exact.instructions_hash = 'x'.repeat(28_000 - base);
    const exactSize = await company();
    mockPool(diagnosticClient([exact]));
    const allowed = await exactSize.invoke(as(exactSize.ceo));
    expect(allowed.response.body).toHaveLength(28_000);
    exact.instructions_hash += 'x';
    const oversized = await company();
    mockPool(diagnosticClient([exact]));
    expect((await oversized.invoke(as(oversized.ceo))).body).toEqual({ error: { code: 'conflict', message: 'Incident metadata cannot be returned safely.' } });
  });

  it.each([
    ['extra field', { ...metadataRow(), prompt: 'hidden prompt canary' }],
    ['bad timestamp', { ...metadataRow(), created_at: '2026-11-01T00:17:00Z' }],
    ['bad digest', { ...metadataRow(), prompt_md5: 'not-a-digest' }],
    ['bad empty start', { ...metadataRow(), kind: 'test', empty_start: true }],
    ['null result', null],
  ])('refuses a forbidden or partial result: %s', async (_name, result) => {
    const c = await company();
    mockPool(diagnosticClient(result === null ? [] : [result]));
    if (result === null) {
      const pool = diagnosticClient([]);
      pool.client.query = (async input => {
        if (typeof input !== 'string') return { rows: null };
        return { rows: [] };
      }) as never;
      mockPool(pool);
    }
    const { response, body } = await c.invoke(as(c.ceo));
    expect(body).toEqual({ error: { code: 'conflict', message: 'Incident metadata cannot be returned safely.' } });
    for (const marker of FORBIDDEN) expect(response.body).not.toContain(marker);
  });

  it('sanitizes driver failures and captured stdout, stderr and logs, then cleans up', async () => {
    const lines: string[] = [];
    const c = await company({ logger: { level: 'error', stream: { write: (line: string) => void lines.push(line) } } });
    const pool = diagnosticClient([metadataRow()]);
    pool.fail(dbFailure());
    const lifecycle = mockPool(pool);
    let stderr = '';
    let stdout = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      stdout += String(chunk);
      return true;
    });
    const { response, body } = await c.invoke(as(c.ceo));
    process.stderr.write('task79-stderr-sentinel');
    process.stdout.write('task79-stdout-sentinel');
    c.app.log.error('task79-log-sentinel');
    const logs = lines.join('\n');
    expectUnavailable(body);
    expect(stderr).toBe('task79-stderr-sentinel');
    expect(stdout).toBe('task79-stdout-sentinel');
    expect(logs).toContain('task79-log-sentinel');
    for (const marker of FORBIDDEN) {
      expect(response.body).not.toContain(marker);
      expect(stderr).not.toContain(marker);
      expect(stdout).not.toContain(marker);
      expect(logs).not.toContain(marker);
    }
    expect(pool.queries.at(-1)).toBe('ROLLBACK');
    expect(pool.released).toBe(1);
    expect(lifecycle.ended()).toBe(1);
  });

  it('rolls back and closes after a whole-operation timeout', async () => {
    const c = await company();
    const pool = diagnosticClient([metadataRow()]);
    pool.hang();
    const lifecycle = mockPool(pool);
    const started = Date.now();
    expectUnavailable((await c.invoke(as(c.ceo))).body);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(pool.queries.at(-1)).toBe('ROLLBACK');
    expect(pool.released).toBe(1);
    expect(lifecycle.ended()).toBe(1);
  }, 10_000);
});
