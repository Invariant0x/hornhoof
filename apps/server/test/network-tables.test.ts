import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { companies, machines, people } from '../src/db/schema.js';
import { setUpCompany, testApp } from './helpers.js';

const rowsOf = <T>(answer: unknown): T[] => (answer as { rows: T[] }).rows;

/* The orchestrator runs SQL as Hornhoof itself (Ivan's word of 17 November 2026): it reads and changes every row of the
   network's tables, their keys too, as Hornhoof does. */
describe("the network's tables and the orchestrator's SQL", () => {
  async function network() {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const agentSql = app.ctx.agentSql!;
    const rows = async (text: string) => (await agentSql.run(text, 'write'))[0]!;
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people);
    const [machine] = await db.insert(machines).values({ companyId: company!.id, personId: owner!.id, machineKey: 'mac-0001-abcd' }).returning();
    return { db, rows, company: company!, owner: owner!, machine: machine! };
  }

  it("reads and changes the company's authority, its machines' certificates and the peer secrets", async () => {
    const { db, rows, machine } = await network();
    await db.execute(sql`INSERT INTO authority (cert_pem, key_enc) VALUES ('cert', 'key')`);
    await db.execute(sql`INSERT INTO certificates (serial, machine_id, until) VALUES ('0a', ${machine.id}, now() + interval '1 day')`);
    await db.execute(sql`INSERT INTO peer_secrets (kind, secret_enc) VALUES ('app', 'secret')`);
    expect((await rows('SELECT key_enc FROM authority')).rows).toEqual([{ key_enc: 'key' }]);
    expect((await rows(`UPDATE peer_secrets SET secret_enc = 'x'`)).changed).toBe(1);
    expect((await rows(`INSERT INTO peer_secrets (kind, secret_enc) VALUES ('data', 'x')`)).changed).toBe(1);
    for (const table of ['certificates', 'authority', 'peer_secrets']) expect((await rows(`DELETE FROM ${table}`)).changed, table).toBeGreaterThan(0);
    expect(rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM peer_secrets`))).toEqual([{ n: 0 }]);
  });

  it('reads and changes the tables of joined machines, the computer access and its commands', async () => {
    const { db, rows, company, owner, machine } = await network();
    await db.execute(sql`INSERT INTO machine_tickets (ticket_hash, machine_id, expires_at) VALUES ('h', ${machine.id}, now() + interval '1 day')`);
    await db.execute(sql`INSERT INTO person_keys (person_id, company_id, public_key, wrapped, salt, iv, iterations) VALUES (${owner.id}, ${company.id}, 'p', 'w', 's', 'i', 600000)`);
    await db.execute(sql`INSERT INTO machine_access (machine_id, company_id) VALUES (${machine.id}, ${company.id})`);
    expect((await rows('SELECT wrapped, salt, iv FROM person_keys')).rows).toEqual([{ wrapped: 'w', salt: 's', iv: 'i' }]);
    expect((await rows(`INSERT INTO machine_online (machine_id, day, seconds) VALUES ('${machine.id}', '2026-11-11', 20)`)).changed).toBe(1);
    expect((await rows(`INSERT INTO computer_runs (company_id, machine_id, command, timeout_s) VALUES ('${company.id}', '${machine.id}', 'id', 300)`)).changed).toBe(1);
    expect((await rows('SELECT scope, employees FROM machine_access')).rows).toEqual([{ scope: 'orchestrator', employees: [] }]);
    expect((await rows(`UPDATE machine_access SET scope = 'all_agents'`)).changed).toBe(1);
    expect((await rows('SELECT scope FROM machine_access')).rows).toEqual([{ scope: 'all_agents' }]);
    for (const table of ['machine_tickets', 'machine_online', 'person_keys', 'computer_runs', 'machine_access']) expect((await rows(`DELETE FROM ${table}`)).changed, table).toBe(1);
  });

  it('reads and changes the recovery keys, the backups and what a machine is in the network', async () => {
    const { db, rows, company, owner } = await network();
    await db.execute(sql`INSERT INTO recovery_keys (company_id, recipient, made_by) VALUES (${company.id}, 'age1recovery', ${owner.id})`);
    expect((await rows('SELECT recipient FROM recovery_keys')).rows).toEqual([{ recipient: 'age1recovery' }]);
    expect((await rows('DELETE FROM recovery_keys')).changed).toBe(1);
    expect((await rows('SELECT * FROM net.backups')).rows).toEqual([]);
    expect((await rows('UPDATE machines SET keeps_backups = false')).changed).toBe(1);
    expect((await rows('UPDATE machines SET computer_closed = true')).changed).toBe(1);
    expect((await rows('SELECT computer_closed FROM machines')).rows).toEqual([{ computer_closed: true }]);
    expect((await rows(`UPDATE machines SET age_key = 'age1mine', role = 'worker'`)).changed).toBe(1);
  });
});
