import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { decryptSecret } from '../src/crypto/secrets.js';
import { HIDDEN } from '../src/db/agent-sql.js';
import { departments, repoHosts } from '../src/db/schema.js';
import type { HostKey, NewRepository } from '../src/modules/departments/repo-hosts.js';
import { company } from './department-owner-fixture.js';
import { as } from './helpers.js';

/* Hornhoof creates a department's repository itself with a key of the git host the company or the department saved: the
   CEO and people with the whole company save the company's, a department's owner the department's own, which goes first for
   it. GitHub is never reached here: each test answers for it. */

type C = Awaited<ReturnType<typeof company>>;
type Res = { content: { type: string; text: string }[]; isError?: boolean };

const COMPANY_KEY = 'ghp_company0000000000000000001111';
const DEV_KEY = 'github_pat_dev000000000000000002222';

const saveCompanyKey = (c: C, token: string, payload: object) => c.app.inject({ method: 'PUT', url: '/api/repo-host', payload, ...as(token) });
const saveDeptKey = (c: C, token: string, departmentId: string, payload: object) => c.app.inject({ method: 'PUT', url: `/api/departments/${departmentId}/repo-host`, payload, ...as(token) });
const create = (c: C, token: string, departmentId: string, payload: object) => c.app.inject({ method: 'POST', url: `/api/departments/${departmentId}/repositories/new`, payload, ...as(token) });
const deptOf = async (c: C, id: string) => (await c.db.select().from(departments).where(eq(departments.id, id)))[0]!;
const orgDept = async (c: C, token: string, id: string) => ((await c.app.inject({ url: '/api/org', ...as(token) })).json().departments as { id: string; repoHost?: unknown }[]).find(d => d.id === id);

/* GitHub as a test needs it: what it was asked, and its answer. */
function github(c: C, answer: (key: HostKey, repo: NewRepository) => Awaited<ReturnType<C['app']['ctx']['createRepository']>> = (key, repo) => ({ url: `https://github.com/${key.owner}/${repo.name}.git`, branch: 'main', page: `https://github.com/${key.owner}/${repo.name}` })) {
  const asked: { key: HostKey; repo: NewRepository }[] = [];
  c.app.ctx.createRepository = async (key, repo) => {
    asked.push({ key, repo });
    return answer(key, repo);
  };
  return asked;
}

