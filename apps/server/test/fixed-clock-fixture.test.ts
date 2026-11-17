import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { companies } from '../src/db/schema.js';
import { createTestDb, fixture } from './helpers-db.js';

const AT = Date.parse('2030-01-01T00:00:00Z');

function clock(): void {
  vi.useFakeTimers({ now: AT, toFake: ['Date'] });
  onTestFinished(() => vi.useRealTimers());
}

describe('rows captured at an explicit virtual time', () => {
  it('restores the rows and result only at the same frozen time', async () => {
    clock();
    let calls = 0;
    const make = (db: Awaited<ReturnType<typeof createTestDb>>) => async () => {
      calls += 1;
      const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
      return { id: company!.id, at: Date.now() };
    };
    const first = await createTestDb();
    const original = await fixture(first.$client, 'fixed company', make(first), { at: AT });
    await first.$client.close();
    const second = await createTestDb();
    const again = await fixture(second.$client, 'fixed company', make(second), { at: AT });
    expect(calls).toBe(1);
    expect(again).toEqual(original);
    expect(await second.select().from(companies).where(eq(companies.id, original.id))).toHaveLength(1);
  });

  it('makes separate rows when the declared frozen time changes', async () => {
    clock();
    let calls = 0;
    const first = await createTestDb();
    const make = async () => { calls += 1; return Date.now(); };
    expect(await fixture(first.$client, 'dated sample', make, { at: AT })).toBe(AT);
    vi.setSystemTime(AT + 1000);
    expect(await fixture(first.$client, 'dated sample', make, { at: AT + 1000 })).toBe(AT + 1000);
    expect(calls).toBe(2);
  });

  it('refuses an inaccurate anchor and a clock that moves while rows are made', async () => {
    clock();
    const db = await createTestDb();
    await expect(fixture(db.$client, 'wrong anchor', async () => true, { at: AT - 1 })).rejects.toThrow('The fixture clock must stay');
    await expect(fixture(db.$client, 'moving clock', async () => { vi.setSystemTime(AT + 1); return true; }, { at: AT })).rejects.toThrow('The fixture clock must stay');
  });

  it('requires a controlled clock for the explicit anchor', async () => {
    const db = await createTestDb();
    await expect(fixture(db.$client, 'real clock', async () => true, { at: Date.now() })).rejects.toThrow('The fixture clock must stay');
  });
});
