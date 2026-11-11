import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Lab, LAB_IMAGES, type LabMachine, type Ran } from './lab.js';

/* One scenario on two computers of the lab: install.sh sets the company's server up on the first, the second joins it
   with the Machines tab's command and becomes a worker, and then the company disconnects it. Nothing here stands in
   for a part of Hornhoof: the installer, compose, the keepers, the updater and the node are the ones this worktree
   builds. */
const INSTALLER = readFileSync(fileURLToPath(new URL('../../../../scripts/install.sh', import.meta.url)), 'utf8');
const PASSWORD = 'correct horse battery';
const WEB_PORT = 8080;
const PEER_PORT = 8180;
const REFS = { HORNHOOF_APP_REF: LAB_IMAGES.app, HORNHOOF_NODE_REF: LAB_IMAGES.node, HORNHOOF_UPDATER_REF: LAB_IMAGES.updater, HORNHOOF_PULLED: '1' };
const JAR = '/tmp/owner.jar';

const b64url = (bytes: ArrayBuffer | Uint8Array): string => Buffer.from(bytes as ArrayBuffer).toString('base64url');
const quoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;
/* A text inside a statement for the database. */
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/* Waits until the look gives something, however long this computer takes: only a person stops a lab that never gets there. */
async function until<T>(look: () => Promise<T | null | undefined | false>): Promise<T> {
  for (;;) {
    const found = await look();
    if (found) return found;
    await pause(1000);
  }
}

function ok(ran: Ran, what: string): string {
  if (ran.code !== 0) throw new Error(`${what} ended with ${ran.code}:\n${ran.out.slice(-3000)}`);
  return ran.out;
}

type Answer = { status: number; body: string; json: <T>() => T };

/* An HTTP request made on a machine of the lab, with the owner's session when the machine holds it. */
async function http(machine: LabMachine, method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
  const headers = Object.entries({ ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }), ...opts.headers }).map(([name, value]) => `-H ${quoted(`${name}: ${value}`)}`);
  const data = opts.body === undefined ? '' : '--data-binary @-';
  const ran = await machine.exec(`curl -sS -o /tmp/answer -w '%{http_code}' -X ${method} -b ${JAR} -c ${JAR} ${headers.join(' ')} ${data} ${quoted(url)}; echo; cat /tmp/answer`, {
    input: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const [code = '', ...rest] = ran.out.split('\n');
  const body = rest.join('\n');
  return { status: Number(code), body, json: <T>() => JSON.parse(body) as T };
}

/* The owner's key, made as the browser makes it; the test keeps the private half and gives the server only the wrapped
   one. grant: what the owner signs to open a machine for an hour, as their browser does. */
async function ownerKey(password: string) {
  const { subtle } = webcrypto;
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const typed = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const wrapping = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 }, typed, { name: 'AES-GCM', length: 256 }, false, ['wrapKey']);
  const wrapped = await subtle.wrapKey('pkcs8', pair.privateKey, wrapping, { name: 'AES-GCM', iv });
  const publicKey = b64url(await subtle.exportKey('spki', pair.publicKey));
  const grant = async (machine: string) => {
    const at = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ v: 1, machine, until: at + 3600, at, nonce: b64url(webcrypto.getRandomValues(new Uint8Array(16))) });
    return { payload, signature: b64url(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(payload))) };
  };
  return { publicKey, grant, print: createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url'), stored: { publicKey, wrapped: b64url(wrapped), salt: b64url(salt), iv: b64url(iv), iterations: 600_000 } };
}

