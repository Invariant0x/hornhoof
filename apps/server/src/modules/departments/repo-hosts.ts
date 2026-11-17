import { Repo } from '@hornhoof/protocol';
import { and, eq, isNotNull, isNull, max, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireDepartmentChanger } from '../../auth/departments.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { departments, repoHosts } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { checkFolderFree, repoView } from './repository.js';
import { deptName } from './templates.js';

/* The key of a git host Hornhoof creates a repository with, decrypted only for that, and the repository it asks for. */
export type HostKey = { provider: 'github'; owner: string; token: string };
export type NewRepository = { name: string; description: string };
/* The new repository's address to clone and its branch, and the page people open; or why it was not created. */
type CreatedRepository = { url: string; branch: string; page: string } | { problem: string };
export type RepositoryCreator = (key: HostKey, repo: NewRepository) => Promise<CreatedRepository>;

type Row = typeof repoHosts.$inferSelect;
type Dept = typeof departments.$inferSelect;

/* A user or organization on GitHub: letters, digits and single hyphens between them, 39 at most. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/* A repository's name on GitHub. */
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

const IdParams = z.object({ id: z.uuid() });
const HostBody = z.object({ owner: z.string().max(100), token: z.string().trim().max(500).optional() });
export const NewRepositoryBody = z.object({
  name: z.string().max(200).describe('The repository\'s name on GitHub: letters, digits, ".", "-" and "_", 100 at most.'),
  author: z.unknown().optional().describe('{ name, email } the agents commit under, as in set_repository.'),
});
/* With first, only a department's first repository, as the orchestrator creates it in a turn of its own. */
const CreateBody = NewRepositoryBody.extend({ first: z.literal(true).optional() });

/* A key as people who set it read it: never the key, only its last characters. */
const hostView = (h: Row) => ({ provider: h.provider, owner: h.owner, tokenLast4: h.tokenLast4 });
type HostShown = ReturnType<typeof hostView> & { own: boolean };

/* The keys that create the company's repositories: each top-level department's own, else the company's, with which of them
   it is. */
export async function hostsOf(db: Pick<Db, 'select'>, companyId: string): Promise<(departmentId: string) => HostShown | null> {
  const rows = await db.select().from(repoHosts).where(eq(repoHosts.companyId, companyId));
  const company = rows.find(r => !r.departmentId);
  return departmentId => {
    const own = rows.find(r => r.departmentId === departmentId);
    const used = own ?? company;
    return used ? { ...hostView(used), own: Boolean(own) } : null;
  };
}

async function keyFor(db: Pick<Db, 'select'>, companyId: string, departmentId: string): Promise<Row | null> {
  const rows = await db.select().from(repoHosts).where(and(eq(repoHosts.companyId, companyId), or(isNull(repoHosts.departmentId), eq(repoHosts.departmentId, departmentId))));
  return rows.find(r => r.departmentId === departmentId) ?? rows.find(r => !r.departmentId) ?? null;
}

const invalid = (message: string) => new ApiError(400, 'validation', message, 'repo_host_invalid');

const MISSING = (dept: string) =>
  `Hornhoof has no GitHub key to create a repository for ${dept} with. People who see the whole company save one for every department in Settings, under Integrations, ` +
  "and the department's owner one for this department under Repositories on its screen. Or they create the repository themselves and give its address and a token to connect it with set_repository.";

/* What GitHub shows under the repository's name, and its README's first commit holds. */
const aboutOf = (dept: Dept, top: Dept) =>
  `${dept.id === top.id ? deptName(top) : `${deptName(dept)}, a product of ${deptName(top)}`} in Hornhoof: the work of the department, ` +
  'letters, texts, layouts, tables and code, kept as files, so that any earlier version can be brought back.';

/* The company's key and a department's own, and the repository Hornhoof creates with them. A key is set by who sets the
   repositories it creates: the company's by people who see the whole company, a department's also by its owner. */
