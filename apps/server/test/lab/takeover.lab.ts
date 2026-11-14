import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Lab, type LabMachine } from './lab.js';
import { confirmedOf, lateConfirms } from './overlap.js';
import { http, installServer, invite, joinWorker, ok, ownerKey, PASSWORD, pause, quoted, sessionOf, setUp, signIn, sql, WEB_PORT, within, type Server } from './steps.js';
import { checkRows, sqlIn, startWriterAt } from './writer.js';

/* One scenario on three lab computers, with nothing standing in for a part of Hornhoof but hornhoof.org: the machine
   that leads is cut off, and the copy commits waited for takes the server over by itself; the machine that led comes
   back, follows, and what its database held is saved and merged; then the leader and the copy commits wait for stop
   together, the third machine asks the CEO, goes on at his word, and the two follow it when they start again. Someone
   works in the company all along, through whichever machine leads: at no moment do two machines lead, and every task
   the company confirmed is on all three at the end. */
type Place = { machine: LabMachine; folder: string; id: string; network: string; host: string; url: string };
type Word = { mode: string; at: string };
type Machines = { machines: { id: string; hostname: string; data?: { number: number | null; copy: { line: string } | null; led: { until: string } | null } | null }[] };
type Asked = { question: { copies: { networkId: string; reach: string | null }[] } | null; canAnswer: boolean };

