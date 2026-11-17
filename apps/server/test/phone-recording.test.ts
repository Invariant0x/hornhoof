import { expect, it } from 'vitest';
import { as, mcp, until } from './helpers.js';
import { phoneCompany } from './phone-fixture.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=';

it('keeps the session recording on the task and shows the owner its live frame', async () => {
  const c = await phoneCompany();
  const phone = (await c.addPhone()).json();
  const turn = await c.startTurn(c.nora.id, c.task.id);
  const tools = await mcp(c.app, turn.token);
  const reply = await tools.callTool({ name: 'phone_acquire', arguments: { phone: phone.id } }) as { content: { text: string }[] };
  const session = JSON.parse(reply.content[0]!.text) as { id: string };
  const open = c.calls.find(m => m.type === 'phone.open');
  if (open?.type !== 'phone.open') throw new Error('The phone did not receive its session grant.');
  c.node.send({ type: 'phone.frame', sessionId: session.id, generation: open.grant.generation, sequence: 1, at: '2026-11-16T12:00:00Z', capture: { png: PNG, width: 1, height: 1, elements: [] } });
  const live = await c.app.inject({ url: `/api/phones/${phone.id}/live`, ...as(c.claraSession) });
  expect(live.statusCode).toBe(200);
  await until(async () => Boolean((await c.app.inject({ url: `/api/phones/${phone.id}/live`, ...as(c.claraSession) })).json().frame));
  const recording = await c.app.inject({ url: `/api/tasks/${c.task.id}/phone-recordings`, ...as(c.ceoSession) });
  expect(recording.json().recordings[0]).toMatchObject({ id: session.id, phone: 'Clara phone', frames: [{ sequence: 1 }] });
  const image = await c.app.inject({ url: `/api/phone-sessions/${session.id}/frames/1/image`, ...as(c.ceoSession) });
  expect(image.headers['content-type']).toBe('image/png');
  expect(image.rawPayload).toEqual(Buffer.from(PNG, 'base64'));
  expect((await c.app.inject({ url: `/api/phones/${phone.id}/live`, ...as(c.samSession) })).statusCode).toBe(403);
  expect((await c.app.inject({ url: `/api/phone-sessions/${session.id}/frames/1/image`, ...as(c.olafSession) })).statusCode).toBe(403);
});
