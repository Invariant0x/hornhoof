import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeRelay } from '../fake-relay.js';
import { Lab, type LabMachine } from './lab.js';
import { bundleAfter, http, inside, installServer, invite, joinWorker, ok, ownerKey, PASSWORD, restored, setUp, signIn, sql, within, type Server, type Worker } from './steps.js';
import { checkRows, sqlIn, startWriter } from './writer.js';

/* One scenario on three lab computers, with nothing standing in for a part of Hornhoof but the relay: two machines
   take a copy of the company's data and follow the server while someone works in it; a copy sleeps and wakes; the
   CEO puts a machine at a place by hand, keeps it from the server, which takes its copy away, and lets it back; the
   owner of one loses the whole-company scope, and its machine gives up what it holds and is wiped; and the company is
   restored from a backup, after which the copy that is left is made again. Every task the server confirmed is on
   every machine that holds the data at the end. */
type Row = { order: number | null; why: string | null; role: string | null; copy: string | null; upload: string | null; left: string | null; name: string | null; network: string | null };
type Held = { machines: { id: string; hostname: string; data?: { copy: { line: string } | null } | null }[]; copies?: { leader: string; copies: { hostname: string; sync: boolean }[]; onlySince: string | null } | null };

describe('the lab, copies', () => {
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
  const rowOf = async (id: string): Promise<Row> =>
    JSON.parse(
      await sql(m1, `SELECT json_build_object('order', server_order, 'why', server_why, 'role', role, 'copy', copy_state, 'upload', upload_state, 'left', data_left_at, 'name', copy_name, 'network', network_id) FROM machines WHERE id = '${id}'`),
    ) as Row;
  const envOf = async (w: Worker): Promise<Record<string, string>> =>
    Object.fromEntries(ok(await w.machine.exec(`cat ${w.folder}/.env`), 'the settings').split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const servicesOf = async (w: Worker): Promise<string[]> => ok(await w.machine.exec(`cd ${w.folder} && docker compose ps --services`), 'the services').split('\n').filter(Boolean).sort();
  const record = (relay: FakeRelay, link: string) => relay.syncs.get(link) ?? null;
  const machinesOf = async (server: Server): Promise<Held> => (await http(m1, 'GET', `${server.url}/api/machines`)).json<Held>();

  it('gives two machines a copy, lets one sleep, takes the data from one whose owner lost the scope, and remakes a copy after a restore', async () => {
    /* 1. A server with the lab's relay, set up; one machine of the owner's and one of a person who sees the whole
       company join it, and then the company takes its link, which the test registers as frps would. */
    const relay = await lab.relay();
    const link = `lab${randomBytes(4).toString('hex')}`;
    /* The lab answers for hornhoof.org from here to the end: who holds the company's name, and who answers at it. */
    const keepers: { machine: LabMachine; folder: string }[] = [];
    const edge = await lab.edge(relay.fake, link, keepers);
    const server = await installServer(m1, { relay: relay.url, probe: edge.url });
    keepers.push({ machine: m1, folder: '/root/hornhoof' });
    await setUp(server);
    await sql(m1, `WITH plan AS (INSERT INTO subscriptions (company_id, provider, kind, label, owner_person_id, status) SELECT c.id, 'claude', 'personal', 'Lab plan', p.id, 'needs_login' FROM companies c, people p WHERE p.is_owner RETURNING id)
      UPDATE agents SET subscription_id = (SELECT id FROM plan) WHERE kind = 'orchestrator'`);
    const reached = await inside(m1, 'keeper', `node -e "fetch('${relay.url}/api/v1/health').then(r => r.text()).then(t => console.log(t))"`);
    expect(reached.out, reached.out).toContain('"ok":true');
    const key = await ownerKey(PASSWORD);
    const w2 = await joinWorker(server, m2, key, m1, { probe: edge.url });
    const person = await invite(server, m3, { name: 'Pat', email: 'pat@lab.hornhoof.test', access: { whole: true } });
    const w3 = await joinWorker(server, m3, await ownerKey(PASSWORD), m3, { probe: edge.url });
    keepers.push({ machine: m2, folder: w2.folder }, { machine: m3, folder: w3.folder });
    const taken = await http(m1, 'PUT', `${server.url}/api/link`, { body: { name: link } });
    expect(taken.status, taken.body).toBe(200);
    lab.frps(relay.fake, link, keepers);
    await within(2, "the server's link client holds the company's name", async () => relay.fake.routes.get(link)?.state === 'held');
    log('1. the server has its link, and two machines joined');

    /* 2. Both get a place and a copy, with the company's secrets and a database of their own, and the relay is told
       which one commits wait for. */
    await within(5, 'both machines have a place and hold the data', async () => {
      const [a, b] = [await rowOf(w2.id), await rowOf(w3.id)];
      return [a.order, b.order].sort().join() === '2,3' && a.role === 'data' && b.role === 'data';
    });
    /* Which of the two is number 2 is the ranking's to say, by what each machine measures: the scenario calls that one
       the first copy and the other the second. */
    const [wf, wo, mf] = (await rowOf(w2.id)).order === 2 ? [w2, w3, m2] : [w3, w2, m3];
    await within(15, 'both copies are ready', async () => {
      const [a, b] = [await rowOf(w2.id), await rowOf(w3.id)];
      log(`   copies: ${a.copy}, ${b.copy}`);
      return a.copy === 'ready' && b.copy === 'ready';
    });
    for (const w of [w2, w3]) {
      const env = await envOf(w);
      expect(env.HORNHOOF_SECRET).toBe(server.secret);
      expect([Boolean(env.NODE_KEY), Boolean(env.RELAY_URL), env.COMPOSE_PROFILES, env.HORNHOOF_ROLE]).toEqual([true, true, 'data,builtin', 'data']);
      const services = await servicesOf(w);
      /* With its own built-in node, which runs the work of the company's keys. */
      expect(services).toEqual(expect.arrayContaining(['app', 'db', 'node']));
    }
    const [id2, id3] = [(await rowOf(w2.id)).network!, (await rowOf(w3.id)).network!];
    const [idF, idO] = wf === w2 ? [id2, id3] : [id3, id2];
    await within(3, "the relay knows the copy commits wait for", async () => record(relay.fake, link)?.state === 'on' && record(relay.fake, link)?.copy === idF);
    const [host2, host3] = [await sql(m1, `SELECT hostname FROM machines WHERE id = '${w2.id}'`), await sql(m1, `SELECT hostname FROM machines WHERE id = '${w3.id}'`)];
    const [hostF, hostO] = wf === w2 ? [host2, host3] : [host3, host2];
    await within(2, 'the Machines tab says who holds the company', async () => {
      const copies = (await machinesOf(server)).copies;
      return copies?.copies.length === 2 && copies.copies.find(copy => copy.hostname === hostF)?.sync === true && copies.copies.find(copy => copy.hostname === hostO)?.sync === false && copies.onlySince === null;
    });
    log('2. both machines keep a copy, and commits wait for the first');

    /* 3. Someone works in the company from here to the end. The first copy's database stops answering: the company
       goes on, and the copy is said to sleep; it wakes, and commits wait for it again. */
    const writer = startWriter(m1, server.url);
    await within(1, 'tasks are being written', async () => writer.ids().length > 0);
    ok(await mf.exec(`cd ${wf.folder} && docker compose pause db`), 'pausing the database of the first copy');
    const paused = writer.ids().length;
    await within(1, 'a task is created while the first copy sleeps', async () => writer.ids().length > paused);
    await within(2, 'commits wait for the other copy, or for none', async () => {
      const said = record(relay.fake, link);
      return said?.state === 'off' || (said?.state === 'on' && said.copy === idO);
    });
    await within(4, 'the first copy is said to sleep', async () => (await machinesOf(server)).machines.find(machine => machine.id === wf.id)?.data?.copy?.line === 'asleep');
    ok(await mf.exec(`cd ${wf.folder} && docker compose unpause db`), 'waking the database of the first copy');
    await within(5, 'commits wait for the first copy again', async () => record(relay.fake, link)?.state === 'on' && record(relay.fake, link)?.copy === idF);
    const sofar = writer.ids();
    await within(5, 'both copies hold every task confirmed so far', async () => (await checkRows(m2, w2.folder, sofar)).length === 0 && (await checkRows(m3, w3.folder, sofar)).length === 0);
    log(`3. a copy slept and woke, and both hold the ${sofar.length} tasks written so far`);

    /* 3a. The CEO puts the second copy's machine at 2: it stands there by hand at once, and commits come to wait for
       it. Left to Hornhoof again, the two hold 2 and 3, and commits wait for whichever is 2. */
    const pin = (id: string, place: number | 'none' | null) => http(m1, 'PUT', `${server.url}/api/machines/${id}/priority`, { body: { pin: place } });
    const bothReady = async () => {
      const [a, b] = [await rowOf(w2.id), await rowOf(w3.id)];
      return a.role === 'data' && b.role === 'data' && a.copy === 'ready' && b.copy === 'ready' && (await machinesOf(server)).machines.filter(machine => machine.data?.copy?.line === 'ready').length === 2;
    };
    const byHand = await pin(wo.id, 2);
    expect(byHand.status, byHand.body).toBe(204);
    const [second, third] = [await rowOf(wo.id), await rowOf(wf.id)];
    expect([second.order, second.why, third.order, third.why]).toEqual([2, 'pinned', 3, 'new']);
    await within(1, 'commits wait for the machine the CEO put at 2', async () => record(relay.fake, link)?.state === 'on' && record(relay.fake, link)?.copy === idO);
    expect((await pin(wo.id, null)).status).toBe(204);
    const places = [await rowOf(w2.id), await rowOf(w3.id)];
    expect(places.map(row => row.order).sort()).toEqual([2, 3]);
    const atTwo = places[0]!.order === 2 ? id2 : id3;
    await within(1, 'commits wait for whichever machine is 2', async () => record(relay.fake, link)?.state === 'on' && record(relay.fake, link)?.copy === atTwo);
    log('3a. a place set by hand moved the copy commits wait for, and back');

    /* 3b. The CEO keeps the second machine from the server: it has no place, gives the server what it holds and is
       wiped, as a worker whose owner still sees the whole company, so no key of the company changes. */
    await within(5, 'both copies are up to date', bothReady);
    const keyKept = relay.fake.bindings.get(link)?.key;
    const keptOut = await pin(w3.id, 'none');
    expect(keptOut.status, keptOut.body).toBe(204);
    expect((await rowOf(w3.id)).order).toBeNull();
    await within(10, 'the machine kept out gave what it held and is wiped', async () => {
      const merge = await sql(m1, `SELECT status FROM net.merges WHERE source LIKE 'upload:%' ORDER BY created_at DESC LIMIT 1`);
      const row = await rowOf(w3.id);
      log(`   role: ${row.role}; upload: ${row.upload ?? 'none'}; merge: ${merge || 'none'}`);
      return row.role === 'worker' && row.upload === null && (merge === 'merged' || merge === 'done');
    });
    expect((await rowOf(w3.id)).left).toBeNull();
    const retired = await envOf(w3);
    expect([retired.HORNHOOF_SECRET, retired.NODE_KEY, retired.POSTGRES_PASSWORD, retired.HORNHOOF_ROLE]).toEqual(['', '', '', 'worker']);
    expect(ok(await m3.exec('docker volume ls --format "{{.Name}}"'), 'the volumes').split('\n').filter(name => name.endsWith('_pgdata'))).toEqual([]);
    expect((await machinesOf(server)).copies?.copies.map(copy => copy.hostname)).toEqual([host2]);
    expect(relay.fake.bindings.get(link)?.key).toBe(keyKept);
    log('3b. the machine kept from the server gave its copy up, and no key changed');

    /* 3c. Let back, it gets a place and the data again, and makes a copy under a new name that holds every task. */
    expect((await pin(w3.id, null)).status).toBe(204);
    await within(15, 'the machine let back holds an up-to-date copy again', async () => {
      const row = await rowOf(w3.id);
      log(`   place: ${row.order ?? 'none'}; role: ${row.role}; copy: ${row.copy ?? 'none'} (${row.name ?? 'no name'})`);
      return (row.order === 2 || row.order === 3) && row.role === 'data' && row.copy === 'ready';
    });
    expect((await rowOf(w3.id)).name).toMatch(/_2$/);
    const written = writer.ids();
    await within(5, 'the new copy holds every task confirmed so far', async () => (await checkRows(m3, w3.folder, written)).length === 0);
    log('3c. let back, the machine made a copy again');

    /* 3d. While that copy does not answer, the other is the only one up to date, and is not kept from the server. */
    ok(await m3.exec(`cd ${w3.folder} && docker compose pause db`), 'pausing the database of the second copy');
    await within(1, 'the second copy is no longer said to be up to date', async () => (await machinesOf(server)).machines.find(machine => machine.id === w3.id)?.data?.copy?.line !== 'ready');
    const only = await pin(w2.id, 'none');
    expect([only.status, only.json<{ error: { reason?: string } }>().error.reason], only.body).toEqual([409, 'only_copy']);
    ok(await m3.exec(`cd ${w3.folder} && docker compose unpause db`), 'waking the database of the second copy');
    await within(3, 'both copies are up to date again', bothReady);
    log('3d. the only up-to-date copy could not be kept from the server');

    /* 4. Pat sees one department from now on: at once the machine has no place and owes what it holds, and the link's
       key is another. Then the server has that merged and saved, and the machine holds nothing of the company. */
    const keyBefore = relay.fake.bindings.get(link)?.key;
    const department = await sql(m1, `INSERT INTO departments (company_id, name, role_code) SELECT id, 'One', 'ONE' FROM companies RETURNING id`);
    const patched = await http(m1, 'PATCH', `${server.url}/api/people/${person}`, { body: { access: { departments: [department.split('\n')[0]!], teams: [] } } });
    expect(patched.status, patched.body).toBe(200);
    const left = await rowOf(w3.id);
    expect([left.order, left.role, left.upload === 'waiting' || left.upload === 'received']).toEqual([null, 'worker', true]);
    await within(2, "the link's key changed at the relay", async () => relay.fake.bindings.get(link)?.key !== keyBefore);
    await within(3, "the company's name is held at the relay", async () => relay.fake.routes.get(link)?.state === 'held');
    await within(10, 'what the machine held is merged and saved, and the machine is wiped', async () => {
      const merge = await sql(m1, `SELECT status FROM net.merges WHERE source LIKE 'upload:%' ORDER BY created_at DESC LIMIT 1`);
      const row = await rowOf(w3.id);
      log(`   upload: ${row.upload ?? 'none'}; merge: ${merge || 'none'}`);
      return (merge === 'merged' || merge === 'done') && row.upload === null;
    });
    expect(Number(await sql(m1, `SELECT count(*) FROM net.backups b JOIN net.merges m ON m.fork = b.id WHERE m.source LIKE 'upload:%' AND b.reason = 'fork'`))).toBeGreaterThan(0);
    expect(await sql(m1, `SELECT count(*) FROM pg_database WHERE datname LIKE 'hornhoof_upload%'`)).toBe('0');
    expect((await inside(m1, 'keeper', 'ls /control/uploads 2> /dev/null | grep -v -e "\\.done$" -e "\\.failed$" || true')).out.trim()).toBe('');
    const wiped = await envOf(w3);
    expect([wiped.HORNHOOF_SECRET, wiped.NODE_KEY, wiped.POSTGRES_PASSWORD, wiped.HORNHOOF_ROLE]).toEqual(['', '', '', 'worker']);
    expect(wiped).not.toHaveProperty('COMPOSE_PROFILES');
    expect(ok(await m3.exec('docker volume ls --format "{{.Name}}"'), 'the volumes').split('\n').filter(name => name.endsWith('_pgdata'))).toEqual([]);
    const control = (await m3.exec(`cd ${w3.folder} && docker compose exec -T keeper ls /control`)).out.split('\n');
    for (const name of ['dumps', 'replica.json', 'wipe.json', 'wiped.json']) expect(control, name).not.toContain(name);
    expect((await rowOf(w3.id)).left).not.toBeNull();
    log('4. the machine whose owner lost the scope gave what it held and is wiped');

    /* 5. A backup of the company, and its restore with what came after brought back: the copy that is left is made
       again from the restored server, and nothing of its old attempt stays. */
    const before = (await rowOf(w2.id)).name;
    expect(await signIn(m1, server.url, PASSWORD)).toBe(200);
    const since = new Date();
    const saved = await within(2, 'the recovery file is saved', async () => {
      const answer = await http(m1, 'POST', `${server.url}/api/backups/recovery`);
      return answer.status === 200 ? answer : null;
    });
    const bundle = await bundleAfter(m1, since, (JSON.parse(saved.json<{ text: string }>().text.split('\n')[1]!) as { recipient: string }).recipient);
    await restored(server, bundle.id, true);
    await within(3, "the company's name is held at the relay", async () => relay.fake.routes.get(link)?.state === 'held');
    await within(15, 'the copy is ready again, with a new attempt', async () => {
      const row = await rowOf(w2.id);
      log(`   copy: ${row.copy} ${row.name}`);
      return row.copy === 'ready' && row.name !== null && row.name !== before;
    });
    const now = (await rowOf(w2.id)).name!;
    await within(5, 'nothing of the older attempt stays', async () => {
      const slots = await sql(m1, `SELECT count(*) FROM pg_replication_slots WHERE slot_name LIKE 'copy\\_%' AND slot_name <> '${now}'`);
      const old = await sqlIn(m2, w2.folder, `SELECT count(*) FROM pg_database WHERE datname LIKE 'hornhoof_old_%' OR datname = 'hornhoof_next'`, 'postgres');
      return slots === '0' && old === '0';
    });
    expect(await sql(m1, `SELECT count(*) FROM net.merge_conflicts c JOIN net.merges m ON m.id = c.merge WHERE m.source LIKE 'machine:%'`)).toBe('0');
    log('5. the company was restored, and the copy was made again');

    /* 6. Every task the server confirmed is on the server and on the copy, those written between the backup and the
       restore too, which the merge of the database from before brought back. */
    const ids = await writer.stop();
    await within(10, 'the server and the copy hold every task that was confirmed', async () => {
      const [onServer, onCopy] = [await checkRows(m1, '/root/hornhoof', ids), await checkRows(m2, w2.folder, ids)];
      log(`   of ${ids.length} tasks, missing on the server: ${onServer.length}, on the copy: ${onCopy.length}`);
      return onServer.length === 0 && onCopy.length === 0;
    });
    log(`6. all ${ids.length} tasks that were confirmed are on the server and on the copy`);
  });
});
