import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import type { Db } from '../src/db/client.js';
import { agentEvents, agents, companies, departments, jobs, proposals, subscriptions } from '../src/db/schema.js';
import { listen, setUpCompany, testApp } from './helpers.js';

const TOKEN = 'tool-token-0123456789abcdef0123456789';

async function company() {
  const { app, db } = await testApp();
  await listen(app);
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [sub] = await db.select().from(subscriptions);
  const job = async (status: 'running' | 'done', token = TOKEN) =>
    (await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status, toolTokenHash: hashToken(token) }).returning())[0]!;
  return { app, db, companyId: acme!.id, orchestrator: orchestrator!, job };
}

async function mcp(app: FastifyInstance, token?: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  onTestFinished(() => client.close());
  return client;
}

const text = (res: unknown) => ((res as { content: { type: string; text: string }[] }).content[0]!.text);
const SALES = { template: 'sales', checked: true, note: 'Schools first' };

async function propose(client: Client, items: object[]) {
  return client.callTool({ name: 'propose_structure', arguments: { brief: 'Acme sells characters to schools. Two products.', items } });
}

const stored = async (db: Db) => ({
  proposals: await db.select().from(proposals).orderBy(asc(proposals.createdAt)),
  events: await db.select().from(agentEvents).where(eq(agentEvents.kind, 'proposal')),
});

