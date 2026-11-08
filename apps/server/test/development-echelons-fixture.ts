import { agents, companies, departments, people, subscriptions } from '../src/db/schema.js';
import { createTask, type NewTask } from '../src/modules/tasks/engine.js';
import { taskDetail } from '../src/modules/tasks/views.js';
import { setUpCompany, testApp } from './helpers.js';

export const BASE = 'a'.repeat(40);
export const HEAD = 'b'.repeat(40);

export async function fixture(options: { small?: boolean; riskClass?: 'none' | 'security'; authorProvider?: 'claude' | 'codex'; reviewerModel?: string; autoReviewer?: boolean; cleanup?: boolean; creator?: 'author' } = {}) {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [person] = await db.select().from(people);
  const [claude] = await db.select().from(subscriptions);
  const [codex] = await db.insert(subscriptions).values({ companyId: company!.id, provider: 'codex', kind: 'personal', label: 'Code', ownerPersonId: person!.id, status: 'ready' }).returning();
  const [department] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, subscriptionId: string, model: string) =>
    (await db.insert(agents).values({ companyId: company!.id, departmentId: department!.id, name, kind, roleKey, subscriptionId, model, skills: app.ctx.templates.roles.get(roleKey)?.skills.filter(s => s.on).map(s => s.id) ?? [] }).returning())[0]!;
  const head = await hire('Head', 'head', 'DEV-HEAD', claude!.id, 'claude-opus-5-5');
  const author = await hire('Author', 'worker', 'DEV-BE', options.authorProvider === 'claude' ? claude!.id : codex!.id, options.authorProvider === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol');
  const reviewer = await hire('Reviewer', 'worker', 'DEV-REV', claude!.id, options.reviewerModel ?? 'claude-opus-5-5');
  const security = await hire('Security', 'worker', 'DEV-SEC', claude!.id, 'claude-opus-5-5');
  const tester = await hire('Tests', 'worker', 'DEV-TEST', claude!.id, 'claude-opus-5-5');
  let commit = HEAD;
  let changedPaths = ['logic/totals.ts'];
  app.ctx.readCommit = async () => ({ branch: 'task-1', commitSha: commit });
  app.ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: changedPaths, diff: '@@ -1 +1 @@\n-old\n+new' });
  const input = {
    title: 'Keep totals', brief: 'Keep the total correct.', body: 'Change logic/totals.ts.',
    departmentId: department!.id, assigneeAgentId: author.id, executor: true,
    cleanup: options.cleanup, small: options.small ?? true, riskClass: options.riskClass ?? 'none', paths: ['logic/totals.ts'], reviewerAgentId: options.autoReviewer ? undefined : reviewer.id, securityAgentId: security.id, testsAgentId: tester.id,
  };
  const create = (changes: Partial<NewTask> = {}) => createTask(app.ctx, { agentId: head.id }, { ...input, ...changes });
  const atCommit = (head: string, paths = ['logic/totals.ts']) => { commit = head; changedPaths = paths; };
  const { task } = await createTask(app.ctx, { agentId: options.creator === 'author' ? author.id : head.id }, input);
  const detail = async (id = task.id) => {
    const { loadTask } = await import('../src/modules/tasks/engine.js');
    return taskDetail(app.ctx, await loadTask(db, id), () => true);
  };
  return { ctx: app.ctx, db, task, create, atCommit, head, author, reviewer, security, tester, detail, hire, claude: claude!, codex: codex! };
}

