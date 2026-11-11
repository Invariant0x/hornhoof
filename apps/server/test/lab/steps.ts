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
export const REFS = { HORNHOOF_APP_REF: LAB_IMAGES.app, HORNHOOF_NODE_REF: LAB_IMAGES.node, HORNHOOF_UPDATER_REF: LAB_IMAGES.updater, HORNHOOF_PULLED: '1' };
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

/* An HTTP request made on a machine of the lab, with the owner's session when the machine holds it. */
export async function http(machine: LabMachine, method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
  const headers = Object.entries({ ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }), ...opts.headers }).map(([name, value]) => `-H ${quoted(`${name}: ${value}`)}`);
  const data = opts.body === undefined ? '' : '--data-binary @-';
  const ran = await machine.exec(`curl -sS -o /tmp/answer -w '%{http_code}' -X ${method} -b ${JAR} -c ${JAR} ${headers.join(' ')} ${data} ${quoted(url)}; echo; cat /tmp/answer`, {
    input: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const [code = '', ...rest] = ran.out.split('\n');
  const body = rest.join('\n');
  return { status: Number(code), body, json: <T>() => JSON.parse(body) as T };
}

/* The owner signs in anew on that machine, as after everyone was signed out; the status the server answered. */
export async function signIn(machine: LabMachine, url: string, password: string): Promise<number> {
  await machine.exec(`rm -f ${JAR}`);
  return (await http(machine, 'POST', `${url}/api/auth/login`, { body: { email: EMAIL, password } })).status;
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
export async function installServer(machine: LabMachine, opts: { url?: string } = {}): Promise<Server> {
  const url = opts.url ?? `http://${machine.address}:${WEB_PORT}`;
  const secret = randomBytes(32).toString('base64');
  const env = [`HORNHOOF_SECRET=${secret}`, `NODE_KEY=${randomBytes(32).toString('base64')}`, `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`, `HORNHOOF_PORT=${WEB_PORT}`, `PUBLIC_URL=${url}`];
  ok(await machine.exec('mkdir -p /root/hornhoof && umask 077 && cat > /root/hornhoof/.env', { input: `${env.join('\n')}\n` }), 'writing .env');
  ok(await machine.exec('cat > /root/install.sh', { input: INSTALLER }), 'copying install.sh');
  const installed = ok(await machine.exec('HORNHOOF_TTY=/dev/null bash /root/install.sh server', { env: REFS }), 'install.sh server');
  const link = /https?:\/\/\S+\/setup\?code=(\S+)/.exec(installed);
  expect(link, installed).not.toBeNull();
  return { machine, url, code: link![1]!, secret, installed };
}

/* The setup screen: the company and its owner, whose session the server's machine holds from here. The build it runs. */
export async function setUp(server: Server, password = PASSWORD): Promise<{ commit: string }> {
  const setup = await http(server.machine, 'POST', `${server.url}/api/setup`, { body: { code: server.code, companyName: 'Lab', name: 'Ivan', email: EMAIL, password, orchestrator: { mode: 'later' } } });
  expect(setup.status, setup.body).toBe(201);
  return (await http(server.machine, 'GET', `${server.url}/api/health`)).json<{ commit: string }>();
}

export type KeeperStatus = { certificate: boolean; leader: { path: string; machine: string } | null; disconnected: boolean; machine: string | null };
export type Worker = { machine: LabMachine; folder: string; port: string; id: string; joined: string; coreEnv: string; keeper: () => Promise<KeeperStatus> };

/* The command from Machines, run on another machine as a person runs it; it is a worker once its keeper holds its
   certificate and has found the server. */
export async function joinWorker(server: Server, machine: LabMachine, key: OwnerKey): Promise<Worker> {
  const made = await http(server.machine, 'POST', `${server.url}/api/machines/command`);
  expect(made.status, made.body).toBe(201);
  const command = `${made.json<{ command: string }>().command} --owner-key ${key.publicKey}`;
  expect(command).toContain(`${server.url}/install.sh | bash -s -- --join `);
  const joinEnv = { ...REFS, HORNHOOF_NODE_IMAGE: LAB_IMAGES.node, HORNHOOF_TTY: '/dev/null', HORNHOOF_SIGNIN_WAIT: '0' };
  const joined = await machine.exec(command, { env: joinEnv });
  expect(joined.code, joined.out.slice(-3000)).toBe(0);
  const folder = ok(await machine.exec('ls -d /root/hornhoof-*'), 'the core folder').trim();
  expect(folder).toMatch(/^\/root\/hornhoof-[a-z]{6}$/);
  const coreEnv = ok(await machine.exec(`cat ${folder}/.env`), 'the core .env');
  const port = /^HORNHOOF_PORT=(\d+)$/m.exec(coreEnv)![1]!;
  const keeper = async () => (await http(machine, 'GET', `http://localhost:${port}/api/keeper`)).json<KeeperStatus>();
  const status = await until(async () => {
    const said = await keeper().catch(() => null);
    return said?.certificate && said.leader ? said : null;
  });
  return { machine, folder, port, id: status.machine!, joined: joined.out, coreEnv, keeper };
}
