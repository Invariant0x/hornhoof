/* Two companies on the same two computers, from the install to a switch of leader: five runs of the installer and four
   databases in one scenario, as its second half routes over the networks the first half installed. It runs with the slow
   tests, apart from every change's run. */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sql as raw } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config.js';
import { encryptSecret } from '../../src/crypto/secrets.js';
import { companies, machines, peerSecrets, people, publicLinks } from '../../src/db/schema.js';
import { only } from '../../src/db/selections.js';
import { REPLICA_FILE } from '../../src/modules/keeper/become.js';
import { COPY_STATE } from '../../src/modules/keeper/copy.js';
import { Hander, readHanding } from '../../src/modules/keeper/handing.js';
import { handoverOf, recordHandover, termOf, writeTerm } from '../../src/modules/keeper/promote.js';
import { SWITCH_MS, type TakeState } from '../../src/modules/keeper/switch-step.js';
import { Promoter, readTaking, Taker, type OwnSubscription } from '../../src/modules/keeper/taking.js';
import { linkClientId } from '../../src/modules/link/client.js';
import { PublicLinks } from '../../src/modules/link/link.js';
import { peerClientId, peerConfigFor, serviceName } from '../../src/modules/link/peer-client.js';
import type { Bound, SyncRecord } from '../../src/modules/link/relay.js';
import { visitClientId, visitConfigFor } from '../../src/modules/link/visit-client.js';
import { createTestSql, ownDatabases, TEST_SECRET } from '../helpers.js';
import { SUB_A } from '../install-script-helpers.js';
import { cidrsOverlap, envMap, ipInCidr, LAN_ADDR_A, LAN_ADDR_B, LAN_ROUTE_A, LAN_ROUTE_B, makeComputer, tempDir } from '../multi-company-computers.js';

/* Multi-company leader/copy/switch tests write net_local terms directly, so each test gets isolated databases. */
ownDatabases();

const SILENT_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => SILENT_LOG,
} as unknown as FastifyBaseLogger;

