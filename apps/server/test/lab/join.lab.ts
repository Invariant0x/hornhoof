import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Lab, type LabMachine } from './lab.js';
import { http, installServer, joinWorker, literal, ok, ownerKey, PASSWORD, PEER_PORT, quoted, setUp, sql, until, WEB_PORT } from './steps.js';

/* One scenario on two computers of the lab: install.sh sets the company's server up on the first, the second joins it
   with the Machines tab's command and becomes a worker, and then the company disconnects it. Nothing here stands in
   for a part of Hornhoof: the installer, compose, the keepers, the updater and the node are the ones this worktree
   builds. */
describe('the lab', () => {
  let lab: Lab;
  let m1: LabMachine;
  let m2: LabMachine;
  let server: string;

  beforeAll(async () => {
    lab = await Lab.start({ machines: 2 });
    m1 = lab.machine(1);
    m2 = lab.machine(2);
    server = `http://${m1.address}:${WEB_PORT}`;
  });

  /* HH_LAB_KEEP=1 leaves the machines for a person to look at; the label printed at the start finds them. */
  afterAll(async () => {
    if (!process.env.HH_LAB_KEEP) await lab?.stop();
  });

  it('installs a server, joins a worker with the command from Machines, and disconnects it', async () => {
    /* 1. The server, by install.sh server, and the company with its owner by the setup screen. */
    const installed = await installServer(m1);
    expect(installed.url).toBe(server);
    expect(ok(await m1.exec('cd /root/hornhoof && docker compose ps --services --status running'), 'compose ps').trim().split('\n').sort()).toEqual(['app', 'db', 'front', 'keeper', 'node', 'updater']);
    const health = await setUp(installed);

    /* 2. The owner's key, then the command from Machines, run on the second machine as a person runs it. */
    const key = await ownerKey(PASSWORD);
    expect((await http(m1, 'PUT', `${server}/api/me/key`, { body: { password: PASSWORD, ...key.stored } })).status).toBe(204);
    const worker = await joinWorker(installed, m2, key);
    const { folder, port, coreEnv, keeper } = worker;
    expect(coreEnv).toContain(`HORNHOOF_OWNER_KEY=${key.publicKey}`);
    expect(coreEnv).toContain('HORNHOOF_ROLE=worker');
    expect(coreEnv).toContain(`HORNHOOF_JOIN_SERVER=${server}`);
    const node = ok(await m2.exec("docker ps --filter label=hornhoof.subscription --format '{{.Names}}'"), 'docker ps').trim();
    expect(node).toMatch(/^hornhoof-machine-[0-9a-f]{8}$/);

    /* 3. The worker has its place, reaches the server directly, and serves the company on its own address. */
    const status = await keeper();
    expect(status).toMatchObject({ certificate: true, leader: { path: 'direct' }, disconnected: false });
    expect((await http(m2, 'GET', `http://localhost:${port}/api/health`)).json<{ commit: string }>().commit).toBe(health.commit);
    /* Its row: a worker under its computer's id, with the addresses its updater read, its owner's pin and its path. */
    const wanted = `worker|t|t|${key.print}|direct`;
    let row = '';
    await until(async () => {
      row = await sql(m1, `SELECT role, network_id IS NOT NULL, cardinality(addresses) > 0, owner_pin, path FROM machines WHERE id = '${status.machine}'`);
      if (row !== wanted) console.log(`the worker's row is ${row}, waiting for ${wanted}`);
      return row === wanted;
    });
    type Machines = { machines: { id: string; online: boolean; core: { webPort: number | null } | null }[] };
    const shown = await until(async () => {
      const list = (await http(m1, 'GET', `${server}/api/machines`)).json<Machines>();
      const mine = list.machines.find(machine => machine.id === status.machine);
      /* Its node is online: the nested node reached the worker's front through the worker's own Docker. */
      return mine?.online && mine.core?.webPort ? mine : null;
    });
    expect(shown.core!.webPort).toBe(Number(port));
    expect(ok(await m2.exec(`cd ${folder} && docker compose ps --services`), 'compose ps').trim().split('\n').sort()).toEqual(['front', 'keeper', 'updater']);

    /* 4. A worker gets no way to the data, and holds no secret of the company. */
    const probe = `
      const http2 = require('node:http2'), fs = require('node:fs');
      const held = JSON.parse(fs.readFileSync('/keeper/certificate.json', 'utf8'));
      const session = http2.connect('https://${m1.address}:${PEER_PORT}', { cert: held.certPem, key: fs.readFileSync('/keeper/machine.key', 'utf8'), ca: held.authorityPem, checkServerIdentity: () => undefined });
      session.on('error', err => { console.log('error ' + err.code); process.exit(0); });
      const stream = session.request({ ':method': 'CONNECT', ':authority': 'db:5432' });
      stream.on('response', headers => { console.log('status ' + headers[':status']); process.exit(0); });
      stream.on('close', () => { console.log('closed'); process.exit(0); });
    `;
    expect(ok(await m2.exec(`cd ${folder} && docker compose exec -T keeper node -e ${quoted(probe)}`), 'the probe').trim()).toBe('status 403');
    expect(ok(await m2.exec(`cd ${folder} && docker compose exec -T keeper sh -c 'printf "%s|%s" "$HORNHOOF_SECRET" "$NODE_KEY"'`), 'the keeper env')).toBe('|');
    expect(coreEnv).not.toMatch(/^(HORNHOOF_SECRET|NODE_KEY|POSTGRES_PASSWORD|PUBLIC_URL)=/m);

    /* 5. The connected machine has standing access even though it holds its owner's key. */
    const machine = status.machine!;
    type Views = { views: { machine: { id: string }; reachable: boolean; open: boolean }[] };
    const viewOf = async () => (await http(m1, 'GET', `${server}/api/machines/access`)).json<Views>().views.find(view => view.machine.id === machine);
    await until(async () => {
      const view = await viewOf();
      return view?.reachable && view.open;
    });
    const run = async (command: string): Promise<string> =>
      (await sql(m1, `INSERT INTO computer_runs (company_id, machine_id, command, timeout_s) SELECT company_id, id, ${literal(command)}, 60 FROM machines WHERE id = '${machine}' RETURNING id`)).split('\n')[0]!;
    const ended = (id: string) =>
      until(async () => {
        const said = await sql(m1, `SELECT state || '|' || coalesce(exit::text, '') || '|' || coalesce(output, '') FROM computer_runs WHERE id = '${id}'`);
        return said.startsWith('waiting|') || said.startsWith('sent|') ? null : said;
      });
    /* The machine's own files are at /host: the name it reads there is its own. */
    expect(await ended(await run('cat /host/etc/hostname'))).toBe('done|0|m2');
    const settings = async () => JSON.parse(ok(await m2.exec(`cd ${folder} && docker compose exec -T keeper cat /control/computer.json`), 'computer.json')) as { untilSec: number | null; by: string };
    expect(await settings()).toMatchObject({ untilSec: expect.any(Number), by: 'keeper' });

    /* Closed by its owner, nothing runs there: a command that comes then never starts. */
    expect((await http(m1, 'POST', `${server}/api/machines/${machine}/access/close`)).status).toBe(200);
    await until(async () => (await settings()).untilSec === null);
    expect(await ended(await run('touch /host/root/ran-while-closed'))).toMatch(/^done\|126\|/);
    expect((await m2.exec('ls /root/ran-while-closed')).code).not.toBe(0);
    expect((await http(m1, 'POST', `${server}/api/machines/${machine}/access/open`)).status).toBe(200);
    expect(await ended(await run('cat /host/etc/hostname'))).toBe('done|0|m2');

    /* 6. Disconnect cuts it off: it says so itself, and its certificate is on the server's list. */
    const serial = await sql(m1, `SELECT serial FROM certificates WHERE machine_id = '${status.machine}' AND revoked_at IS NULL`);
    expect(serial).toMatch(/^[0-9a-f]+$/);
    expect((await http(m1, 'POST', `${server}/api/machines/${status.machine}/disconnect`)).status).toBe(204);
    await until(async () => (await keeper().catch(() => null))?.disconnected);
    const page = await http(m2, 'GET', `http://localhost:${port}/tasks`, { headers: { accept: 'text/html' } });
    expect(page.status).toBe(410);
    expect(page.body).toContain('This machine was disconnected from the company.');
    expect(await sql(m1, `SELECT count(*) FROM certificates WHERE serial = '${serial}' AND revoked_at IS NOT NULL`)).toBe('1');
  });
});
