import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from '../src/db/errors.js';
import { companies, machines, people, subscriptions } from '../src/db/schema.js';
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

  it('keeps one machine row per person and machine key', async () => {
    const db = await createTestDb();
    const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
    const [person] = await db.insert(people).values({ companyId: company!.id, name: 'Ivan', email: 'ivan@acme.com', status: 'active', scopeKind: 'company' }).returning();
    const machine = { companyId: company!.id, personId: person!.id, machineKey: 'mac-1', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };
    await db.insert(machines).values(machine);
    const err = await db.insert(machines).values(machine).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('stores a personal subscription without a target', async () => {
    const db = await createTestDb();
    const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
    const [person] = await db.insert(people).values({ companyId: company!.id, name: 'Ivan', email: 'ivan@acme.com', status: 'active', scopeKind: 'company' }).returning();
    const [sub] = await db.insert(subscriptions).values({ companyId: company!.id, provider: 'glm', kind: 'personal', label: 'GLM', ownerPersonId: person!.id, status: 'waiting_machine' }).returning();
    expect(sub).toMatchObject({ targetKind: null, targetId: null, machineId: null, limits: null, removedAt: null });
  });
});

/* Each PGlite is a whole Postgres in WASM memory; a file that leaves them open grows by gigabytes and gets killed on a small CI runner. */
describe('test databases', () => {
  let opened: { closed: boolean } | undefined;

  it('opens one for the test', async () => {
    opened = (await createTestDb()).$client;
    expect(opened.closed).toBe(false);
  });

  it('closes it once that test ends', () => {
    expect(opened?.closed).toBe(true);
  });
});