export function repoHostRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  /* A department or product of the person's company. */
  async function departmentOf(me: Person, id: string): Promise<Dept> {
    const [dept] = await db.select().from(departments).where(and(eq(departments.id, id), eq(departments.companyId, me.companyId)));
    if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    return dept;
  }

  async function save(me: Person, departmentId: string | null, raw: unknown) {
    const body = HostBody.parse(raw);
    const owner = body.owner.trim();
    if (!OWNER.test(owner)) throw invalid('Name the GitHub user or organization the repositories go to, as in github.com/<owner>: letters, digits and hyphens.');
    const place = departmentId ? eq(repoHosts.departmentId, departmentId) : and(eq(repoHosts.companyId, me.companyId), isNull(repoHosts.departmentId));
    const [saved] = await db.select().from(repoHosts).where(place);
    if (!body.token && !saved) throw invalid('Give the key: a GitHub token that may create repositories for this owner and push to them.');
    const key = body.token ? { tokenEnc: encryptSecret(body.token, ctx.config.secret), tokenLast4: body.token.slice(-4) } : {};
    const fields = { owner, ...key, updatedBy: me.id, updatedAt: new Date() };
    const [row] = saved
      ? await db.update(repoHosts).set(fields).where(eq(repoHosts.id, saved.id)).returning()
      : await db.insert(repoHosts).values({ companyId: me.companyId, departmentId, owner, tokenEnc: key.tokenEnc!, tokenLast4: key.tokenLast4!, updatedBy: me.id }).returning();
    ctx.bus.publish(me.companyId, { type: 'org' });
    return { host: hostView(row!) };
  }

  app.get('/api/repo-host', async req => {
    const me = await requirePerson(req, db);
    await requireDepartmentChanger(db, me, null);
    const [row] = await db.select().from(repoHosts).where(and(eq(repoHosts.companyId, me.companyId), isNull(repoHosts.departmentId)));
    return { host: row ? hostView(row) : null };
  });

  app.put('/api/repo-host', async req => {
    const me = await requirePerson(req, db);
    await requireDepartmentChanger(db, me, null);
    return save(me, null, req.body);
  });

  app.delete('/api/repo-host', async (req, reply) => {
    const me = await requirePerson(req, db);
    await requireDepartmentChanger(db, me, null);
    await db.delete(repoHosts).where(and(eq(repoHosts.companyId, me.companyId), isNull(repoHosts.departmentId)));
    ctx.bus.publish(me.companyId, { type: 'org' });
    return reply.code(204).send();
  });

  app.put('/api/departments/:id/repo-host', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    await requireDepartmentChanger(db, me, id);
    const dept = await departmentOf(me, id);
    if (dept.parentId) throw new ApiError(400, 'validation', `${deptName(dept)} is a product. Save the key on the department that holds it.`, 'repo_host_on_product');
    return save(me, dept.id, req.body);
  });

  app.delete('/api/departments/:id/repo-host', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    await requireDepartmentChanger(db, me, id);
    await db.delete(repoHosts).where(and(eq(repoHosts.companyId, me.companyId), eq(repoHosts.departmentId, id)));
    ctx.bus.publish(me.companyId, { type: 'org' });
    return reply.code(204).send();
  });

  /* A new private repository on the git host, with the department's key or else the company's, connected with that key: as
     the place's own when it has none, else as a new product of the department named after it. Everything that would stop it
     being connected is checked before the host is asked. */
  app.post('/api/departments/:id/repositories/new', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    await requireDepartmentChanger(db, me, id);
    const body = CreateBody.parse(req.body);
    const name = body.name.trim();
    if (!NAME.test(name) || name === '.' || name === '..') throw new ApiError(400, 'validation', 'Name the repository with letters, digits, ".", "-" and "_", 100 at most.', 'repo_name_invalid');
    const author = Repo.pick({ author: true }).safeParse({ author: body.author });
    if (!author.success) throw new ApiError(400, 'validation', 'Give the author a name on one line and a full email.', 'repo_invalid');
    const place = await departmentOf(me, id);
    const top = place.parentId ? await departmentOf(me, place.parentId) : place;
    const first = Boolean(body.first);
    if (first) await keepsNone(db, top);
    if (place.repoUrl && place.parentId) throw new ApiError(409, 'conflict', `${deptName(place)} keeps ${place.repoUrl} already, and a product keeps one repository. Create it on ${deptName(top)}, where it comes as a new product.`, 'repo_exists');
    const asProduct = Boolean(place.repoUrl);
    const productName = name.slice(0, 60);
    const host = await keyFor(db, me.companyId, top.id);
    if (!host) throw new ApiError(409, 'conflict', MISSING(deptName(top)), 'repo_host_missing');
    const expected = `https://github.com/${host.owner}/${name}.git`;
    await checks(db, top, place, asProduct, productName, expected, first);

    const key: HostKey = { provider: host.provider, owner: host.owner, token: decryptSecret(host.tokenEnc, ctx.config.secret) };
    const made = await ctx.createRepository(key, { name, description: aboutOf(place, top) });
    if ('problem' in made) throw new ApiError(502, 'unavailable', `GitHub did not create ${host.owner}/${name}. ${made.problem}`, 'repo_host_refused');

    const authorFields = author.data.author ? { repoAuthorName: author.data.author.name, repoAuthorEmail: author.data.author.email } : {};
    const fields = { repoUrl: made.url, repoBranch: made.branch, repoTokenEnc: host.tokenEnc, repoTokenLast4: host.tokenLast4, ...authorFields };
    try {
      if (!Repo.pick({ url: true, branch: true }).safeParse({ url: made.url, branch: made.branch }).success) throw new ApiError(502, 'unavailable', `GitHub gave it an address or branch Hornhoof does not take: ${made.url}, ${made.branch}.`, 'repo_host_refused');
      const row = await db.transaction(async tx => {
        await checks(tx, top, place, asProduct, productName, made.url, first);
        if (asProduct) {
          const [last] = await tx.select({ n: max(departments.position) }).from(departments).where(eq(departments.companyId, me.companyId));
          const [product] = await tx.insert(departments).values({ companyId: me.companyId, name: productName, parentId: top.id, roleCode: top.roleCode, position: (last?.n ?? -1) + 1, ...fields }).returning();
          return product!;
        }
        const [set] = await tx.update(departments).set({ ...fields, repoTokenRevision: sql`${departments.repoTokenRevision} + 1` }).where(and(eq(departments.id, place.id), isNull(departments.repoUrl))).returning();
        if (!set) throw new ApiError(409, 'conflict', `${deptName(place)} got a repository meanwhile.`, 'repo_exists');
        return set;
      });
      ctx.bus.publish(me.companyId, { type: 'org' });
      reply.code(201);
      return { place: { id: row.id, name: deptName(row) }, product: asProduct, page: made.page, repository: repoView(row) };
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      throw new ApiError(err.status, err.code, `GitHub created ${made.page}, but Hornhoof did not connect it: ${err.message} Connect it by its address with set_repository.`, err.reason);
    }
  });
}

