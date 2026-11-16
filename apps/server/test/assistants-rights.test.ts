import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { people } from '../src/db/schema.js';
import { aclCompany, type AclCompany } from './agent-view-company.js';
import { as } from './helpers.js';

type Viewer = keyof AclCompany['tokens'];
type Crew = keyof AclCompany['crew'];

/* An assistant of this person, set up by them, and its key. */
async function assistantOf(c: AclCompany, owner: Viewer): Promise<{ id: string; key: string }> {
  const added = await c.app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name: `Ava of ${owner}`, owner: c.ids[owner], program: 'avaclone' }, ...as(c.tokens[owner]) });
  const { id } = added.json().person;
  const { key } = (await c.app.inject({ method: 'POST', url: `/api/people/${id}/key`, ...as(c.tokens[owner]) })).json();
  return { id, key };
}

const bearer = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });
const asAssistant = (c: AclCompany, key: string, url: string, method: 'GET' | 'POST' = 'GET', payload?: object) =>
  c.app.inject({ method, url, ...bearer(key), ...(payload ? { payload } : {}) });

/* The agents the assistant may write to, by the crew's names, and whether the orchestrator is among them. */
async function reach(c: AclCompany, key: string): Promise<{ crew: Crew[]; orchestrator: boolean }> {
  const res = await asAssistant(c, key, '/api/assistant/agents');
  expect(res.statusCode).toBe(200);
  const ids = new Set(res.json().agents.map((a: { id: string }) => a.id));
  return { crew: (Object.keys(c.crew) as Crew[]).filter(k => ids.has(c.crew[k].id)).sort(), orchestrator: ids.has(c.orchestrator.id) };
}

describe("an assistant's key", () => {
  it('opens only the assistant API, as its owner, and says who the owner is in plain fields', async () => {
    const c = await aclCompany();
    const { id, key } = await assistantOf(c, 'olga');
    const me = await asAssistant(c, key, '/api/assistant/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      assistant: { id, name: 'Ava of olga', title: '', program: 'avaclone', agentId: null, agentReady: false },
      owner: {
        id: c.ids.olga, name: 'Olga', title: '', ceo: false, ceoDelegate: false, wholeCompany: false,
        departments: [{ id: c.dev.id, name: 'Development' }], teams: [], responsibleFor: [{ id: c.dev.id, name: 'Development' }],
        telegram: { username: null, id: null },
      },
      company: { name: 'Acme' },
      contract: 2,
    });
    for (const url of ['/api/people', '/api/me', '/api/subscriptions', '/api/machines', '/api/link', '/api/updates', '/api/requests', `/api/agents/${c.crew.owned.id}/events`]) {
      expect((await asAssistant(c, key, url)).statusCode, url).toBe(401);
    }
    expect((await c.app.inject({ method: 'POST', url: '/api/people/invite', ...bearer(key), payload: { name: 'X', email: 'x@acme.com', access: { whole: true } } })).statusCode).toBe(401);
  });

  it("does not open the CEO's marks of an employee's letters", async () => {
    const c = await aclCompany();
    const { key } = await assistantOf(c, 'ceo');
    const res = await c.app.inject({ method: 'POST', url: `/api/agents/${c.crew.owned.id}/inbox/mark`, ...bearer(key), payload: { status: 'done', receivedBefore: '2100-01-01T00:00:00.000Z', reason: 'Stale.' } });
    expect(res.statusCode).toBe(401);
    /* The same marks open to the CEO's own session. */
    expect((await c.app.inject({ method: 'POST', url: `/api/agents/${c.crew.owned.id}/inbox/mark`, ...as(c.tokens.ceo), payload: { status: 'done', receivedBefore: '2100-01-01T00:00:00.000Z', reason: 'Stale.' } })).statusCode).toBe(200);
  });

  it("names the owner's Telegram as it is now, so a program can tell its owner from another person", async () => {
    const c = await aclCompany();
    const { key } = await assistantOf(c, 'olga');
    const telegram = async () => (await asAssistant(c, key, '/api/assistant/me')).json().owner.telegram;
    expect(await telegram()).toEqual({ username: null, id: null });
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.olga}`, payload: { telegram: '@Olga_K' }, ...as(c.tokens.olga) })).statusCode).toBe(200);
    expect(await telegram()).toEqual({ username: 'olga_k', id: null });
    await c.app.ctx.db.update(people).set({ telegramUserId: 5550001 }).where(eq(people.id, c.ids.olga));
    expect(await telegram()).toEqual({ username: 'olga_k', id: 5550001 });
  });

  it('is refused when missing, wrong, replaced, revoked, or its assistant is switched off', async () => {
    const c = await aclCompany();
    const { id, key } = await assistantOf(c, 'ann');
    expect((await c.app.inject({ url: '/api/assistant/me' })).statusCode).toBe(401);
    expect((await asAssistant(c, 'hha_' + 'x'.repeat(43), '/api/assistant/me')).json().error.reason).toBe('assistant_key_invalid');
    const { key: next } = (await c.app.inject({ method: 'POST', url: `/api/people/${id}/key`, ...as(c.tokens.ann) })).json();
    expect((await asAssistant(c, key, '/api/assistant/me')).statusCode).toBe(401);
    expect((await asAssistant(c, next, '/api/assistant/me')).statusCode).toBe(200);
    await c.app.inject({ method: 'PATCH', url: `/api/people/${id}`, payload: { status: 'disabled' }, ...as(c.tokens.ceo) });
    expect((await asAssistant(c, next, '/api/assistant/me')).statusCode).toBe(401);
    await c.app.inject({ method: 'PATCH', url: `/api/people/${id}`, payload: { status: 'active' }, ...as(c.tokens.ceo) });
    expect((await asAssistant(c, next, '/api/assistant/me')).statusCode).toBe(200);
    await c.app.inject({ method: 'DELETE', url: `/api/people/${id}/key`, ...as(c.tokens.ann) });
    expect((await asAssistant(c, next, '/api/assistant/me')).statusCode).toBe(401);
  });

  it('acts with its owner\'s rights as they are now, and is refused while the owner is disabled', async () => {
    const c = await aclCompany();
    const { key } = await assistantOf(c, 'wes');
    expect((await reach(c, key)).crew).toEqual(['wide']);
    await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.wes}`, payload: { status: 'disabled' }, ...as(c.tokens.ceo) });
    const refused = await asAssistant(c, key, '/api/assistant/agents');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.reason).toBe('assistant_owner_inactive');
  });
});

