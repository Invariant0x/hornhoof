import type { NodeReconnect } from '@hornhoof/protocol';
import { asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { companies, departments, machines, nodeConnectionEvents, nodes, people } from '../src/db/schema.js';
import { attachNodeReconnect, pruneNodeConnectionHistory, recordNodeConnection } from '../src/modules/nodes/history.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

async function companyWithNode() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [owner] = await db.select().from(people);
  const [machine] = await db.insert(machines).values({ companyId: company!.id, personId: owner!.id, machineKey: 'home-0001-abcd', hostname: 'home-api' }).returning();
  const [node] = await db.insert(nodes).values({ companyId: company!.id, machineId: machine!.id, keyHash: 'node-key-hash' }).returning();
  return { app, db, ceo, companyId: company!.id, machineId: machine!.id, nodeId: node!.id };
}

const reconnect: NodeReconnect = {
  disconnectedAt: '2026-11-04T10:00:00.000Z',
  reconnectedAt: '2026-11-04T10:00:40.000Z',
  offlineMs: 40_000,
  attempts: 3,
  cause: 'dns_error',
  closeCode: 1006,
  closeReason: 'abnormal',
  errorCode: 'ENOTFOUND',
  error: 'DNS lookup failed',
  dnsFailed: true,
  watchdogTimedOut: false,
  clockJumpMs: null,
  networkChanged: true,
};

describe('node connection history', () => {
  it('stores both ends of an outage and the node report on the disconnect', async () => {
    const { app, db, companyId, machineId, nodeId } = await companyWithNode();
    const disconnectedAt = new Date('2026-11-04T10:00:00.000Z');
    const reconnectedAt = new Date('2026-11-04T10:00:40.000Z');
    await recordNodeConnection(app.ctx, nodeIdentity(nodeId), {
      kind: 'disconnected', at: disconnectedAt, actor: 'network', cause: 'abnormal_close', closeCode: 1006, closeReason: 'abnormal', error: null,
    });
    await recordNodeConnection(app.ctx, nodeIdentity(nodeId), { kind: 'connected', at: reconnectedAt });
    await attachNodeReconnect(db, nodeIdentity(nodeId), reconnect);

    const rows = await db.select().from(nodeConnectionEvents).orderBy(asc(nodeConnectionEvents.happenedAt));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      companyId, machineId, nodeId, kind: 'disconnected', happenedAt: disconnectedAt,
      actor: 'network', cause: 'abnormal_close', closeCode: 1006, closeReason: 'abnormal', offlineMs: 40_000, nodeReport: reconnect,
    });
    expect(rows[1]).toMatchObject({ companyId, machineId, nodeId, kind: 'connected', happenedAt: reconnectedAt, offlineMs: 40_000, nodeReport: null });
  });

  it('keeps a server close without a report from an older node', async () => {
    const { app, db, nodeId } = await companyWithNode();
    const at = new Date('2026-11-04T10:00:00.000Z');
    await recordNodeConnection(app.ctx, nodeIdentity(nodeId), {
      kind: 'disconnected', at, actor: 'server', cause: 'missed_pongs', closeCode: 1006, closeReason: '', error: null,
    });
    const [row] = await db.select().from(nodeConnectionEvents).where(eq(nodeConnectionEvents.nodeId, nodeId));
    expect(row).toMatchObject({ cause: 'missed_pongs', offlineMs: null, nodeReport: null });
  });

  it('deletes events older than 14 days and keeps newer ones', async () => {
    const { db, companyId, machineId, nodeId } = await companyWithNode();
    const now = new Date('2026-11-15T10:00:00.000Z');
    await db.insert(nodeConnectionEvents).values([
      { companyId, machineId, nodeId, kind: 'disconnected', happenedAt: new Date('2026-10-31T10:00:00.000Z') },
      { companyId, machineId, nodeId, kind: 'connected', happenedAt: new Date('2026-11-01T10:00:01.000Z') },
      { companyId, machineId, nodeId, kind: 'connected', happenedAt: new Date('2026-11-14T10:00:00.000Z') },
    ]);
    await pruneNodeConnectionHistory(db, now);
    const rows = await db.select({ happenedAt: nodeConnectionEvents.happenedAt }).from(nodeConnectionEvents).orderBy(asc(nodeConnectionEvents.happenedAt));
    expect(rows).toEqual([{ happenedAt: new Date('2026-11-01T10:00:01.000Z') }, { happenedAt: new Date('2026-11-14T10:00:00.000Z') }]);
  });

  it('keeps only the newest 2000 events on each machine', async () => {
    const { db, companyId, machineId, nodeId } = await companyWithNode();
    const now = new Date('2026-11-15T10:00:00.000Z');
    await db.execute(sql`insert into node_connection_events (company_id, machine_id, node_id, kind, happened_at)
      select ${companyId}, ${machineId}, ${nodeId}, 'connected', cast(${now} as timestamp with time zone) - (n || ' seconds')::interval from generate_series(0, 2000) n`);
    await pruneNodeConnectionHistory(db, now);
    const rows = await db.execute<{ n: number; oldest: string }>(sql`select count(*)::int as n,
      to_char(min(happened_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as oldest from node_connection_events where machine_id = ${machineId}`);
    expect(rows.rows).toEqual([{ n: 2000, oldest: '2026-11-15T09:26:41Z' }]);
  });
});


