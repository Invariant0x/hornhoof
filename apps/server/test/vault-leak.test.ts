import { Decrypter, armor, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { as, connectNode, mcp, nextOf, until } from './helpers.js';
import { NODE_KEY, vaultCompany } from './vault-fixture.js';

/* One password and one code secret no other text holds, then everything Hornhoof answers, logs and keeps is searched for
   them in every form they could take. */
const PASSWORD = 'pw-LEAK-7f3a9c1e-marker';
const SECOND = 'pw-LEAK-second-0b51d2';
const SECRET = 'HHVAULTMARKERQQ7Z2LEAKTESTXY';
const forms = (value: string) => [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64').replace(/=+$/, ''), Buffer.from(value).toString('base64url'), encodeURIComponent(value)];
const MARKERS = [PASSWORD, SECOND, SECRET].flatMap(forms);

type ToolReply = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };

describe('no vault value leaves Hornhoof', () => {
  it('holds the marker password and code secret in no answer, tool reply, log line, task event, node message or table', async () => {
    const lines: string[] = [];
    const c = await vaultCompany({ level: 'trace', stream: { write: (line: string) => void lines.push(line) } });
    const seen: string[] = [];
    const keep = (label: string, text: string) => void seen.push(`${label}\n${text}`);

    const identity = await generateX25519Identity();
    const node = await connectNode(c.wsUrl, NODE_KEY);
    node.send({ type: 'hello', version: '0.31.0', loggedIn: true, running: [], publicKey: await identityToRecipient(identity), fills: ['browser'] });
    await until(async () => (await c.app.inject({ url: '/api/agents/orchestrator/events', ...as(c.ceoSession) })).json().state.ready);

    const made = await c.add(c.ceoSession, { name: 'Leak check', site: 'https://partner.example/login', login: 'team@acme.test', password: PASSWORD, code: `otpauth://totp/Partner:team?secret=${SECRET}&digits=6` });
    keep('create', made.body);
    const id = made.json().id as string;
    const bad = await c.add(c.ceoSession, { name: 'Bad', site: 'https://partner.example', login: 'x', password: 'pw7', code: `${SECRET}!` });
    keep('refused create', bad.body);
    const changed = await c.app.inject({ method: 'PATCH', url: `/api/vault/${id}`, payload: { password: SECOND }, ...as(c.claraSession) });
    keep('refused change', changed.body);
    keep('change', (await c.app.inject({ method: 'PATCH', url: `/api/vault/${id}`, payload: { password: SECOND, code: SECRET }, ...as(c.ceoSession) })).body);
    for (const session of [c.ceoSession, c.claraSession, c.samSession, c.olafSession]) {
      keep('list', (await c.app.inject({ url: '/api/vault', ...as(session) })).body);
      keep('log', (await c.app.inject({ url: `/api/vault/${id}/log`, ...as(session) })).body);
    }

    const { token } = await c.startTurn(c.nora.id, c.task.id);
    const client = await mcp(c.app, token);
    keep('tool list', JSON.stringify(await client.callTool({ name: 'vault_entries', arguments: {} })));
    const pending = client.callTool({ name: 'vault_fill', arguments: { entry: 'Leak check', target: 'browser' } }) as Promise<ToolReply>;
    const fill = await nextOf(node, 'secret.fill');
    keep('node message', JSON.stringify(fill));
    const d = new Decrypter();
    d.addIdentity(identity);
    const opened = await d.decrypt(armor.decode(fill.sealed), 'text');
    expect(JSON.parse(opened)).toMatchObject({ password: SECOND, totp: { secret: SECRET } });
    /* The search finds the values where they are: only the node opens them. */
    expect([SECOND, SECRET].every(m => MARKERS.includes(m) && opened.includes(m))).toBe(true);
    node.send({ type: 'secret.filled', requestId: fill.requestId, status: 'signed_in', filled: ['login', 'password', 'code'], shot: 'iVBORw0KGgo=' });
    keep('tool fill', JSON.stringify(await pending));
    keep('tool refused', JSON.stringify(await client.callTool({ name: 'vault_fill', arguments: { entry: 'Leak check', target: 'browser', address: 'https://evil.example/' } })));
    keep('tool list again', JSON.stringify(await client.callTool({ name: 'vault_entries', arguments: {} })));

    const tables = await c.db.execute<{ table_name: string }>(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    for (const { table_name: table } of tables.rows) {
      const rows = await c.db.execute(sql.raw(`SELECT * FROM "${table}"`));
      keep(`table ${table}`, JSON.stringify(rows.rows));
    }
    keep('server log', lines.join(''));

    expect(seen.length).toBeGreaterThan(20);
    expect(lines.length).toBeGreaterThan(0);
    for (const text of seen) for (const marker of MARKERS) expect(text.includes(marker), `${marker} in ${text.split('\n')[0]}`).toBe(false);
  });
});