/* What would stop a new repository being connected: a product name the department has, a folder its agents fill, or, for
   a department's first, a repository it keeps already. */
async function checks(db: Pick<Db, 'select'>, top: Dept, place: Dept, asProduct: boolean, productName: string, url: string, first: boolean): Promise<void> {
  if (first) await keepsNone(db, top);
  if (asProduct) {
    const products = await db.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.parentId, top.id));
    const same = products.find(p => p.name?.toLowerCase() === productName.toLowerCase());
    if (same) throw new ApiError(409, 'conflict', `${deptName(top)} has a product named ${same.name} already. Give the repository another name.`, 'product_taken');
  }
  await checkFolderFree(db, top.id, url, asProduct ? null : place.id);
}

/* A department keeps no repository: neither its own nor one of a product. */
async function keepsNone(db: Pick<Db, 'select'>, top: Dept): Promise<void> {
  const [kept] = await db
    .select({ url: departments.repoUrl })
    .from(departments)
    .where(and(or(eq(departments.id, top.id), eq(departments.parentId, top.id)), isNotNull(departments.repoUrl)));
  if (kept)
    throw new ApiError(
      409,
      'conflict',
      `${deptName(top)} keeps a repository already, ${kept.url}. Without the word of the CEO, the CEO delegate or its owner only a department's first one is created. Nothing was created: ask one of them.`,
      'repo_exists',
    );
}
