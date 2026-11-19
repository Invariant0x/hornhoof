import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, subscriptions } from '../src/db/schema.js';
import { as, invitePerson, listen, mcp, setUpCompany, testApp } from './helpers.js';

/* Development with two products, Shop and Billing, and Marketing, which has no repository; an agent in each place, each
   in a running turn whose token reaches its tools. */
async function company() {
  const { app, db } = await testApp();
  await listen(app);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const place = async (values: Partial<typeof departments.$inferInsert>) => (await db.insert(departments).values({ companyId, roleCode: 'DEV', ...values }).returning())[0]!;
  const dev = await place({ templateKey: 'development' });
  const shop = await place({ name: 'Shop', parentId: dev.id, position: 1 });
  const billing = await place({ name: 'Billing', parentId: dev.id, position: 2 });
  const marketing = await place({ templateKey: 'marketing', roleCode: 'MKT' });
  const agent = async (name: string, departmentId: string, productId: string | null) => {
    const [a] = await db.insert(agents).values({ companyId, kind: 'worker', name, roleKey: 'DEV-BE', departmentId, productId, model: '', subscriptionId: sub!.id }).returning();
    const token = `tool-token-${name.toLowerCase()}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: a!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token) });
    return { ...a!, client: await mcp(app, token) };
  };
  const write = (id: string, payload: object, who = ceo) => app.inject({ method: 'PUT', url: `/api/departments/${id}/briefing`, payload, ...as(who) });
  return { app, db, ceo, dev, shop, billing, marketing, agent, write };
}

const briefing = async (client: Client) => {
  const res = (await client.callTool({ name: 'briefing', arguments: {} })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content[0]!.text, read: () => JSON.parse(res.content[0]!.text) as Record<string, any> };
};

const repo = (url: string, rules = '', author: { name: string; email: string } | null = null, branch = 'main') => ({ url, branch, rules, author });

describe('what a department and its products keep for their agents', () => {
  it('gives an agent its department and its product, with every repository of the product and the cloned one first, and nothing of any other', async () => {
    const { app, ceo, dev, shop, billing, marketing, agent, write } = await company();
    expect((await app.inject({ method: 'PUT', url: `/api/departments/${shop.id}/repository`, payload: { url: 'https://github.com/acme/shop.git', branch: 'release', token: 'ghp_shop2222', author: { name: 'Alex Rivera', email: 'alex@acme.example' } }, ...as(ceo) })).statusCode).toBe(200);
    expect((await write(dev.id, { text: 'We work by gates: review, security, tests.', repositories: [] })).statusCode).toBe(200);
    expect((await write(shop.id, {
      text: 'The shop sells shoes.',
      repositories: [
        repo('https://github.com/acme/shop-design.git', 'Design files only.', { name: 'Ada', email: 'ada@acme.dev' }),
        repo('https://github.com/acme/shop.git', 'Run npm test before you hand in.'),
        repo('https://github.com/acme/shop-docs.git', 'Plain English.', null, 'docs'),
      ],
    })).statusCode).toBe(200);
    expect((await write(billing.id, { text: 'Billing keeps its own plan.', repositories: [repo('https://github.com/acme/billing.git')] })).statusCode).toBe(200);
    expect((await write(marketing.id, { text: 'Marketing speaks plainly and posts twice a week.', repositories: [] })).statusCode).toBe(200);

    const bruno = await briefing((await agent('Bruno', dev.id, shop.id)).client);
    expect(bruno.read().department).toEqual({ name: 'Development', text: 'We work by gates: review, security, tests.', repositories: [] });
    expect(bruno.read().product).toEqual({
      name: 'Shop',
      text: 'The shop sells shoes.',
      repositories: [
        { url: 'https://github.com/acme/shop.git', branch: 'release', cloned: './shop', author: { name: 'Alex Rivera', email: 'alex@acme.example' }, rules: 'Run npm test before you hand in.' },
        repo('https://github.com/acme/shop-design.git', 'Design files only.', { name: 'Ada', email: 'ada@acme.dev' }),
        repo('https://github.com/acme/shop-docs.git', 'Plain English.', null, 'docs'),
      ],
    });
    expect(bruno.read().repositoryRules).toContain('read its own rules first (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md)');
    expect(bruno.read().repositoryRules).toContain('The company\'s authority and safety rules still govern');
    expect(bruno.read().repositoryRules).toContain('Apply any approval the department explicitly requires');
    for (const other of ['Billing keeps its own plan', 'billing.git', 'Marketing speaks plainly', 'ghp_']) expect(bruno.text).not.toContain(other);

    /* An agent of the department outside a product gets the department's record, and where each task's code goes: it may
       work on any product's task, whose repository is cloned in its folder when the task starts. */
    const pia = (await briefing((await agent('Pia', dev.id, null)).client)).read();
    expect(pia).toEqual({
      repositoryRules: expect.stringContaining('read its own rules first'),
      department: { name: 'Development', text: 'We work by gates: review, security, tests.', repositories: [] },
      product: null,
      taskRepositories: [{ product: { id: shop.id, name: 'Shop' }, url: 'https://github.com/acme/shop.git', branch: 'release', folder: './shop' }],
    });
    expect(JSON.stringify(pia)).not.toMatch(/ghp_|Billing keeps/);

    /* A department without a repository keeps its own way of working, and its agents read only that. */
    const mia = await briefing((await agent('Mia', marketing.id, null)).client);
    expect(mia.read()).toEqual({ department: { name: 'Marketing', text: 'Marketing speaks plainly and posts twice a week.', repositories: [] }, product: null });
    expect(mia.text).not.toContain('gates');
  });

  it("lists for a head every repository of its department and its products, the department's own first, and where each is cloned", async () => {
    const { app, ceo, dev, shop, billing, agent } = await company();
    const connect = (id: string, url: string) => app.inject({ method: 'PUT', url: `/api/departments/${id}/repository`, payload: { url, branch: 'main', token: 'ghp_secret9999' }, ...as(ceo) });
    await connect(billing.id, 'https://github.com/acme/billing.git');
    await connect(dev.id, 'https://github.com/acme/platform.git');
    await connect(shop.id, 'https://github.com/acme/shop.git');
    const head = (await briefing((await agent('Hana', dev.id, null)).client)).read();
    expect(head.taskRepositories).toEqual([
      { product: null, url: 'https://github.com/acme/platform.git', branch: 'main', folder: './platform' },
      { product: { id: shop.id, name: 'Shop' }, url: 'https://github.com/acme/shop.git', branch: 'main', folder: './shop' },
      { product: { id: billing.id, name: 'Billing' }, url: 'https://github.com/acme/billing.git', branch: 'main', folder: './billing' },
    ]);
    /* An agent of one product works on that product's tasks only, and reads nothing of another's. */
    const bruno = await briefing((await agent('Bruno', dev.id, shop.id)).client);
    expect(bruno.read()).not.toHaveProperty('taskRepositories');
    expect(bruno.text).not.toContain('billing');
  });

  it("never gives an agent a product of another department, whatever its card names", async () => {
    const { db, dev, shop, marketing, agent, write } = await company();
    await write(shop.id, { text: 'The shop sells shoes.', repositories: [] });
    const mia = await agent('Mia', marketing.id, null);
    await db.update(agents).set({ productId: shop.id }).where(eq(agents.id, mia.id));
    const read = await briefing(mia.client);
    expect(read.read().product).toBeNull();
    expect(read.text).not.toContain('shoes');
    expect(dev.id).not.toBe(marketing.id);
  });

  it('starts empty, and shows people the connected repository and who wrote the record last', async () => {
    const { app, ceo, dev, agent, write } = await company();
    expect((await app.inject({ url: `/api/departments/${dev.id}/briefing`, ...as(ceo) })).json().briefing).toEqual({ text: '', repositories: [], connected: null, updatedAt: null, by: null });
    expect((await briefing((await agent('Pia', dev.id, null)).client)).read()).toEqual({ department: { name: 'Development', text: '', repositories: [] }, product: null });
    await app.inject({ method: 'PUT', url: `/api/departments/${dev.id}/repository`, payload: { url: 'https://github.com/acme/platform.git', branch: 'main', token: 'ghp_platform1111' }, ...as(ceo) });
    const saved = (await write(dev.id, { text: 'Gates.', repositories: [repo('https://github.com/acme/tools.git')] })).json().briefing;
    expect(saved).toMatchObject({ text: 'Gates.', repositories: [repo('https://github.com/acme/tools.git')], connected: { url: 'https://github.com/acme/platform.git', branch: 'main', author: null }, by: { byOrchestrator: false } });
    expect(saved.by.name).toBeTruthy();
    expect(JSON.stringify(saved)).not.toContain('ghp_');
  });

  it('lets people with access to the department read and change it, and nobody else', async () => {
    const { app, ceo, dev, shop, marketing, write } = await company();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [marketing.id] } });
    expect((await write(marketing.id, { text: 'Posts twice a week.', repositories: [] }, maria)).statusCode).toBe(200);
    for (const id of [dev.id, shop.id]) {
      const refused = await write(id, { text: 'Skip the review.', repositories: [] }, maria);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.reason).toBe('not_your_department');
      expect((await app.inject({ url: `/api/departments/${id}/briefing`, ...as(maria) })).statusCode).toBe(403);
    }
    expect((await app.inject({ url: `/api/departments/${dev.id}/briefing`, ...as(ceo) })).json().briefing.text).toBe('');
  });

  it('takes only https repositories and records of a bounded size', async () => {
    const { dev, write } = await company();
    expect((await write(dev.id, { text: 'x', repositories: [repo('http://github.com/acme/a.git')] })).statusCode).toBe(400);
    expect((await write(dev.id, { text: 'x'.repeat(20_001), repositories: [] })).statusCode).toBe(400);
    expect((await write(dev.id, { text: 'x', repositories: Array.from({ length: 21 }, (_, i) => repo(`https://github.com/acme/r${i}.git`)) })).statusCode).toBe(400);
    expect((await write(dev.id, { text: 'x', repositories: [], extra: true })).statusCode).toBe(400);
  });
});