describe('the lab, a takeover', () => {
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
  /* What a machine's keeper says to its app; null when it is not there or cannot be read. */
  const wordOf = async (at: Place): Promise<Word | null> => {
    const ran = await inKeeper(at, 'cat /control/keeper.json 2> /dev/null');
    try {
      return ran.code === 0 ? (JSON.parse(ran.out) as Word) : null;
    } catch {
      return null;
    }
  };
  /* A word that is not written any more is what a keeper that ended left behind: it counts for ten seconds. */
  const leads = (word: Word | null) => word?.mode === 'lead' && Date.now() - Date.parse(word.at) < 10_000;
  /* Everything that runs on a machine stops at once, as when its power goes; what ran, to start it again. */
  const halt = async (at: Place): Promise<string[]> => {
    const running = ok(await at.machine.exec('docker ps -q'), 'listing what runs').split('\n').filter(Boolean);
    ok(await at.machine.exec(`docker stop -t 1 ${running.join(' ')}`), `stopping ${at.host}`);
    return running;
  };
  const wake = async (at: Place, ran: string[]) => ok(await at.machine.exec(`docker start ${ran.join(' ')}`), `starting ${at.host}`);

  it('takes the server over from a leader that is cut off, merges it when it is back, and goes on at the CEO\'s word when the leader and its copy stop together', async () => {
    const space = [await m1.exec('df -h /'), await m1.exec('docker system df')];
    log(`the disk before:\n${space.map(ran => ran.out.trim()).join('\n')}`);

    /* 1. A server with the lab's relay and its stand-in for hornhoof.org's answer to the probe, set up; one machine
       of the owner's and one of a person who sees the whole company join it; the company takes its link, and the lab
       plays frps for its name from here to the end. Both machines get a place and a copy. */
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
    /* The owner's session, shown at whichever machine's own address the company answers at. */
    const cookie = await sessionOf(m1);
    const api = (at: Place, method: string, path: string, body?: unknown) => http(at.machine, method, `${at.url}${path}`, { body, headers: { cookie }, maxTime: 20 });

    const placeOf = async (machine: LabMachine, folder: string, url: string, where: string): Promise<Place> => ({
      machine, folder, url, ...(JSON.parse(await sql(m1, `SELECT json_build_object('id', id, 'network', network_id, 'host', hostname) FROM machines WHERE ${where}`)) as { id: string; network: string; host: string }),
    });
    /* A machine's row as the database of that place has it. */
    const rowOf = async (at: Place, id: string) =>
      JSON.parse(await sqlIn(at.machine, at.folder, `SELECT json_build_object('order', server_order, 'role', role, 'copy', copy_state, 'name', copy_name) FROM machines WHERE id = '${id}'`)) as {
        order: number | null; role: string | null; copy: string | null; name: string | null;
      };
    const machinesAt = async (at: Place): Promise<Machines> => (await api(at, 'GET', '/api/machines')).json<Machines>();
    const cardOf = async (at: Place, id: string) => (await machinesAt(at)).machines.find(machine => machine.id === id)?.data ?? null;

    /* The server takes place 1 at its first ranking, a moment after the others joined. */
    await within(2, 'the server has place 1', async () => (await sql(m1, 'SELECT count(*) FROM machines WHERE server_order = 1')) === '1');
    const p1 = await placeOf(m1, '/root/hornhoof', `http://localhost:${WEB_PORT}`, 'server_order = 1');
    places.push(p1);
    lab.frps(relay.fake, link, places);
    await within(2, "the server's link client holds the company's name", async () => relay.fake.routes.get(link)?.state === 'held');
    await within(5, 'both machines have a place and hold the data', async () => {
      const [a, b] = [await rowOf(p1, w2.id), await rowOf(p1, w3.id)];
      return [a.order, b.order].sort().join() === '2,3' && a.role === 'data' && b.role === 'data';
    });
    const [p2, p3] = [await placeOf(m2, w2.folder, `http://localhost:${w2.port}`, `id = '${w2.id}'`), await placeOf(m3, w3.folder, `http://localhost:${w3.port}`, `id = '${w3.id}'`)];
    places.push(p2, p3);
    await within(15, 'both copies are ready', async () => {
      const [a, b] = [await rowOf(p1, p2.id), await rowOf(p1, p3.id)];
      log(`   copies: ${a.copy}, ${b.copy}`);
      return a.copy === 'ready' && b.copy === 'ready';
    });
    /* Which of the two is number 2 is the ranking's to say: that one is the copy commits wait for, the first here. */
    const [first, other] = (await rowOf(p1, p2.id)).order === 2 ? [p2, p3] : [p3, p2];
    const syncOf = () => (relay.fake.syncs.get(link)?.state === 'on' ? (relay.fake.syncs.get(link)?.copy ?? null) : null);
    await within(3, 'the relay knows the copy commits wait for', async () => syncOf() === first.network);
    log(`1. the server has its link, two machines keep a copy, and commits wait for ${first.host}`);

    /* 2. Someone works in the company from here to the end, through whichever machine leads. Once a second the test
       looks at what each machine's keeper says to its app: which one leads, whether two do, and the lines the old
       leader's card went through as the leader of the moment shows it. */
    const seen = { leader: p1 as Place | null, both: [] as string[], lines: new Set<string>(), going: true };
    const watching = (async () => {
      while (seen.going) {
        const words = await Promise.all(places.map(at => wordOf(at).catch(() => null)));
        const leading = places.filter((_, i) => leads(words[i] ?? null));
        if (leading.length > 1) seen.both.push(`${new Date().toISOString()} ${leading.map(at => at.host).join(' and ')}`);
        seen.leader = leading.length === 1 ? leading[0]! : null;
        if (seen.leader && seen.leader !== p1) {
          const line = await cardOf(seen.leader, p1.id).then(card => card?.copy?.line, () => undefined);
          if (line) seen.lines.add(line);
        }
        await pause(1000);
      }
    })();
    const writer = startWriterAt(async () => (seen.leader ? { machine: seen.leader.machine, url: seen.leader.url, headers: { cookie } } : null));
    const answeredBy = (at: Place, since = 0) => writer.written().filter(one => one.machine === at.machine.name && one.at > since).length;
    await within(1, 'tasks are being written', async () => answeredBy(p1) > 0);

    /* 3. Number 1 cut off: the copy commits waited for takes the server over by itself, and the machine that led
       confirms nothing more. */
    await lab.cut(m1);
    const t0 = Date.now();
    await within(1.25, `${first.host} leads`, async () => leads(await wordOf(first)));
    log(`   ${first.host} took the server over ${Math.round((Date.now() - t0) / 1000)} s after the cut`);
    await within(2, `${first.host} is number 1, by a takeover from ${p1.host}`, async () => {
      const kind = await sqlIn(first.machine, first.folder, `SELECT kind FROM net.handovers WHERE from_machine_id = '${p1.id}' AND to_machine_id = '${first.id}' ORDER BY at DESC LIMIT 1`);
      return kind === 'takeover' && (await cardOf(first, first.id))?.number === 1;
    });
    await within(2, `a task is confirmed by ${first.host}`, async () => answeredBy(first, t0) > 0);
    for (let tries = 0; tries < 3; tries++) {
      const refused = await api(p1, 'POST', '/api/tasks', { title: 'Written on the machine that was cut off' });
      expect(refused.status >= 200 && refused.status < 300, `${refused.status} ${refused.body}`).toBe(false);
    }
    await within(5, "the other machine's copy follows the new leader", async () => (await rowOf(first, other.id)).copy === 'ready');
    log('3. the leader was cut off, its copy took the server over, and the machine that led confirms nothing');

    /* 4. Coming back: the machine that led follows, its database is saved and merged, and its copy is made again. */
    await lab.mend(m1);
    await within(2, `${p1.host} follows ${first.host}`, async () => {
      const keeper = await http(m1, 'GET', `${p1.url}/api/keeper`, { maxTime: 10 }).then(answer => answer.json<{ leader: { machine: string } | null }>(), () => null);
      return (await wordOf(p1))?.mode === 'read' && keeper?.leader?.machine === first.id;
    });
    const merged = async (leader: Place, from: Place) => {
      const status = await sqlIn(leader.machine, leader.folder, `SELECT status FROM net.merges WHERE source LIKE 'machine:${from.id}:led-%' ORDER BY created_at DESC LIMIT 1`);
      const card = await cardOf(leader, from.id);
      log(`   ${from.host}: copy ${card?.copy?.line ?? 'none'}; merge of what it led: ${status || 'none'}`);
      return card?.copy?.line === 'ready' && !!card.led && (status === 'merged' || status === 'done');
    };
    await within(15, `what ${p1.host} led is merged, and its copy is ready again`, () => merged(first, p1));
    /* That it saved what it led shows in the backup the leader recorded of it: the card says so for a moment only,
       which a look once a second may miss. */
    log(`   the lines of its card: ${[...seen.lines].join(', ')}`);
    expect(Number(await sqlIn(first.machine, first.folder, `SELECT count(*) FROM net.backups WHERE reason = 'fork' AND signer = '${p1.id}'`))).toBeGreaterThan(0);
    expect((await cardOf(first, first.id))?.number).toBe(1);
    log('4. the machine that led is back, follows, and what it led is saved and merged');

    /* 5. The leader and the copy commits wait for stop together: the third machine may lack changes, so it asks the
       CEO, who signs in on that machine while it only reads, and goes on from it. */
    await within(5, 'both copies are up to date, and the relay knows the one commits wait for', async () => {
      const [a, b] = [await rowOf(first, p1.id), await rowOf(first, other.id)];
      return a.copy === 'ready' && b.copy === 'ready' && [p1.network, other.network].includes(syncOf() ?? '');
    });
    const [x, y] = syncOf() === p1.network ? [p1, other] : [other, p1];
    const stopped = await Promise.all([halt(first), halt(x)]);
    const t1 = Date.now();
    /* The machine takes a sign-in itself once it knows the leader is gone, a few seconds after it stopped. */
    await within(2, `the CEO signs in on ${y.host}, which only reads`, async () => (await signIn(y.machine, y.url, PASSWORD)) === 200);
    const asked = await within(1.5, `${y.host} asks the CEO, naming itself alone`, async () => {
      const said = (await http(y.machine, 'GET', `${y.url}/api/network/question`, { maxTime: 10 })).json<Asked>();
      const copies = said.question?.copies ?? [];
      return said.canAnswer && copies.length === 1 && copies[0]!.networkId === y.network ? copies[0]! : null;
    });
    expect(leads(await wordOf(y))).toBe(false);
    const went = await http(y.machine, 'POST', `${y.url}/api/network/question/go-on`, { body: { networkId: y.network, reach: asked.reach }, maxTime: 10 });
    expect(went.status, went.body).toBe(202);
    await within(1.25, `${y.host} leads at the CEO's word`, async () => leads(await wordOf(y)));
    await within(2, `${y.host}'s handover is the CEO's, and tasks are confirmed by it`, async () => {
      const kind = await sqlIn(y.machine, y.folder, `SELECT kind FROM net.handovers WHERE to_machine_id = '${y.id}' ORDER BY at DESC LIMIT 1`);
      return kind === 'ceo' && answeredBy(y, t1) > 0;
    });
    log(`5. the leader and its copy stopped together, and ${y.host} went on at the CEO's word`);

    /* 6. The two start again: both follow, what the old leader led is saved and merged, and both copies are made
       again from the machine that leads now. */
    await Promise.all([wake(first, stopped[0]), wake(x, stopped[1])]);
    await within(15, `${first.host} and ${x.host} follow ${y.host} with copies that are ready`, async () => {
      const words = [await wordOf(first), await wordOf(x)];
      return words.every(word => word?.mode === 'read') && (await merged(y, first)) && (await cardOf(y, x.id))?.copy?.line === 'ready';
    });
    await within(5, 'no database that came back waits to be merged', async () => (await sqlIn(y.machine, y.folder, `SELECT count(*) FROM net.merges WHERE source LIKE 'machine:%' AND status NOT IN ('merged', 'done')`)) === '0');
    /* Asked of the database: the machine the company was installed on is no computer of the Machines tab while it leads. */
    expect((await rowOf(y, y.id)).order).toBe(1);
    log('6. both machines that stopped follow the new leader, and what they held is merged');

    /* 7. Nobody works any more. Once both copies hold everything the leader wrote, every task the company confirmed is
       on all three machines, those the stopped copy held past the new leader's reach too, which the merges brought
       back; and no machine confirmed a task once a later leader had. */
    const written = await writer.stop();
    seen.going = false;
    await watching;
    const w = await sqlIn(y.machine, y.folder, 'SELECT pg_current_wal_lsn()');
    await within(2, 'both copies hold everything the leader wrote', async () => {
      const slots = await sqlIn(y.machine, y.folder, `SELECT count(*) FILTER (WHERE confirmed_flush_lsn >= '${w}'::pg_lsn) || '/' || count(*) FROM pg_replication_slots WHERE slot_name LIKE 'copy\\_%'`);
      log(`   slots at the leader's last position: ${slots}`);
      return slots === '2/2';
    });
    const ids = written.map(one => one.id);
    /* A copy that is made again reads its old database until the new one is whole and takes its place, a moment after
       the leader counts it as up to date: the three are asked until each holds every task. */
    await within(5, 'all three machines hold every task that was confirmed', async () => {
      const missing = await Promise.all(places.map(at => checkRows(at.machine, at.folder, ids)));
      log(`   of ${ids.length} tasks, missing: ${places.map((at, i) => `${at.host} ${missing[i]!.length}`).join(', ')}`);
      return missing.every(list => list.length === 0);
    });
    const confirmed = await confirmedOf(y.machine, y.folder, written);
    expect(confirmed.length).toBe(written.length);
    expect(lateConfirms(confirmed)).toEqual([]);
    /* By the writer's own clock too: the machines that answered, in the order they did, are the three leaders in
       their order, each once. */
    const order = written.map(one => one.machine).filter((name, i, all) => name !== all[i - 1]);
    expect(order).toEqual([p1, first, y].map(at => at.machine.name));
    expect(seen.both).toEqual([]);
    log(`7. all ${ids.length} tasks that were confirmed are on the three machines, and one machine led at a time`);
  });
});