describe('whom an assistant may write to', () => {
  it("the CEO's: the orchestrator and every employee", async () => {
    const c = await aclCompany();
    expect(await reach(c, (await assistantOf(c, 'ceo')).key)).toEqual({ crew: (Object.keys(c.crew) as Crew[]).sort(), orchestrator: true });
  });

  it("the CEO delegate's: the same as the CEO's", async () => {
    const c = await aclCompany();
    expect(await reach(c, (await assistantOf(c, 'clara')).key)).toEqual({ crew: (Object.keys(c.crew) as Crew[]).sort(), orchestrator: true });
  });

  it("a department owner's: that department's head and employees, as the owner's window has it", async () => {
    const c = await aclCompany();
    const { key } = await assistantOf(c, 'olga');
    expect(await reach(c, key)).toEqual({ crew: ['head', 'mine', 'other', 'owned'], orchestrator: false });
    const refused = await asAssistant(c, key, '/api/assistant/messages', 'POST', { agentId: c.orchestrator.id, text: 'Hire a designer.' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.reason).toBe('assistant_agent_refused');
    expect((await asAssistant(c, key, '/api/assistant/messages', 'POST', { agentId: c.crew.far.id, text: 'Hi.' })).statusCode).toBe(403);
  });

  it("a listed person's: the employees on their plan where they work, as their window has it", async () => {
    const c = await aclCompany();
    expect(await reach(c, (await assistantOf(c, 'ann')).key)).toEqual({ crew: ['mine'], orchestrator: false });
  });

  it("is exactly whom its owner writes to in the agent's window, for everyone", async () => {
    const c = await aclCompany();
    const everyone = [c.orchestrator, ...Object.values(c.crew)];
    for (const owner of Object.keys(c.tokens) as Viewer[]) {
      const { key } = await assistantOf(c, owner);
      const listed = new Set((await asAssistant(c, key, '/api/assistant/agents')).json().agents.map((a: { id: string }) => a.id));
      for (const agent of everyone) {
        const window = (await c.app.inject({ url: `/api/agents/${agent.id}/events`, ...as(c.tokens[owner]) })).statusCode === 200;
        expect(listed.has(agent.id), `${owner}: ${agent.name}`).toBe(window);
      }
    }
  });

  it('names each agent with its kind, role and department', async () => {
    const c = await aclCompany();
    const { key } = await assistantOf(c, 'olga');
    const head = (await asAssistant(c, key, '/api/assistant/agents')).json().agents.find((a: { id: string }) => a.id === c.crew.head.id);
    expect(head).toEqual({ id: c.crew.head.id, name: 'Hana', kind: 'head', role: { en: expect.any(String), ru: expect.any(String) }, department: { id: c.dev.id, name: { en: 'Development', ru: 'Разработка' } } });
  });
});
