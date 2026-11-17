/* eslint-disable hornhoof/no-ddl-on-shared-database -- These run on a Postgres database each of them makes and drops, shared with no other test. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parse } from 'yaml';
import { formerAgentRole, readerRole } from '../../src/db/agent-sql.js';
import type { Db } from '../../src/db/client.js';

export interface RealDatabase {
  url: string;
  admin: pg.Client;
  drop(): Promise<void>;
}

export function realServer(): string {
  const url = process.env.HH_REAL_PG;
  if (!url) throw new Error('run with npm run test:real');
  return url;
}

async function connected(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  /* What a test does may end this session, as a copy's swap ends every session on its databases: the next query on it
     fails, and nothing else comes of it. */
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

/* Every statement gets its try, so one that fails leaves nothing else behind; the caller gets the first failure. */
async function onServer(statements: string[]): Promise<void> {
  const server = await connected(realServer());
  const failures: unknown[] = [];
  for (const statement of statements) await server.query(statement).catch((failure: unknown) => failures.push(failure));
  await server.end();
  if (failures.length > 0) throw failures[0];
}

const urlOf = (database: string): string => {
  const url = new URL(realServer());
  url.pathname = `/${database}`;
  return url.href;
};

/* Each test file gets a database of its own on the one container, so the files leave nothing behind for one another. The
   roles of the agents belong to the server, not to the database, and would outlive it. */
export async function realDatabase(): Promise<RealDatabase> {
  const name = `hh_${randomBytes(6).toString('hex')}`;
  await onServer([`CREATE DATABASE ${name}`]);
  const url = urlOf(name);
  const admin = await connected(url);
  const drop = async (): Promise<void> => {
    await admin.end();
    await onServer([`DROP DATABASE ${name} WITH (FORCE)`, `DROP ROLE IF EXISTS ${formerAgentRole(name)}`, `DROP ROLE IF EXISTS ${readerRole(name)}`]);
  };
  return { url, admin, drop };
}

/* A copy of a database as it is now, with its connections off, as a restore leaves the database it sets aside. Every
   other session on the one it is copied from is ended first, which a copy needs: the test closes its own pools on it
   before, and connects anew after. A test that writes the copy turns its connections on first. */
export async function forkDatabase(from: string, name: string): Promise<string> {
  await onServer([
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${from}' AND pid <> pg_backend_pid()`,
    `CREATE DATABASE ${name} TEMPLATE ${from}`,
    `ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS false`,
  ]);
  return urlOf(name);
}

/* Statements run on the server itself, outside every database of the tests. */
export const onRealServer = onServer;
export const realUrlOf = urlOf;

/* How many sessions of a process, told apart by the name it connects with, wait for a lock right now. */
export const sessionsWaitingOnALock = async (real: RealDatabase, name: string): Promise<number> => {
  const { rows } = await real.admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'",
    [name],
  );
  return rows[0]!.n;
};

/* openDb answers the database alone, and a test has to end the connections behind it. */
export const poolOf = (db: Db): pg.Pool => (db as unknown as { $client: pg.Pool }).$client;

/* One command with what it printed, or a failure that says what it wrote to its error stream. Its input comes on
   standard input, and what it needs of the environment comes by name, so no value stands on a command line. */
export function run(command: string, args: string[], opts: { stdin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...opts.env } });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => (out += text));
    child.stderr.setEncoding('utf8').on('data', (text: string) => (err += text));
    child.once('error', reject);
    child.once('close', code => (code === 0 ? resolve(out) : reject(new Error(`${command} ${args[0] ?? ''} ended with ${code}: ${err.trim().slice(0, 2000)}`))));
    child.stdin.end(opts.stdin ?? '');
  });
}

