import { describe, expect, it } from 'vitest';
import { databaseSize, LARGEST_TABLES, tellOfDatabaseSize } from '../src/modules/copies/database-size.js';
import { aclCompany } from './agent-view-company.js';
import { as } from './helpers.js';

type Size = { bytes: number; line: number; tables: { name: string; bytes: number }[] };

const machinesTab = async (c: Awaited<ReturnType<typeof aclCompany>>, token: string) => {
  const answer = await c.app.inject({ url: '/api/machines', ...as(token) });
  expect(answer.statusCode).toBe(200);
  return answer.json<{ database?: Size | null }>().database ?? null;
};

const card = async (c: Awaited<ReturnType<typeof aclCompany>>, token: string) => {
  const answer = await c.app.inject({ url: '/api/requests', ...as(token) });
  expect(answer.statusCode).toBe(200);
  return answer.json<{ databaseLarge?: Size | null }>().databaseLarge ?? null;
};

describe("the company's database", () => {
  it('says how big it is and names its largest tables, the largest first', async () => {
    const c = await aclCompany();
    const size = await databaseSize(c.app.ctx);
    expect(size.bytes).toBeGreaterThan(0);
    expect(size.line).toBe(2048 * 1024 * 1024);
    expect(size.tables).toHaveLength(LARGEST_TABLES);
    for (const table of size.tables) expect(table.name).toMatch(/^(public|net)\.[a-z0-9_]+$/);
    expect(size.tables.map(table => table.bytes)).toEqual(size.tables.map(table => table.bytes).toSorted((a, b) => b - a));
    expect(size.tables.reduce((sum, table) => sum + table.bytes, 0)).toBeLessThanOrEqual(size.bytes);
  });

  it('shows on the machines tab to whoever sees the whole company', async () => {
    const c = await aclCompany();
    for (const token of [c.tokens.ceo, c.tokens.wes, c.tokens.clara]) expect(await machinesTab(c, token)).toMatchObject({ bytes: expect.any(Number), tables: expect.any(Array) });
    for (const token of [c.tokens.ann, c.tokens.bob]) expect(await machinesTab(c, token)).toBeNull();
  });

  it('is a card for the CEO once it is past its line, and the screens are asked to look when it crosses', async () => {
    /* A line of one megabyte, which every database is past. */
    const c = await aclCompany({ DATABASE_WARN_MB: '1' });
    const events: string[] = [];
    const unsub = c.app.ctx.bus.subscribe(c.companyId, event => { if (event.type === 'requests') events.push(event.type); });
    try {
      await tellOfDatabaseSize(c.app.ctx);
      expect(events).toEqual(['requests']);
      expect(await card(c, c.tokens.ceo)).toMatchObject({ line: 1024 * 1024, bytes: expect.any(Number), tables: expect.any(Array) });
      for (const token of [c.tokens.ann, c.tokens.bob, c.tokens.wes, c.tokens.clara]) expect(await card(c, token)).toBeNull();
      /* Still past it: nothing new to look at. */
      await tellOfDatabaseSize(c.app.ctx);
      expect(events).toEqual(['requests']);
    } finally {
      unsub();
    }
    /* Under the line there is no card. */
    const small = await aclCompany();
    expect(await card(small, small.tokens.ceo)).toBeNull();
  });
});
