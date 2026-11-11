import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDb } from '../../src/db/client.js';
import { CopyMaker, SCHEMA_DIR, SCHEMA_FILE } from '../../src/modules/keeper/copy.js';
import { keeperSql } from '../../src/modules/keeper/lease-store.js';
import { ensurePublication, ensureReplica, REPLICA_ROLE, replicaPassword } from '../../src/modules/keeper/replica.js';
import { ENDLESS_LEASE } from '../prepare-environment.js';
import { realCluster, run, type Platform, type RealCluster } from './pg.js';

export type Pair = {
  leader: RealCluster;
  copy: RealCluster;
  maker: CopyMaker;
  /* The password of the role the copy reads the leader with, and the id the copy's machine goes by. */
  password: string;
  networkId: string;
  /* The owner's way into a database of the copy by its name. */
  copyUrl(database: string): string;
  /* The updater's part for the request the maker left, when there is one: whether it loaded a schema. */
  playUpdater(): Promise<boolean>;
  /* Ticks, with the updater's part between them, until the copy says this or the time is up. */
  until(done: () => boolean | Promise<boolean>, ms?: number): Promise<void>;
  lines: string[];
  close(): Promise<void>;
};

const withDatabase = (url: string, database: string): string => {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.href;
};

/* Two Postgres servers on a Docker network of their own: a leader, migrated, with the role and the publication its
   keeper makes, and a machine that is to keep a copy, with the maker of that copy. The copy's database reaches the
   leader's by its name on that network, not through a keeper's door: the door's path is the lab's. */
export async function pair(opts: { leader?: Platform; copy?: Platform } = {}): Promise<Pair> {
  const tag = randomBytes(4).toString('hex');
  const network = `hh-pair-${tag}`;
  await run('docker', ['network', 'create', network]);
  const made: RealCluster[] = [];
  const folders = [mkdtempSync(join(tmpdir(), 'hh-pair-control-')), mkdtempSync(join(tmpdir(), 'hh-pair-keeper-'))] as const;
  const close = async (): Promise<void> => {
    await maker?.stop();
    for (const cluster of made) await cluster.close();
    await run('docker', ['network', 'rm', network]).catch(() => undefined);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  };
  let maker: CopyMaker | undefined;
  try {
    const leader = await realCluster({ network, name: `hh-pair-${tag}-leader`, platform: opts.leader });
    made.push(leader);
    const copy = await realCluster({ network, name: `hh-pair-${tag}-copy`, platform: opts.copy });
    made.push(copy);
    await migrateDb(leader.url);
    await leader.admin.query(ENDLESS_LEASE);
    const password = replicaPassword(randomBytes(32));
    await ensureReplica(() => keeperSql(leader.url, { timeoutMs: 20_000 }), password);
    const sql = keeperSql(leader.url, { timeoutMs: 20_000 });
    await ensurePublication(sql);
    await sql.close();
    const [controlDir, dir] = folders;
    const networkId = randomBytes(32).toString('hex');
    const lines: string[] = [];
    const copyUrl = (database: string) => withDatabase(copy.url, database);
    maker = new CopyMaker({
      admin: keeperSql(copyUrl('postgres'), { timeoutMs: 20_000 }),
      db: database => keeperSql(copyUrl(database), { timeoutMs: 20_000 }),
      controlDir, dir, networkId, password,
      diskFree: () => 100 * 2 ** 30,
      log: line => lines.push(line),
      publisher: { host: leader.host, port: 5432 },
    });
    /* What updater.sh does for schema.json, by the same commands, in the copy's own container. */
    const playUpdater = async (): Promise<boolean> => {
      const request = join(controlDir, SCHEMA_FILE);
      if (!existsSync(request)) return false;
      const asked = JSON.parse(readFileSync(request, 'utf8')) as { attempt: number; database: string; port: number; password: string };
      const dump = (flags: string[]) => copy.exec(['pg_dump', '-h', leader.host, '-p', '5432', '-U', REPLICA_ROLE, ...flags, 'hornhoof'], { env: { PGPASSWORD: asked.password }, pass: ['PGPASSWORD'] });
      const schema = (await dump(['--schema-only', '--no-owner', '--no-publications', '--no-subscriptions', '--no-privileges'])) + (await dump(['--data-only', '--table=drizzle.__drizzle_migrations']));
      await copy.exec(['psql', '-U', 'hornhoof', '-1', '-v', 'ON_ERROR_STOP=1', '-d', asked.database], { stdin: schema });
      await copy.exec(['sh', '-c', 'umask 077 && cat > "$PGDATA/replica.pgpass"'], { stdin: `*:*:*:${REPLICA_ROLE}:${asked.password}\n` });
      mkdirSync(join(controlDir, SCHEMA_DIR), { recursive: true });
      writeFileSync(join(controlDir, SCHEMA_DIR, `${asked.attempt}.done`), '');
      rmSync(request);
      return true;
    };
    const made0 = maker;
    const until = async (done: () => boolean | Promise<boolean>, ms = 120_000): Promise<void> => {
      const end = Date.now() + ms;
      for (;;) {
        await made0.tick({ slot: 'ok', leaderSize: 50 * 2 ** 20, migrations: null, old: null, upload: null });
        await playUpdater();
        if (await done()) return;
        if (Date.now() > end) throw new Error(`The copy did not get there in time. It says ${JSON.stringify(made0.report())}, and its keeper said: ${lines.join(' | ') || 'nothing'}`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    };
    return { leader, copy, maker, password, networkId, copyUrl, playUpdater, until, lines, close };
  } catch (err) {
    await close();
    throw err;
  }
}
