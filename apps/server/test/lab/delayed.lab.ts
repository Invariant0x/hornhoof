import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Lab, type LabMachine } from './lab.js';
import { http, installServer, joinWorker, ownerKey, PASSWORD, pause, quoted, sessionOf, setUp, sql, WEB_PORT, within, type Server } from './steps.js';
import { sqlIn, startWriterAt } from './writer.js';

type Place = { machine: LabMachine; folder: string; id: string; network: string; host: string; url: string };
type Word = { mode: string; at: string };

/* Two-machine Docker lab scenario with controllable network latency on both hornhoof.org's relay/probe and the stcp
   peer channel between nodes A and B (direct LAN port 8180 blocked with TCP RST so traffic crosses the delayed relay). */
describe('the lab, two machines over a delayed relay and peer path', () => {
  let lab: Lab;
  let m1: LabMachine;
  let m2: LabMachine;

  beforeAll(async () => {
    lab = await Lab.start({ machines: 2 });
    [m1, m2] = [lab.machine(1), lab.machine(2)];
  });

  afterAll(async () => {
    if (!process.env.HH_LAB_KEEP) await lab?.stop();
  });

  const inKeeper = (at: Place, cmd: string) => at.machine.exec(`cd ${at.folder} && docker compose exec -T keeper sh -c ${quoted(cmd)}`);
  const wordOf = async (at: Place): Promise<Word | null> => {
    const ran = await inKeeper(at, 'cat /control/keeper.json 2> /dev/null');
    try {
      return ran.code === 0 ? (JSON.parse(ran.out) as Word) : null;
    } catch {
      return null;
    }
  };
  const leads = (word: Word | null) => word?.mode === 'lead' && Date.now() - Date.parse(word.at) < 10_000;

  it('keeps the lease across first copy, restores sync after a 10 s cut, and merges a returned leader over the delayed peer relay', async () => {
    const relayGate = lab.network({ oneWayMs: 300 });
    const peerGate = lab.network({ oneWayMs: 600 });
    const relay = await lab.relay({ gate: relayGate });
    const link = `lab${randomBytes(4).toString('hex')}`;
    const places: Place[] = [];
    const edge = await lab.edge(relay.fake, link, places, { gate: relayGate });

    const server: Server = await installServer(m1, { relay: relay.url, probe: edge.url });
    await setUp(server);
    const key = await ownerKey(PASSWORD);
    const w2 = await joinWorker(server, m2, key, m1, { probe: edge.url });
    const taken = await http(m1, 'PUT', `${server.url}/api/link`, { body: { name: link } });
    expect(taken.status, taken.body).toBe(200);
    const cookie = await sessionOf(m1);

    const placeOf = async (machine: LabMachine, folder: string, url: string, where: string): Promise<Place> => ({
      machine,
      folder,
      url,
      ...(JSON.parse(await sql(m1, `SELECT json_build_object('id', id, 'network', network_id, 'host', hostname) FROM machines WHERE ${where}`)) as {
        id: string;
        network: string;
        host: string;
      }),
    });

    await within(2, 'the server has place 1', async () => (await sql(m1, 'SELECT count(*) FROM machines WHERE server_order = 1')) === '1');
    const p1 = await placeOf(m1, '/root/hornhoof', `http://localhost:${WEB_PORT}`, 'server_order = 1');
    const p2 = await placeOf(m2, w2.folder, `http://localhost:${w2.port}`, `id = '${w2.id}'`);
    places.push(p1, p2);
    lab.frps(relay.fake, link, places);
    await lab.peerRelay(link, places, { gate: peerGate, blockDirect: true });

    /* 1. Copy becomes ready over the delayed peer relay; m1 keeps its lease under the 1.2 s two-RTT probe. */
    await within(15, 'copy on m2 is ready over the relay path', async () => {
      const state = await sqlIn(p1.machine, p1.folder, `SELECT copy_state || ':' || coalesce(path, '') FROM machines WHERE id = '${p2.id}'`);
      return state === 'ready:relay';
    });
    const syncOf = () => (relay.fake.syncs.get(link)?.state === 'on' ? (relay.fake.syncs.get(link)?.copy ?? null) : null);
    await within(3, 'the relay names m2 as the synchronous copy', async () => syncOf() === p2.network);
    expect(leads(await wordOf(p1))).toBe(true);

    /* 2. Continuous writes + 10 s peer path cut: sync drops to off and returns to on once mended. */
    const writer = startWriterAt(async () => (leads(await wordOf(p1)) ? { machine: p1.machine, url: p1.url, headers: { cookie } } : leads(await wordOf(p2)) ? { machine: p2.machine, url: p2.url, headers: { cookie } } : null));
    try {
      peerGate.setCut(true);
      await pause(11_000);
      expect(relay.fake.syncs.get(link)?.state).toBe('off');
      peerGate.setCut(false);
      await within(2, 'the relay sync record returns to on after mending the delayed peer path', async () => syncOf() === p2.network);

      /* 3. Cut m1 so m2 takes over, then mend m1 and merge m1's led database over the 1.2 s RTT peer relay. */
      await lab.cut(m1);
      await within(1.5, 'm2 takes over as leader', async () => leads(await wordOf(p2)));
      await lab.mend(m1);
      await within(15, 'm1 led database merges on m2 without losing m2 lease', async () => {
        const status = await sqlIn(p2.machine, p2.folder, `SELECT status FROM net.merges WHERE source LIKE 'machine:${p1.id}:led-%' ORDER BY created_at DESC LIMIT 1`);
        return leads(await wordOf(p2)) && (status === 'merged' || status === 'done');
      });
    } finally {
      await writer.stop();
    }
  });
});