export type Platform = 'linux/amd64' | 'linux/arm64';
export type RealCluster = {
  /* The owner's way in from this computer, and a connection of the owner's that is open already. */
  url: string;
  admin: pg.Client;
  /* The name the other containers of its network reach it by, and the owner's password. */
  host: string;
  password: string;
  /* A command in its container, as the user the database runs as. */
  exec(args: string[], opts?: { stdin?: string; env?: NodeJS.ProcessEnv; pass?: string[] }): Promise<string>;
  close(): Promise<void>;
};

/* The image and the settings compose's db runs with, read from compose.yaml, so a test cluster is the one a server has. */
function composeDb(): { image: string; command: string[] } {
  const compose = parse(readFileSync(fileURLToPath(new URL('../../../../compose.yaml', import.meta.url)), 'utf8')) as { services: { db: { image: string; command: string[] } } };
  return { image: compose.services.db.image, command: compose.services.db.command.slice(1) };
}

/* The image of one processor among those compose's image names, by its own digest. A Docker that keeps one image
   under a name cannot hold a second processor's under the same digest, and refuses to pull it ("cannot overwrite
   digest"): each processor's image is run by the digest of its own, which the registry is asked for once. */
const imagesFor = new Map<string, Promise<string>>();
function imageFor(image: string, platform: Platform): Promise<string> {
  const known = imagesFor.get(platform);
  if (known) return known;
  const found = (async () => {
    const listed = JSON.parse(await run('docker', ['buildx', 'imagetools', 'inspect', image, '--format', '{{json .Manifest}}'])) as { manifests?: { digest: string; platform?: { os: string; architecture: string } }[] };
    const [os, architecture] = platform.split('/');
    const one = listed.manifests?.find(manifest => manifest.platform?.os === os && manifest.platform.architecture === architecture);
    if (!one) throw new Error(`${image} has no image for ${platform}.`);
    return `${image.split(/[:@]/)[0]!}@${one.digest}`;
  })();
  imagesFor.set(platform, found);
  return found;
}

/* A Postgres server of its own, in a container of that name on that Docker network, with a database hornhoof owned by
   the user hornhoof as compose makes it, published on this computer alone. platform: the processor it runs for, the
   computer's own when none is named. */
export async function realCluster(opts: { network: string; name: string; platform?: Platform }): Promise<RealCluster> {
  const { image: named, command } = composeDb();
  const password = randomBytes(16).toString('hex');
  const platform = opts.platform ? ['--platform', opts.platform] : [];
  const image = opts.platform ? await imageFor(named, opts.platform) : named;
  await run('docker', ['run', '--detach', '--name', opts.name, '--network', opts.network, ...platform, '-e', 'POSTGRES_USER=hornhoof', '-e', 'POSTGRES_DB=hornhoof', '-e', 'POSTGRES_PASSWORD', '-p', '127.0.0.1::5432', image, ...command], {
    env: { POSTGRES_PASSWORD: password },
  });
  const close = async (): Promise<void> => void (await run('docker', ['rm', '-f', opts.name]).catch(() => undefined));
  try {
    /* Over TCP, since the image's first start runs a server on its socket alone and then restarts it. */
    for (let tries = 0; ; tries++) {
      const ready = await run('docker', ['exec', opts.name, 'pg_isready', '-h', '127.0.0.1', '-U', 'hornhoof']).then(() => true, () => false);
      if (ready) break;
      if (tries > 600) throw new Error(`Postgres in ${opts.name} did not answer.`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const published = (await run('docker', ['port', opts.name, '5432/tcp'])).trim().split('\n')[0]!;
    const url = `postgres://hornhoof:${password}@127.0.0.1:${published.slice(published.lastIndexOf(':') + 1)}/hornhoof`;
    const admin = await connected(url);
    const exec: RealCluster['exec'] = (args, more = {}) =>
      run('docker', ['exec', '-i', '-u', 'postgres', ...(more.pass ?? []).flatMap(name => ['-e', name]), opts.name, ...args], { stdin: more.stdin, env: more.env });
    return { url, admin, host: opts.name, password, exec, close: async () => { await admin.end().catch(() => undefined); await close(); } };
  } catch (err) {
    await close();
    throw err;
  }
}