describe('Two companies on the same two computers lead, copy, and switch leader without interfering', () => {
  it('isolates subnets, ports, folders, Compose projects, hornhoof.org names, and peer client ids across lead, copy, and switch', async () => {
    /* Physical Machine A (192.168.1.10/24) and Machine B (192.168.1.20/24). Both companies share the exact same two
       physical machines and even see the same physical machine id on each host if derived from host identity. */
    const SHARED_HOST_A_ID = 'a0'.repeat(16);
    const SHARED_HOST_B_ID = 'b0'.repeat(16);

    const machineA = makeComputer(LAN_ADDR_A, LAN_ROUTE_A);
    const machineB = makeComputer(LAN_ADDR_B, LAN_ROUTE_B);

    /* Install Company 1 (alpha), Company 2 (beta), and a 3rd project (gamma) on Machine A. */
    expect(machineA.runServer(['--name', 'alpha']).code).toBe(0);
    expect(machineA.runServer(['--name', 'beta']).code).toBe(0);
    expect(machineA.runServer(['--name', 'gamma']).code).toBe(0);

    const alphaA = machineA.dotEnv('hornhoof-alpha');
    const betaA = machineA.dotEnv('hornhoof-beta');
    const gammaA = machineA.dotEnv('hornhoof-gamma');

    /* Join Machine B to Company 1 (alpha) and Company 2 (beta) as data-keeping copies, including a second OS user home
       on Machine B where a sibling hornhoof-alpha project already exists on the same Docker engine. */
    const user2Home = join(machineB.root, 'home-bob');
    mkdirSync(user2Home, { recursive: true });

    const alphaJoinBody = [
      `core hornhoof-alpha ${'A'.repeat(43)} ${alphaA.HORNHOOF_PORT} ${randomUUID()}`,
      `${SUB_A} claude node-key-alpha00000000000`,
    ].join('\n');
    expect(machineB.runJoin(['--server', `http://192.168.1.10:${alphaA.HORNHOOF_PORT}`], { STUB_JOIN_BODY: `${alphaJoinBody}\n` }).code).toBe(0);
    const alphaBDir = machineB.folder('hornhoof-alpha');
    const alphaB = machineB.dotEnv('hornhoof-alpha');

    /* Suppose Company 2 also suggests hornhoof-alpha (or its own hornhoof-beta) on Machine B while user 1's hornhoof-alpha
       keeper is running in Docker: installing under user2Home must never collide on Compose project name or subnet! */
    const betaJoinBody = [
      `core hornhoof-alpha ${'B'.repeat(43)} ${betaA.HORNHOOF_PORT} ${randomUUID()}`,
      `${SUB_A} claude node-key-beta000000000000`,
    ].join('\n');
    const betaJoinRes = machineB.runJoin(['--server', `http://192.168.1.10:${betaA.HORNHOOF_PORT}`], {
      HOME: user2Home,
      HORNHOOF_HOME: join(user2Home, '.hornhoof'),
      HORNHOOF_DIR: join(user2Home, 'hornhoof'),
      STUB_CORES: `${alphaB.COMPOSE_PROJECT_NAME}:${alphaBDir}:${alphaB.HORNHOOF_PORT}`,
      STUB_JOIN_BODY: `${betaJoinBody}\n`,
    });
    expect(betaJoinRes.code).toBe(0);
    const betaBDir = machineB.folder('hornhoof-alpha-2', user2Home);
    const betaB = envMap(readFileSync(join(betaBDir, '.env'), 'utf8'));

    /* 1. Working folders, Compose project names, ports, and Docker subnets are strictly isolated on both computers. */
    expect(new Set([machineA.folder('hornhoof-alpha'), machineA.folder('hornhoof-beta'), machineA.folder('hornhoof-gamma')]).size).toBe(3);
    expect(new Set([alphaBDir, betaBDir]).size).toBe(2);
    expect(new Set([alphaA.COMPOSE_PROJECT_NAME, betaA.COMPOSE_PROJECT_NAME, gammaA.COMPOSE_PROJECT_NAME]).size).toBe(3);
    expect(new Set([alphaB.COMPOSE_PROJECT_NAME, betaB.COMPOSE_PROJECT_NAME]).size).toBe(2);
    expect(betaB.COMPOSE_PROJECT_NAME).toBe('hornhoof-alpha-2');

    expect(new Set([alphaA.HORNHOOF_PORT, alphaA.HORNHOOF_PEER_PORT, betaA.HORNHOOF_PORT, betaA.HORNHOOF_PEER_PORT, gammaA.HORNHOOF_PORT, gammaA.HORNHOOF_PEER_PORT]).size).toBe(6);
    expect(new Set([alphaB.HORNHOOF_PORT, alphaB.HORNHOOF_PEER_PORT, betaB.HORNHOOF_PORT, betaB.HORNHOOF_PEER_PORT]).size).toBe(4);

    for (const machine of [machineA, machineB]) {
      const nets = machine.networks();
      expect(nets.length).toBeGreaterThanOrEqual(4);
      for (let i = 0; i < nets.length; i++) {
        expect(cidrsOverlap(nets[i]!.subnet, '192.168.1.0/24')).toBe(false);
        for (let j = i + 1; j < nets.length; j++) {
          expect(cidrsOverlap(nets[i]!.subnet, nets[j]!.subnet)).toBe(false);
        }
      }
    }

    /* Simulated container routing check: a container on Machine B or Machine A reaches the peer host IP directly on LAN
       only if NONE of the host's Docker networks shadows that peer IP. */
    const canRouteOnLan = (fromMachine: ReturnType<typeof makeComputer>, targetHostIp: string): boolean =>
      fromMachine.networks().every(net => !ipInCidr(targetHostIp, net.subnet));
    expect(canRouteOnLan(machineB, '192.168.1.10')).toBe(true);
    expect(canRouteOnLan(machineA, '192.168.1.20')).toBe(true);

    /* 2. Shared in-memory hornhoof.org relay: link names and frpc client/service IDs never collide across companies,
       even when both companies run on hosts with the exact same machineId! */
    const relayTaken = new Map<string, { key: string; holder: string | null; generation: number; sync: SyncRecord }>();
    let hiddenSeq = 0;
    function attachSharedRelay(links: PublicLinks) {
      vi.spyOn(links.relay, 'bind').mockImplementation(async (requested?: string): Promise<Bound> => {
        const name = requested ?? `auto-company-${++hiddenSeq}`;
        if (relayTaken.has(name)) throw new Error(`Relay name ${name} is already taken`);
        const key = randomBytes(24).toString('base64url');
        relayTaken.set(name, { key, holder: null, generation: 0, sync: { state: 'off', copy: null, epoch: 0, generation: 0, at: null } });
        return {
          name,
          url: `https://${name}.hornhoof.org`,
          key,
          tunnel: { serverAddr: 'relay.hornhoof.org', serverPort: 443, protocol: 'wss' },
        };
      });
      vi.spyOn(links.relay, 'unbind').mockImplementation(async (name: string, key: string) => {
        const entry = relayTaken.get(name);
        if (entry?.key === key) relayTaken.delete(name);
      });
    }

    /* Spin up full CompanyRuntime (Machine A leader + Machine B copy + Hander/Taker/Promoter) for both companies. */
    async function createCompanyRuntime(label: string, desiredLinkName?: string) {
      const secret = Buffer.from(TEST_SECRET, 'base64');
      const [dirA, controlA, dirB, controlB] = [
        tempDir(`hh-${label}-a-dir-`),
        tempDir(`hh-${label}-a-ctl-`),
        tempDir(`hh-${label}-b-dir-`),
        tempDir(`hh-${label}-b-ctl-`),
      ];
      const dbA = await createTestSql();
      const dbB = await createTestSql();
      /* Initial term 1 on Machine A; Machine B starts as a synced ready copy following Machine A. */
      await dbA.sql.query(
        'UPDATE net_local.state SET term_number = 1, term_machine = $1, machine = $1, term_split = false, handed_to = NULL, handed_lsn = NULL, handed_at = NULL',
        [SHARED_HOST_A_ID],
      );
      await dbA.sql.query('UPDATE net_local.lease SET term_number = 1, term_machine = $1, term_split = false', [SHARED_HOST_A_ID]);
      await dbB.sql.query(
        "SET session_replication_role = replica; DELETE FROM net_local.lease; DELETE FROM net_local.state; SET session_replication_role = origin; SET hornhoof.fenced = 'off'",
      );

      const [comp] = await dbA.db.insert(companies).values({ name: `Company ${label}` }).returning();
      const [owner] = await dbA.db
        .insert(people)
        .values({ companyId: comp!.id, name: `Owner ${label}`, email: `owner@${label}.test`, status: 'active', scopeKind: 'company', isOwner: true })
        .returning();

      const slotOnAForB = `copy_${SHARED_HOST_B_ID.slice(0, 16)}_2`;
      const slotOnBForA = `copy_${SHARED_HOST_A_ID.slice(0, 16)}_1`;

      const [rowA] = await dbA.db
        .insert(machines)
        .values({ companyId: comp!.id, personId: owner!.id, machineKey: `key-${label}-a`, hostname: 'machine-a', role: 'data', networkId: SHARED_HOST_A_ID, serverOrder: 1 })
        .returning();
      const [rowB] = await dbA.db
        .insert(machines)
        .values({
          companyId: comp!.id,
          personId: owner!.id,
          machineKey: `key-${label}-b`,
          hostname: 'machine-b',
          role: 'data',
          networkId: SHARED_HOST_B_ID,
          serverOrder: 2,
          copyName: slotOnAForB,
          copyState: 'ready',
        })
        .returning();

      /* Replicate the leader's rows onto Machine B's copy database, as logical replication applies them on B. */
      await dbB.sql.query('SET session_replication_role = replica');
      await dbB.db.insert(companies).values(comp!);
      await dbB.db.insert(people).values(owner!);
      await dbB.db.insert(machines).values([rowA!, rowB!]);
      await dbB.sql.query('SET session_replication_role = origin');

      const configA = { secret, controlDir: controlA, relayUrl: 'https://hornhoof.org', publicUrl: `http://localhost:8080`, machineId: SHARED_HOST_A_ID } as unknown as Config;
      const links = new PublicLinks({ db: dbA.db, config: configA, log: SILENT_LOG });
      attachSharedRelay(links);
      if (desiredLinkName) {
        await links.set(comp!.id, desiredLinkName);
      } else {
        expect(await links.ensureHidden(comp!.id)).toBe(true);
      }
      const [linkRow] = await dbA.db.select().from(publicLinks);
      const linkName = linkRow!.name;

      await dbA.db.insert(peerSecrets).values([
        { kind: 'app', secretEnc: encryptSecret(`${label}-app-secret`, secret) },
        { kind: 'data', secretEnc: encryptSecret(`${label}-data-secret`, secret) },
        { kind: 'visit', secretEnc: encryptSecret(JSON.stringify({ name: linkName, key: `${label}-visitor-key-0123456789` }), secret) },
      ]);

      const relayEntry = relayTaken.get(linkName)!;
      relayEntry.holder = linkClientId(linkName, SHARED_HOST_A_ID);
      relayEntry.generation = 1;
      relayEntry.sync = { state: 'on', copy: SHARED_HOST_B_ID, epoch: 1, generation: 1, at: 1_000 };

      let now = 1_000_000;
      const stateA = { leads: true, fenced: false, tunnelRunning: true, frontOpen: true, exited: 0 };
      const stateB = { subEnabled: true, subApplying: true, copyReady: true, takerExited: 0, promoterLeads: false, appLeads: false };
      const peerLog: string[] = [];

      const subB: OwnSubscription = {
        enabled: async () => stateB.subEnabled,
        applying: async () => stateB.subEnabled && stateB.subApplying,
        disable: async () => {
          stateB.subEnabled = false;
        },
        enable: async () => {
          stateB.subEnabled = true;
        },
      };

      let promoterB: Promoter | null = null;
      const takerB = new Taker({
        dir: dirB,
        sql: dbB.sql,
        leader: () => (stateA.fenced ? null : { networkId: SHARED_HOST_A_ID, hostname: 'machine-a' }),
        copyReady: () => stateB.copyReady,
        subscription: subB,
        exit: () => {
          stateB.takerExited += 1;
        },
        now: () => now,
        log: () => {},
      });

      const handerA = new Hander({
        dir: dirA,
        controlDir: controlA,
        sql: dbA.sql,
        secret,
        lease: {
          fence: async () => {
            stateA.fenced = true;
            stateA.leads = false;
          },
        },
        term: () => (stateA.leads ? { number: 1, machine: SHARED_HOST_A_ID, split: false } : null),
        sync: {
          named: () => SHARED_HOST_B_ID,
          record: () => relayEntry.sync,
          generation: () => relayEntry.generation,
          copies: () => [{ name: slotOnAForB, networkId: SHARED_HOST_B_ID, state: 'sync' as const }],
        },
        peer: networkId => ({
          request: async (method, path, body) => {
            if (!canRouteOnLan(machineA, '192.168.1.20') || !canRouteOnLan(machineB, '192.168.1.10')) {
              throw new Error(`LAN peer route shadowed by overlapping Docker subnet for ${label}`);
            }
            peerLog.push(`${label}:${networkId}:${method}:${path.split('?')[0]}`);
            if (path.startsWith('/peer/switch/state') && promoterB?.leads()) {
              const sw = path.split('=')[1] ?? '';
              const promotedState: TakeState = {
                state: 'leading',
                switch: sw,
                term: { number: 2, machine: SHARED_HOST_B_ID, split: false },
                slots: { [SHARED_HOST_A_ID]: slotOnBForA },
              };
              return { status: 200, body: promotedState };
            }
            const res = await takerB.handle(SHARED_HOST_A_ID, method, path, body);
            res.after?.();
            return { status: res.status, body: res.body };
          },
        }),
        front: {
          close: async () => {
            stateA.frontOpen = false;
          },
          open: () => {
            stateA.frontOpen = true;
          },
        },
        tunnel: {
          start: () => {
            stateA.tunnelRunning = true;
          },
          stop: async () => {
            stateA.tunnelRunning = false;
            if (relayEntry.holder === linkClientId(linkName, SHARED_HOST_A_ID)) relayEntry.holder = null;
          },
        },
        leads: () => stateA.leads,
        updating: () => false,
        machine: { networkId: SHARED_HOST_A_ID },
        exit: () => {
          stateA.exited += 1;
        },
        wal: {
          position: async () => '0/4000000',
          slots: async () => [{ name: slotOnAForB, read: true, atW: true }],
        },
        now: () => now,
        log: () => {},
      });

      async function requestMoveToB(): Promise<string> {
        await dbA.db.execute(raw`DELETE FROM net.move`);
        await dbA.db.execute(raw`INSERT INTO net.move (machine_id, from_machine_id, asked_by, asked_at, state) VALUES (${rowB!.id}, ${rowA!.id}, ${owner!.id}, clock_timestamp(), 'preparing')`);
        const rows = (await dbA.db.execute(raw`SELECT request::text, state FROM net.move`) as unknown as { rows: { request: string; state: string }[] }).rows;
        const req = rows[0]!.request;
        if (stateB.subEnabled) {
          await dbB.sql.query('SET session_replication_role = replica');
          await dbB.sql.query('DELETE FROM net.move');
          await dbB.sql.query(
            `INSERT INTO net.move (request, machine_id, from_machine_id, asked_by, asked_at, state) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, clock_timestamp(), 'switching')`,
            [req, rowB!.id, rowA!.id, owner!.id],
          );
          await dbB.sql.query('SET session_replication_role = origin');
        }
        return req;
      }

      async function switchLeaderFromAToB(): Promise<string> {
        const req = await requestMoveToB();
        /* Hander on A offers switch to Taker on B, fences A, sends go, and stops A's link tunnel. */
        for (let i = 0; i < 6 && stateB.takerExited === 0; i++) {
          now += 250;
          await handerA.look();
        }
        expect(readTaking(dirB)?.phase).toBe('go');
        expect(stateB.subEnabled).toBe(false);

        /* Taker exited so B restarts as Promoter, takes the company's own link name at the relay, probes its nonce, and promotes to term 2. */
        writeFileSync(join(controlB, REPLICA_FILE), '{}');
        writeFileSync(join(dirB, COPY_STATE), '{}');
        promoterB = new Promoter({
          dir: dirB,
          controlDir: controlB,
          sql: dbB.sql,
          machine: { networkId: SHARED_HOST_B_ID },
          registered: async () => relayEntry.holder === linkClientId(linkName, SHARED_HOST_B_ID),
          name: async () => null,
          probe: async nonce => ({ machine: SHARED_HOST_B_ID, nonce }),
          tunnel: {
            start: () => {
              relayEntry.holder = linkClientId(linkName, SHARED_HOST_B_ID);
              relayEntry.generation += 1;
            },
            stop: async () => {},
          },
          subscription: subB,
          appLeads: () => stateB.appLeads,
          exit: () => {},
          promote: async t => {
            const slots = { [SHARED_HOST_A_ID]: slotOnBForA };
            await writeTerm(dbB.sql, { above: t.term.number, machine: SHARED_HOST_B_ID });
            await recordHandover(dbB.sql, {
              id: t.switch,
              from: rowA!.id,
              term: t.term,
              applied: t.w ?? '0/4000000',
              to: rowB!.id,
              at: new Date(now),
              slots,
            });
            stateB.promoterLeads = true;
            return slots;
          },
          now: () => now,
          log: () => {},
        });

        for (let i = 0; i < 10 && !promoterB.leads(); i++) {
          now += 250;
          await promoterB.look();
        }
        expect(promoterB.leads()).toBe(true);
        stateB.appLeads = true;
        now += 250;
        await promoterB.look();

        /* Hander on A observes B's leading state, writes A's replica.json to follow B under term 2, and finishes the move. */
        for (let i = 0; i < 6 && stateA.exited === 0; i++) {
          now += 250;
          await handerA.look();
        }
        return req;
      }

      const copiedNamesOnB = async () => (await dbB.db.select(only(companies, 'name')).from(companies)).map(r => r.name);
      const pendingMovesOnB = async () => (await dbB.sql.query('SELECT 1 FROM net.move')).rows;

      return {
        label,
        comp: comp!,
        rowAId: rowA!.id,
        slotOnBForA,
        links,
        linkName,
        dirA,
        controlA,
        dirB,
        controlB,
        dbA,
        dbB,
        stateA,
        stateB,
        peerLog,
        relayEntry,
        switchLeaderFromAToB,
        copiedNamesOnB,
        pendingMovesOnB,
        handoverOnB: (id: string) => handoverOf(dbB.sql, id),
        termOnA: () => termOf(dbA.sql),
        termOnB: () => termOf(dbB.sql),
      };
    }

    const company1 = await createCompanyRuntime('alpha', 'alpha-co');
    const company2 = await createCompanyRuntime('beta');

    /* Company 2 cannot steal Company 1's hornhoof.org name, and its auto-assigned hidden name is distinct. */
    await expect(company2.links.set(company2.comp.id, 'alpha-co')).rejects.toThrow(/taken/);
    expect(company1.linkName).toBe('alpha-co');
    expect(company2.linkName).toBe('auto-company-1');
    expect(company1.linkName).not.toBe(company2.linkName);

    /* Every frpc client ID and STCP service name on Machine A and Machine B is disjoint between the two companies,
       even though Machine A has SHARED_HOST_A_ID in both companies and Machine B has SHARED_HOST_B_ID in both! */
    const idsCompany1 = [
      linkClientId(company1.linkName, SHARED_HOST_A_ID),
      linkClientId(company1.linkName, SHARED_HOST_B_ID),
      peerClientId(company1.linkName, SHARED_HOST_A_ID),
      peerClientId(company1.linkName, SHARED_HOST_B_ID),
      visitClientId(company1.linkName, SHARED_HOST_A_ID),
      visitClientId(company1.linkName, SHARED_HOST_B_ID),
      serviceName(company1.linkName, SHARED_HOST_A_ID, 'data'),
      serviceName(company1.linkName, SHARED_HOST_A_ID, 'app'),
      serviceName(company1.linkName, SHARED_HOST_B_ID, 'data'),
      serviceName(company1.linkName, SHARED_HOST_B_ID, 'app'),
    ];
    const idsCompany2 = [
      linkClientId(company2.linkName, SHARED_HOST_A_ID),
      linkClientId(company2.linkName, SHARED_HOST_B_ID),
      peerClientId(company2.linkName, SHARED_HOST_A_ID),
      peerClientId(company2.linkName, SHARED_HOST_B_ID),
      visitClientId(company2.linkName, SHARED_HOST_A_ID),
      visitClientId(company2.linkName, SHARED_HOST_B_ID),
      serviceName(company2.linkName, SHARED_HOST_A_ID, 'data'),
      serviceName(company2.linkName, SHARED_HOST_A_ID, 'app'),
      serviceName(company2.linkName, SHARED_HOST_B_ID, 'data'),
      serviceName(company2.linkName, SHARED_HOST_B_ID, 'app'),
    ];
    for (const id of idsCompany1) expect(idsCompany2).not.toContain(id);

    const peerToml1 = peerConfigFor(
      {
        settings: { url: `https://${company1.linkName}.hornhoof.org`, name: company1.linkName, key: 'k'.repeat(20), tunnel: { serverAddr: 'relay.hornhoof.org', serverPort: 443, protocol: 'wss' }, mode: 'http', hidden: false },
        secrets: { data: 'd1', app: 'a1' },
      },
      { machineId: SHARED_HOST_A_ID, local: { data: 7081, app: 7080 } },
    );
    const peerToml2 = peerConfigFor(
      {
        settings: { url: `https://${company2.linkName}.hornhoof.org`, name: company2.linkName, key: 'm'.repeat(20), tunnel: { serverAddr: 'relay.hornhoof.org', serverPort: 443, protocol: 'wss' }, mode: 'http', hidden: true },
        secrets: { data: 'd2', app: 'a2' },
      },
      { machineId: SHARED_HOST_A_ID, local: { data: 7081, app: 7080 } },
    );
    expect(peerToml1).toContain(`clientID = "${peerClientId(company1.linkName, SHARED_HOST_A_ID)}"`);
    expect(peerToml2).toContain(`clientID = "${peerClientId(company2.linkName, SHARED_HOST_A_ID)}"`);
    expect(peerToml1).not.toContain(company2.linkName);

    const visitToml1 = visitConfigFor(
      { name: company1.linkName, serverAddr: 'relay.hornhoof.org', serverPort: 443, visitorKey: 'v1'.repeat(10), appSecret: 'a1', dataSecret: 'd1' },
      { machineId: SHARED_HOST_B_ID, targets: [SHARED_HOST_A_ID], kind: 'data' },
    );
    const visitToml2 = visitConfigFor(
      { name: company2.linkName, serverAddr: 'relay.hornhoof.org', serverPort: 443, visitorKey: 'v2'.repeat(10), appSecret: 'a2', dataSecret: 'd2' },
      { machineId: SHARED_HOST_B_ID, targets: [SHARED_HOST_A_ID], kind: 'data' },
    );
    expect(visitToml1).toContain(`clientID = "${visitClientId(company1.linkName, SHARED_HOST_B_ID)}"`);
    expect(visitToml2).toContain(`clientID = "${visitClientId(company2.linkName, SHARED_HOST_B_ID)}"`);
    expect(visitToml1).not.toContain(company2.linkName);

    /* Both companies initially lead on Machine A (term 1) and replicate only their own company data to Machine B. */
    expect(await company1.termOnA()).toMatchObject({ number: 1, machine: SHARED_HOST_A_ID, split: false });
    expect(await company2.termOnA()).toMatchObject({ number: 1, machine: SHARED_HOST_A_ID, split: false });
    expect(await company1.termOnB()).toBeNull();
    expect(await company2.termOnB()).toBeNull();
    expect(await company1.copiedNamesOnB()).toEqual(['Company alpha']);
    expect(await company2.copiedNamesOnB()).toEqual(['Company beta']);

    /* 3. Switch Company 1's leader from Machine A to Machine B. Company 2 must stay completely untouched on Machine A! */
    const switch1Id = await company1.switchLeaderFromAToB();

    expect(await company1.termOnB()).toMatchObject({ number: 2, machine: SHARED_HOST_B_ID, split: false });
    expect(await company1.pendingMovesOnB()).toEqual([]);
    expect(await company1.handoverOnB(switch1Id)).toEqual({
      from: company1.rowAId,
      term: { number: 1, machine: SHARED_HOST_A_ID, split: false },
      slots: { [SHARED_HOST_A_ID]: company1.slotOnBForA },
    });
    expect(readHanding(company1.dirA)).toBeNull();
    expect(company1.stateA.exited).toBe(1);
    expect(existsSync(join(company1.controlA, REPLICA_FILE))).toBe(true);
    expect(company1.relayEntry.holder).toBe(linkClientId(company1.linkName, SHARED_HOST_B_ID));

    /* Verify Company 2 experienced ZERO side effects while Company 1 switched on the same two machines. */
    expect(company2.stateA.leads).toBe(true);
    expect(company2.stateA.fenced).toBe(false);
    expect(company2.stateA.tunnelRunning).toBe(true);
    expect(company2.stateB.subEnabled).toBe(true);
    expect(company2.stateB.takerExited).toBe(0);
    expect(await company2.termOnA()).toMatchObject({ number: 1, machine: SHARED_HOST_A_ID, split: false });
    expect(await company2.termOnB()).toBeNull();
    expect(await company2.copiedNamesOnB()).toEqual(['Company beta']);
    expect(existsSync(join(company2.controlA, REPLICA_FILE))).toBe(false);
    expect(company2.relayEntry.holder).toBe(linkClientId(company2.linkName, SHARED_HOST_A_ID));
    expect(company2.peerLog).toEqual([]);

    /* 4. Now switch Company 2's leader from Machine A to Machine B. Company 1 on Machine B stays untouched! */
    const c1PeerCallsBefore = [...company1.peerLog];
    const c1RelayGenBefore = company1.relayEntry.generation;

    const switch2Id = await company2.switchLeaderFromAToB();

    expect(await company2.termOnB()).toMatchObject({ number: 2, machine: SHARED_HOST_B_ID, split: false });
    expect(await company2.pendingMovesOnB()).toEqual([]);
    expect(await company2.handoverOnB(switch2Id)).toEqual({
      from: company2.rowAId,
      term: { number: 1, machine: SHARED_HOST_A_ID, split: false },
      slots: { [SHARED_HOST_A_ID]: company2.slotOnBForA },
    });
    expect(readHanding(company2.dirA)).toBeNull();
    expect(company2.stateA.exited).toBe(1);
    expect(existsSync(join(company2.controlA, REPLICA_FILE))).toBe(true);
    expect(company2.relayEntry.holder).toBe(linkClientId(company2.linkName, SHARED_HOST_B_ID));

    /* Company 1 remains untouched on Machine B under term 2. */
    expect(await company1.termOnB()).toMatchObject({ number: 2, machine: SHARED_HOST_B_ID, split: false });
    expect(await company1.copiedNamesOnB()).toEqual(['Company alpha']);
    expect(company1.relayEntry.holder).toBe(linkClientId(company1.linkName, SHARED_HOST_B_ID));
    expect(company1.relayEntry.generation).toBe(c1RelayGenBefore);
    expect(company1.peerLog).toEqual(c1PeerCallsBefore);
    expect(basename(alphaBDir)).not.toBe(basename(betaBDir));
    void SWITCH_MS;
  }, 90_000);
});
