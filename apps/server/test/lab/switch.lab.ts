import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Lab, type LabMachine } from './lab.js';
import { http, installServer, invite, joinWorker, ok, ownerKey, PASSWORD, pause, quoted, setUp, sql, within, type Server } from './steps.js';
import { checkRows, sqlIn, startWriter } from './writer.js';

/* One scenario on three lab computers, with nothing standing in for a part of Hornhoof but hornhoof.org: the CEO moves
   the server to another machine and back while someone works in the company, once more with the taking keeper started
   again in the middle, and once when hornhoof.org never gives the new machine the company's name, so the server
   stays. At no moment do two machines lead, the third machine's copy follows whichever leads without being made
   again, and every task the server confirmed is on all three at the end. */
type Place = { machine: LabMachine; folder: string; id: string; network: string; host: string };
type Word = { mode: string; at: string };
type Machines = {
  machines: { id: string; hostname: string; data?: { number: number | null; copy: { line: string } | null } | null }[];
  copies?: { leader: string; copies: { hostname: string; sync: boolean }[] } | null;
  move?: { machine: string; state: string; reason: string | null } | null;
};
type Pool = { builtin: { online: boolean; machine: { id: string; name: string } | null } | null; builtins: { machine: string; online: boolean }[] };

describe('the lab, a planned switch', () => {
  let lab: Lab;
  let m1: LabMachine;
  let m2: LabMachine;
  let m3: LabMachine;

  beforeAll(async () => {
    lab = await Lab.start({ machines: 3 });
    [m1, m2, m3] = [lab.machine(1), lab.machine(2), lab.machine(3)];
  });

  /* HH_LAB_KEEP=1 leaves the machines for a person to look at; the label printed at the start finds them. */
  afterAll(async () => {
    if (!process.env.HH_LAB_KEEP) await lab?.stop();
  });

  const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
  const inKeeper = (at: Place, cmd: string) => at.machine.exec(`cd ${at.folder} && docker compose exec -T keeper sh -c ${quoted(cmd)}`);
  /* A file of JSON in a machine's keeper container; null when it is not there or cannot be read. */
  const fileOf = async <T>(at: Place, path: string): Promise<T | null> => {
    const ran = await inKeeper(at, `cat ${path} 2> /dev/null`);
    try {
      return ran.code === 0 ? (JSON.parse(ran.out) as T) : null;
    } catch {
      return null;
    }
  };
  const wordOf = (at: Place) => fileOf<Word>(at, '/control/keeper.json');
  const phaseOf = async (at: Place, file: 'handing.json' | 'taking.json') => (await fileOf<{ phase?: string }>(at, `/keeper/${file}`))?.phase ?? null;
  const clientOf = async (at: Place) => /clientID = "([^"]+)"/.exec((await inKeeper(at, 'cat /tmp/frpc.toml 2> /dev/null')).out)?.[1] ?? null;
  /* The attempt a copy's name ends with. */
  const attemptOf = (name: string | null) => Number(/_(\d+)$/.exec(name ?? '')?.[1] ?? 0);

  it('moves the server to another machine and back, through a restart in the middle and an abort, and loses nothing', async () => {
    const space = [await m1.exec('df -h /'), await m1.exec('docker system df')];
    log(`the disk before:\n${space.map(ran => ran.out.trim()).join('\n')}`);

    /* 1. A server with the lab's relay and its stand-in for hornhoof.org's answer to the probe, set up; one machine
       of the owner's and one of a person who sees the whole company join it; the company takes its link, which the
       test registers as frps would. */
    const relay = await lab.relay();
    const link = `lab${randomBytes(4).toString('hex')}`;
    const places: Place[] = [];
    const edge = await lab.edge(relay.fake, link, places);
    const server: Server = await installServer(m1, { relay: relay.url, probe: edge.url });
    await setUp(server);
    await sql(m1, `WITH plan AS (INSERT INTO subscriptions (company_id, provider, kind, label, owner_person_id, status) SELECT c.id, 'claude', 'personal', 'Lab plan', p.id, 'needs_login' FROM companies c, people p WHERE p.is_owner RETURNING id)
      UPDATE agents SET subscription_id = (SELECT id FROM plan) WHERE kind = 'orchestrator'`);
    const key = await ownerKey(PASSWORD);
    const w2 = await joinWorker(server, m2, key, m1, { probe: edge.url });
    await invite(server, m3, { name: 'Pat', email: 'pat@lab.hornhoof.test', access: { whole: true } });
    const w3 = await joinWorker(server, m3, await ownerKey(PASSWORD), m3, { probe: edge.url });
    const taken = await http(m1, 'PUT', `${server.url}/api/link`, { body: { name: link } });
    expect(taken.status, taken.body).toBe(200);

    /* Whichever machine leads answers at m1's address too: its front door passes on to the leader. */
    const machines = async (): Promise<Machines> => (await http(m1, 'GET', `${server.url}/api/machines`)).json<Machines>();
    const pool = async (): Promise<Pool> => (await http(m1, 'GET', `${server.url}/api/pool`)).json<Pool>();
    const rowOf = async (leader: Place, id: string) =>
      JSON.parse(await sqlIn(leader.machine, leader.folder, `SELECT json_build_object('order', server_order, 'role', role, 'copy', copy_state, 'name', copy_name) FROM machines WHERE id = '${id}'`)) as {
        order: number | null; role: string | null; copy: string | null; name: string | null;
      };
    /* The server takes place 1 at its first ranking, a moment after the others joined. */
    /* The machine the server's own node runs on, as the pool names it: a computer someone joined by its row, and the
       machine the company was installed on by none, since that row is no computer people see. */
    const onServer = (said: Pool, at: Place): boolean => (at === p1 ? said.builtin?.machine === null : said.builtin?.machine?.id === at.id);
    const first = JSON.parse(await within(2, 'the server has place 1', () => sql(m1, `SELECT json_build_object('id', id, 'network', network_id, 'host', hostname) FROM machines WHERE server_order = 1`))) as { id: string; network: string; host: string };
    const p1: Place = { machine: m1, folder: '/root/hornhoof', ...first };
    const placeOf = async (machine: LabMachine, folder: string, id: string): Promise<Place> => ({
      machine, folder, id, ...(JSON.parse(await sql(m1, `SELECT json_build_object('network', network_id, 'host', hostname) FROM machines WHERE id = '${id}'`)) as { network: string; host: string }),
    });
    const register = async (at: Place) => {
      const client = await within(2, `${at.host}'s link client has its settings`, () => clientOf(at));
      const said = relay.fake.register(link, client);
      expect(said.ok, JSON.stringify(said)).toBe(true);
    };
    places.push(p1);
    await register(p1);
    await within(5, 'both machines have a place and hold the data', async () => {
      const [a, b] = [await rowOf(p1, w2.id), await rowOf(p1, w3.id)];
      return [a.order, b.order].sort().join() === '2,3' && a.role === 'data' && b.role === 'data';
    });
    /* Which of the two is number 2 is the ranking's to say, by what each machine measures: the scenario moves the
       server to that one, and the other is the third machine, whose copy follows whichever leads. */
    const [wa, wb, ma, mb] = (await rowOf(p1, w2.id)).order === 2 ? [w2, w3, m2, m3] : [w3, w2, m3, m2];
    const [p2, p3] = [await placeOf(ma, wa.folder, wa.id), await placeOf(mb, wb.folder, wb.id)];
    places.push(p2, p3);
    await within(15, 'both copies are ready', async () => {
      const [a, b] = [await rowOf(p1, p2.id), await rowOf(p1, p3.id)];
      log(`   copies: ${a.copy}, ${b.copy}`);
      return a.copy === 'ready' && b.copy === 'ready';
    });
    await within(3, 'the relay knows the copy commits wait for', async () => relay.fake.syncs.get(link)?.state === 'on' && relay.fake.syncs.get(link)?.copy === p2.network);
    await within(3, "both machines' built-in nodes are online", async () => {
      const said = await pool();
      return said.builtin?.online === true && onServer(said, p1) && said.builtins.some(node => node.machine === p2.network && node.online);
    });
    log('1. the server has its link, two machines keep a copy, and their built-in nodes are online');

    /* 2. Someone works in the company from here to the end, at m1's address. Once a second the test looks at what
       each machine's keeper says to its app, and at how the third machine's copy does. */
    const writer = startWriter(m1, server.url);
    await within(1, 'tasks are being written', async () => writer.ids().length > 0);
    const seen = { both: [] as string[], third: new Set<string>(), going: true };
    const watching = (async () => {
      while (seen.going) {
        const words = await Promise.all([p1, p2].map(at => wordOf(at).catch(() => null)));
        /* A word that is not written any more is what a keeper that ended left behind: it counts for ten seconds. */
        const newest = Math.max(...words.map(word => (word ? Date.parse(word.at) : 0)));
        const leading = words.filter(word => word?.mode === 'lead' && newest - Date.parse(word.at) < 10_000);
        if (leading.length > 1) seen.both.push(new Date().toISOString());
        /* While the server changes hands the answer may be none of the Machines tab's. */
        const line = await machines().then(said => said.machines?.find(machine => machine.id === p3.id)?.data?.copy?.line, () => undefined);
        if (line) seen.third.add(line);
        await pause(1000);
      }
    })();

    /* The test plays frps for the company's name in every move: the old leader's link client has stopped once its
       keeper wrote go, and the new one's is let in once its keeper did. restart: the taking keeper is started again
       before the name is given. */
    const frps = async (from: Place, to: Place, opts: { restart?: boolean; give?: boolean } = {}) => {
      let looks = 0;
      await within(2, `${from.host} wrote that the server goes`, async () => {
        const phase = await phaseOf(from, 'handing.json');
        /* What the move waits for, said every ten seconds: the copy commits wait for, as the leader and the relay name it. */
        if (phase !== 'go' && looks++ % 5 === 0) {
          const word = await fileOf<{ mode: string; copies?: { networkId: string; state: string }[] }>(from, '/control/keeper.json');
          const [route, sync] = [relay.fake.routes.get(link), relay.fake.syncs.get(link)];
          log(`   waiting: handing ${phase ?? 'none'}; ${from.host} ${word?.mode}; copies ${(word?.copies ?? []).map(copy => `${copy.networkId.slice(0, 8)}:${copy.state}`).join(' ')}; route ${route?.state} gen ${route?.generation} ${route?.client?.slice(-22)}; record ${sync?.state} ${sync?.copy?.slice(0, 8)} gen ${sync?.generation} epoch ${sync?.epoch}; target ${to.network.slice(0, 8)}`);
        }
        return phase === 'go';
      });
      relay.fake.drop(link);
      if (opts.give === false) return;
      await within(2, `${to.host} wrote that it takes the server`, async () => ['go', 'promoted'].includes((await phaseOf(to, 'taking.json')) ?? ''));
      if (opts.restart) ok(await to.machine.exec(`cd ${to.folder} && docker compose restart keeper`), 'starting the taking keeper again');
      await register(to);
    };
    const move = async (to: Place) => {
      const asked = await http(m1, 'POST', `${server.url}/api/machines/${to.id}/move`);
      expect(asked.status, asked.body).toBe(202);
    };
    /* What holds once the server moved from one machine to the other. */
    const moved = async (from: Place, to: Place, handovers: number) => {
      const third = { before: attemptOf((await rowOf(to, p3.id).catch(() => null))?.name ?? null) };
      await within(2, `${to.host} leads and ${from.host} follows it`, async () => {
        const [leads, follows] = [await wordOf(to), await wordOf(from)];
        const keeper = await http(from.machine, 'GET', `http://localhost:${from === p1 ? 8080 : from === p2 ? wa.port : wb.port}/api/keeper`).then(answer => answer.json<{ leader: { machine: string } | null }>(), () => null);
        return leads?.mode === 'lead' && follows?.mode === 'read' && keeper?.leader?.machine === to.id;
      });
      /* Which place the machine that led takes after the leader is the ranking's to say, by what each machine measures. */
      await within(5, `the Machines tab has ${to.host} first and ${from.host} after it with its copy ready`, async () => {
        const said = await machines().catch(() => null);
        const [leader, follower] = [said?.machines?.find(machine => machine.id === to.id), said?.machines?.find(machine => machine.id === from.id)];
        /* The machine the company was installed on is no computer of the list while the server runs on it. */
        const first = to === p1 ? leader === undefined : leader?.data?.number === 1;
        return said?.copies?.leader === to.host && first && (follower?.data?.number ?? 0) > 1 && follower?.data?.copy?.line === 'ready' && !said.move;
      });
      expect(await sqlIn(to.machine, to.folder, `SELECT count(*) FROM net.handovers WHERE from_machine_id = '${from.id}' AND to_machine_id = '${to.id}'`)).toBe(String(handovers));
      expect(await sqlIn(from.machine, from.folder, `SELECT handed_to FROM net_local.state WHERE handed_to IS NOT NULL ORDER BY handed_at DESC LIMIT 1`)).toBe(to.network);
      /* The third machine's copy joined the new leader with what it held: one attempt up, and never made again. */
      await within(5, "the third machine's copy follows the new leader", async () => {
        const row = await rowOf(to, p3.id);
        return row.copy === 'ready' && attemptOf(row.name) > third.before;
      });
      expect(attemptOf((await rowOf(to, p3.id)).name)).toBe(third.before + 1);
      await within(3, "the new leader's built-in node is the server's, and the old one's is online beside it", async () => {
        const said = await pool().catch(() => null);
        return said?.builtin?.online === true && onServer(said, to) && said.builtins.some(node => node.machine === from.network && node.online);
      });
    };
    const third = async (leader: Place) => attemptOf((await rowOf(leader, p3.id)).name);

    /* 3. The CEO moves the server to the second machine. */
    await move(p2);
    await frps(p1, p2);
    await moved(p1, p2, 1);
    log('3. the server moved to the second machine');

    /* 4. And back to the machine the company was installed on. */
    await move(p1);
    await frps(p2, p1);
    await moved(p2, p1, 1);
    log('4. the server moved back');

    /* 5. To the second machine again, whose keeper is started again after it took the go and before hornhoof.org gave
       it the company's name. */
    await move(p2);
    await frps(p1, p2, { restart: true });
    await moved(p1, p2, 2);
    log('5. the server moved again, through a restart of the keeper that took it');

    /* 6. Back to the first machine, but hornhoof.org never gives it the company's name: the second machine takes the
       server back, and the request says why it failed. */
    const before = await third(p2);
    await move(p1);
    await frps(p2, p1, { give: false });
    /* What it wrote down of the switch says so until it leads again, and is gone after that. */
    await within(3, `${p2.host} gave the handing up`, async () => ['aborted', null].includes(await phaseOf(p2, 'handing.json')));
    /* From here the lab answers for the company's name as hornhoof.org does by itself: the client that runs gets the
       name while it is free, and the name goes free again when that client stops. */
    lab.frps(relay.fake, link, places);
    await within(3, `${p2.host} leads again, and ${p1.host} follows it`, async () => {
      const [leads, follows] = [await wordOf(p2), await wordOf(p1)];
      return leads?.mode === 'lead' && follows?.mode === 'read';
    });
    await within(5, 'the request failed for want of the name, and the first machine holds an up-to-date copy', async () => {
      const said = await machines().catch(() => null);
      return said?.move?.state === 'failed' && said.move.reason === 'no_link' && said.machines.find(machine => machine.id === p1.id)?.data?.copy?.line === 'ready';
    });
    expect(relay.fake.routes.get(link)?.client).toBe(await clientOf(p2));
    expect(await third(p2)).toBe(before);
    log('6. a move that got no name from hornhoof.org left the server where it was');

    /* 7. Nobody works any more. Once both copies hold everything the leader wrote, every task the server confirmed is
       on all three machines, and at no look did two machines lead or was the third machine's copy made again. */
    const ids = await writer.stop();
    seen.going = false;
    await watching;
    const w = await sqlIn(p2.machine, p2.folder, 'SELECT pg_current_wal_lsn()');
    await within(2, 'both copies hold everything the leader wrote', async () => {
      const slots = await sqlIn(p2.machine, p2.folder, `SELECT count(*) FILTER (WHERE confirmed_flush_lsn >= '${w}'::pg_lsn) || '/' || count(*) FROM pg_replication_slots WHERE slot_name LIKE 'copy\\_%'`);
      log(`   slots at the leader's last position: ${slots}`);
      return slots === '2/2';
    });
    for (const at of [p1, p2, p3]) expect(await checkRows(at.machine, at.folder, ids), at.host).toEqual([]);
    expect(seen.both).toEqual([]);
    expect([...seen.third].filter(line => line === 'making' || line === 'remaking')).toEqual([]);
    log(`7. all ${ids.length} tasks that were confirmed are on the three machines, and one machine led at a time`);
  });
});
