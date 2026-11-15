import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { assistants, people } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { aclCompany, type AclCompany } from './agent-view-company.js';
import { as } from './helpers.js';

type Viewer = keyof AclCompany['tokens'];

const addAssistant = (c: AclCompany, by: Viewer, owner: string, more: object = {}) =>
  c.app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name: 'Ava', owner, program: 'avaclone', ...more }, ...as(c.tokens[by]) });
const keyOf = (c: AclCompany, by: Viewer, id: string) => c.app.inject({ method: 'POST', url: `/api/people/${id}/key`, ...as(c.tokens[by]) });
const settingsOf = (c: AclCompany, by: Viewer, id: string, payload: object) => c.app.inject({ method: 'PATCH', url: `/api/people/${id}/assistant`, payload, ...as(c.tokens[by]) });

describe('an assistant in People', () => {
  it('is a person marked as an agent of its owner, with no email and no access of its own', async () => {
    const c = await aclCompany();
    const res = await addAssistant(c, 'ceo', c.ids.ceo, { title: 'Personal assistant', eventsUrl: 'https://ava.example/hornhoof' });
    expect(res.statusCode).toBe(201);
    const { person } = res.json();
    expect(person).toMatchObject({
      name: 'Ava', title: 'Personal assistant', email: null, status: 'active', isOwner: false, isCeoDelegate: false,
      access: { whole: false, departments: [], teams: [] },
      assistant: { owner: { id: c.ids.ceo, name: 'Ivan' }, program: 'avaclone', eventsUrl: 'https://ava.example/hornhoof', key: null },
    });
    const listed = (await c.get('/api/people', c.tokens.ann)).json().people.find((p: { id: string }) => p.id === person.id);
    expect(listed.assistant).toMatchObject({ owner: { id: c.ids.ceo, name: 'Ivan' }, program: 'avaclone' });
    expect((await c.get('/api/people', c.tokens.ann)).json().people.find((p: { id: string }) => p.id === c.ids.ann).assistant).toBeNull();
    const [row] = await c.db.select().from(people).where(eq(people.id, person.id));
    expect(row).toMatchObject({ isAgent: true, assistantOf: c.ids.ceo, passwordHash: null, scopeKind: 'listed' });
  });

  it('gets a key and a signing secret shown once, kept as a hash and encrypted, replaced and revoked', async () => {
    const c = await aclCompany();
    const ava = (await addAssistant(c, 'ceo', c.ids.ceo)).json().person;
    const first = await keyOf(c, 'ceo', ava.id);
    expect(first.statusCode).toBe(201);
    const { key, signingSecret, person } = first.json();
    expect(key).toMatch(/^hha_[A-Za-z0-9_-]{43}$/);
    expect(signingSecret).toMatch(/^hhs_[A-Za-z0-9_-]{43}$/);
    expect(person.assistant.key).toEqual({ createdAt: expect.any(String) });
    const [row] = await c.db.select().from(assistants).where(eq(assistants.personId, ava.id));
    expect(row!.keyHash).toBe(hashToken(key));
    expect(JSON.stringify(row)).not.toContain(key);
    expect(JSON.stringify(row)).not.toContain(signingSecret.slice(4));
    expect((await c.get('/api/people', c.tokens.ceo)).body).not.toContain(key);

    const second = (await keyOf(c, 'ceo', ava.id)).json();
    expect(second.key).not.toBe(key);
    expect(second.signingSecret).not.toBe(signingSecret);
    expect((await c.db.select().from(assistants).where(eq(assistants.personId, ava.id)))[0]!.keyHash).toBe(hashToken(second.key));

    const revoked = await c.app.inject({ method: 'DELETE', url: `/api/people/${ava.id}/key`, ...as(c.tokens.ceo) });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().person.assistant.key).toBeNull();
    expect((await c.db.select().from(assistants).where(eq(assistants.personId, ava.id)))[0]).toMatchObject({ keyHash: null, wakeSecretEnc: null, keyCreatedAt: null });
  });

  it("gives OpenClaw and Hermes their settings with a new key: Hornhoof's MCP server, and the webhook when Hornhoof wakes them", async () => {
    const c = await aclCompany();
    const made = async (program: string, eventsUrl?: string) => {
      const ava = (await addAssistant(c, 'ceo', c.ids.ceo, { program, eventsUrl })).json().person;
      return (await keyOf(c, 'ceo', ava.id)).json();
    };
    expect((await made('avaclone', 'https://ava.example/hornhoof')).setup).toBeNull();
    expect((await made('other')).setup).toBeNull();

    const claw = await made('openclaw', 'http://127.0.0.1:18789/hooks/wake');
    expect(claw.setup).toEqual({
      file: '~/.openclaw/openclaw.json',
      text: [
        '{',
        '  mcp: {',
        '    servers: {',
        '      hornhoof: {',
        `        url: "${claw.address}/api/assistant/mcp",`,
        '        transport: "streamable-http",',
        `        headers: { Authorization: "Bearer ${claw.key}" },`,
        '      },',
        '    },',
        '  },',
        '  hooks: {',
        '    enabled: true,',
        `    token: "${claw.signingSecret}",`,
        '  },',
        '}',
      ].join('\n'),
    });
    const quiet = await made('openclaw');
    expect(quiet.setup.text).toContain(`Authorization: "Bearer ${quiet.key}"`);
    expect(quiet.setup.text).not.toContain('hooks');
    expect(quiet.setup.text).not.toContain(quiet.signingSecret);

    const hermes = await made('hermes', 'http://127.0.0.1:8644/webhooks/hornhoof');
    expect(hermes.setup).toEqual({
      file: '~/.hermes/config.yaml',
      text: [
        'mcp_servers:',
        '  hornhoof:',
        `    url: "${hermes.address}/api/assistant/mcp"`,
        '    headers:',
        `      Authorization: "Bearer ${hermes.key}"`,
        'platforms:',
        '  webhook:',
        '    enabled: true',
        '    extra:',
        '      routes:',
        '        hornhoof:',
        `          secret: "${hermes.signingSecret}"`,
        '          prompt: "New events wait for you in Hornhoof after number {after}. Read them with the Hornhoof tool read_events, with after {after}, and tell your owner what they need to know."',
        '          deliver: telegram',
        '          mirror_to_session: true',
      ].join('\n'),
    });
    const hermesQuiet = await made('hermes');
    expect(hermesQuiet.setup.text).not.toContain('platforms');
    expect(hermesQuiet.setup.text).not.toContain(hermesQuiet.signingSecret);
  });

  it('changes its program and events address, which must be a web address', async () => {
    const c = await aclCompany();
    const ava = (await addAssistant(c, 'ceo', c.ids.ceo)).json().person;
    const changed = await settingsOf(c, 'ceo', ava.id, { program: 'openclaw', eventsUrl: 'http://127.0.0.1:8080/wake' });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().person.assistant).toMatchObject({ program: 'openclaw', eventsUrl: 'http://127.0.0.1:8080/wake' });
    expect((await settingsOf(c, 'ceo', ava.id, { eventsUrl: null })).json().person.assistant.eventsUrl).toBeNull();
    expect((await settingsOf(c, 'ceo', ava.id, { eventsUrl: 'ftp://ava.example' })).statusCode).toBe(400);
    expect((await settingsOf(c, 'ceo', ava.id, { program: 'somebot' })).statusCode).toBe(400);
    expect((await addAssistant(c, 'ceo', c.ids.ceo, { eventsUrl: 'not an address' })).statusCode).toBe(400);
  });

  it('is set up by its owner, and by people with the whole company, but the CEO\'s and the delegate\'s only by the CEO', async () => {
    const c = await aclCompany();
    const own = await addAssistant(c, 'ann', c.ids.ann);
    expect(own.statusCode).toBe(201);
    expect((await keyOf(c, 'ann', own.json().person.id)).statusCode).toBe(201);
    expect((await addAssistant(c, 'ann', c.ids.bob)).statusCode).toBe(403);
    expect((await keyOf(c, 'olga', own.json().person.id)).statusCode).toBe(403);
    expect((await settingsOf(c, 'olga', own.json().person.id, { program: 'other' })).statusCode).toBe(403);
    expect((await addAssistant(c, 'wes', c.ids.ann)).statusCode).toBe(201);
    expect((await keyOf(c, 'wes', own.json().person.id)).statusCode).toBe(201);

    const ceos = (await addAssistant(c, 'ceo', c.ids.ceo)).json().person;
    const claras = (await addAssistant(c, 'clara', c.ids.clara)).json().person;
    for (const viewer of ['wes', 'clara'] as const) {
      const refused = await keyOf(c, viewer, ceos.id);
      expect(refused.statusCode, viewer).toBe(403);
      expect(refused.json().error.reason).toBe('owner_locked');
    }
    expect((await addAssistant(c, 'wes', c.ids.ceo)).statusCode).toBe(403);
    expect((await addAssistant(c, 'wes', c.ids.clara)).statusCode).toBe(403);
    expect((await keyOf(c, 'wes', claras.id)).statusCode).toBe(403);
    expect((await keyOf(c, 'clara', claras.id)).statusCode).toBe(201);
    expect((await keyOf(c, 'ceo', claras.id)).statusCode).toBe(201);
  });

  it('belongs to an active person of the company, never to another assistant', async () => {
    const c = await aclCompany();
    const ava = (await addAssistant(c, 'ceo', c.ids.ceo)).json().person;
    const ofAssistant = await addAssistant(c, 'ceo', ava.id);
    expect(ofAssistant.statusCode).toBe(409);
    expect(ofAssistant.json().error.reason).toBe('assistant_owner_invalid');
    await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.bob}`, payload: { status: 'disabled' }, ...as(c.tokens.ceo) });
    expect((await addAssistant(c, 'ceo', c.ids.bob)).json().error.reason).toBe('assistant_owner_invalid');
    expect((await addAssistant(c, 'ceo', '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await keyOf(c, 'ceo', c.ids.ann)).json().error.reason).toBe('not_an_assistant');
  });

  it('never signs in: no invite link, no access, no Telegram, and it comes back active', async () => {
    const c = await aclCompany();
    const ava = (await addAssistant(c, 'ceo', c.ids.ceo)).json().person;
    const link = await c.app.inject({ method: 'POST', url: `/api/people/${ava.id}/invite`, ...as(c.tokens.ceo) });
    expect(link.statusCode).toBe(409);
    expect(link.json().error.reason).toBe('assistant_no_sign_in');
    const access = await c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}`, payload: { access: { whole: true } }, ...as(c.tokens.ceo) });
    expect(access.statusCode).toBe(409);
    expect(access.json().error.reason).toBe('assistant_has_owner_rights');
    const telegram = await c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}`, payload: { telegram: '@ava_bot' }, ...as(c.tokens.ceo) });
    expect(telegram.statusCode).toBe(409);
    const off = await c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}`, payload: { status: 'disabled' }, ...as(c.tokens.ceo) });
    expect(off.json().person.status).toBe('disabled');
    const on = await c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}`, payload: { status: 'active', title: 'Back' }, ...as(c.tokens.ceo) });
    expect(on.json().person).toMatchObject({ status: 'active', title: 'Back' });
  });
});
