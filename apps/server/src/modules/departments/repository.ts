import { repoFolder, type Workspace } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { departments } from '../../db/schema.js';

type Repo = NonNullable<Workspace['repo']>;

/* The repository an agent works in: its product's, else its department's, else none. The token comes decrypted, for the node alone. */
export async function repoFor(ctx: Pick<Ctx, 'db' | 'config'>, agent: { productId: string | null; departmentId: string | null }): Promise<Repo | null> {
  for (const id of [agent.productId, agent.departmentId]) {
    if (!id) continue;
    const [d] = await ctx.db.select({ url: departments.repoUrl, branch: departments.repoBranch, tokenEnc: departments.repoTokenEnc }).from(departments).where(eq(departments.id, id));
    if (d?.url) return { url: d.url, branch: d.branch ?? 'main', token: d.tokenEnc ? decryptSecret(d.tokenEnc, ctx.config.secret) : '' };
  }
  return null;
}

/* Where the agent finds the repository, added to every turn that carries one. */
export const repoLine = (repo: Repo) =>
  `Your repository ${repo.url} (branch ${repo.branch}) is cloned in ./${repoFolder(repo.url)} inside your folder. Work there: a branch per task, and the main branch only after the CEO approves the exact commit.`;
