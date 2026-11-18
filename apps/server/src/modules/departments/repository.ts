import { repoFolder, type Workspace } from '@hornhoof/protocol';
import { eq, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { departments, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { deptName } from './templates.js';

type Repo = NonNullable<Workspace['repo']>;

/* The first of these departments and products that has a repository, with it. The token comes decrypted, for the node and for reading the repository's branches. */
export async function repoAt(ctx: { db: Pick<Ctx['db'], 'select'>; config: Ctx['config'] }, ids: (string | null)[]): Promise<{ department: typeof departments.$inferSelect; repo: Repo } | null> {
  for (const id of ids) {
    if (!id) continue;
    const [d] = await ctx.db.select().from(departments).where(eq(departments.id, id));
    if (d?.repoUrl) return { department: d, repo: { url: d.repoUrl, branch: d.repoBranch ?? 'main', token: d.repoTokenEnc ? decryptSecret(d.repoTokenEnc, ctx.config.secret) : '', author: authorOf(d) } };
  }
  return null;
}

/* Where a turn looks for its repository: for a task of the agent's own department, the task's product and department, as
   every check of the task does, so an agent of the whole department works in the repository of the product its task is
   of; otherwise the agent's own product and department. */
export async function turnPlaces(db: Pick<Ctx['db'], 'select'>, agent: { productId: string | null; departmentId: string | null }, taskId: string | null): Promise<(string | null)[]> {
  const [task] = taskId ? await db.select({ productId: tasks.productId, departmentId: tasks.departmentId }).from(tasks).where(eq(tasks.id, taskId)) : [];
  return task && task.departmentId === agent.departmentId ? [task.productId, task.departmentId] : [agent.productId, agent.departmentId];
}

/* One repository under two spellings of its address, with or without the ending .git or /. */
const bare = (url: string) => url.replace(/\/+$/, '').replace(/\.git$/i, '');

/* A department's agents clone its repository and those of its products side by side in their folders, each into the folder
   its address ends in, so two repositories of one department under one such name would share a folder: the second would
   point the first one's clone at itself. Names compare without case, as some machines' files do. except: the place being set,
   whose own repository it replaces. */
export async function checkFolderFree(db: Pick<Ctx['db'], 'select'>, departmentId: string, url: string, except: string | null): Promise<void> {
  const folder = repoFolder(url);
  const family = await db.select().from(departments).where(or(eq(departments.id, departmentId), eq(departments.parentId, departmentId)));
  const other = family.find(d => d.id !== except && d.repoUrl && repoFolder(d.repoUrl).toLowerCase() === folder.toLowerCase() && bare(d.repoUrl) !== bare(url));
  if (other) {
    const where = `${other.id === departmentId ? 'The department' : 'The product'} ${deptName(other)}`;
    throw new ApiError(409, 'conflict', `${where} keeps ${other.repoUrl}, which the department's agents clone into ./${repoFolder(other.repoUrl!)} already. A department keeps no two repositories whose addresses end in one name.`, 'repo_folder_taken');
  }
}

export const authorOf = (d: { repoAuthorName: string | null; repoAuthorEmail: string | null }) =>
  d.repoAuthorName && d.repoAuthorEmail ? { name: d.repoAuthorName, email: d.repoAuthorEmail } : null;

/* The free memory a machine needs to take a test run of a repository that names none. */
export const TEST_MEMORY_GB = 4;

/* A repository as people who set it read it: never its token, only the token's last characters. */
export const repoView = (d: typeof departments.$inferSelect) =>
  d.repoUrl ? { url: d.repoUrl, branch: d.repoBranch ?? 'main', tokenLast4: d.repoTokenLast4, author: authorOf(d), testMemoryGb: d.repoTestMemoryGb ?? TEST_MEMORY_GB, fullTestCommand: d.repoFullTestCommand } : null;

