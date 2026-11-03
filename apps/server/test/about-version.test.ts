import { describe, expect, it } from 'vitest';
import { companies, departments } from '../src/db/schema.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

describe('the current build for About', () => {
  it('gives a person without company access only the version and short commit', async () => {
    const { app, db } = await testApp({ HORNHOOF_VERSION: '9.9.9', HORNHOOF_COMMIT: 'abc1234567890def1234567890abcdef1234567890' });
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [department] = await db.insert(departments).values({ companyId: company!.id, name: 'Engineering', roleCode: 'DEV' }).returning();
    const person = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [department!.id] } });
    const response = await app.inject({ method: 'GET', url: '/api/updates/current', ...as(person) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: '9.9.9', commit: 'abc1234' });
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(person) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/updates/check', ...as(person) })).statusCode).toBe(403);
  });

  it('requires a person to be signed in', async () => {
    const { app } = await testApp();
    expect((await app.inject({ method: 'GET', url: '/api/updates/current' })).statusCode).toBe(401);
  });
});