describe('the key Hornhoof creates repositories with', () => {
  it('is saved for the whole company by the CEO and people with the whole company, and shows only its owner and last characters', async () => {
    const c = await company();
    const saved = await saveCompanyKey(c, c.ceoToken, { owner: 'acme', token: COMPANY_KEY });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(COMPANY_KEY);
    expect(saved.json()).toEqual({ host: { provider: 'github', owner: 'acme', tokenLast4: '1111' } });
    expect((await c.app.inject({ url: '/api/repo-host', ...as(c.wholeToken) })).json()).toEqual({ host: { provider: 'github', owner: 'acme', tokenLast4: '1111' } });
    const [row] = await c.db.select().from(repoHosts);
    expect(row).toMatchObject({ companyId: c.companyId, departmentId: null, owner: 'acme', tokenLast4: '1111' });
    expect(row!.tokenEnc).not.toContain(COMPANY_KEY);
    expect(decryptSecret(row!.tokenEnc, c.app.ctx.config.secret)).toBe(COMPANY_KEY);

    /* A new owner keeps the saved key; a new key replaces it; one row for the company all along. */
    expect((await saveCompanyKey(c, c.wholeToken, { owner: 'acme-labs' })).json().host).toEqual({ provider: 'github', owner: 'acme-labs', tokenLast4: '1111' });
    expect((await saveCompanyKey(c, c.ceoToken, { owner: 'acme', token: 'ghp_other9999' })).json().host.tokenLast4).toBe('9999');
    expect(await c.db.select().from(repoHosts)).toHaveLength(1);

    /* A department's owner and anyone else set no key of the whole company, and read none. */
    expect((await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana)).statusCode).toBe(200);
    for (const token of [c.danaToken, c.samToken]) {
      expect((await saveCompanyKey(c, token, { owner: 'mine', token: 'ghp_mine1234' })).statusCode).toBe(403);
      expect((await c.app.inject({ url: '/api/repo-host', ...as(token) })).statusCode).toBe(403);
    }
    expect((await c.app.inject({ method: 'DELETE', url: '/api/repo-host', ...as(c.danaToken) })).statusCode).toBe(403);

    expect((await c.app.inject({ method: 'DELETE', url: '/api/repo-host', ...as(c.ceoToken) })).statusCode).toBe(204);
    expect((await c.app.inject({ url: '/api/repo-host', ...as(c.ceoToken) })).json()).toEqual({ host: null });
  });

  it("stays out of the agents' own way into the database", () => {
    expect(HIDDEN).toContain('repo_hosts');
  });

  it('needs a key the first time, and an owner GitHub could have', async () => {
    const c = await company();
    const keyless = await saveCompanyKey(c, c.ceoToken, { owner: 'acme' });
    expect(keyless.statusCode).toBe(400);
    expect(keyless.json().error.reason).toBe('repo_host_invalid');
    for (const owner of ['', 'acme/shop', '-acme', 'a'.repeat(40), 'https://github.com/acme']) {
      const wrong = await saveCompanyKey(c, c.ceoToken, { owner, token: COMPANY_KEY });
      expect(wrong.statusCode, owner).toBe(400);
      expect(wrong.json().error.reason, owner).toBe('repo_host_invalid');
    }
    expect(await c.db.select().from(repoHosts)).toEqual([]);
  });

  it("is saved for one department by its owner, goes first for it, and shows on the department's screen to those who set its repositories", async () => {
    const c = await company();
    expect((await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana)).statusCode).toBe(200);
    expect(await orgDept(c, c.danaToken, c.dev.id)).toMatchObject({ repoHost: null });

    expect((await saveCompanyKey(c, c.ceoToken, { owner: 'acme', token: COMPANY_KEY })).statusCode).toBe(200);
    expect(await orgDept(c, c.danaToken, c.dev.id)).toMatchObject({ repoHost: { provider: 'github', owner: 'acme', tokenLast4: '1111', own: false } });

    const own = await saveDeptKey(c, c.danaToken, c.dev.id, { owner: 'acme-dev', token: DEV_KEY });
    expect(own.statusCode).toBe(200);
    expect(own.body).not.toContain(DEV_KEY);
    expect(own.json()).toEqual({ host: { provider: 'github', owner: 'acme-dev', tokenLast4: '2222' } });
    expect(await orgDept(c, c.danaToken, c.dev.id)).toMatchObject({ repoHost: { owner: 'acme-dev', tokenLast4: '2222', own: true } });
    expect(await orgDept(c, c.ceoToken, c.sales.id)).toMatchObject({ repoHost: { owner: 'acme', own: false } });
    /* Sam does not set Development's repositories, so he does not read its key either. */
    expect((await orgDept(c, c.samToken, c.dev.id))?.repoHost ?? null).toBeNull();

    /* Not on another department, not by Sam, and not on a product: a product goes with the department that holds it. */
    expect((await saveDeptKey(c, c.danaToken, c.sales.id, { owner: 'x', token: 'ghp_x1234' })).statusCode).toBe(403);
    expect((await saveDeptKey(c, c.samToken, c.dev.id, { owner: 'x', token: 'ghp_x1234' })).statusCode).toBe(403);
    const onProduct = await saveDeptKey(c, c.ceoToken, c.product.id, { owner: 'x', token: 'ghp_x1234' });
    expect(onProduct.statusCode).toBe(400);
    expect(onProduct.json().error.reason).toBe('repo_host_on_product');

    expect((await c.app.inject({ method: 'DELETE', url: `/api/departments/${c.dev.id}/repo-host`, ...as(c.danaToken) })).statusCode).toBe(204);
    expect(await orgDept(c, c.danaToken, c.dev.id)).toMatchObject({ repoHost: { owner: 'acme', own: false } });
  });
});

