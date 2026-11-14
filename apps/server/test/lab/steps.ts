import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { LAB_IMAGES, type LabMachine, type Ran } from './lab.js';

/* What the lab's scenarios share: requests made on a machine of the lab, and the first steps every scenario takes, as a
   person takes them: install.sh sets a server up, the setup screen makes the company, and the Machines tab's command
   joins another computer. Nothing here stands in for a part of Hornhoof. */
export const INSTALLER = readFileSync(fileURLToPath(new URL('../../../../scripts/install.sh', import.meta.url)), 'utf8');
export const PASSWORD = 'correct horse battery';
export const EMAIL = 'ivan@lab.hornhoof.test';
export const WEB_PORT = 8080;
export const PEER_PORT = 8180;
/* The lab's computers share one real computer, which may be busy with other work: the installer waits for Hornhoof's
   answer for as long as a person would before giving up, not for what an idle machine needs. */
export const REFS = { HORNHOOF_APP_REF: LAB_IMAGES.app, HORNHOOF_NODE_REF: LAB_IMAGES.node, HORNHOOF_UPDATER_REF: LAB_IMAGES.updater, HORNHOOF_PULLED: '1', HORNHOOF_ANSWER_WAIT: '900', HORNHOOF_CORE_WAIT: '900' };
const JAR = '/tmp/owner.jar';

export const b64url = (bytes: ArrayBuffer | Uint8Array): string => Buffer.from(bytes as ArrayBuffer).toString('base64url');
export const quoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;
/* A text inside a statement for the database. */
export const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;
export const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/* Waits until the look gives something, however long this computer takes: only a person stops a lab that never gets there. */
export async function until<T>(look: () => Promise<T | null | undefined | false>): Promise<T> {
  for (;;) {
    const found = await look();
    if (found) return found;
    await pause(1000);
  }
}

/* The same, for what the product promises within a time: past it the scenario fails, saying what it waited for. */
export async function within<T>(minutes: number, what: string, look: () => Promise<T | null | undefined | false>): Promise<T> {
  const end = Date.now() + minutes * 60_000;
  for (;;) {
    const found = await look().catch(() => null);
    if (found) return found;
    if (Date.now() > end) throw new Error(`Not within ${minutes} minutes: ${what}`);
    await pause(2000);
  }
}

export function ok(ran: Ran, what: string): string {
  if (ran.code !== 0) throw new Error(`${what} ended with ${ran.code}:\n${ran.out.slice(-3000)}`);
  return ran.out;
}

export type Answer = { status: number; body: string; json: <T>() => T };

/* An HTTP request made on a machine of the lab, with the owner's session when the machine holds it. maxTime: the
   seconds after which the request is given up, with status 0; without it the request waits for as long as it is held.
   signsIn: the answer's cookies are kept as the machine's session; any other request only shows the session, since
   two requests at once that both wrote it down would leave the machine with none. */
