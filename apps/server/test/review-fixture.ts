import { and, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, subscriptions, taskEvents } from '../src/db/schema.js';
import { createTask, submit, verdict } from '../src/modules/tasks/engine.js';
import { echelonsTurn, listen, mcp, setUpCompany, testApp } from './helpers.js';

export const BASE = '0'.repeat(40);
export const FIRST = 'a'.repeat(40);
export const SECOND = 'b'.repeat(40);

export async function fixture() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const ctx = app.ctx;
  const [company] = await db.select().from(companies);
  const companyId = company!.id;
  const [ceo] = await db.select().from(people);
  const [claude] = await db.select().from(subscriptions);
  const [codex] = await db.insert(subscriptions).values({ companyId, provider: 'codex', kind: 'personal', label: 'Review', ownerPersonId: ceo!.id, status: 'ready' }).returning();
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, kind: 'worker' | 'head', roleKey: string, subscriptionId = claude!.id) =>
    (await db.insert(agents).values({ companyId, name, kind, roleKey, subscriptionId, departmentId: dev!.id, model: subscriptionId === codex!.id ? 'gpt-6.1-sol' : 'claude-opus-5-5', skills: ctx.templates.roles.get(roleKey)?.skills.filter(skill => skill.on).map(skill => skill.id) ?? [] }).returning())[0]!;
  const head = await hire('Head', 'head', 'DEV-HEAD');
  const author = await hire('Author', 'worker', 'DEV-BE');
  const reviewer = await hire('Reviewer', 'worker', 'DEV-REV', codex!.id);
  await echelonsTurn(db, companyId);
  const task = (await createTask(ctx, { agentId: head.id }, { title: 'Keep totals', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: author.id, executor: true, small: true, reviewerAgentId: reviewer.id, paths: ['logic/totals.ts'] })).task;
  let commit = FIRST;
  ctx.readCompare = async (_repo, refs) => ({ complete: true, baseSha: refs.base, headSha: refs.head, paths: ['logic/totals.ts'], diff: '@@ -3 +3 @@\n-old\n+new' });
  ctx.readCommit = async () => ({ branch: `task-${task.number}`, commitSha: commit });
  const event = async (kind: 'submitted' | 'verdict') => (await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, kind))).orderBy(taskEvents.id)).at(-1)!;
  let toolNumber = 0;
  const tools = async (actor = reviewer) => {
    if (!app.server.listening) await listen(app);
    const token = `review-tool-token-${++toolNumber}-0123456789abcdef`;
    await db.insert(jobs).values({ companyId, agentId: actor.id, subscriptionId: actor.subscriptionId!, taskId: task.id, kind: 'conversation', prompt: 'Review', status: 'running', timeoutMs: 1000, toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  return { ctx, db, task, head, author, reviewer, event, tools, hire, ceo: ceo!, advance: () => { commit = SECOND; } };
}

type Finding = { findingId: string; revision: string; reviewedCommit: string; reviewerId: string; reviewerVendor: string; taskId: string; authorId: string };
type FindingReport = { uniqueConfirmed: number; byVendor: { vendor: string; count: number; findingIds: string[] }[]; issues: Finding[]; legacyUncounted: number };

export async function rejectedFinding(category: 'security' | 'data' | 'spec' | 'other' | 'mechanical' = 'data') {
  const f = await fixture();
  await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } });
  const returned = await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, comment: 'The total is lost', reviewedCommit: FIRST, issues: [{ category, blocking: true, path: 'logic/totals.ts', line: 3, harm: 'A buyer is charged the wrong total.' }] });
  const issues = (await f.event('verdict')).data.issues;
  expect(issues).toEqual([expect.objectContaining({ findingId: expect.any(String), revision: expect.any(String), reviewedCommit: FIRST, reviewerId: f.reviewer.id, reviewerVendor: 'codex', taskId: f.task.id, authorId: f.author.id })]);
  const finding = (issues as Finding[])[0]!;
  const read = async (actor = f.reviewer): Promise<{ reviewFindings: FindingReport; fixReview?: { reviewedCommit: string; fixCommit: string; findingIds: string[] } }> => {
    const result = await (await f.tools(actor)).callTool({ name: 'task', arguments: { task: f.task.number } });
    return JSON.parse((result.content as { text: string }[])[0]!.text);
  };
  const confirm = async (actor = f.head, more: Record<string, unknown> = {}) => (await f.tools(actor)).callTool({ name: 'confirm_finding', arguments: { task: f.task.number, findingId: finding.findingId, revision: finding.revision, confirmed: true, reason: 'Verified the lost total', ...more } });
  const fix = async () => {
    f.advance();
    f.ctx.readCompare = async (_repo, refs) => ({ complete: true, baseSha: refs.base, headSha: refs.head, paths: ['logic/totals.ts'], diff: '@@ -3 +3 @@\n-old\n+fixed' });
    return submit(f.ctx, f.reviewer.id, f.task.id, { summary: 'Fixed the lost total', evidence: 'Unit check', review: { baseCommit: BASE } });
  };
  return { ...f, finding, confirm, read, fix, returned };
}

