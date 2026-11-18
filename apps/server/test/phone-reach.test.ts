import { eq } from 'drizzle-orm';
import type { PhoneDevice, PhoneReadinessIssue } from '@hornhoof/protocol';
import { expect, it } from 'vitest';
import { companyPhones, phoneSessions } from '../src/db/schema.js';
import { phoneConnection, phoneConnections } from '../src/modules/phones/presence.js';
import { as, mcp, until } from './helpers.js';
import { phoneCompany } from './phone-fixture.js';

type Reply = { content: { type: string; text?: string }[]; isError?: boolean };
const ENDPOINT = '192.168.1.80:5555';
const ready: PhoneDevice = { serial: ENDPOINT, status: 'device', model: 'Pixel_8' };
const available = { online: true, state: 'available', connection: 'ready' };
const missing = { online: false, state: 'offline', connection: 'not_connected' };

async function company() {
  const c = await phoneCompany({ lists: true });
  const phone = (await c.addPhone()).json() as { id: string };
  const listed = async () => ((await c.app.inject({ url: '/api/phones', ...as(c.claraSession) })).json() as { phones: unknown[] }).phones[0];
  return { ...c, phone, listed };
}

it('shows a phone offline once its node\'s adb stops listing it, also unauthorized or offline, and available again when it does', async () => {
  const c = await company();
  c.adbLists([ready]);
  expect(await c.listed()).toMatchObject(available);
  c.adbLists([]);
  expect(await c.listed()).toMatchObject(missing);
  c.adbLists([{ ...ready, status: 'unauthorized', model: null }]);
  expect(await c.listed()).toMatchObject(missing);
  c.adbLists([{ ...ready, status: 'offline', model: null }]);
  expect(await c.listed()).toMatchObject(missing);
  c.adbLists(null);
  expect(await c.listed()).toMatchObject(missing);
  c.adbLists([ready]);
  expect(await c.listed()).toMatchObject(available);
  expect((await c.app.inject({ url: `/api/phones/${c.phone.id}`, ...as(c.claraSession) })).json()).toMatchObject(available);
});

it('asks the node only about the company\'s own phones on it', async () => {
  const c = await company();
  await c.listed();
  const asked = c.calls.filter(m => m.type === 'phone.list');
  expect(asked.length).toBeGreaterThan(0);
  for (const m of asked) expect(m).toMatchObject({ serials: [ENDPOINT] });
});

it('asks a node once for everyone who looks at the same time, about the same phones, and asks again at the next look', async () => {
  const c = await company();
  c.adbLists([ready]);
  const [phone] = await c.db.select().from(companyPhones).where(eq(companyPhones.id, c.phone.id));
  const lists = () => c.calls.filter(m => m.type === 'phone.list').length;
  const before = lists();
  c.holdLists();
  const looks = [phoneConnections(c.app.ctx, [phone!]), phoneConnections(c.app.ctx, [phone!])];
  const third = phoneConnection(c.app.ctx, phone!);
  /* A phone on the same node that the first look did not ask about gets an answer of its own. */
  const cable = phoneConnection(c.app.ctx, { ...phone!, id: '00000000-0000-4000-8000-0000000000c1', serial: 'ZY22CABLE01' });
  await until(() => lists() >= before + 2);
  c.answerLists();
  const [first, second] = await Promise.all(looks);
  expect([first!.get(phone!.id), second!.get(phone!.id), await third]).toEqual(['ready', 'ready', 'ready']);
  expect(await cable).toBe('not_connected');
  expect(lists()).toBe(before + 2);
  c.adbLists([]);
  expect(await phoneConnection(c.app.ctx, phone!)).toBe('not_connected');
  expect(lists()).toBe(before + 3);
});

it('gives agents the same state in the phones tool', async () => {
  const c = await company();
  const turn = await c.startTurn(c.nora.id, c.task.id);
  const tools = await mcp(c.app, turn.token);
  const phones = async () => (JSON.parse(((await tools.callTool({ name: 'phones', arguments: {} })) as Reply).content[0]!.text!) as { phones: unknown[] }).phones[0];
  c.adbLists([]);
  expect(await phones()).toMatchObject(missing);
  c.adbLists([ready]);
  expect(await phones()).toMatchObject(available);
});

it('lends no phone its node\'s adb does not list, and lends it again once adb lists it', async () => {
  const c = await company();
  const turn = await c.startTurn(c.nora.id, c.task.id);
  const tools = await mcp(c.app, turn.token);
  c.adbLists([{ ...ready, status: 'unauthorized', model: null }]);
  const refused = await tools.callTool({ name: 'phone_acquire', arguments: { phone: c.phone.id } }) as Reply;
  expect(refused.isError).toBe(true);
  expect(JSON.parse(refused.content[0]!.text!)).toMatchObject({ error: { reason: 'phone_not_connected', message: expect.stringMatching(/USB.*Wireless debugging/) } });
  expect(await c.db.select().from(phoneSessions).where(eq(phoneSessions.phoneId, c.phone.id))).toEqual([]);
  expect(c.calls.filter(m => m.type === 'phone.open')).toEqual([]);
  c.adbLists([ready]);
  const lent = await tools.callTool({ name: 'phone_acquire', arguments: { phone: c.phone.id } }) as Reply;
  expect(lent.isError, lent.content[0]?.text).not.toBe(true);
  expect(JSON.parse(lent.content[0]!.text!)).toMatchObject({ status: 'active' });
});

it('says the computer is offline, not the phone, when the node is gone', async () => {
  const c = await company();
  c.adbLists([ready]);
  c.node.close();
  await c.node.closed;
  await until(async () => ((await c.listed()) as { online: boolean }).online === false);
  expect(await c.listed()).toMatchObject({ online: false, state: 'offline', connection: 'computer_offline' });
  expect(await c.listed()).not.toHaveProperty('readiness');
});

/* phone.list alone says whether a phone is there; its settings check reports settings only, of a phone that is there. */
it('shows phone settings only while adb lists the phone, and a check that could not reach it as unread settings', async () => {
  let issues: PhoneReadinessIssue[] | null = ['lock'];
  const c = await phoneCompany({ lists: true, readiness: () => issues });
  c.adbLists([ready]);
  const made = (await c.addPhone()).json();
  expect(made).toMatchObject({ ...available, readiness: ['lock'] });
  const listed = async () => (await c.app.inject({ url: '/api/phones', ...as(c.claraSession) })).json().phones[0] as Record<string, unknown>;
  c.adbLists([]);
  const away = await listed();
  expect(away).toMatchObject(missing);
  expect(away).not.toHaveProperty('readiness');
  issues = null;
  const checks = () => c.calls.filter(m => m.type === 'phone.baseline').length;
  const before = checks();
  c.hello();
  await until(() => checks() > before);
  c.adbLists([ready]);
  await until(async () => JSON.stringify((await listed()).readiness) === JSON.stringify(['check']));
  expect(await listed()).toMatchObject({ ...available, readiness: ['check'] });
});

it('keeps a node that cannot list phones as before: its phones follow its computer and it is asked nothing new', async () => {
  const c = await phoneCompany();
  await c.addPhone();
  const view = (await c.app.inject({ url: '/api/phones', ...as(c.claraSession) })).json();
  expect(view.phones[0]).toMatchObject(available);
  expect(c.calls.filter(m => m.type === 'phone.list')).toEqual([]);
});
