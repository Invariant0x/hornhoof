import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { INVOCATION } from '../src/modules/tools/calls.js';
import { recordPhoneFrame } from '../src/modules/phones/recording.js';
import { agentEvents, attachments, phoneFrames, toolCalls } from '../src/db/schema.js';
import { as } from './helpers.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { phoneCompany } from './phone-fixture.js';

await prepareSharedDatabase();
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] }));

const PASSWORD = 'private-phone-password-1178';
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSgBBwcHCggKEwoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/AABEIAAEAAQMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AOAr54/YT//Z';
type Answer = { content: { type: string; text?: string }[]; isError?: boolean };
async function call(c: Awaited<ReturnType<typeof phoneCompany>>, token: string, name: string, args: Record<string, unknown>, invocation = randomUUID()) {
  c.app.ctx.config.tunnelHost = 'localhost';
  const response = await c.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}`, [INVOCATION]: invocation, accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  expect(response.statusCode).toBe(200);
  const answer = response.json().result as Answer;
  expect(answer.isError, answer.content[0]?.text).not.toBe(true);
  return answer;
}

it('keeps phone execution private after a vault value, while ordinary replay and recordings still work', async () => {
  const c = await phoneCompany();
  c.app.ctx.clock = () => 1_700_000_000_000;
  expect((await c.app.inject({ method: 'POST', url: '/api/vault', ...as(c.ceoSession), payload: { name: 'Partner', site: 'https://example.test', login: 'nora', password: PASSWORD } })).statusCode).toBe(201);
  const phone = (await c.addPhone()).json() as { id: string };
  const turn = await c.startTurn(c.nora.id, c.task.id);
  const acquired = await call(c, turn.token, 'phone_acquire', { phone: phone.id });
  const session = JSON.parse(acquired.content[0]!.text!) as { id: string };
  const tapId = randomUUID();
  for (let retry = 0; retry < 2; retry++) await call(c, turn.token, 'phone_action', { session: session.id, operation: { kind: 'tap', x: 1, y: 2 }, secretExecution: true }, tapId);
  expect(c.calls.filter(message => message.type === 'phone.action')).toHaveLength(1);
  const open = c.calls.find(message => message.type === 'phone.open');
  if (open?.type !== 'phone.open') throw new Error('The phone received no session.');
  const frame = (sequence: number) => ({ type: 'phone.frame' as const, sessionId: session.id, generation: open.grant.generation, sequence, at: '2026-11-16T12:00:00Z', capture: { jpeg: JPEG, width: 1, height: 1, elements: [] } });
  await recordPhoneFrame(c.app.ctx, { kind: 'node', nodeId: c.executor.id }, frame(1));
  const kept = await c.db.select().from(attachments);
  expect(await Promise.all(kept.map(file => c.app.ctx.files.bytes(c.db, file.sha256!)))).toEqual([Buffer.from(JPEG, 'base64')]);
  await call(c, turn.token, 'vault_entry', { entry: 'Partner' });
  const urlId = randomUUID();
  await call(c, turn.token, 'phone_action', { session: session.id, operation: { kind: 'url', url: `https://example.test/?value=${PASSWORD}` } }, urlId);
  expect((await c.db.select().from(toolCalls)).some(row => row.id === urlId)).toBe(false);
  const typedId = randomUUID();
  const typed = await call(c, turn.token, 'phone_action', { session: session.id, operation: { kind: 'text', text: PASSWORD }, secretExecution: false }, typedId);
  expect(c.calls.flatMap(message => message.type === 'phone.action' && message.operation.kind === 'text' ? [message.operation] : [])).toEqual([{ kind: 'text', text: PASSWORD }]);
  const events = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, turn.job.id));
  expect(events).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ kind: 'tool', name: 'phone_action', input: JSON.stringify({ session: session.id, operation: { kind: 'text', text: '[hidden]' } }) }) }));
  const captureId = randomUUID();
  for (let retry = 0; retry < 2; retry++) await call(c, turn.token, 'phone_action', { session: session.id, operation: { kind: 'capture' } }, captureId);
  expect(c.calls.filter(message => message.type === 'phone.action' && message.operation.kind === 'capture')).toHaveLength(2);
  expect((await c.db.select().from(toolCalls)).some(row => row.id === typedId || row.id === captureId)).toBe(false);
  await recordPhoneFrame(c.app.ctx, { kind: 'node', nodeId: c.executor.id }, frame(2));
  expect(await c.db.select().from(phoneFrames).orderBy(phoneFrames.sequence)).toMatchObject([{ sequence: 1, attachmentId: expect.any(String) }, { sequence: 2, attachmentId: null }]);
  expect(await c.db.select().from(attachments)).toHaveLength(1);
  const recording = await c.app.inject({ url: `/api/tasks/${c.task.id}/phone-recordings`, ...as(c.ceoSession) });
  expect(recording.statusCode).toBe(200);
  expect(recording.json().recordings[0].frames[1].imageUrl).toBeNull();
  expect(JSON.stringify(typed)).not.toContain(PASSWORD);
  expect(recording.body).not.toContain(PASSWORD);
  const tables = await c.db.execute(sql`select schemaname, tablename from pg_tables where schemaname in ('public', 'net', 'net_local') order by 1, 2`) as { rows: { schemaname: string; tablename: string }[] };
  const leaks = await c.db.execute(sql.join(tables.rows.map(table => sql`select ${`${table.schemaname}.${table.tablename}`} as table_name where exists (select 1 from ${sql.identifier(table.schemaname)}.${sql.identifier(table.tablename)} t where strpos(row_to_json(t)::text, ${PASSWORD}) > 0)`), sql` union all `)) as { rows: unknown[] };
  expect(leaks.rows).toEqual([]);
});
