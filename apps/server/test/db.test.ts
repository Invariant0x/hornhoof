import { describe, expect, it } from 'vitest';
import { companies } from '../src/db/schema.js';
import { createTestDb } from './helpers.js';

describe('database', () => {
  it('runs migrations and stores a company', async () => {
    const db = await createTestDb();
    await db.insert(companies).values({ name: 'Acme' });
    const rows = await db.select().from(companies);
    expect(rows.map(r => r.name)).toEqual(['Acme']);
  });

  it('refuses a second company in one deployment', async () => {
    const db = await createTestDb();
    await db.insert(companies).values({ name: 'Acme' });
    await expect(db.insert(companies).values({ name: 'Other' })).rejects.toThrow();
  });
});
