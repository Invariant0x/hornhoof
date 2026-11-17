import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { phoneActions } from '../src/db/schema.js';
import { as, mcp } from './helpers.js';
import { phoneCompany } from './phone-fixture.js';

type Reply = { content: { type: string; text?: string }[]; isError?: boolean };
const value = (reply: Reply): Record<string, unknown> => {
  expect(reply.isError, reply.content[0]?.text).not.toBe(true);
  return JSON.parse(reply.content[0]!.text!) as Record<string, unknown>;
};
const START = Date.parse('2026-11-16T12:00:00Z');
const MINUTE = 60_000;

async function holding() {
  const c = await phoneCompany();
  let now = START;
  c.app.ctx.clock = () => now;
  const phone = (await c.addPhone()).json();
  const turn = await c.startTurn(c.nora.id, c.task.id);
  const tools = await mcp(c.app, turn.token);
  const session = value(await tools.callTool({ name: 'phone_acquire', arguments: { phone: phone.id } }) as Reply);
  const declare = async (args: Record<string, unknown>) => value(await tools.callTool({ name: 'phone_declare', arguments: { session: session.id, ...args } }) as Reply);
  const act = async (operation: Record<string, unknown>, secret?: boolean) => value(await tools.callTool({ name: 'phone_action', arguments: { session: session.id, operation, ...(secret === undefined ? {} : { secret }) } }) as Reply);
  // The lease renews with each recorded frame; here the server clock is all that moves, so the session is kept held.
  const later = async (ms: number) => { now += ms; await c.db.execute(sql`UPDATE phone_sessions SET lease_until = ${new Date(now + 30_000).toISOString()} WHERE id = ${session.id}`); };
  return { c, phone, session, tools, declare, act, later };
}

it('counts posts per account in the hour and the day on the server clock and names when the next may go', async () => {
  const h = await holding();
  expect(await h.declare({ account: 'LinkedIn:Acme', kind: 'post', text: 'First post' })).toMatchObject({ status: 'declared', left: { hour: 1, day: 5 } });
  await h.later(10 * MINUTE);
  expect(await h.declare({ account: 'linkedin:acme', kind: 'post', text: 'Second post' })).toMatchObject({ status: 'declared', left: { hour: 0, day: 4 } });
  expect(await h.declare({ account: 'linkedin:acme', kind: 'post', text: 'Third post' })).toEqual({ status: 'wait', limit: 'hour', until: new Date(START + 60 * MINUTE).toISOString() });
  expect(await h.declare({ account: 'twitter:acme', kind: 'post', text: 'Third post' })).toMatchObject({ status: 'declared' });
  await h.later(50 * MINUTE);
  expect(await h.declare({ account: 'linkedin:acme', kind: 'post', text: 'Third post' })).toMatchObject({ status: 'declared', left: { hour: 0, day: 3 } });
  for (const n of [4, 5, 6]) {
    await h.later(61 * MINUTE);
    expect(await h.declare({ account: 'linkedin:acme', kind: 'post', text: `Post ${n}` })).toMatchObject({ status: 'declared' });
  }
  await h.later(61 * MINUTE);
  expect(await h.declare({ account: 'linkedin:acme', kind: 'post', text: 'Post 7' })).toEqual({ status: 'wait', limit: 'day', until: new Date(START + 24 * 60 * MINUTE).toISOString() });
  expect(await h.c.db.select().from(phoneActions)).toHaveLength(7);
});

it('never lets one text go from an account twice in a row, and asks text only where an action has it', async () => {
  const h = await holding();
  expect(await h.declare({ account: 'linkedin:acme', kind: 'message', text: 'Hello, we met at the fair.' })).toMatchObject({ status: 'declared' });
  expect(await h.declare({ account: 'linkedin:acme', kind: 'message', text: '  hello, we met   at the fair. ' })).toEqual({ status: 'repeated' });
  expect(await h.declare({ account: 'linkedin:acme', kind: 'comment', text: 'Hello, we met at the fair.' })).toEqual({ status: 'repeated' });
  expect(await h.declare({ account: 'linkedin:acme', kind: 'like' })).toMatchObject({ status: 'declared' });
  expect(await h.declare({ account: 'linkedin:acme', kind: 'message', text: 'Hello, we met at the fair.' })).toEqual({ status: 'repeated' });
  expect(await h.declare({ account: 'linkedin:acme', kind: 'message', text: 'Thank you for the talk.' })).toMatchObject({ status: 'declared' });
  expect(await h.declare({ account: 'linkedin:acme', kind: 'message', text: 'Hello, we met at the fair.' })).toMatchObject({ status: 'declared' });
  expect(await h.declare({ account: 'linkedin:acme', kind: 'comment' })).toEqual({ status: 'invalid', reason: 'text_needed' });
  expect(await h.declare({ account: 'linkedin:acme', kind: 'like', text: 'Nice' })).toEqual({ status: 'invalid', reason: 'text_not_allowed' });
  expect(await h.declare({ account: 'linkedin:acme', kind: 'sign_in', text: 'member@acme.test' })).toEqual({ status: 'invalid', reason: 'text_not_allowed' });
});

