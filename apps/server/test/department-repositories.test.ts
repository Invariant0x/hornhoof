import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { departments } from '../src/db/schema.js';
import { ONLY_DEPARTMENT_OWNER } from '../src/modules/tools/control.js';
import { company } from './department-owner-fixture.js';
import { as } from './helpers.js';

/* A department may keep several repositories: its own, and one on each product. Another one comes as a new product of the
   department that holds it, in one step, so a head names the product to send a task's change there. */

type C = Awaited<ReturnType<typeof company>>;
type Res = { content: { type: string; text: string }[]; isError?: boolean };

const add = (c: C, token: string, departmentId: string, payload: object) => c.app.inject({ method: 'POST', url: `/api/departments/${departmentId}/repositories`, payload, ...as(token) });
const connect = (c: C, token: string, departmentId: string, url: string) => c.app.inject({ method: 'PUT', url: `/api/departments/${departmentId}/repository`, payload: { url, branch: 'main' }, ...as(token) });
const productsOf = async (c: C, departmentId: string) => (await c.db.select().from(departments).where(eq(departments.parentId, departmentId))).map(p => p.name).sort();

describe('another repository of a department', () => {
  it('comes as a new product of the department holding it, named after it unless a name is given, and never shows its token', async () => {
    const c = await company();
    const author = { name: 'Ivan Korol', email: 'ivan@acme.dev' };
    const res = await add(c, c.ceoToken, c.dev.id, { url: 'https://github.com/acme/mobile-app.git', token: 'ghp_mobile1111', author });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('ghp_mobile1111');
    const { product } = res.json();
    expect(product).toEqual({ id: expect.any(String), name: 'mobile-app', repository: { url: 'https://github.com/acme/mobile-app.git', branch: 'main', tokenLast4: '1111', author, testMemoryGb: 4, fullTestCommand: null } });
    const [row] = await c.db.select().from(departments).where(eq(departments.id, product.id));
    expect(row).toMatchObject({ companyId: c.companyId, parentId: c.dev.id, roleCode: 'DEV', repoUrl: 'https://github.com/acme/mobile-app.git', repoBranch: 'main' });
    expect(row!.repoTokenEnc).not.toContain('ghp_mobile1111');

    const named = await add(c, c.ceoToken, c.dev.id, { name: ' Server ', url: 'https://github.com/acme/api.git', branch: 'release' });
    expect(named.statusCode).toBe(201);
    expect(named.json().product).toMatchObject({ name: 'Server', repository: { url: 'https://github.com/acme/api.git', branch: 'release', tokenLast4: null } });
    expect(await productsOf(c, c.dev.id)).toEqual(['Server', 'Shop', 'mobile-app']);

    /* The department's screen shows each product with its repository. */
    const org = (await c.app.inject({ url: '/api/org', ...as(c.ceoToken) })).json();
    const dev = org.departments.find((d: { id: string }) => d.id === c.dev.id);
    expect(dev.products.map((p: { name: string; repository: { url: string } | null }) => [p.name, p.repository?.url ?? null])).toEqual([
      ['Shop', null],
      ['mobile-app', 'https://github.com/acme/mobile-app.git'],
      ['Server', 'https://github.com/acme/api.git'],
    ]);
  });

  it('is refused where an agent would clone it into the folder of another repository of the department, and adds nothing', async () => {
    const c = await company();
    expect((await connect(c, c.ceoToken, c.dev.id, 'https://github.com/acme/web.git')).statusCode).toBe(200);
    for (const url of ['https://github.com/other/web.git', 'https://github.com/other/Web']) {
      const clash = await add(c, c.ceoToken, c.dev.id, { url });
      expect(clash.statusCode, url).toBe(409);
      expect(clash.json().error.reason).toBe('repo_folder_taken');
      expect(clash.json().error.message).toContain('./web');
    }
    const onProduct = await connect(c, c.ceoToken, c.product.id, 'https://github.com/other/web.git');
    expect(onProduct.statusCode).toBe(409);
    expect(onProduct.json().error.reason).toBe('repo_folder_taken');
    expect(await productsOf(c, c.dev.id)).toEqual(['Shop']);
    /* The same address twice is one clone, and another department's agents have folders of their own. */
    expect((await connect(c, c.ceoToken, c.product.id, 'https://github.com/acme/web.git')).statusCode).toBe(200);
    expect((await connect(c, c.ceoToken, c.sales.id, 'https://github.com/other/web.git')).statusCode).toBe(200);
    /* A department's own repository may move to another address of the same name. */
    expect((await connect(c, c.ceoToken, c.dev.id, 'https://gitlab.com/acme/web.git')).statusCode).toBe(409);
    await c.db.update(departments).set({ repoUrl: null }).where(eq(departments.id, c.product.id));
    expect((await connect(c, c.ceoToken, c.dev.id, 'https://gitlab.com/acme/web.git')).statusCode).toBe(200);
  });

  it('is refused under a name the department has, on a product, and with a wrong address', async () => {
    const c = await company();
    const taken = await add(c, c.ceoToken, c.dev.id, { name: 'shop', url: 'https://github.com/acme/shop.git' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.reason).toBe('product_taken');
    const onProduct = await add(c, c.ceoToken, c.product.id, { url: 'https://github.com/acme/app.git' });
    expect(onProduct.statusCode).toBe(400);
    expect(onProduct.json().error.message).toContain('Shop is a product');
    const wrong = await add(c, c.ceoToken, c.dev.id, { url: 'http://github.com/acme/app.git' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.reason).toBe('repo_invalid');
    expect((await add(c, c.ceoToken, '00000000-0000-4000-8000-000000000000', { url: 'https://github.com/acme/app.git' })).statusCode).toBe(404);
    expect(await productsOf(c, c.dev.id)).toEqual(['Shop']);
  });

  it("is added by the department's owner and people with the whole company, and by nobody else", async () => {
    const c = await company();
    expect((await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana)).statusCode).toBe(200);
    expect((await add(c, c.danaToken, c.dev.id, { url: 'https://github.com/acme/app.git' })).statusCode).toBe(201);
    expect((await add(c, c.danaToken, c.sales.id, { url: 'https://github.com/acme/crm.git' })).statusCode).toBe(403);
    const sam = await add(c, c.samToken, c.sales.id, { url: 'https://github.com/acme/crm.git' });
    expect(sam.statusCode).toBe(403);
    expect(sam.json().error.reason).toBe('department_owner_only');
    expect((await add(c, c.wholeToken, c.sales.id, { url: 'https://github.com/acme/crm.git' })).statusCode).toBe(201);
    expect(await c.db.select({ name: departments.name }).from(departments).where(and(eq(departments.parentId, c.sales.id)))).toEqual([{ name: 'crm' }]);
    /* The owner reads the repositories of the department, as the people who set repositories do, and of no other. */
    const org = (await c.app.inject({ url: '/api/org', ...as(c.danaToken) })).json();
    const dev = org.departments.find((d: { id: string }) => d.id === c.dev.id);
    expect(dev.products.find((p: { name: string }) => p.name === 'app').repository.url).toBe('https://github.com/acme/app.git');
    expect(org.departments.find((d: { id: string }) => d.id === c.sales.id)?.products ?? []).not.toContainEqual(expect.objectContaining({ repository: expect.anything() }));
  });
});

describe('add_repository', () => {
  const call = async (c: Awaited<ReturnType<C['tools']>>, args: Record<string, unknown>) => (await c.callTool({ name: 'add_repository', arguments: args })) as Res;

  it("adds a repository for the CEO or the department's owner, in a turn that answers them, and for nobody else", async () => {
    const c = await company();
    expect((await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana)).statusCode).toBe(200);
    const forCeo = await call(await c.tools(c.orchestrator, c.ids.ceo), { department: c.dev.id, name: 'Docs', url: 'https://github.com/acme/docs.git', token: 'ghp_docs4444' });
    expect(forCeo.isError, forCeo.content[0]!.text).toBeFalsy();
    expect(forCeo.content[0]!.text).not.toContain('ghp_docs4444');
    const forDana = await call(await c.tools(c.orchestrator, c.ids.dana), { department: c.dev.id, url: 'https://github.com/acme/app.git' });
    expect(forDana.isError, forDana.content[0]!.text).toBeFalsy();
    const forSam = await call(await c.tools(c.orchestrator, c.ids.sam), { department: c.dev.id, url: 'https://github.com/acme/other.git' });
    expect(forSam.content[0]!.text).toBe(ONLY_DEPARTMENT_OWNER);
    const unasked = await call(await c.tools(c.orchestrator), { department: c.dev.id, url: 'https://github.com/acme/other.git' });
    expect(unasked.isError).toBe(true);
    expect(await productsOf(c, c.dev.id)).toEqual(['Docs', 'Shop', 'app']);
  });
});
