import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, jobs } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { appOn, as, invitePerson, listen, mcp, openStream, until } from './helpers.js';
import { openTestDb } from './helpers-db.js';
import { failureCompany } from './failure-company.js';

const START = Date.parse('2026-11-21T10:00:00.000Z');
const THRESHOLD_MS = 2 * 60_000;
const MCP_TOKEN = 'tool-token-updater-health-0123456789ab';

type Result = { content: { text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;

function makeControlDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-updater-health-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function touchAlive(control: string, atMs: number): void {
  const file = join(control, 'alive');
  writeFileSync(file, '');
  const at = new Date(atMs);
  utimesSync(file, at, at);
}

const failLoud = (what: string) => (err: unknown) => {
  throw new Error(`${what}: ${String(err)}`);
};

async function openOpsFailuresClient(c: Awaited<ReturnType<typeof failureCompany>>) {
  const collector = await c.hire('Nora', 'worker', 'OPS-FIX', c.ops.id);
  await c.db.update(agents).set({ skills: ['ops-failure-review'] }).where(eq(agents.id, collector.id));
  await c.db.insert(jobs).values({
    companyId: c.companyId,
    subscriptionId: c.sub.id,
    agentId: collector.id,
    kind: 'conversation',
    prompt: 'check failures',
    timeoutMs: 900_000,
    status: 'running',
    toolTokenHash: hashToken(MCP_TOKEN),
  });
  return mcp(c.app, MCP_TOKEN);
}

async function flushStream(c: Awaited<ReturnType<typeof failureCompany>>, stream: Awaited<ReturnType<typeof openStream>>) {
  const before = stream.messages.filter(m => m.type === 'org').length;
  c.ctx.bus.publish(c.companyId, { type: 'org' });
  await until(() => stream.messages.filter(m => m.type === 'org').length > before);
}

describe('updater heartbeat monitoring', () => {
  it('raises one Operations signal when alive goes stale past the threshold, deduplicates ticks, and clears when fresh', async () => {
    const control = makeControlDir();
    let now = START;
    const c = await failureCompany({ HORNHOOF_CONTROL_DIR: control });
    c.ctx.clock = () => now;
    await listen(c.app);
    const deptToken = await invitePerson(c.app, c.ceo, { name: 'Vera', email: 'vera@acme.test', access: { departments: [c.dev.id] } });
    const ceoStream = await openStream(c.app, c.ceo);
    const deptStream = await openStream(c.app, deptToken);
    const failuresClient = await openOpsFailuresClient(c);

    touchAlive(control, START);

    /* Fresh heartbeat: no alert, no silent state. */
    await minuteRound(c.ctx, new Date(now), failLoud);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
    const freshView = (await c.app.inject({ method: 'GET', url: '/api/updates', ...as(c.ceo) })).json();
    expect(freshView.updater.present).toBe(true);
    expect(freshView.updater.silent).toBeUndefined();
    expect(JSON.parse((await call(failuresClient, 'failures')).content[0]!.text).updaterSilent).toBeNull();

    /* Between present cutoff (30s) and staleness threshold (2 min): not present for immediate update, not silent yet. */
    now = START + THRESHOLD_MS - 1;
    await minuteRound(c.ctx, new Date(now), failLoud);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
    const borderView = (await c.app.inject({ method: 'GET', url: '/api/updates', ...as(c.ceo) })).json();
    expect(borderView.updater.present).toBe(false);
    expect(borderView.updater.silent).toBeUndefined();

    /* At threshold: raises exactly one Operations failure signal and surfaces silent state on updates, failures, and company SSE. */
    now = START + THRESHOLD_MS;
    await minuteRound(c.ctx, new Date(now), failLoud);
    await flushStream(c, ceoStream);
    await flushStream(c, deptStream);

    const firstTurns = await c.turnsOf(c.watcher.id);
    expect(firstTurns).toHaveLength(1);
    expect(firstTurns[0]!.prompt).toContain('2026-11-21T10:00:00.000Z');
    const [noticeEvent] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.watcher.id), eq(agentEvents.kind, 'message'))).orderBy(asc(agentEvents.seq));
    expect(noticeEvent?.data).toMatchObject({
      failureCase: `updater-silent:${c.companyId}:${Math.floor(START / 1000)}`,
      notification: { source: 'failure' },
    });

    const staleView = (await c.app.inject({ method: 'GET', url: '/api/updates', ...as(c.ceo) })).json();
    expect(staleView.updater.present).toBe(false);
    expect(staleView.updater.silent).toEqual({ since: '2026-11-21T10:00:00.000Z' });
    expect(JSON.parse((await call(failuresClient, 'failures')).content[0]!.text).updaterSilent).toEqual({ since: '2026-11-21T10:00:00.000Z' });
    expect(ceoStream.messages.filter(m => m.type === 'updates')).toHaveLength(1);
    expect(deptStream.messages.filter(m => m.type === 'updates')).toHaveLength(0);

    /* Repeated minute ticks while still stale send neither duplicate Operations turns nor duplicate SSE pushes. */
    now = START + THRESHOLD_MS + 60_000;
    await minuteRound(c.ctx, new Date(now), failLoud);
    now = START + THRESHOLD_MS + 180_000;
    await minuteRound(c.ctx, new Date(now), failLoud);
    await flushStream(c, ceoStream);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
    expect(ceoStream.messages.filter(m => m.type === 'updates')).toHaveLength(1);

    /* Fresh alive clears the silent state automatically and notifies open company screens once. */
    const recoveredAt = START + THRESHOLD_MS + 240_000;
    now = recoveredAt;
    touchAlive(control, recoveredAt);
    await minuteRound(c.ctx, new Date(now), failLoud);
    await flushStream(c, ceoStream);

    const recoveredView = (await c.app.inject({ method: 'GET', url: '/api/updates', ...as(c.ceo) })).json();
    expect(recoveredView.updater.present).toBe(true);
    expect(recoveredView.updater.silent).toBeUndefined();
    expect(JSON.parse((await call(failuresClient, 'failures')).content[0]!.text).updaterSilent).toBeNull();
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
    expect(ceoStream.messages.filter(m => m.type === 'updates')).toHaveLength(2);

    /* Another fresh tick stays quiet. */
    now = recoveredAt + 10_000;
    touchAlive(control, now);
    await minuteRound(c.ctx, new Date(now), failLoud);
    await flushStream(c, ceoStream);
    expect(ceoStream.messages.filter(m => m.type === 'updates')).toHaveLength(2);

    /* A second outage after recovery raises a single new incident signal. */
    const secondSince = now;
    now = secondSince + THRESHOLD_MS;
    await minuteRound(c.ctx, new Date(now), failLoud);
    const secondTurns = await c.turnsOf(c.watcher.id);
    expect(secondTurns).toHaveLength(2);
    expect(secondTurns[1]!.prompt).toContain(new Date(secondSince).toISOString());

    ceoStream.close();
    deptStream.close();
  });

  it('deduplicates the same stale outage across a server restart', async () => {
    const control = makeControlDir();
    const { client } = await openTestDb();
    onTestFinished(() => client.close());
    let now = START;

    const first = await appOn(client, { HORNHOOF_CONTROL_DIR: control });
    const { setUpCompany } = await import('./helpers.js');
    const { companies, departments, subscriptions } = await import('../src/db/schema.js');
    const ceo = await setUpCompany(first.app);
    const [company] = await first.db.select().from(companies);
    const [sub] = await first.db.select().from(subscriptions);
    await first.db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, sub!.id));
    const [ops] = await first.db.insert(departments).values({ companyId: company!.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const [watcher] = await first.db.insert(agents).values({ companyId: company!.id, name: 'Walt', kind: 'worker', roleKey: 'OPS-WATCH', departmentId: ops!.id, subscriptionId: sub!.id, model: '' }).returning();
    vi.spyOn(first.app.ctx.hub, 'isReady').mockReturnValue(true);
    vi.spyOn(first.app.ctx.hub, 'isOnline').mockReturnValue(true);
    vi.spyOn(first.app.ctx.hub, 'send').mockReturnValue(true);
    first.app.ctx.clock = () => now;

    touchAlive(control, START);
    now = START + THRESHOLD_MS;
    await minuteRound(first.app.ctx, new Date(now), failLoud);
    expect(await first.db.select().from(jobs).where(eq(jobs.agentId, watcher!.id))).toHaveLength(1);

    /* Fresh app instance on the same database and stale alive file does not spam Operations. */
    const second = await appOn(client, { HORNHOOF_CONTROL_DIR: control });
    vi.spyOn(second.app.ctx.hub, 'isReady').mockReturnValue(true);
    vi.spyOn(second.app.ctx.hub, 'isOnline').mockReturnValue(true);
    vi.spyOn(second.app.ctx.hub, 'send').mockReturnValue(true);
    second.app.ctx.clock = () => now + 60_000;
    await minuteRound(second.app.ctx, new Date(now + 60_000), failLoud);
    expect(await second.db.select().from(jobs).where(eq(jobs.agentId, watcher!.id))).toHaveLength(1);
    const view = (await second.app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json();
    expect(view.updater.silent).toEqual({ since: '2026-11-21T10:00:00.000Z' });
  });

  it('routes the alert to OPS-HEAD when OPS-WATCH is busy', async () => {
    const control = makeControlDir();
    let now = START;
    const c = await failureCompany({ HORNHOOF_CONTROL_DIR: control });
    c.ctx.clock = () => now;
    const opsHead = await c.hire('Olga', 'head', 'OPS-HEAD', c.ops.id);
    await c.db.insert(jobs).values({
      companyId: c.companyId,
      subscriptionId: c.sub.id,
      agentId: c.watcher.id,
      kind: 'conversation',
      prompt: 'already busy',
      timeoutMs: 900_000,
      status: 'running',
    });

    touchAlive(control, START);
    now = START + THRESHOLD_MS;
    await minuteRound(c.ctx, new Date(now), failLoud);

    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
    const headTurns = await c.turnsOf(opsHead.id);
    expect(headTurns).toHaveLength(1);
    expect(headTurns[0]!.prompt).toContain('2026-11-21T10:00:00.000Z');
  });

  it('stays quiet when no updater heartbeat was ever present, rejects symlinks, and alerts if alive disappears after being fresh', async () => {
    const control = makeControlDir();
    const outside = makeControlDir();
    let now = START;
    const c = await failureCompany({ HORNHOOF_CONTROL_DIR: control });
    c.ctx.clock = () => now;

    /* No alive file ever observed: stays quiet. */
    await minuteRound(c.ctx, new Date(now), failLoud);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
    expect((await c.app.inject({ method: 'GET', url: '/api/updates', ...as(c.ceo) })).json().updater.silent).toBeUndefined();

    /* Observe a real heartbeat, then replace alive with a symlink to a fresh outside file: must not be treated as present. */
    touchAlive(control, START);
    expect(c.ctx.updater.present()).toBe(true);
    const decoy = join(outside, 'decoy');
    writeFileSync(decoy, '');
    now = START + THRESHOLD_MS;
    utimesSync(decoy, new Date(now), new Date(now));
    rmSync(join(control, 'alive'));
    symlinkSync(decoy, join(control, 'alive'));

    expect(c.ctx.updater.present()).toBe(false);
    await minuteRound(c.ctx, new Date(now), failLoud);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
    expect((await c.app.inject({ method: 'GET', url: '/api/updates', ...as(c.ceo) })).json().updater.silent).toEqual({ since: '2026-11-21T10:00:00.000Z' });

    /* Removing alive altogether keeps the silent state until a regular fresh file returns. */
    rmSync(join(control, 'alive'));
    expect((await c.app.inject({ method: 'GET', url: '/api/updates', ...as(c.ceo) })).json().updater.silent).toEqual({ since: '2026-11-21T10:00:00.000Z' });

    touchAlive(control, now);
    await minuteRound(c.ctx, new Date(now), failLoud);
    const clearView = (await c.app.inject({ method: 'GET', url: '/api/updates', ...as(c.ceo) })).json();
    expect(clearView.updater.present).toBe(true);
    expect(clearView.updater.silent).toBeUndefined();
  });

  it('delivers the alert once an Operations watcher becomes available while still stale', async () => {
    const control = makeControlDir();
    let now = START;
    const c = await failureCompany({ HORNHOOF_CONTROL_DIR: control });
    c.ctx.clock = () => now;
    await c.db.update(agents).set({ switchedOffAt: new Date(now) }).where(eq(agents.id, c.watcher.id));

    touchAlive(control, START);
    now = START + THRESHOLD_MS;
    await minuteRound(c.ctx, new Date(now), failLoud);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
    expect((await c.app.inject({ method: 'GET', url: '/api/updates', ...as(c.ceo) })).json().updater.silent).toEqual({ since: '2026-11-21T10:00:00.000Z' });

    await c.db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, c.watcher.id));
    now = START + THRESHOLD_MS + 60_000;
    await minuteRound(c.ctx, new Date(now), failLoud);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
  });
});