export async function http(machine: LabMachine, method: string, url: string, opts: { body?: unknown; headers?: Record<string, string>; maxTime?: number; signsIn?: boolean } = {}): Promise<Answer> {
  const headers = Object.entries({ ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }), ...opts.headers }).map(([name, value]) => `-H ${quoted(`${name}: ${value}`)}`);
  const data = opts.body === undefined ? '' : '--data-binary @-';
  const limit = opts.maxTime ? `--max-time ${opts.maxTime}` : '';
  /* Each request keeps its answer in a file of its own: a scenario asks a machine while its writer does. */
  const ran = await machine.exec(`o=/tmp/answer.$$; : > $o; curl -sS -o $o -w '%{http_code}' -X ${method} -b ${JAR} ${opts.signsIn ? `-c ${JAR}` : ''} ${limit} ${headers.join(' ')} ${data} ${quoted(url)}; echo; cat $o; rm -f $o`, {
    input: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const [code = '', ...rest] = ran.out.split('\n');
  const body = rest.join('\n');
  /* What curl says of a request it gave up comes before the status, on the same line. */
  return { status: Number(code.slice(-3)) || 0, body, json: <T>() => JSON.parse(body) as T };
}

/* The owner's session as the server's machine holds it, to show at another machine's address: the session is the
   company's, whichever machine leads. */
export async function sessionOf(machine: LabMachine): Promise<string> {
  const token = ok(await machine.exec(`awk '$6 == "hh_session" { print $7 }' ${JAR}`), "reading the owner's session").trim();
  if (!token) throw new Error(`${machine.name} holds no session of the owner.`);
  return `hh_session=${token}`;
}

/* The owner signs in anew on that machine, as after everyone was signed out; the status the server answered. */
export async function signIn(machine: LabMachine, url: string, password: string): Promise<number> {
  await machine.exec(`rm -f ${JAR}`);
  return (await http(machine, 'POST', `${url}/api/auth/login`, { body: { email: EMAIL, password }, signsIn: true })).status;
}

/* The owner's key, made as the browser makes it; the test keeps the private half and gives the server only the wrapped
   one. grant: what the owner signs to open a machine for an hour, as their browser does. */
export async function ownerKey(password: string) {
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
export type OwnerKey = Awaited<ReturnType<typeof ownerKey>>;

/* A question to the server's database, on the server's own machine. */
export async function sql(server: LabMachine, query: string): Promise<string> {
  return ok(await server.exec(`cd /root/hornhoof && docker compose exec -T db psql -U hornhoof -d hornhoof -tAc ${quoted(query)}`), 'psql').trim();
}

export type Server = { machine: LabMachine; url: string; code: string; secret: string; installed: string };

/* The server, by install.sh server, over a .env as a first install makes it, with an address the other machines reach.
   url: the address people open it at, its own unless another is given, as for a server set up in the place of a lost one. */
export async function installServer(machine: LabMachine, opts: { url?: string; relay?: string; probe?: string } = {}): Promise<Server> {
  const url = opts.url ?? `http://${machine.address}:${WEB_PORT}`;
  const secret = randomBytes(32).toString('base64');
  const env = [`HORNHOOF_SECRET=${secret}`, `NODE_KEY=${randomBytes(32).toString('base64')}`, `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`, `HORNHOOF_PORT=${WEB_PORT}`, `PUBLIC_URL=${url}`];
  /* The relay the company takes its link at, when the lab serves one. No certificate is ordered for a name of the
     lab's: there is no such name outside it, and no authority is to hear of it. */
  if (opts.relay) env.push(`RELAY_URL=${opts.relay}`, 'ACME_DIRECTORY=off');
  /* Where a machine that takes the server over asks who answers at the company's name, when the lab plays that part. */
  if (opts.probe) env.push(`HORNHOOF_LINK_PROBE=${opts.probe}`);
  ok(await machine.exec('mkdir -p /root/hornhoof && umask 077 && cat > /root/hornhoof/.env', { input: `${env.join('\n')}\n` }), 'writing .env');
  ok(await machine.exec('cat > /root/install.sh', { input: INSTALLER }), 'copying install.sh');
  const ran = await machine.exec('HORNHOOF_TTY=/dev/null bash /root/install.sh server', { env: REFS });
  /* An install that failed says why in what its services logged. */
  if (ran.code !== 0) ran.out += `\n${(await machine.exec('cd /root/hornhoof && docker compose logs --tail 80 app keeper migrate 2>&1')).out.slice(-6000)}`;
  const installed = ok(ran, 'install.sh server');
  const link = /https?:\/\/\S+\/setup\?code=(\S+)/.exec(installed);
  expect(link, installed).not.toBeNull();
  return { machine, url, code: link![1]!, secret, installed };
}

/* The lab's machines share this computer's one disk, so how long a write takes to reach it says nothing of the
   machine each of them stands for, and one slow write while the others load their images would keep a machine from
   holding a copy for its first half hour. The server's database therefore takes every such measure as that of a
   quiet disk. Nothing else of what a machine reports is touched. */
export async function quietDisk(server: LabMachine): Promise<void> {
  // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- the database of a lab machine, which goes with the machine
  await sql(server, `CREATE OR REPLACE FUNCTION lab_quiet_disk() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.fsync_p99_ms > 5 THEN NEW.fsync_p99_ms := 5; END IF; RETURN NEW; END $f$;
    DROP TRIGGER IF EXISTS lab_quiet_disk ON machines;
    CREATE TRIGGER lab_quiet_disk BEFORE INSERT OR UPDATE ON machines FOR EACH ROW EXECUTE FUNCTION lab_quiet_disk();
    UPDATE machines SET fsync_p99_ms = 5 WHERE fsync_p99_ms > 5`);
}

/* The setup screen: the company and its owner, whose session the server's machine holds from here. The build it runs. */
export async function setUp(server: Server, password = PASSWORD): Promise<{ commit: string }> {
  const setup = await http(server.machine, 'POST', `${server.url}/api/setup`, { body: { code: server.code, companyName: 'Lab', name: 'Ivan', email: EMAIL, password, orchestrator: { mode: 'later' } }, signsIn: true });
  expect(setup.status, setup.body).toBe(201);
  await quietDisk(server.machine);
  return (await http(server.machine, 'GET', `${server.url}/api/health`)).json<{ commit: string }>();
}

export type KeeperStatus = { certificate: boolean; leader: { path: string; machine: string } | null; disconnected: boolean; machine: string | null };
export type Worker = { machine: LabMachine; folder: string; port: string; id: string; joined: string; coreEnv: string; keeper: () => Promise<KeeperStatus> };

/* A person the owner invites, who takes the invite on a machine of the lab: that machine holds their session from then
   on, as the server's machine holds the owner's. Their id. */
export async function invite(server: Server, machine: LabMachine, person: { name: string; email: string; access: object }, password = PASSWORD): Promise<string> {
  const invited = await http(server.machine, 'POST', `${server.url}/api/people/invite`, { body: { ...person, title: '' } });
  expect(invited.status, invited.body).toBe(201);
  const said = invited.json<{ inviteUrl: string; person?: { id: string } }>();
  const token = new URL(said.inviteUrl).pathname.split('/').pop()!;
  await machine.exec(`rm -f ${JAR}`);
  const accepted = await http(machine, 'POST', `${server.url}/api/invites/${token}/accept`, { body: { password }, signsIn: true });
  expect(accepted.status, accepted.body).toBeLessThan(300);
  return sql(server.machine, `SELECT id FROM people WHERE email = ${literal(person.email)}`);
}

/* The command from Machines, run on another machine as a person runs it; it is a worker once its keeper holds its
   certificate and has found the server. as: the machine that holds the session of the person who joins it, the
   owner's on the server's machine unless another is named. */
export async function joinWorker(server: Server, machine: LabMachine, key: OwnerKey, as: LabMachine = server.machine, opts: { probe?: string } = {}): Promise<Worker> {
  const made = await http(as, 'POST', `${server.url}/api/machines/command`);
  expect(made.status, made.body).toBe(201);
  const command = `${made.json<{ command: string }>().command} --owner-key ${key.publicKey}`;
  expect(command).toContain(`${server.url}/install.sh | bash -s -- --join `);
  const joinEnv = { ...REFS, HORNHOOF_NODE_IMAGE: LAB_IMAGES.node, HORNHOOF_TTY: '/dev/null', HORNHOOF_SIGNIN_WAIT: '0' };
  const joined = await machine.exec(command, { env: joinEnv });
  expect(joined.code, joined.out.slice(-3000)).toBe(0);
  const folder = ok(await machine.exec('ls -d /root/hornhoof-*'), 'the core folder').trim();
  expect(folder).toMatch(/^\/root\/hornhoof-[a-z]{6}$/);
  /* Its settings name where the lab answers the probe, and its keeper starts again with them. */
  if (opts.probe) ok(await machine.exec(`cd ${folder} && printf 'HORNHOOF_LINK_PROBE=%s\n' ${quoted(opts.probe)} >> .env && docker compose up -d --no-build keeper`), 'naming the probe');
  const coreEnv = ok(await machine.exec(`cat ${folder}/.env`), 'the core .env');
  const port = /^HORNHOOF_PORT=(\d+)$/m.exec(coreEnv)![1]!;
  const keeper = async () => (await http(machine, 'GET', `http://localhost:${port}/api/keeper`)).json<KeeperStatus>();
  const status = await until(async () => {
    const said = await keeper().catch(() => null);
    return said?.certificate && said.leader ? said : null;
  });
  return { machine, folder, port, id: status.machine!, joined: joined.out, coreEnv, keeper };
}

/* A command in one of the server's containers, on the server's own machine. */
export const inside = (server: LabMachine, service: string, cmd: string): Promise<Ran> => server.exec(`cd /root/hornhoof && docker compose exec -T ${service} sh -c ${quoted(cmd)}`);

export type Bundle = { id: string; reason: string; recovery: string | null; dumpedAt: string };

/* The backups the server has recorded, newest first. */
export async function bundles(server: LabMachine): Promise<Bundle[]> {
  return JSON.parse((await sql(server, `SELECT coalesce(json_agg(json_build_object('id', id, 'reason', reason, 'recovery', recovery, 'dumpedAt', dumped_at) ORDER BY made_at DESC), '[]') FROM net.backups`)) || '[]') as Bundle[];
}

/* A bundle of the database in use made after this moment, which the recovery file opens. */
export const bundleAfter = (server: LabMachine, since: Date, recipient: string): Promise<Bundle> =>
  within(3, 'a bundle of the company as it is now is recorded', async () => (await bundles(server)).find(row => row.reason !== 'fork' && row.recovery === recipient && new Date(row.dumpedAt) > since));

/* The owner restores a backup on the server's machine; the restore as the updater says it went. */
export async function restored(server: Server, id: string, bringBack: boolean) {
  const m1 = server.machine;
  /* A backup is restored from a machine that says it holds it, which the server's keeper says in its next report. */
  await within(3, 'the server reports that it holds the backup', async () => (await sql(m1, `SELECT count(*) FROM machines WHERE '${id}' = ANY(held_backups)`)) !== '0');
  expect(await signIn(m1, server.url, PASSWORD)).toBe(200);
  const asked = await http(m1, 'POST', `${server.url}/api/backups/${id}/restore`, { body: { bringBack } });
  expect(asked.status, asked.body).toBe(202);
  const attempt = asked.json<{ attempt: string }>().attempt;
  const status = async () => JSON.parse(ok(await inside(m1, 'keeper', 'cat /control/restore-status.json'), 'the status')) as { attempt: string; state: string; step: string; line: string; kept: string | null; dumpedAt?: string };
  const ended = await within(4, 'the restore ended', async () => {
    const said = await status().catch(() => null);
    return said && said.attempt === attempt && said.state !== 'running' ? said : null;
  });
  expect(ended, ended.line).toMatchObject({ state: 'done', step: 'start' });
  await within(1, 'the restored company answers', async () => (await http(m1, 'GET', `${server.url}/api/health`)).status === 200);
  return ended;
}