describe('a repository Hornhoof creates', () => {
  it('is a private repository of the key\'s owner, connected to a department without one with the same key, and never shows the key', async () => {
    const c = await company();
    await c.db.update(departments).set({ name: 'Marketing' }).where(eq(departments.id, c.sales.id));
    expect((await saveCompanyKey(c, c.ceoToken, { owner: 'acme', token: COMPANY_KEY })).statusCode).toBe(200);
    const asked = github(c);
    const author = { name: 'Alex Rivera', email: 'alex@acme.example' };

    const res = await create(c, c.ceoToken, c.sales.id, { name: 'marketing', author });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.body).not.toContain(COMPANY_KEY);
    expect(asked).toEqual([{ key: { provider: 'github', owner: 'acme', token: COMPANY_KEY }, repo: { name: 'marketing', description: expect.stringContaining('Marketing') } }]);
    expect(asked[0]!.repo.description).toMatch(/any earlier version/);
    expect(res.json()).toEqual({
      place: { id: c.sales.id, name: 'Marketing' },
      product: false,
      page: 'https://github.com/acme/marketing',
      repository: { url: 'https://github.com/acme/marketing.git', branch: 'main', tokenLast4: '1111', author, testMemoryGb: 4, fullTestCommand: null, releaseWorkflow: null },
    });
    const row = await deptOf(c, c.sales.id);
    expect(row).toMatchObject({ repoUrl: 'https://github.com/acme/marketing.git', repoBranch: 'main', repoTokenLast4: '1111' });
    expect(decryptSecret(row.repoTokenEnc!, c.app.ctx.config.secret)).toBe(COMPANY_KEY);
  });

  it("uses the department's own key before the company's, and comes as a new product of a department that has one already", async () => {
    const c = await company();
    expect((await saveCompanyKey(c, c.ceoToken, { owner: 'acme', token: COMPANY_KEY })).statusCode).toBe(200);
    expect((await saveDeptKey(c, c.ceoToken, c.dev.id, { owner: 'acme-dev', token: DEV_KEY })).statusCode).toBe(200);
    await c.db.update(departments).set({ repoUrl: 'https://github.com/acme/web.git' }).where(eq(departments.id, c.dev.id));
    const asked = github(c);

    const res = await create(c, c.ceoToken, c.dev.id, { name: 'docs' });
    expect(res.statusCode, res.body).toBe(201);
    expect(asked.map(a => a.key)).toEqual([{ provider: 'github', owner: 'acme-dev', token: DEV_KEY }]);
    const { place, product, repository } = res.json();
    expect(product).toBe(true);
    expect(place.name).toBe('docs');
    expect(repository).toMatchObject({ url: 'https://github.com/acme-dev/docs.git', tokenLast4: '2222' });
    expect(await deptOf(c, place.id)).toMatchObject({ parentId: c.dev.id, roleCode: 'DEV', repoUrl: 'https://github.com/acme-dev/docs.git' });
    expect((await deptOf(c, c.dev.id)).repoUrl).toBe('https://github.com/acme/web.git');

    /* A product without one takes it as its own, with the key of the department holding it. */
    const onProduct = await create(c, c.ceoToken, c.product.id, { name: 'shop' });
    expect(onProduct.statusCode, onProduct.body).toBe(201);
    expect(onProduct.json()).toMatchObject({ place: { id: c.product.id, name: 'Shop' }, product: false });
    expect(asked.at(-1)!.key.owner).toBe('acme-dev');
  });

  it('asks GitHub for nothing where it could not be connected, and says what is missing', async () => {
    const c = await company();
    const asked = github(c);

    const keyless = await create(c, c.ceoToken, c.sales.id, { name: 'sales' });
    expect(keyless.statusCode).toBe(409);
    expect(keyless.json().error.reason).toBe('repo_host_missing');
    expect(keyless.json().error.message).toMatch(/Settings, under Integrations/);
    expect(keyless.json().error.message).toMatch(/set_repository|address and a token/);

    expect((await saveCompanyKey(c, c.ceoToken, { owner: 'acme', token: COMPANY_KEY })).statusCode).toBe(200);
    for (const name of ['', 'my repo', 'a/b', '..', 'x'.repeat(101)]) {
      const wrong = await create(c, c.ceoToken, c.sales.id, { name });
      expect(wrong.statusCode, name).toBe(400);
      expect(wrong.json().error.reason, name).toBe('repo_name_invalid');
    }
    const badAuthor = await create(c, c.ceoToken, c.sales.id, { name: 'sales', author: { name: 'Ivan', email: 'nope' } });
    expect(badAuthor.statusCode).toBe(400);

    /* A product keeps one repository. */
    await c.db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, c.product.id));
    const kept = await create(c, c.ceoToken, c.product.id, { name: 'shop2' });
    expect(kept.statusCode).toBe(409);
    expect(kept.json().error.reason).toBe('repo_exists');

    /* A second one goes in as a product, so a name the department has, or a folder its agents fill, is refused first. */
    await c.db.update(departments).set({ repoUrl: 'https://github.com/other/web.git' }).where(eq(departments.id, c.dev.id));
    expect((await create(c, c.ceoToken, c.dev.id, { name: 'Shop' })).json().error.reason).toBe('product_taken');
    expect((await create(c, c.ceoToken, c.dev.id, { name: 'web' })).json().error.reason).toBe('repo_folder_taken');
    expect(asked).toEqual([]);
  });

  it("says GitHub's refusal and connects nothing", async () => {
    const c = await company();
    expect((await saveCompanyKey(c, c.ceoToken, { owner: 'acme', token: COMPANY_KEY })).statusCode).toBe(200);
    github(c, () => ({ problem: 'GitHub has a repository named sales for acme already.' }));
    const res = await create(c, c.ceoToken, c.sales.id, { name: 'sales' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ reason: 'repo_host_refused', message: expect.stringContaining('named sales for acme already') });
    expect((await deptOf(c, c.sales.id)).repoUrl).toBeNull();
  });

  it("is created by those who set the department's repositories, and by nobody else", async () => {
    const c = await company();
    expect((await saveCompanyKey(c, c.ceoToken, { owner: 'acme', token: COMPANY_KEY })).statusCode).toBe(200);
    expect((await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana)).statusCode).toBe(200);
    const asked = github(c);
    expect((await create(c, c.danaToken, c.sales.id, { name: 'sales' })).statusCode).toBe(403);
    expect((await create(c, c.samToken, c.dev.id, { name: 'dev' })).statusCode).toBe(403);
    expect(asked).toEqual([]);
    expect((await create(c, c.danaToken, c.dev.id, { name: 'dev' })).statusCode).toBe(201);
  });
});

