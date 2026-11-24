import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import {
  agents,
  certificates,
  companies,
  computerRuns,
  departments,
  jobs,
  machineOnline,
  machines,
  nodeCodes,
  nodeConnections,
  nodes,
  people,
  subscriptions,
  tasks,
  testParts,
  testRuns,
} from '../src/db/schema.js';
import { saveLink } from '../src/modules/link/link.js';
import { certFacts } from '../src/modules/network/authority.js';
import { tryGrant } from '../src/modules/network/follow.js';
import { hostIdOf } from '../src/modules/network/join.js';
import { VIA } from '../src/modules/network/via.js';
import { placesOf } from '../src/modules/testruns/runs.js';
import { appOn, as, connectNode, invitePerson, listen, prepareApp, setUpCompany, testApp, until } from './helpers.js';
import { openTestDb, timed } from './helpers-db.js';

await prepareApp();

const ALPHA_KEY = 'alpha-0001-key0';
const ALPHA_HOST_ID = hostIdOf(ALPHA_KEY);
const BETA_KEY = 'beta-0002-key00';
const BETA_HOST_ID = hostIdOf(BETA_KEY);
const GAMMA_KEY = 'gamma-0003-key0';
const LEGACY_NET_ID = 'ab12cd34'.repeat(4);
const NODE_KEY = 'builtin-node-key-0123456789abcdef';
const OWN = { remoteAddress: '127.0.0.1', headers: { [VIA]: 'keeper' } };
const GIB = 1024 ** 3;

const newSignKey = (): string => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const codeOf = (command: string): string => command.split('--join ')[1]!;
const builtinToken = (machineId: string): string =>
  `builtin.${machineId}.${createHmac('sha256', NODE_KEY).update(`hornhoof builtin node ${machineId}`).digest('hex')}`;

async function planCommand(app: FastifyInstance, token: string, providers: ('claude' | 'codex')[] = ['claude']): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers }, ...as(token) });
  expect(res.statusCode).toBe(201);
  return codeOf(res.json().command as string);
}

async function machineCommand(app: FastifyInstance, token: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/machines/command', ...as(token) });
  expect(res.statusCode).toBe(201);
  return codeOf(res.json().command as string);
}

async function joinComputer(
  app: FastifyInstance,
  code: string,
  computer: { machineId: string; hostname: string; os?: 'linux' | 'darwin'; arch?: string; core?: boolean },
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/nodes/join',
    payload: { code, os: 'linux', arch: 'x86_64', core: true, ...computer },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    machine: { id: string };
    nodes: { nodeId: string; subscriptionId: string | null; provider: string; key: string }[];
    core: { here?: boolean; port: number; ticket?: string } | null;
  };
}

async function issueServerCertificate(app: FastifyInstance, signKey = newSignKey()) {
  const res = await app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey }, ...OWN });
  expect(res.statusCode).toBe(200);
  return res.json() as { machine: string; role: string; certPem: string };
}