describe('/mcp', () => {
  it('refuses a request without a token or with the token of a finished job', async () => {
    const { app, job } = await company();
    await job('done');
    await expect(mcp(app)).rejects.toThrow();
    await expect(mcp(app, TOKEN)).rejects.toThrow();
  });

  it('answers 405 to GET and DELETE', async () => {
    const { app } = await company();
    expect((await app.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(405);
    expect((await app.inject({ method: 'DELETE', url: '/mcp' })).statusCode).toBe(405);
  });

  it('offers the orchestrator the company view, the structure proposal, staffing and tasks', async () => {
    const { app, job } = await company();
    await job('running');
    const client = await mcp(app, TOKEN);
    const catchUp = (await client.listTools()).tools.find(tool => tool.name === 'program_keys');
    expect(catchUp?.description).toContain('Ask the account holder for their personal consent');
    expect(catchUp?.description).not.toContain('the owner\'s own too');
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['add_api_key', 'add_plan_to_machine', 'add_repository', 'add_tasks', 'answer_request', 'api', 'apply_pipeline', 'approval_policy', 'ask_person', 'backlog', 'build_structure', 'cancel_task', 'cancel_update', 'change_employee', 'change_orchestrator', 'change_person', 'check_updates', 'close_improvement', 'close_task', 'comment', 'company', 'computer', 'computer_result', 'connect_plans', 'create_google_sheet', 'create_repository', 'database', 'delete_person', 'disconnect_machine', 'edit_turn', 'escalate_missed_goal', 'explain_request', 'find_tool', 'fire_employee', 'forget', 'goals', 'hire', 'improvements', 'inbox', 'inbox_mark', 'invite_again', 'invite_person', 'lend_machine', 'logs', 'machine_command', 'machines', 'merge_conflicts', 'merge_pick', 'message_employee', 'move_orchestrator', 'notebook', 'open_computer_access', 'pause_task', 'phone_acquire', 'phone_action', 'phone_release', 'phone_session', 'phones', 'pipeline_catalog', 'pipeline_report', 'plan_command', 'pool', 'program_keys', 'program_recovery_release', 'program_screen', 'propose_staff', 'propose_structure', 'remember', 'remove_public_link', 'remove_repository', 'remove_subscription', 'replan_wait', 'report', 'request_approval', 'reset_employee', 'resolve_goal_risk', 'resume_task', 'rewrite_note', 'send_telegram_file', 'set_approval_policy', 'set_autonomous_release', 'set_budget', 'set_department_owner', 'set_goal', 'set_pipeline', 'set_public_link', 'set_repository', 'set_team_urgent_only', 'set_urgent', 'set_wait_policy', 'shell', 'source', 'staffing_options', 'stop_employee', 'task', 'tasks', 'test_subscription', 'track_work', 'turns', 'update_hornhoof', 'update_task', 'use_tool', 'vault_entries', 'vault_entry', 'wait_for']);
  });

  it('gives an employee the company view and its task tools', async () => {
    const { app, db, companyId } = await company();
    const [sub] = await db.select().from(subscriptions);
    const [bruno] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Bruno', model: 'sonnet', subscriptionId: sub!.id }).returning();
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: bruno!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(TOKEN) });
    const client = await mcp(app, TOKEN);
    const catalog = (await client.listTools()).tools;
    const description = (name: string) => catalog.find(tool => tool.name === name)?.description;
    expect(description('run_tests')).toContain('configured main line');
    expect(description('run_tests')).toContain('matching reusable evidence');
    expect(description('start_calls')).toContain('read full answers with calls');
    expect(description('phone_action')).toContain('Use social networks through their phone apps at a human pace.');
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['approval_policy', 'ask_person', 'blocked', 'briefing', 'calls', 'check_author', 'comment', 'company', 'computer', 'computer_result', 'confirm_finding', 'create_google_sheet', 'end_wait', 'goals', 'inbox', 'inbox_mark', 'machines', 'message_employee', 'phone_acquire', 'phone_action', 'phone_release', 'phone_session', 'phones', 'release_turn', 'replan_wait', 'report', 'request_approval', 'run_tests', 'run_work', 'send_telegram_file', 'start_calls', 'stop_calls', 'stop_tests', 'stop_work', 'submit', 'task', 'tasks', 'test_harness', 'test_run', 'track_work', 'vault_entries', 'vault_entry', 'verdict', 'wait_for', 'work_run']);
  });

  it('describes the company with the templates and no email addresses', async () => {
    const { app, db, companyId, job } = await company();
    await job('running');
    await db.update(companies).set({ brief: 'Characters for schools.' }).where(eq(companies.id, companyId));
    const [dev] = await db.insert(departments).values({ companyId, name: null, templateKey: 'development', roleCode: 'DEV', about: 'Two products' }).returning();
    const [mascot] = await db.insert(departments).values({ companyId, name: 'Mascot', roleCode: 'DEV', parentId: dev!.id, repoUrl: 'https://github.com/acme/mascot.git', repoBranch: 'release', repoTokenEnc: 'sealed', repoTokenLast4: 'Wq9z' }).returning();
    const [sub] = await db.select().from(subscriptions);
    const [bruno, hana] = await db
      .insert(agents)
      .values([
        { companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, productId: mascot!.id, model: 'claude-sonnet-5-5', subscriptionId: sub!.id, overrides: { base: 'Designs only: no product code.' } },
        { companyId, kind: 'head', name: 'Hana', roleKey: 'DEV-HEAD', departmentId: dev!.id, model: '' },
        { companyId, kind: 'worker', name: 'Gone', roleKey: 'DEV-FE', departmentId: dev!.id, model: '', removedAt: new Date() },
      ])
      .returning();
    const client = await mcp(app, TOKEN);
    const raw = text(await client.callTool({ name: 'company', arguments: {} }));
    expect(raw).not.toMatch(/@/);
    /* The token's last four are no hex digits, so no id of the answer holds them by chance. */
    expect(raw).not.toMatch(/sealed|Wq9z/);
    const view = JSON.parse(raw);
    expect(view).toMatchObject({
      name: 'Acme',
      brief: 'Characters for schools.',
      people: [{ name: 'Ivan', title: 'CEO' }],
      departments: [
        {
          id: dev!.id,
          name: 'Development',
          template: 'development',
          about: 'Two products',
          /* Where a task's code goes: a product's repository, else the department's own; never its token. */
          repository: null,
          products: [{ id: mascot!.id, name: 'Mascot', repository: { url: 'https://github.com/acme/mascot.git', branch: 'release' } }],
          employees: [
            /* The id is what create_task takes as the executor; the role id is what it takes as a gate. */
            { id: hana!.id, name: 'Hana', roleId: 'DEV-HEAD', role: 'Head of development', kind: 'head', product: null, provider: null, model: null, ownText: false },
            /* A person gave Bruno text of his own over his role's, which may narrow the work he takes: a head asks before giving him any. */
            { id: bruno!.id, name: 'Bruno', roleId: 'DEV-BE', role: 'Backend engineer', kind: 'worker', product: 'Mascot', provider: 'anthropic_api', model: 'claude-sonnet-5-5', ownText: true },
          ],
        },
      ],
      subscriptions: [{ provider: 'anthropic_api', kind: 'api_key', servesWholeCompany: true }],
    });
    expect(view.templates).toHaveLength(11);
    expect(view.templates).toContainEqual(expect.objectContaining({ key: 'video_production', name: 'Video production' }));
    expect(view.templates.filter((t: { alwaysOn: boolean }) => t.alwaysOn).map((t: { key: string }) => t.key)).toEqual(['operations']);
    expect(view.templates[0]).toMatchObject({ key: 'operations', name: 'Operations', description: expect.any(String) });
  });

  it('turns a structure it cannot accept into an error the agent can read, and stores nothing', async () => {
    const { app, db, companyId, job } = await company();
    await job('running');
    const [ops] = await db.insert(departments).values({ companyId, name: null, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const client = await mcp(app, TOKEN);
    for (const items of [
      [{ department: ops!.id, checked: true, note: '', remove: true }],
      [{ department: '00000000-0000-4000-8000-000000000000', checked: true, note: '' }],
      [SALES, SALES],
      [{ template: 'operations', checked: true, note: '' }],
    ]) {
      const res = await propose(client, items);
      expect(res.isError, JSON.stringify(items)).toBe(true);
      expect(text(res).length).toBeGreaterThan(10);
    }
    expect(await stored(db)).toEqual({ proposals: [], events: [] });
  });

  it('shows a valid structure to the CEO, and a newer one replaces it', async () => {
    const { app, db, orchestrator, job } = await company();
    const running = await job('running');
    const client = await mcp(app, TOKEN);
    const first = await propose(client, [SALES]);
    expect(first.isError).toBeFalsy();
    expect(text(first)).toMatch(/^Prepared structure preview [0-9a-f-]+\. Apply the selected changes with build_structure/);
    await propose(client, [SALES, { template: 'sales', name: 'Sales Europe', checked: true, note: 'Later' }]);
    const { proposals: rows, events } = await stored(db);
    expect(rows.map(p => p.status)).toEqual(['dismissed', 'draft']);
    expect(rows[1]).toMatchObject({ agentId: orchestrator.id, jobId: running.id, brief: 'Acme sells characters to schools. Two products.' });
    expect(events).toHaveLength(2);
    expect(events[1]!.data).toMatchObject({ proposalId: rows[1]!.id, items: [SALES, { name: 'Sales Europe' }] });
  });
});