it('journals the steps of a declared action with its task, and a typed login and password only as a typed secret', async () => {
  const LOGIN = 'login-MARKER-1079@acme.test';
  const PASSWORD = 'pw-MARKER-1079-c4e2a9';
  const lines: string[] = [];
  const h = await (async () => {
    const c = await phoneCompany({ level: 'trace', stream: { write: (line: string) => void lines.push(line) } });
    let now = START;
    c.app.ctx.clock = () => now;
    const phone = (await c.addPhone()).json();
    const turn = await c.startTurn(c.nora.id, c.task.id);
    const tools = await mcp(c.app, turn.token);
    const session = value(await tools.callTool({ name: 'phone_acquire', arguments: { phone: phone.id } }) as Reply);
    const tick = async (ms: number) => { now += ms; await c.db.execute(sql`UPDATE phone_sessions SET lease_until = ${new Date(now + 30_000).toISOString()} WHERE id = ${session.id}`); };
    return { c, phone, session, tools, tick };
  })();
  const call = async (name: string, args: Record<string, unknown>) => {
    await h.tick(1000);
    const reply = await h.tools.callTool({ name, arguments: { session: h.session.id, ...args } }) as Reply;
    answers.push(JSON.stringify(reply));
    return value(reply);
  };
  const answers: string[] = [];
  await call('phone_action', { operation: { kind: 'tap', x: 5, y: 5 } });
  await call('phone_declare', { account: 'linkedin:acme', kind: 'sign_in' });
  await call('phone_action', { operation: { kind: 'tap', x: 10, y: 20 } });
  await call('phone_action', { operation: { kind: 'text', text: LOGIN } });
  await call('phone_action', { operation: { kind: 'text', text: PASSWORD }, secret: true });
  await call('phone_declare', { account: 'linkedin:acme', kind: 'comment', text: 'Congratulations on the launch!' });
  await call('phone_action', { operation: { kind: 'url', url: 'https://www.linkedin.com/feed/update/1?utm=private' } });
  await call('phone_action', { operation: { kind: 'text', text: 'Congratulations on the launch!' } });
  await h.tick(11 * MINUTE);
  await call('phone_action', { operation: { kind: 'swipe', x: 1, y: 900, toX: 1, toY: 100, ms: 300 } });

  const rows = await h.c.db.select().from(phoneActions).orderBy(phoneActions.at);
  expect(rows.map(r => [r.kind, r.account, r.text, r.taskId])).toEqual([
    ['sign_in', 'linkedin:acme', null, h.c.task.id],
    ['tap', 'linkedin:acme', '10 20', h.c.task.id],
    ['secret', 'linkedin:acme', null, h.c.task.id],
    ['secret', 'linkedin:acme', null, h.c.task.id],
    ['comment', 'linkedin:acme', 'Congratulations on the launch!', h.c.task.id],
    ['url', 'linkedin:acme', 'https://www.linkedin.com/feed/update/1', h.c.task.id],
    ['text', 'linkedin:acme', null, h.c.task.id],
  ]);
  expect(h.c.calls.filter(m => m.type === 'phone.action').map(m => m.type === 'phone.action' && m.operation.kind)).toEqual(['tap', 'tap', 'text', 'text', 'url', 'text', 'swipe']);

  const journal = await h.c.app.inject({ url: `/api/phones/${h.phone.id}/journal`, ...as(h.c.claraSession) });
  expect(journal.statusCode).toBe(200);
  expect(journal.json().actions).toEqual([
    expect.objectContaining({ kind: 'comment', account: 'linkedin:acme', text: 'Congratulations on the launch!', agent: 'Nora', steps: 2, secret: false, task: expect.objectContaining({ id: h.c.task.id }) }),
    expect.objectContaining({ kind: 'sign_in', account: 'linkedin:acme', text: null, steps: 3, secret: true }),
  ]);
  expect((await h.c.app.inject({ url: `/api/phones/${h.phone.id}/journal`, ...as(h.c.samSession) })).statusCode).toBe(403);
  expect((await h.c.app.inject({ url: `/api/phones/${h.phone.id}/journal`, ...as(h.c.olafSession) })).statusCode).toBe(403);

  const rowsOf = async <T>(query: ReturnType<typeof sql>) => ((await h.c.db.execute(query)) as unknown as { rows: T[] }).rows;
  const kept = JSON.stringify([await rowsOf(sql`SELECT * FROM phone_actions`), await rowsOf(sql`SELECT * FROM tool_calls`), await rowsOf(sql`SELECT * FROM agent_events`), await rowsOf(sql`SELECT * FROM task_events`), await rowsOf(sql`SELECT * FROM phone_sessions`)]);
  for (const marker of [LOGIN, PASSWORD]) {
    expect(kept).not.toContain(marker);
    expect(journal.body).not.toContain(marker);
    expect(answers.join('\n')).not.toContain(marker);
    expect(lines.join('\n')).not.toContain(marker);
  }
});