describe('one computer with both a server install and a node row (#2023)', () => {
  it('merges server-first and node-first setups into one machine row and keeps both roles after leadership moves', async () => {
    const { client } = await timed('setupMs', openTestDb);
    onTestFinished(() => timed('teardownMs', () => client.close()));

    const first = await appOn(client, {
      TUNNEL_HOST: '127.0.0.1',
      NODE_KEY,
      NODE_PING_MS: '50',
      HORNHOOF_MACHINE_ID: ALPHA_HOST_ID,
      HORNHOOF_HOST_ID: ALPHA_HOST_ID,
    });
    await first.app.ready();
    const ceo = await setUpCompany(first.app);
    const [company] = await first.db.select().from(companies);
    await saveLink(first.db, first.config, company!.id, {
      name: 'acme',
      url: 'https://acme.hornhoof.test',
      key: 'k'.repeat(32),
      tunnel: { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' },
    });

    /* Server install gets its certificate first, then the owner connects plans on the same computer. */
    const cert = await issueServerCertificate(first.app);
    expect(certFacts(cert.certPem).machineId).toBe(cert.machine);
    await first.app.inject({ method: 'POST', url: '/api/network/report', payload: { hostname: 'rack-alpha', webPort: 8080, memory: 32 * GIB, cores: 8 }, ...OWN });

    const joined = await joinComputer(first.app, await planCommand(first.app, ceo, ['claude']), {
      machineId: ALPHA_KEY,
      hostname: 'rack-alpha',
    });
    expect(joined.core).toEqual({ here: true, port: 8080 });
    expect(joined.machine.id).toBe(cert.machine);

    const liveRows = await first.db.select().from(machines).where(and(eq(machines.companyId, company!.id), isNull(machines.revokedAt)));
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0]).toMatchObject({
      id: cert.machine,
      machineKey: ALPHA_KEY,
      networkId: ALPHA_HOST_ID,
      role: 'data',
      hostname: 'rack-alpha',
    });

    /* Join a second computer that will take over leadership, then restart the app as the second computer. */
    const betaJoined = await joinComputer(first.app, await machineCommand(first.app, ceo), {
      machineId: BETA_KEY,
      hostname: 'rack-beta',
    });
    await first.db
      .update(machines)
      .set({
        networkId: BETA_HOST_ID,
        role: 'data',
        signKey: newSignKey(),
        serverOrder: 1,
        serverWhy: 'server',
        webPort: 8080,
      })
      .where(eq(machines.id, betaJoined.machine.id));
    await first.db
      .update(machines)
      .set({
        serverOrder: 2,
        serverWhy: 'always.best_link',
        copyState: 'ready',
        copyAt: new Date(),
        copyName: 'copy_alpha_1',
        reportAt: new Date(),
      })
      .where(eq(machines.id, cert.machine));
    await first.app.close();

    const second = await appOn(client, {
      TUNNEL_HOST: '127.0.0.1',
      NODE_KEY,
      NODE_PING_MS: '50',
      HORNHOOF_MACHINE_ID: BETA_HOST_ID,
      HORNHOOF_HOST_ID: BETA_HOST_ID,
    });
    const url = await listen(second.app);

    /* Connect both the plan node and the replica built-in node on rack-alpha, reporting disk and running counts. */
    const planSocket = await connectNode(url, joined.nodes[0]!.key);
    const replicaBuiltin = await connectNode(url, builtinToken(ALPHA_HOST_ID));
    onTestFinished(() => {
      planSocket.close();
      replicaBuiltin.close();
    });
    planSocket.send({
      type: 'hello',
      version: '0.5.0',
      loggedIn: true,
      running: [],
      load: {
        cpus: 8,
        load: 1.5,
        memFree: 20 * GIB,
        memTotal: 32 * GIB,
        jobs: 1,
        tests: 0,
        diskFree: 120 * GIB,
        diskTotal: 256 * GIB,
        disk: {
          free: 120 * GIB,
          total: 256 * GIB,
          threshold: 10 * GIB,
          low: null,
          parts: { images: 4 * GIB, workingCopies: 2 * GIB },
          cleaned: [],
        },
      },
    });
    replicaBuiltin.send({
      type: 'hello',
      version: '0.5.0',
      loggedIn: true,
      running: [],
      load: {
        cpus: 8,
        load: 2,
        memFree: 18 * GIB,
        memTotal: 32 * GIB,
        jobs: 1,
        tests: 1,
        diskFree: 118 * GIB,
        diskTotal: 256 * GIB,
        disk: {
          free: 118 * GIB,
          total: 256 * GIB,
          threshold: 10 * GIB,
          low: null,
          parts: { images: 4 * GIB, workingCopies: 3 * GIB },
          cleaned: [],
        },
      },
    });
    await until(() => second.app.ctx.hub.isReady({ kind: 'node', nodeId: joined.nodes[0]!.nodeId }) && second.app.ctx.hub.isReady({ kind: 'builtin', machine: ALPHA_HOST_ID }));

    const listed = (await second.app.inject({ url: '/api/machines', ...as(ceo) })).json() as {
      machines: {
        id: string;
        hostname: string;
        serverInstall: boolean;
        online: boolean;
        plans: { provider: string }[];
        core: { webPort: number | null } | null;
        keepsBackups: boolean | null;
        data?: { number: number | null; copy: { line: string } | null } | null;
        load: { jobs: number; tests: number; disk?: { parts: Record<string, number> } } | null;
        folders: { plan: string | null; bytes: number }[];
      }[];
    };
    const alphaRows = listed.machines.filter(m => m.hostname === 'rack-alpha');
    expect(alphaRows).toHaveLength(1);
    expect(alphaRows[0]).toMatchObject({
      id: cert.machine,
      hostname: 'rack-alpha',
      serverInstall: false,
      online: true,
      plans: [{ provider: 'claude' }],
      core: { webPort: 8080 },
      keepsBackups: true,
      data: { number: 2 },
      load: { jobs: 2, tests: 1, disk: { parts: { images: 4 * GIB, workingCopies: 5 * GIB } } },
    });
    expect(alphaRows[0]!.folders).toHaveLength(2);

    /* Pool and test-run places count rack-alpha as one physical computer across its node and built-in node. */
    const pool = (await second.app.inject({ url: '/api/pool', ...as(ceo) })).json() as { machines: { id: string; name: string }[] };
    expect(pool.machines.filter(m => m.name === 'rack-alpha')).toHaveLength(1);
    const places = await placesOf(second.app.ctx, company!.id);
    const alphaPlaces = places.filter(p => p.machineId === cert.machine);
    expect(alphaPlaces.map(p => p.builtin).sort()).toEqual([false, true]);

    /* Rolling update check sees active node work on the unified row and holds off granting an install. */
    const [sub] = await second.db.select().from(subscriptions).where(eq(subscriptions.companyId, company!.id));
    await second.db.update(machines).set({ updateCommit: 'c'.repeat(40), updateState: 'ready', reportAt: new Date() }).where(eq(machines.id, cert.machine));
    const [runningJob] = await second.db
      .insert(jobs)
      .values({
        companyId: company!.id,
        subscriptionId: sub!.id,
        nodeId: joined.nodes[0]!.nodeId,
        status: 'running',
        startedAt: new Date(),
        prompt: 'check',
        timeoutMs: 60_000,
      })
      .returning({ id: jobs.id });
    const grantedBusy = await second.db.transaction(tx =>
      tryGrant(tx, second.config, cert.machine, { version: '0.44.0', tag: 'v0.44.0', commit: 'c'.repeat(40), digest: 'sha256:' + '1'.repeat(64), nodeDigest: 'sha256:' + '2'.repeat(64), updaterDigest: 'sha256:' + '3'.repeat(64) }, new Date()),
    );
    expect(grantedBusy).toBe(false);
    await second.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, runningJob!.id));

    /* Node-first setup: if the node joins before the keeper requests its first server certificate, thisMachine claims the same row. */
    const nodeFirst = await testApp({
      TUNNEL_HOST: '127.0.0.1',
      HORNHOOF_MACHINE_ID: ALPHA_HOST_ID,
      HORNHOOF_HOST_ID: ALPHA_HOST_ID,
    });
    const ceo2 = await setUpCompany(nodeFirst.app);
    const firstNode = await joinComputer(nodeFirst.app, await machineCommand(nodeFirst.app, ceo2), {
      machineId: ALPHA_KEY,
      hostname: 'rack-alpha',
    });
    const claimed = await issueServerCertificate(nodeFirst.app);
    expect(claimed.machine).toBe(firstNode.machine.id);
    const [co2] = await nodeFirst.db.select().from(companies);
    expect(await nodeFirst.db.select().from(machines).where(eq(machines.companyId, co2!.id))).toHaveLength(1);
  });

  it('keeps two different computers with the same display name as two separate machines', async () => {
    const { app, db } = await testApp({
      TUNNEL_HOST: '127.0.0.1',
      HORNHOOF_MACHINE_ID: ALPHA_HOST_ID,
      HORNHOOF_HOST_ID: ALPHA_HOST_ID,
    });
    const ceo = await setUpCompany(app);
    await issueServerCertificate(app);
    await app.inject({ method: 'POST', url: '/api/network/report', payload: { hostname: 'shared-box', webPort: 8080 }, ...OWN });

    const one = await joinComputer(app, await machineCommand(app, ceo), { machineId: ALPHA_KEY, hostname: 'shared-box' });
    const two = await joinComputer(app, await machineCommand(app, ceo), { machineId: GAMMA_KEY, hostname: 'shared-box' });
    expect(one.machine.id).not.toBe(two.machine.id);

    const listed = (await app.inject({ url: '/api/machines', ...as(ceo) })).json() as { machines: { id: string; hostname: string }[] };
    expect(listed.machines.map(m => [m.id, m.hostname])).toEqual([
      [one.machine.id, 'shared-box'],
      [two.machine.id, 'shared-box'],
    ]);
    const [company] = await db.select().from(companies);
    expect(await db.select().from(machines).where(and(eq(machines.companyId, company!.id), isNull(machines.revokedAt)))).toHaveLength(2);
  });

  it('joins existing server-install and node pairs on startup upgrade, including legacy 32-hex machine ids', async () => {
    const { client } = await timed('setupMs', openTestDb);
    onTestFinished(() => timed('teardownMs', () => client.close()));

    const seed = await appOn(client, {
      TUNNEL_HOST: '127.0.0.1',
      HORNHOOF_MACHINE_ID: BETA_HOST_ID,
      HORNHOOF_HOST_ID: BETA_HOST_ID,
    });
    await seed.app.ready();
    const ceo = await setUpCompany(seed.app);
    const [company] = await seed.db.select().from(companies);
    const [owner] = await seed.db.select().from(people).where(eq(people.isOwner, true));
    const [dev] = await seed.db.insert(departments).values({ companyId: company!.id, name: 'Engineering', roleCode: 'ENG' }).returning();
    const [worker] = await seed.db.insert(agents).values({ companyId: company!.id, departmentId: dev!.id, kind: 'worker', name: 'Builder', model: '' }).returning();
    const [task] = await seed.db.insert(tasks).values({ companyId: company!.id, departmentId: dev!.id, number: 1, title: 'Check', brief: '', body: '' }).returning();

    /* Pre-upgrade pair 1: former server (64-hex networkId = hostIdOf(ALPHA_KEY)) + separate node row on the same computer. */
    const backupId = randomUUID();
    const [alphaServer] = await seed.db
      .insert(machines)
      .values({
        companyId: company!.id,
        personId: owner!.id,
        machineKey: `server:${ALPHA_HOST_ID}`,
        networkId: ALPHA_HOST_ID,
        role: 'data',
        signKey: newSignKey(),
        hostname: 'rack-alpha',
        webPort: 8080,
        serverOrder: 2,
        serverWhy: 'always.best_link',
        copyState: 'ready',
        copyAt: new Date(),
        copyName: 'copy_alpha_1',
        heldBackups: [backupId],
      })
      .returning();
    const [alphaNode] = await seed.db
      .insert(machines)
      .values({
        companyId: company!.id,
        personId: owner!.id,
        machineKey: ALPHA_KEY,
        hostname: 'rack-alpha',
        os: 'linux',
        arch: 'x86_64',
        lendsTests: false,
      })
      .returning();
    /* Unrelated computer with the exact same hostname must not be touched by the startup join. */
    const [sameNameOther] = await seed.db
      .insert(machines)
      .values({
        companyId: company!.id,
        personId: owner!.id,
        machineKey: GAMMA_KEY,
        hostname: 'rack-alpha',
        os: 'linux',
        arch: 'arm64',
      })
      .returning();

    const [sub] = await seed.db
      .insert(subscriptions)
      .values({ companyId: company!.id, provider: 'claude', kind: 'personal', label: 'Claude', ownerPersonId: owner!.id, status: 'ready' })
      .returning();
    const [node] = await seed.db
      .insert(nodes)
      .values({ companyId: company!.id, machineId: alphaNode!.id, subscriptionId: sub!.id, keyHash: hashToken('node-secret-alpha'), status: 'ready' })
      .returning();
    await seed.db.insert(nodeCodes).values({
      codeHash: hashToken('pending-add-code'),
      companyId: company!.id,
      personId: owner!.id,
      subscriptionIds: [sub!.id],
      machineId: alphaNode!.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await seed.db.insert(nodeConnections).values({
      companyId: company!.id,
      machineId: alphaNode!.id,
      nodeId: node!.id,
      connectedAt: new Date(Date.now() - 60_000),
    });
    const [seedJob] = await seed.db
      .insert(jobs)
      .values({ companyId: company!.id, subscriptionId: sub!.id, agentId: worker!.id, taskId: task!.id, status: 'running', startedAt: new Date(), prompt: 'run', timeoutMs: 60_000 })
      .returning();
    const [run] = await seed.db
      .insert(testRuns)
      .values({ companyId: company!.id, taskId: task!.id, agentId: worker!.id, jobId: seedJob!.id, number: 1, branch: 'release-check-1', commitSha: 'a'.repeat(40), command: 'npm test', status: 'running', parts: 1, timeoutMs: 60_000 })
      .returning();
    await seed.db.insert(testParts).values({
      runId: run!.id,
      companyId: company!.id,
      part: 1,
      status: 'running',
      machineId: alphaNode!.id,
      nodeId: node!.id,
      computer: `machine:${alphaNode!.id}`,
      startedAt: new Date(),
    });
    await seed.db.insert(certificates).values({ serial: 'aa11', machineId: alphaServer!.id, until: new Date(Date.now() + 86_400_000) });
    await seed.db.insert(machineOnline).values({ machineId: alphaServer!.id, day: '2026-11-24', seconds: 3600 });
    await seed.db.insert(computerRuns).values({ companyId: company!.id, machineId: alphaServer!.id, command: 'true', timeoutS: 30, state: 'done', exit: 0, output: '' });

    /* Pre-upgrade pair 2: current leader with a legacy 32-hex HORNHOOF_MACHINE_ID paired via 64-hex HORNHOOF_HOST_ID. */
    const [betaServer] = await seed.db
      .insert(machines)
      .values({
        companyId: company!.id,
        personId: owner!.id,
        machineKey: `server:${LEGACY_NET_ID}`,
        networkId: LEGACY_NET_ID,
        role: 'data',
        signKey: newSignKey(),
        hostname: 'rack-beta',
        webPort: 8080,
        serverOrder: 1,
        serverWhy: 'server',
      })
      .returning();
    const [betaNode] = await seed.db
      .insert(machines)
      .values({
        companyId: company!.id,
        personId: owner!.id,
        machineKey: BETA_KEY,
        hostname: 'rack-beta',
        os: 'linux',
        arch: 'x86_64',
      })
      .returning();
    await seed.db.execute(
      sql`INSERT INTO net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at) VALUES (gen_random_uuid(), ${alphaServer!.id}, 1, ${ALPHA_HOST_ID}, '0/100', ${betaServer!.id}, now())`,
    );
    await seed.app.close();

    /* Boot the upgraded server on rack-beta (32-hex machineId + 64-hex hostId). */
    const upgraded = await appOn(client, {
      TUNNEL_HOST: '127.0.0.1',
      HORNHOOF_MACHINE_ID: LEGACY_NET_ID,
      HORNHOOF_HOST_ID: BETA_HOST_ID,
    });
    await upgraded.app.ready();

    const remaining = await upgraded.db.select().from(machines).where(eq(machines.companyId, company!.id));
    expect(remaining.map(m => m.id).sort()).toEqual([alphaServer!.id, betaServer!.id, sameNameOther!.id].sort());

    const mergedAlpha = remaining.find(m => m.id === alphaServer!.id)!;
    expect(mergedAlpha).toMatchObject({
      id: alphaServer!.id,
      machineKey: ALPHA_KEY,
      networkId: ALPHA_HOST_ID,
      role: 'data',
      lendsTests: false,
      heldBackups: [backupId],
    });
    const mergedBeta = remaining.find(m => m.id === betaServer!.id)!;
    expect(mergedBeta).toMatchObject({
      id: betaServer!.id,
      machineKey: BETA_KEY,
      networkId: LEGACY_NET_ID,
      role: 'data',
    });
    expect(remaining.some(m => m.id === alphaNode!.id || m.id === betaNode!.id)).toBe(false);

    /* Every child record and handover still points at the surviving machine ids. */
    expect((await upgraded.db.select().from(nodes).where(eq(nodes.id, node!.id)))[0]!.machineId).toBe(alphaServer!.id);
    expect((await upgraded.db.select().from(nodeCodes))[0]!.machineId).toBe(alphaServer!.id);
    expect((await upgraded.db.select().from(nodeConnections))[0]!.machineId).toBe(alphaServer!.id);
    expect((await upgraded.db.select().from(testParts))[0]).toMatchObject({ machineId: alphaServer!.id, computer: `machine:${alphaServer!.id}` });
    expect((await upgraded.db.select().from(certificates))[0]!.machineId).toBe(alphaServer!.id);
    expect((await upgraded.db.select().from(machineOnline))[0]!.machineId).toBe(alphaServer!.id);
    expect((await upgraded.db.select().from(computerRuns))[0]!.machineId).toBe(alphaServer!.id);

    const listed = (await upgraded.app.inject({ url: '/api/machines', ...as(ceo) })).json() as {
      builtin: { machine: { id: string; hostname: string } | null };
      machines: { id: string; hostname: string; plans: { provider: string }[]; lendsTests: boolean }[];
    };
    expect(listed.builtin.machine).toEqual({ id: betaServer!.id, hostname: 'rack-beta' });
    expect(listed.machines.map(m => m.id).sort()).toEqual([alphaServer!.id, betaServer!.id, sameNameOther!.id].sort());
    expect(listed.machines.find(m => m.id === alphaServer!.id)).toMatchObject({
      hostname: 'rack-alpha',
      plans: [{ provider: 'claude' }],
      lendsTests: false,
    });
  });

  it('refuses to remove the unified machine while it leads, and removes both its node and replica roles after a move', async () => {
    const { client } = await timed('setupMs', openTestDb);
    onTestFinished(() => timed('teardownMs', () => client.close()));

    const first = await appOn(client, {
      TUNNEL_HOST: '127.0.0.1',
      HORNHOOF_MACHINE_ID: ALPHA_HOST_ID,
      HORNHOOF_HOST_ID: ALPHA_HOST_ID,
    });
    await first.app.ready();
    const ceo = await setUpCompany(first.app);
    const cert = await issueServerCertificate(first.app);
    const joined = await joinComputer(first.app, await planCommand(first.app, ceo, ['claude']), {
      machineId: ALPHA_KEY,
      hostname: 'rack-alpha',
    });
    expect(joined.machine.id).toBe(cert.machine);

    /* While rack-alpha leads, disconnecting it is refused with leader. */
    const refused = await first.app.inject({ method: 'POST', url: `/api/machines/${cert.machine}/disconnect`, ...as(ceo) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { reason: 'leader' } });

    /* Move leadership to rack-beta, then remove rack-alpha via the #1808 disconnect path. */
    const beta = await joinComputer(first.app, await machineCommand(first.app, ceo), {
      machineId: BETA_KEY,
      hostname: 'rack-beta',
    });
    await first.db
      .update(machines)
      .set({ networkId: BETA_HOST_ID, role: 'data', signKey: newSignKey(), serverOrder: 1, serverWhy: 'server' })
      .where(eq(machines.id, beta.machine.id));
    await first.db
      .update(machines)
      .set({ serverOrder: 2, serverWhy: 'always.best_link', copyState: 'ready', copyAt: new Date(), copyName: 'copy_alpha_1' })
      .where(eq(machines.id, cert.machine));
    await first.app.close();

    const second = await appOn(client, {
      TUNNEL_HOST: '127.0.0.1',
      HORNHOOF_MACHINE_ID: BETA_HOST_ID,
      HORNHOOF_HOST_ID: BETA_HOST_ID,
    });
    await second.app.ready();

    const removed = await second.app.inject({ method: 'POST', url: `/api/machines/${cert.machine}/disconnect`, ...as(ceo) });
    expect(removed.statusCode).toBe(204);

    const listed = (await second.app.inject({ url: '/api/machines', ...as(ceo) })).json() as { machines: { id: string; hostname: string }[] };
    expect(listed.machines.map(m => [m.id, m.hostname])).toEqual([[beta.machine.id, 'rack-beta']]);

    const [revokedMachine] = await second.db.select().from(machines).where(eq(machines.id, cert.machine));
    expect(revokedMachine!.revokedAt).not.toBeNull();
    expect(revokedMachine!.serverOrder).toBeNull();
    expect((await second.db.select().from(certificates).where(eq(certificates.machineId, cert.machine))).every(c => c.revokedAt !== null)).toBe(true);
    expect((await second.db.select().from(nodes).where(eq(nodes.machineId, cert.machine))).every(n => n.keyHash === null)).toBe(true);
    expect((await second.db.select().from(subscriptions))[1]!.status).toBe('waiting_machine');
  });

  it('never transfers ownership of the server-install row to a non-owner joining on the same computer', async () => {
    const { app, db } = await testApp({
      TUNNEL_HOST: '127.0.0.1',
      HORNHOOF_MACHINE_ID: ALPHA_HOST_ID,
      HORNHOOF_HOST_ID: ALPHA_HOST_ID,
    });
    const ceo = await setUpCompany(app);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const coworker = await invitePerson(app, ceo, { name: 'Alex', email: 'alex@acme.test', access: { whole: true } });
    const cert = await issueServerCertificate(app);

    const coworkerJoin = await joinComputer(app, await machineCommand(app, coworker), {
      machineId: ALPHA_KEY,
      hostname: 'rack-alpha',
    });
    expect(coworkerJoin.machine.id).not.toBe(cert.machine);
    const [serverRow] = await db.select().from(machines).where(eq(machines.id, cert.machine));
    expect(serverRow!.personId).toBe(owner!.id);
  });
});
