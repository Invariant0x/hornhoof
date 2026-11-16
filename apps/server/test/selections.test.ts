import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { companies, people } from '../src/db/schema.js';
import { countOnly, idOnly } from '../src/db/selections.js';
import { createTestDb } from './helpers-db.js';

it('selects the id column of the table it is given and nothing else', () => {
  expect(idOnly(people)).toEqual({ id: people.id });
  expect(idOnly(people).id).toBe(people.id);
});

it('reads the ids of the rows a query finds, and counts them', async () => {
  const db = await createTestDb();
  const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
  const [before] = await db.select(countOnly()).from(people);
  const made = await db.insert(people).values([
    { companyId: company!.id, name: 'Ivan', email: 'ivan@acme.example', status: 'active', scopeKind: 'company' },
    { companyId: company!.id, name: 'Rita', email: 'rita@acme.example', status: 'active', scopeKind: 'company' },
  ]).returning();
  const rita = made.find(p => p.name === 'Rita')!;
  expect(await db.select(idOnly(people)).from(people).where(eq(people.email, 'rita@acme.example'))).toEqual([{ id: rita.id }]);
  const [after] = await db.select(countOnly()).from(people);
  const [none] = await db.select(countOnly()).from(people).where(eq(people.email, 'nobody@acme.example'));
  expect({ added: Number(after!.n) - Number(before!.n), none: Number(none!.n) }).toEqual({ added: 2, none: 0 });
});