/* A question to the server's database, on the server's own machine. */
async function sql(server: LabMachine, query: string): Promise<string> {
  return ok(await server.exec(`cd /root/hornhoof && docker compose exec -T db psql -U hornhoof -d hornhoof -tAc ${quoted(query)}`), 'psql').trim();
}

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
    /* 1. The server, by install.sh server, over a .env as a first install makes it, with an address the other machine reaches. */
    const env = [`HORNHOOF_SECRET=${randomBytes(32).toString('base64')}`, `NODE_KEY=${randomBytes(32).toString('base64')}`, `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`, `HORNHOOF_PORT=${WEB_PORT}`, `PUBLIC_URL=${server}`];
    ok(await m1.exec('mkdir -p /root/hornhoof && umask 077 && cat > /root/hornhoof/.env', { input: `${env.join('\n')}\n` }), 'writing .env');
    ok(await m1.exec('cat > /root/install.sh', { input: INSTALLER }), 'copying install.sh');
    const installed = ok(await m1.exec('HORNHOOF_TTY=/dev/null bash /root/install.sh server', { env: REFS }), 'install.sh server');
    const link = /https?:\/\/\S+\/setup\?code=(\S+)/.exec(installed);
    expect(link, installed).not.toBeNull();
    expect(ok(await m1.exec('cd /root/hornhoof && docker compose ps --services --status running'), 'compose ps').trim().split('\n').sort()).toEqual(['app', 'db', 'front', 'keeper', 'node', 'updater']);
    const setup = await http(m1, 'POST', `${server}/api/setup`, { body: { code: link![1], companyName: 'Lab', name: 'Ivan', email: 'ivan@lab.hornhoof.test', password: PASSWORD, orchestrator: { mode: 'later' } } });
    expect(setup.status, setup.body).toBe(201);
    const health = (await http(m1, 'GET', `${server}/api/health`)).json<{ commit: string }>();

    /* 2. The owner's key, then the command from Machines, run on the second machine as a person runs it. */
    const key = await ownerKey(PASSWORD);
    expect((await http(m1, 'PUT', `${server}/api/me/key`, { body: { password: PASSWORD, ...key.stored } })).status).toBe(204);
    const made = await http(m1, 'POST', `${server}/api/machines/command`);
    expect(made.status, made.body).toBe(201);
    const command = `${made.json<{ command: string }>().command} --owner-key ${key.publicKey}`;
    expect(command).toContain(`${server}/install.sh | bash -s -- --join `);
    const joinEnv = { ...REFS, HORNHOOF_NODE_IMAGE: LAB_IMAGES.node, HORNHOOF_TTY: '/dev/null', HORNHOOF_SIGNIN_WAIT: '0' };
    const joined = await m2.exec(command, { env: joinEnv });
    expect(joined.code, joined.out.slice(-3000)).toBe(0);
    const folder = ok(await m2.exec('ls -d /root/hornhoof-*'), 'the core folder').trim();
    expect(folder).toMatch(/^\/root\/hornhoof-[a-z]{6}$/);
    const coreEnv = ok(await m2.exec(`cat ${folder}/.env`), 'the core .env');
    expect(coreEnv).toContain(`HORNHOOF_OWNER_KEY=${key.publicKey}`);
    expect(coreEnv).toContain('HORNHOOF_ROLE=worker');
    expect(coreEnv).toContain(`HORNHOOF_JOIN_SERVER=${server}`);
    const port = /^HORNHOOF_PORT=(\d+)$/m.exec(coreEnv)![1]!;
    const node = ok(await m2.exec("docker ps --filter label=hornhoof.subscription --format '{{.Names}}'"), 'docker ps').trim();
    expect(node).toMatch(/^hornhoof-machine-[0-9a-f]{8}$/);

    /* 3. The worker has its place, reaches the server directly, and serves the company on its own address. */
    type Status = { certificate: boolean; leader: { path: string } | null; disconnected: boolean; machine: string | null };
    const keeper = async () => (await http(m2, 'GET', `http://localhost:${port}/api/keeper`)).json<Status>();
    const status = await until(async () => {
      const said = await keeper().catch(() => null);
      return said?.certificate && said.leader ? said : null;
    });
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

    /* 5. Its owner opens its computer with what their key signs, and a command runs there as root. Commands are written
       into the server's database as the orchestrator's tool writes them. */
    const machine = status.machine!;
    const networkId = await sql(m1, `SELECT network_id FROM machines WHERE id = '${machine}'`);
    type Views = { views: { machine: { id: string }; reachable: boolean; key: string; until: string | null }[] };
    const viewOf = async () => (await http(m1, 'GET', `${server}/api/machines/access`)).json<Views>().views.find(view => view.machine.id === machine);
    await until(async () => {
      const view = await viewOf();
      return view?.reachable && view.key === 'held';
    });
    const grant = await key.grant(networkId);
    const opened = await http(m1, 'POST', `${server}/api/machines/${machine}/access/open`, { body: { grant } });
    expect(opened.status, opened.body).toBe(200);
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
    expect(await settings()).toMatchObject({ untilSec: (JSON.parse(grant.payload) as { until: number }).until, by: 'keeper' });

    /* Closed by its owner, nothing runs there: a command that comes then never starts. */
    expect((await http(m1, 'POST', `${server}/api/machines/${machine}/access/close`)).status).toBe(200);
    await until(async () => (await settings()).untilSec === null);
    expect(await ended(await run('touch /host/root/ran-while-closed'))).toMatch(/^done\|126\|/);
    /* A row written past the app says open again, with the grant that was closed: the machine's keeper takes no such
       word, so it stays closed, and a command sent then is answered by its updater as closed. */
    await sql(m1, `UPDATE machine_access SET until = now() + interval '1 hour', "grant" = ${literal(JSON.stringify(grant))}::jsonb WHERE machine_id = '${machine}'`);
    const refused = await ended(await run('touch /host/root/ran-on-a-forged-row'));
    expect(refused).toMatch(/^done\|126\|/);
    expect((await settings()).untilSec).toBeNull();
    expect((await m2.exec('ls /root/ran-while-closed /root/ran-on-a-forged-row')).code).not.toBe(0);
    await sql(m1, `UPDATE machine_access SET until = NULL, "grant" = NULL WHERE machine_id = '${machine}'`);

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