describe('create_repository', () => {
  const call = async (c: Awaited<ReturnType<C['tools']>>, args: Record<string, unknown>) => (await c.callTool({ name: 'create_repository', arguments: args })) as Res;

  it("creates a department's first repository in a turn of its own, with no person's word, when a key is saved, and answers where it is", async () => {
    const c = await company();
    expect((await saveCompanyKey(c, c.ceoToken, { owner: 'acme', token: COMPANY_KEY })).statusCode).toBe(200);
    const asked = github(c);

    const own = await call(await c.tools(c.orchestrator), { department: c.sales.id, name: 'sales' });
    expect(own.isError, own.content[0]!.text).toBeFalsy();
    expect(own.content[0]!.text).toContain('https://github.com/acme/sales.git');
    expect(own.content[0]!.text).not.toContain(COMPANY_KEY);
    expect((await deptOf(c, c.sales.id)).repoUrl).toBe('https://github.com/acme/sales.git');
    expect(asked).toHaveLength(1);

    /* Then the department keeps one, and another goes in a turn of its own too, as the owner. */
    const again = await call(await c.tools(c.orchestrator), { department: c.sales.id, name: 'sales-docs' });
    expect(again.isError, again.content[0]!.text).toBeFalsy();
    expect(asked).toHaveLength(2);
  });

  it("creates another one in a turn of its own for a department that keeps a repository, as the owner", async () => {
    const c = await company();
    expect((await saveCompanyKey(c, c.ceoToken, { owner: 'acme', token: COMPANY_KEY })).statusCode).toBe(200);
    await c.db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, c.product.id));
    const asked = github(c);
    const made = await call(await c.tools(c.orchestrator, c.ids.sam), { department: c.dev.id, name: 'dev' });
    expect(made.isError, made.content[0]!.text).toBeFalsy();
    expect(asked).toHaveLength(1);
  });

  it("creates any other one for the CEO or the department's owner, in a turn that answers them", async () => {
    const c = await company();
    expect((await saveCompanyKey(c, c.ceoToken, { owner: 'acme', token: COMPANY_KEY })).statusCode).toBe(200);
    expect((await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana)).statusCode).toBe(200);
    await c.db.update(departments).set({ repoUrl: 'https://github.com/other/web.git' }).where(eq(departments.id, c.dev.id));
    const asked = github(c);

    const forDana = await call(await c.tools(c.orchestrator, c.ids.dana), { department: c.dev.id, name: 'docs' });
    expect(forDana.isError, forDana.content[0]!.text).toBeFalsy();
    expect(forDana.content[0]!.text).toContain('https://github.com/acme/docs.git');
    expect(forDana.content[0]!.text).not.toContain(COMPANY_KEY);
    const forCeo = await call(await c.tools(c.orchestrator, c.ids.ceo), { department: c.dev.id, name: 'notes' });
    expect(forCeo.isError, forCeo.content[0]!.text).toBeFalsy();
    expect((await c.db.select().from(departments).where(eq(departments.parentId, c.dev.id))).map(d => d.name).sort()).toEqual(['Shop', 'docs', 'notes']);
    expect(asked).toHaveLength(2);
  });

  it('says what it takes when there is no key, so the orchestrator can offer it', async () => {
    const c = await company();
    for (const person of [c.ids.ceo, null]) {
      const answer = await call(await c.tools(c.orchestrator, person), { department: c.sales.id, name: 'sales' });
      expect(answer.isError).toBe(true);
      expect(answer.content[0]!.text).toMatch(/no GitHub key/);
      expect(answer.content[0]!.text).toMatch(/Settings, under Integrations/);
    }
  });
});
