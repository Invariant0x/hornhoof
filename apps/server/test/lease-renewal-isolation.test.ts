import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { loadConfig } from '../src/config.js';
import { runBounded } from '../src/modules/agents/timers.js';
import { Keeper } from '../src/modules/keeper/keeper.js';
import { LEASE_MS, type Clocks } from '../src/modules/keeper/lease.js';
import { LeaseHolder } from '../src/modules/keeper/lease-holder.js';
import { keeperSql, leaseOfMachine, leaseStore, type Sql } from '../src/modules/keeper/lease-store.js';
import { readKeeperState } from '../src/modules/keeper/state.js';
import { fakeLease } from './fake-lease.js';
import { TEST_SECRET, until } from './helpers.js';

const T0: Clocks = { wall: 1e12, mono: 5e3 };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-lease-iso-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('keeper lease renewal isolation under DB load', () => {
  it('runs lease renewals on a dedicated connection even while background problems, prune and guard hang or fail', async () => {
    const bgGate = deferred<void>();
    onTestFinished(() => bgGate.resolve());
    const leaseQueries: string[] = [];
    const bgQueries: string[] = [];
    let closedLease = 0;
    let closedBg = 0;

    const leaseSql: Sql & { close(): Promise<void> } = {
      async query<R>(text: string) {
        leaseQueries.push(text);
        if (/SELECT current_database\(\)/i.test(text)) return { rows: [{ name: 'hornhoof' } as R] };
        if (/INSERT INTO net_local\.lease/i.test(text)) return { rows: [{ number: 1 } as R] };
        if (/UPDATE net_local\.lease/i.test(text)) return { rows: [{ '?column?': 1 } as R] };
        return { rows: [{ ended: 0 } as R] };
      },
      async close() { closedLease += 1; },
    };

    const backgroundSql: Sql & { close(): Promise<void> } = {
      async query<R>(text: string) {
        bgQueries.push(text);
        await bgGate.promise;
        if (/SELECT current_database\(\)/i.test(text)) return { rows: [{ name: 'hornhoof' } as R] };
        return { rows: [{ there: false } as R] };
      },
      async close() { closedBg += 1; },
    };

    const store = leaseStore(leaseSql, { machineId: 'machine-a', backgroundSql });
    const term = await store.take('normal', new Date(T0.wall + LEASE_MS));

    /* Start blocking background maintenance queries. */
    const problemsPending = store.problems();
    const prunePending = store.prune();
    const guardPending = store.othersHoldData();

    /* Lease renewal completes immediately on its dedicated connection without waiting for backgroundSql. */
    expect(await store.renew(term, 'normal', new Date(T0.wall + 2000 + LEASE_MS), false, 'alone')).toBe(true);
    expect(leaseQueries.some(q => /UPDATE net_local\.lease/i.test(q))).toBe(true);
    expect(bgQueries.length).toBeGreaterThan(0);
    expect(leaseQueries.some(q => /net\.journal|information_schema|pg_trigger/i.test(q))).toBe(false);
    /* Background metadata checks use pg_attribute rather than information_schema.columns. */
    expect(bgQueries.some(q => /information_schema\.columns/i.test(q))).toBe(false);

    bgGate.resolve();
    await Promise.all([problemsPending, prunePending, guardPending]);
    await store.close();
    expect([closedLease, closedBg]).toEqual([1, 1]);
  });

  it('opens two separate Sql connections in leaseOfMachine and closes both', async () => {
    const opened: { queries: string[]; closed: number }[] = [];
    const lease = leaseOfMachine(
      { databaseUrl: 'postgres://nowhere.invalid/db', machineId: 'machine-a' },
      () => undefined,
      () => {
        const handle = { queries: [] as string[], closed: 0 };
        opened.push(handle);
        return {
          async query<R>(text: string) {
            handle.queries.push(text);
            if (/INSERT INTO net_local\.lease/i.test(text)) return { rows: [{ number: 1 } as R] };
            if (/SELECT current_database\(\)/i.test(text)) return { rows: [{ name: 'hornhoof' } as R] };
            return { rows: [{ there: false, ended: 0 } as R] };
          },
          close: async () => { handle.closed += 1; },
        };
      },
    );
    expect(opened).toHaveLength(2);
    await lease!.take('normal', new Date(T0.wall + LEASE_MS));
    await lease!.othersHoldData();
    expect(opened[0]!.queries.some(q => /net_local\.lease/i.test(q))).toBe(true);
    expect(opened[0]!.queries.some(q => /machines/i.test(q))).toBe(false);
    expect(opened[1]!.queries.some(q => /machines/i.test(q))).toBe(true);
    await lease!.close();
    expect(opened.map(h => h.closed)).toEqual([1, 1]);
  });

  it('recovers agentRoles lookup after a transient database error instead of caching the rejected promise', async () => {
    let failFirst = true;
    const sqlMock: Sql = {
      async query<R>(text: string) {
        if (/SELECT current_database\(\)/i.test(text)) {
          if (failFirst) {
            failFirst = false;
            throw new Error('transient connect timeout');
          }
          return { rows: [{ name: 'hornhoof' } as R] };
        }
        return { rows: [{ ended: 0 } as R] };
      },
    };
    const store = leaseStore(sqlMock, { machineId: 'machine-a' });
    await expect(store.endSessions()).rejects.toThrow('transient connect timeout');
    expect(await store.endSessions()).toBe(0);
  });

  it('keeps renewing every second without blocking tick() while prune() hangs, avoids overlapping prunes, and logs renewal failures once per outage', async () => {
    let now = T0;
    const lines: string[] = [];
    const pruneGate = deferred<number>();
    onTestFinished(() => pruneGate.resolve(0));
    let pruneStarts = 0;
    let renewError: Error | null = null;
    const lease = fakeLease({
      prune: () => {
        pruneStarts += 1;
        return pruneGate.promise;
      },
      renew: async () => {
        if (renewError) throw renewError;
        return true;
      },
    });
    const h = new LeaseHolder({ lease, updaterBusy: () => false, now: () => now, pruneEveryMs: 2000, log: line => lines.push(line) });
    const after = (ms: number) => { now = { wall: now.wall + ms, mono: now.mono + ms }; };
    const tickWithin = (ms: number) => Promise.race([
      h.tick().then(() => true),
      new Promise<boolean>(resolve => { setTimeout(() => { resolve(false); }, ms); }),
    ]);

    await h.tick();
    await h.look();
    /* Trigger prune at +2 s while keeping it hung across five subsequent ticks. */
    for (let s = 1; s <= 6; s++) {
      after(1000);
      expect(await tickWithin(200)).toBe(true);
      expect(h.mode()).toBe('lead');
    }
    expect(pruneStarts).toBe(1);
    expect(lease.calls.filter(c => c.method === 'renew')).toHaveLength(6);

    /* Rejecting prune logs once and releases the prune guard for the next cycle. */
    pruneGate.reject(new Error('prune statement timeout'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(lines.some(line => line.includes('Could not prune the journal: prune statement timeout'))).toBe(true);

    /* Renewal failures are logged once per outage, not silently swallowed or spammed. */
    renewError = new Error('query timeout');
    after(1000);
    await h.tick();
    after(1000);
    await h.tick();
    expect(lines.filter(line => line.includes('Could not renew the lease: query timeout'))).toHaveLength(1);

    /* Recovery clears the once-flag so a later outage logs again. */
    renewError = null;
    after(1000);
    await h.tick();
    renewError = new Error('query timeout');
    after(1000);
    await h.tick();
    expect(lines.filter(line => line.includes('Could not renew the lease: query timeout'))).toHaveLength(2);
  });

  it('prevents fencesTimer and guardTimer from stacking slow queries and writes read mode before fence() finishes', async () => {
    const dir = tempDir();
    const appServer = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>(resolve => appServer.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => {
      appServer.closeAllConnections();
      appServer.close();
    });
    const appPort = (appServer.address() as AddressInfo).port;

    let problemsInFlight = 0;
    let maxProblemsInFlight = 0;
    let guardInFlight = 0;
    let maxGuardInFlight = 0;
    let firstLook = true;
    let renewCommits = true;
    const problemsGate = deferred<void>();
    const guardGate = deferred<void>();
    const fenceGate = deferred<void>();

    const lease = fakeLease({ renew: async () => renewCommits });
    lease.problems = async () => {
      if (firstLook) {
        firstLook = false;
        return [];
      }
      problemsInFlight += 1;
      maxProblemsInFlight = Math.max(maxProblemsInFlight, problemsInFlight);
      await problemsGate.promise;
      problemsInFlight -= 1;
      return [];
    };
    lease.othersHoldData = async () => {
      guardInFlight += 1;
      maxGuardInFlight = Math.max(maxGuardInFlight, guardInFlight);
      await guardGate.promise;
      guardInFlight -= 1;
      return false;
    };
    lease.fence = async () => {
      await fenceGate.promise;
    };

    let now = T0;
    const keeper = new Keeper({
      config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_CONTROL_DIR: dir }),
      db: null,
      app: { host: '127.0.0.1', port: appPort },
      frontHost: null,
      lease,
      now: () => now,
      everyMs: 25,
      linkEveryMs: 15,
      guardEveryMs: 15,
      log: () => undefined,
      host: '127.0.0.1',
      ports: { front: 0, linkHttp: 0, linkTls: 0, peer: 0, peerApp: 0 },
    });
    await keeper.start();
    onTestFinished(async () => {
      problemsGate.resolve();
      guardGate.resolve();
      fenceGate.resolve();
      await keeper.stop();
    });

    await until(() => problemsInFlight >= 1 && guardInFlight >= 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(maxProblemsInFlight).toBe(1);
    expect(maxGuardInFlight).toBe(1);

    /* Lapse the lease while fence() is blocked: keeper.json must flip to read immediately. */
    renewCommits = false;
    for (let s = 1; s <= 11; s++) {
      now = { wall: now.wall + 1000, mono: now.mono + 1000 };
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    const switchedToRead = await Promise.race([
      until(() => readKeeperState(dir)?.mode === 'read').then(() => true),
      new Promise<boolean>(resolve => { setTimeout(() => { resolve(false); }, 1000); }),
    ]);
    expect(switchedToRead).toBe(true);
    expect(keeper.mode()).toBe('read');

    problemsGate.resolve();
    guardGate.resolve();
    fenceGate.resolve();
  });

  it('sends server-side statement_timeout in Postgres startup options from keeperSql', async () => {
    const startupPayloads: string[] = [];
    const open = new Set<net.Socket>();
    const server = net.createServer(socket => {
      open.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => open.delete(socket));
      let started = false;
      socket.on('data', chunk => {
        if (!started) {
          started = true;
          startupPayloads.push(chunk.toString('utf8'));
          /* AuthenticationOk + ReadyForQuery */
          socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => {
      for (const socket of open) socket.destroy();
      server.close();
    });
    const { port } = server.address() as AddressInfo;
    const url = `postgres://u:p@127.0.0.1:${port}/d`;

    const fixed = keeperSql(url, { timeoutMs: 250 });
    onTestFinished(() => fixed.close());
    await expect(fixed.query('SELECT 1')).rejects.toThrow();

    const dynamic = keeperSql(url, { timeoutMs: () => 200 });
    onTestFinished(() => dynamic.close());
    await expect(dynamic.query('SELECT 1')).rejects.toThrow();

    expect(startupPayloads[0]).toContain('-c synchronous_commit=local -c statement_timeout=250');
    expect(startupPayloads[1]).toContain('-c synchronous_commit=local -c statement_timeout=5000');
  });

  it('bounds concurrent minuteRound maintenance sweeps while preserving error isolation', async () => {
    let active = 0;
    let peak = 0;
    const ran: number[] = [];
    const errors: string[] = [];
    const tasks = Array.from({ length: 13 }, (_, i) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      ran.push(i);
      active -= 1;
      if (i === 4) throw new Error('boom');
    });
    await runBounded(tasks.map(fn => () => fn().catch((err: Error) => { errors.push(err.message); })), 3);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(ran.sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, i) => i));
    expect(errors).toEqual(['boom']);
  });
});
