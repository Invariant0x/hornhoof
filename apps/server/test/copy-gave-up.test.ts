import { describe, expect, it } from 'vitest';
import { machines } from '../src/db/schema.js';
import { aclCompany } from './agent-view-company.js';
import { as } from './helpers.js';

const SINCE = '2026-11-24T20:00:00.000Z';
const from = (id: string) => ({ remoteAddress: '127.0.0.1', headers: { 'x-hornhoof-via': id, 'x-hornhoof-keeper': '1' } });

async function cards(c: Awaited<ReturnType<typeof aclCompany>>, token: string, query = '') {
  const answer = await c.app.inject({ url: `/api/requests${query}`, ...as(token) });
  expect(answer.statusCode).toBe(200);
  return answer.json<{ copyGaveUp?: unknown[] }>().copyGaveUp ?? [];
}

describe('a copy its keeper gave up', () => {
  it('is one card for the machine owner and the CEO until the keeper says anything else, and refreshes the screens', async () => {
    const c = await aclCompany({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: 'a1b2c3d4'.repeat(4) });
    const [copy, other] = await c.db.insert(machines).values([
      { companyId: c.companyId, personId: c.ids.bob, machineKey: 'copy-key-12345', hostname: 'Replica', role: 'data' },
      { companyId: c.companyId, personId: c.ids.bob, machineKey: 'other-key-12345', hostname: 'Other', role: 'data' },
    ]).returning();
    const report = async (machine: string, copyBody: object) => {
      const answer = await c.app.inject({ method: 'POST', url: '/api/network/report', ...from(machine), payload: { copy: copyBody } });
      expect(answer.statusCode).toBe(204);
    };
    const stopped = { state: 'stopped', progress: null, at: null, error: 'apply', name: 'copy_0123456789abcdef_5', old: null, gaveUp: { since: SINCE, attempts: 4, why: 'failed' } };
    const events: string[] = [];
    const unsub = c.app.ctx.bus.subscribe(c.companyId, event => { if (event.type === 'requests') events.push(event.type); });
    try {
      expect(await cards(c, c.tokens.ceo)).toEqual([]);
      await report(copy!.id, stopped);
      expect(events).toContain('requests');
      const card = { id: copy!.id, hostname: 'Replica', since: SINCE, attempts: 4, why: 'failed' };
      for (const token of [c.tokens.ceo, c.tokens.bob]) expect(await cards(c, token)).toEqual([card]);
      for (const token of [c.tokens.ann, c.tokens.wes, c.tokens.clara]) expect(await cards(c, token)).toEqual([]);
      expect(await cards(c, c.tokens.ceo, `?person=${c.ids.ann}`)).toEqual([]);
      /* The same word again changes nothing, and refreshes nothing. */
      events.length = 0;
      await report(copy!.id, stopped);
      expect(events).not.toContain('requests');
      /* A copy that stops for a path too weak is a card of its own kind, and one machine's word is no other's. */
      await report(other!.id, { ...stopped, name: 'copy_fedcba9876543210_2', gaveUp: { since: SINCE, attempts: 0, why: 'slow' } });
      expect((await cards(c, c.tokens.ceo)).map(one => (one as { why: string }).why).sort()).toEqual(['failed', 'slow']);
      /* The keeper makes a copy again: the card goes, and the screens are asked to look. */
      events.length = 0;
      await report(copy!.id, { state: 'making', progress: 0, at: null, error: null, name: 'copy_0123456789abcdef_5', old: null });
      expect(events).toContain('requests');
      expect((await cards(c, c.tokens.ceo)).map(one => (one as { id: string }).id)).toEqual([other!.id]);
      expect(await cards(c, c.tokens.bob)).toEqual([expect.objectContaining({ id: other!.id })]);
    } finally {
      unsub();
    }
  });
});
