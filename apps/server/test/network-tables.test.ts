import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentRole } from '../src/db/agent-sql.js';
import { companies, machines, people } from '../src/db/schema.js';
import { ownDatabases, setUpCompany, testApp } from './helpers.js';

/* The test grants a role rights on tables, which emptying the tables does not undo. */
ownDatabases();

const rowsOf = <T>(answer: unknown): T[] => (answer as { rows: T[] }).rows;

describe("the network's tables and the orchestrator's SQL", () => {
  /* A build from before these tables grants the orchestrator every table of public it does not hide, as after a way back
     to it. The tables keep their rows to their owner whatever is granted. */
  it("keeps the orchestrator out of them even when it is granted them", async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const agentSql = app.ctx.agentSql!;
    const rows = async (text: string) => (await agentSql.run(text, 'write'))[0]!;
    /* The first call makes the roles. */
    await rows('SELECT 1');
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people);
    const [machine] = await db.insert(machines).values({ companyId: company!.id, personId: owner!.id, machineKey: 'server:test' }).returning();
    await db.execute(sql`INSERT INTO authority (cert_pem, key_enc) VALUES ('cert', 'key')`);
    await db.execute(sql`INSERT INTO certificates (serial, machine_id, until) VALUES ('0a', ${machine!.id}, now() + interval '1 day')`);
    await db.execute(sql`INSERT INTO peer_secrets (kind, secret_enc) VALUES ('app', 'secret')`);
    await db.execute(sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON authority, certificates, peer_secrets TO "${agentRole('postgres')}"`));

    for (const table of ['authority', 'certificates', 'peer_secrets']) {
      expect((await rows(`SELECT * FROM ${table}`)).rows, table).toEqual([]);
      expect((await rows(`DELETE FROM ${table}`)).changed, table).toBe(0);
    }
    expect((await rows(`UPDATE peer_secrets SET secret_enc = 'x'`)).changed).toBe(0);
    await expect(rows(`INSERT INTO peer_secrets (kind, secret_enc) VALUES ('data', 'x')`)).rejects.toMatchObject({ code: '42501' });
    expect(rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM peer_secrets`))).toEqual([{ n: 1 }]);
  });

  it('keeps the orchestrator out of the tables of joined machines too, even when it is granted them', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const agentSql = app.ctx.agentSql!;
    const rows = async (text: string) => (await agentSql.run(text, 'write'))[0]!;
    await rows('SELECT 1');
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people);
    const [machine] = await db.insert(machines).values({ companyId: company!.id, personId: owner!.id, machineKey: 'mac-0001-abcd' }).returning();
    await db.execute(sql`INSERT INTO machine_tickets (ticket_hash, machine_id, expires_at) VALUES ('h', ${machine!.id}, now() + interval '1 day')`);
    await db.execute(sql`INSERT INTO machine_online (machine_id, day, seconds) VALUES (${machine!.id}, '2026-11-10', 20)`);
    await db.execute(sql`INSERT INTO person_keys (person_id, company_id, public_key, wrapped, salt, iv, iterations) VALUES (${owner!.id}, ${company!.id}, 'p', 'w', 's', 'i', 600000)`);
    await db.execute(sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON machine_tickets, machine_online, person_keys TO "${agentRole('postgres')}"`));
    for (const table of ['machine_tickets', 'machine_online', 'person_keys']) {
      expect((await rows(`SELECT * FROM ${table}`)).rows, table).toEqual([]);
      expect((await rows(`DELETE FROM ${table}`)).changed, table).toBe(0);
    }
    await expect(rows(`INSERT INTO machine_online (machine_id, day, seconds) VALUES ('${machine!.id}', '2026-11-11', 20)`)).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps the orchestrator out of computer access and its commands, even when it is granted them', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const agentSql = app.ctx.agentSql!;
    const rows = async (text: string) => (await agentSql.run(text, 'write'))[0]!;
    await rows('SELECT 1');
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people);
    const [machine] = await db.insert(machines).values({ companyId: company!.id, personId: owner!.id, machineKey: 'mac-0001-abcd' }).returning();
    await db.execute(sql`INSERT INTO machine_access (machine_id, company_id) VALUES (${machine!.id}, ${company!.id})`);
    await db.execute(sql`INSERT INTO computer_runs (company_id, machine_id, command, timeout_s) VALUES (${company!.id}, ${machine!.id}, 'true', 300)`);
    await db.execute(sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON machine_access, computer_runs TO "${agentRole('postgres')}"`));
    for (const table of ['machine_access', 'computer_runs']) {
      expect((await rows(`SELECT * FROM ${table}`)).rows, table).toEqual([]);
      expect((await rows(`DELETE FROM ${table}`)).changed, table).toBe(0);
    }
    expect((await rows(`UPDATE machine_access SET until = now() + interval '1 hour'`)).changed).toBe(0);
    await expect(rows(`INSERT INTO machine_access (machine_id, company_id, until) VALUES (gen_random_uuid(), '${company!.id}', now() + interval '1 hour')`)).rejects.toMatchObject({ code: '42501' });
    await expect(rows(`INSERT INTO computer_runs (company_id, machine_id, command, timeout_s) VALUES ('${company!.id}', '${machine!.id}', 'id', 300)`)).rejects.toMatchObject({ code: '42501' });
    expect(rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM computer_runs`))).toEqual([{ n: 1 }]);
  });

  it('keeps the orchestrator out of the backups and the recovery keys, even when it is granted them', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const agentSql = app.ctx.agentSql!;
    const rows = async (text: string) => (await agentSql.run(text, 'write'))[0]!;
    await rows('SELECT 1');
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people);
    await db.insert(machines).values({ companyId: company!.id, personId: owner!.id, machineKey: 'mac-0001-abcd' });
    await db.execute(sql`INSERT INTO recovery_keys (company_id, recipient, made_by) VALUES (${company!.id}, 'age1recovery', ${owner!.id})`);
    await db.execute(sql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON recovery_keys TO "${agentRole('postgres')}"`));
    expect((await rows('SELECT * FROM recovery_keys')).rows).toEqual([]);
    expect((await rows('DELETE FROM recovery_keys')).changed).toBe(0);
    await expect(rows(`INSERT INTO recovery_keys (company_id, recipient, made_by) VALUES ('${company!.id}', 'age1other', '${owner!.id}')`)).rejects.toMatchObject({ code: '42501' });
    await expect(rows('SELECT * FROM net.backups')).rejects.toMatchObject({ code: '42501' });
    /* Whether a machine keeps the company's backups is its owner's tick, and what it holds its keeper's word. */
    await expect(rows('UPDATE machines SET keeps_backups = false')).rejects.toMatchObject({ code: '42501' });
    await expect(rows(`UPDATE machines SET age_key = 'age1mine'`)).rejects.toMatchObject({ code: '42501' });
  });

  it('lets the orchestrator read the rows of these tables but their keys, and change none of them', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const agentSql = app.ctx.agentSql!;
    const rows = async (text: string) => (await agentSql.run(text, 'write'))[0]!;
    await rows('SELECT 1');
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people);
    const [machine] = await db.insert(machines).values({ companyId: company!.id, personId: owner!.id, machineKey: 'mac-0001-abcd' }).returning();
    await db.execute(sql`INSERT INTO peer_secrets (kind, secret_enc) VALUES ('app', 'secret')`);
    await db.execute(sql`INSERT INTO machine_online (machine_id, day, seconds) VALUES (${machine!.id}, '2026-11-10', 20)`);
    await db.execute(sql`INSERT INTO computer_runs (company_id, machine_id, command, timeout_s) VALUES (${company!.id}, ${machine!.id}, 'true', 300)`);
    expect((await rows('SELECT kind FROM peer_secrets')).rows).toEqual([{ kind: 'app' }]);
    expect((await rows('SELECT seconds FROM machine_online')).rows).toEqual([{ seconds: 20 }]);
    expect((await rows('SELECT command FROM computer_runs')).rows).toEqual([{ command: 'true' }]);
    await expect(rows('SELECT secret_enc FROM peer_secrets')).rejects.toMatchObject({ code: '42501' });
    await expect(rows('DELETE FROM computer_runs')).rejects.toMatchObject({ code: '42501' });
    await expect(rows(`UPDATE machine_online SET seconds = 0`)).rejects.toMatchObject({ code: '42501' });
  });

  it('lets the orchestrator read what a machine is in the network, and change none of it', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const agentSql = app.ctx.agentSql!;
    const [company] = await db.select().from(companies);
    const [owner] = await db.select().from(people);
    await db.insert(machines).values({ companyId: company!.id, personId: owner!.id, machineKey: 'server:test', networkId: 'a1b2c3d4'.repeat(4), role: 'data', webPort: 8080 });
    expect((await agentSql.run('SELECT role, network_id, web_port FROM machines', 'write'))[0]!.rows).toEqual([{ role: 'data', network_id: 'a1b2c3d4'.repeat(4), web_port: 8080 }]);
    await expect(agentSql.run(`UPDATE machines SET role = 'worker'`, 'write')).rejects.toMatchObject({ code: '42501' });
  });
});
