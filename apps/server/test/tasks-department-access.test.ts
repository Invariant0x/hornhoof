import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { departments, people, tasks } from '../src/db/schema.js';
import { as, echelonsTurn, invitePerson } from './helpers.js';
import { call, company, work } from './turns-company.js';

/* A company with an open turn in each department, a task of Development and two of Sales, the owner of Sales and a deputy
   of the CEO. Development's task waits for an event, in its holder's words. */
async function tracker() {
  const c = await company();
  await echelonsTurn(c.db, c.companyId);
  const boss = await c.tools(c.orchestrator);
  await call(boss, 'add_tasks', { tasks: [work(c.dev.id, 'Checkout'), work(c.sales.id, 'Announcement'), work(c.sales.id, 'Call the bank')] });
  const dora = await invitePerson(c.app, c.ceoToken, { name: 'Dora', email: 'dora@acme.test', access: { departments: [c.sales.id] } });
  const [doraRow] = await c.db.select().from(people).where(eq(people.email, 'dora@acme.test'));
  await c.db.update(departments).set({ ownerPersonId: doraRow!.id }).where(eq(departments.id, c.sales.id));
  const dina = await invitePerson(c.app, c.ceoToken, { name: 'Dina', email: 'dina@acme.test', access: { whole: true } });
  await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.email, 'dina@acme.test'));
  const wait = { since: '2026-11-14T10:00:00.000Z', until: '2026-11-14T11:00:00.000Z', reason: 'Hana waits for the bank to answer.' };
  await c.db.update(tasks).set({ externalWait: wait }).where(eq(tasks.title, 'Checkout'));
  const byTitle = async (title: string) => (await c.db.select().from(tasks).where(eq(tasks.title, title)))[0]!;
  const send = (token: string, method: 'POST' | 'PUT' | 'PATCH', url: string, payload: object) => c.app.inject({ method, url, payload, ...as(token) });
  return { ...c, dora, dina, send, checkout: await byTitle('Checkout'), announcement: await byTitle('Announcement') };
}

const numbers = (body: { tasks: { number: number }[] }) => body.tasks.map(t => t.number);
const reason = (res: { statusCode: number; json: () => { error?: { reason?: string } } }) => [res.statusCode, res.json().error?.reason];

describe("another department's tasks for the people of a department", () => {
  it("lets a department head read every department's tasks, task cards, waits and turns, with the words of other agents left out", async () => {
    const { get, ceoToken, dora, dev, sales, design, checkout } = await tracker();
    expect((await get(dora, '/api/task-departments')).json().departments.map((d: { id: string }) => d.id)).toEqual([dev.id, sales.id, design.id]);
    expect(numbers((await get(dora, `/api/tasks?status=all&department=${dev.id}`)).json())).toEqual([1]);
    /* Without a department named: the tasks of every department in one list. */
    expect(numbers((await get(dora, '/api/tasks?status=all')).json())).toEqual([3, 2, 1]);
    const card = await get(dora, `/api/tasks/${checkout.id}`);
    expect(card.statusCode).toBe(200);
    expect(card.json().task).toMatchObject({ number: 1, title: 'Checkout', assignee: { name: 'Hana' }, externalWait: null });
    expect((await get(ceoToken, `/api/tasks/${checkout.id}`)).json().task.externalWait).toMatchObject({ reason: 'Hana waits for the bank to answer.' });
    expect((await get(dora, `/api/tasks/${checkout.id}/waits`)).statusCode).toBe(200);
    expect((await get(dora, '/api/turns')).json().turns.map((t: { number: number }) => t.number)).toEqual([1, 2, 3]);
    /* The orchestrator's own work stays with the people who have the whole company. */
    expect(reason(await get(dora, '/api/tasks?department=none'))).toEqual([403, 'not_your_department']);
  });

  it("refuses a department head every change of another department's work and settings, and lets them change their own", async () => {
    const { send, dora, dev, sales, checkout, announcement } = await tracker();
    expect(reason(await send(dora, 'POST', '/api/tasks', { title: 'Mine now', department: dev.id }))).toEqual([403, 'not_your_department']);
    expect(reason(await send(dora, 'POST', `/api/tasks/${checkout.id}/comments`, { text: 'Faster, please.' }))).toEqual([403, 'task_not_yours']);
    expect(reason(await send(dora, 'POST', `/api/tasks/${checkout.id}/cancel`, { why: 'Not needed.' }))).toEqual([403, 'task_not_yours']);
    expect(reason(await send(dora, 'PUT', `/api/tasks/${checkout.id}/paused`, { paused: true, reason: 'Wait.' }))).toEqual([403, 'task_not_yours']);
    expect(reason(await send(dora, 'PUT', `/api/tasks/${checkout.id}/urgent`, { urgent: true }))).toEqual([403, 'task_not_yours']);
    expect((await send(dora, 'POST', '/api/tasks', { title: 'Price list', department: sales.id })).statusCode).toBe(201);
    expect((await send(dora, 'POST', `/api/tasks/${announcement.id}/comments`, { text: 'Thanks.' })).statusCode).toBe(201);
  });

  it('lets the CEO and the deputy change the work of every department', async () => {
    const { send, ceoToken, dina, dev, sales } = await tracker();
    for (const token of [ceoToken, dina]) for (const department of [dev.id, sales.id]) {
      expect((await send(token, 'POST', '/api/tasks', { title: 'From the top', department })).statusCode).toBe(201);
    }
  });
});