describe('machine connection history API', () => {
  it('summarizes 24 hours and returns server and node observations together', async () => {
    const { app, db, ceo, companyId, machineId, nodeId } = await companyWithNode();
    const now = Date.now();
    const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000);
    const stored = { companyId, machineId, nodeId };
    await db.insert(nodeConnectionEvents).values([
      { ...stored, kind: 'disconnected', happenedAt: at(90_000), actor: 'network', cause: 'abnormal_close', offlineMs: 5000 },
      { ...stored, kind: 'disconnected', happenedAt: at(10_800), actor: 'network', cause: 'abnormal_close', closeCode: 1006, closeReason: 'reset', offlineMs: 40_000, nodeReport: reconnect },
      { ...stored, kind: 'connected', happenedAt: at(10_760), offlineMs: 40_000 },
      { ...stored, kind: 'disconnected', happenedAt: at(7200), actor: 'network', cause: 'abnormal_close', offlineMs: 20_000 },
      { ...stored, kind: 'connected', happenedAt: at(7180), offlineMs: 20_000 },
      { ...stored, kind: 'disconnected', happenedAt: at(3600), actor: 'server', cause: 'missed_pongs', offlineMs: 60_000 },
      { ...stored, kind: 'connected', happenedAt: at(3540), offlineMs: 60_000 },
    ]);

    const response = await app.inject({ url: `/api/machines/${machineId}/connection-history`, ...as(ceo) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary).toMatchObject({ disconnects: 3, averageOfflineMs: 40_000, topCause: 'abnormal_close' });
    expect(body.events).toHaveLength(7);
    expect(body.events[0]).toMatchObject({ kind: 'connected', offlineMs: 60_000 });
    const reported = body.events.find((event: { nodeReport: NodeReconnect | null }) => event.nodeReport !== null);
    expect(reported).toMatchObject({ kind: 'disconnected', actor: 'network', cause: 'abnormal_close', closeCode: 1006, closeReason: 'reset', offlineMs: 40_000, nodeReport: reconnect });

    const [latestConnection] = await db.select({ id: nodeConnectionEvents.id }).from(nodeConnectionEvents).where(eq(nodeConnectionEvents.kind, 'connected')).orderBy(sql`happened_at desc`).limit(1);
    await db.delete(nodeConnectionEvents).where(eq(nodeConnectionEvents.id, latestConnection!.id));
    await db.update(nodeConnectionEvents).set({ offlineMs: null, happenedAt: new Date(Date.now() - 600_000) }).where(eq(nodeConnectionEvents.cause, 'missed_pongs'));
    const ongoing = await app.inject({ url: `/api/machines/${machineId}/connection-history`, ...as(ceo) });
    expect(ongoing.json().summary.averageOfflineMs).toBeGreaterThanOrEqual(220_000);
    expect(ongoing.json().summary.averageOfflineMs).toBeLessThan(225_000);
  });

  it('lets a listed person read only their own machine history', async () => {
    const { app, db, ceo, companyId, machineId } = await companyWithNode();
    const [department] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@example.test', access: { departments: [department!.id] } });
    const denied = await app.inject({ url: `/api/machines/${machineId}/connection-history`, ...as(maria) });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('home-api');

    const [owner] = await db.select({ id: people.id }).from(people).where(eq(people.email, 'maria@example.test'));
    const [own] = await db.insert(machines).values({ companyId, personId: owner!.id, machineKey: 'maria-key', hostname: 'maria-pc' }).returning();
    const allowed = await app.inject({ url: `/api/machines/${own!.id}/connection-history`, ...as(maria) });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ summary: { disconnects: 0, averageOfflineMs: null, topCause: null }, events: [] });
  });

  it('does not expose a machine of another company', async () => {
    const { app, db, ceo, machineId } = await companyWithNode();
    const [other] = await db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    await db.update(machines).set({ companyId: other!.id }).where(eq(machines.id, machineId));
    const response = await app.inject({ url: `/api/machines/${machineId}/connection-history`, ...as(ceo) });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('abnormal_close');
  });
});
