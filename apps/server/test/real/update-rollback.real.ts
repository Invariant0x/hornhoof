import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeadUpdate } from '../../src/modules/keeper/lead-update.js';
import { keeperSql } from '../../src/modules/keeper/lease-store.js';
import { DROPPED_FILE, PROMISED_FILE, SETTLED_FILE } from '../../src/modules/updates/control.js';
import { syncedPair, type SyncedPair } from './pair.js';

let p: SyncedPair;
const folders: string[] = [];

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-update-'));
  folders.push(dir);
  return dir;
}

async function connected(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  /* Dropping a database ends every session on it: the next query on it fails, and nothing else comes of it. */
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

beforeAll(async () => {
  p = await syncedPair();
  /* The copy is the one commits wait for, and the relay was told so. */
  await p.wait(async () => p.record()?.state === 'on' && p.controller.named() !== null, 300_000, 'the copy named at the relay');
}, 900_000);

afterAll(async () => {
  await p?.close();
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
}, 300_000);

describe('an update that goes back while a copy follows', () => {
  it('puts the saved database back once the copies stopped and their slots went', { timeout: 900_000 }, async () => {
    const [dir, controlDir] = [folder(), folder()];
    const said = { leads: false, maintenance: false };
    const told: object[] = [];
    const copy = await connected(p.copyUrl('hornhoof'));
    const subscription = p.maker.report()!.name!;
    const sql = keeperSql(p.leader.url, { timeoutMs: 60_000 });
    const update = new LeadUpdate({
      dir, controlDir, sql, sync: p.controller,
      /* The copy's keeper, as far as an update asks it: it promises, stops applying when told, and follows again once
         the update ended. */
      peer: () => ({
        request: async (_method, _path, body) => {
          const word = body as { stop?: boolean; ended?: boolean };
          told.push(word);
          if (word.stop) {
            p.keeping(false);
            await copy.query(`ALTER SUBSCRIPTION ${subscription} DISABLE`);
          }
          if (word.ended) await copy.query(`ALTER SUBSCRIPTION ${subscription} ENABLE`);
          return { status: 200, body: { ok: true } };
        },
      }),
      hostname: async () => 'copy', leads: () => said.leads, maintenance: () => said.maintenance,
      log: line => p.lines.push(line),
    });
    const status = (step: string, more: object = {}) =>
      writeFileSync(join(controlDir, 'status.json'), JSON.stringify({ id: 'u1', version: '0.19.0', state: 'running', step, log: '', at: 'now', migrations: 1, restore: false, ...more }));
    const answer = (name: string) => (existsSync(join(controlDir, name)) ? (JSON.parse(readFileSync(join(controlDir, name), 'utf8')) as unknown) : null);
    /* The keeper looks four times a second, until the updater has its answer. */
    const until = async (done: () => boolean | Promise<boolean>, what: string, ms = 180_000) => {
      const end = Date.now() + ms;
      for (;;) {
        await update.look();
        if (await done()) return;
        if (Date.now() > end) throw new Error(`Did not see ${what} in time. Said: ${p.lines.join(' | ') || 'nothing'}`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    };
    try {
      /* The copy promises to wait. */
      status('promise');
      await until(() => answer(PROMISED_FILE) !== null, 'the promise');
      expect(answer(PROMISED_FILE)).toEqual({ id: 'u1', ok: true });

      /* The app writes its last rows; then the lease is in maintenance, and where the log ends is W. */
      const app = await p.app();
      await app.query(`INSERT INTO notebook_notes (company_id, number, text) SELECT id, 1, 'before the update' FROM companies`);
      await app.end();
      said.maintenance = true;
      status('backup');
      await until(() => answer(SETTLED_FILE) !== null, 'the word about the dump');
      /* The copy held everything, stopped, and commits wait for no copy: the dump may be taken. */
      expect(answer(SETTLED_FILE)).toEqual({ id: 'u1', ok: true });
      expect(told).toContainEqual({ stop: true });
      expect((await p.leader.admin.query<{ synchronous_standby_names: string }>('SHOW synchronous_standby_names')).rows[0]!.synchronous_standby_names).toBe('');
      expect(p.record()).toMatchObject({ state: 'off' });
      expect((await copy.query(`SELECT 1 FROM notebook_notes WHERE text = 'before the update'`)).rows).toHaveLength(1);
      expect((await p.leader.admin.query('SELECT version FROM net_local.maintenance')).rows).toEqual([{ version: '0.19.0' }]);

      /* The dump, as the updater takes it, and then a migration of the new build. */
      const dump = await p.leader.exec(['pg_dump', '-U', 'hornhoof', '-d', 'hornhoof']);
      // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- The database of this file's own Postgres server, which goes with it.
      await p.leader.admin.query('ALTER TABLE tasks ADD COLUMN made_by_the_update text');

      /* The new build did not answer: the database goes back to the dump. Not while a slot holds the one in use. */
      status('rollback', { restore: true });
      await until(() => answer(DROPPED_FILE) !== null, "the word that the copies' slots went");
      expect((await p.leader.admin.query('SELECT 1 FROM pg_replication_slots')).rows).toEqual([]);
      const asOwner = ['psql', '-U', 'hornhoof', '-v', 'ON_ERROR_STOP=1', '-q'];
      await p.leader.exec([...asOwner, '-d', 'postgres', '-c', 'DROP DATABASE IF EXISTS hornhoof_restore', '-c', 'CREATE DATABASE hornhoof_restore OWNER hornhoof TEMPLATE template0']);
      await p.leader.exec([...asOwner, '-d', 'hornhoof_restore'], { stdin: dump });
      await p.leader.exec([...asOwner, '-d', 'postgres', '-c', 'DROP DATABASE IF EXISTS hornhoof WITH (FORCE)', '-c', 'ALTER DATABASE hornhoof_restore RENAME TO hornhoof']);

      /* The database is as it was saved: in maintenance, and with nothing of the migration. */
      const restored = await connected(p.leader.url);
      try {
        expect((await restored.query('SELECT version FROM net_local.maintenance')).rows).toEqual([{ version: '0.19.0' }]);
        expect((await restored.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'made_by_the_update'`)).rows).toEqual([]);
        expect((await restored.query(`SELECT 1 FROM notebook_notes WHERE text = 'before the update'`)).rows).toHaveLength(1);

        /* The build from before runs again and leads: the update ends, and the copy follows again. */
        status('finished', { state: 'rolled_back', restore: true });
        said.maintenance = false;
        said.leads = true;
        await until(() => !update.busy(), 'the end of the update');
        expect((await restored.query('SELECT 1 FROM net_local.maintenance')).rows).toEqual([]);
        expect(told.at(-1)).toEqual({ ended: true });
        expect([answer(PROMISED_FILE), answer(SETTLED_FILE), answer(DROPPED_FILE)]).toEqual([null, null, null]);
        /* Its slot is gone with the database that held it, so the copy makes itself again from the leader. */
        expect((await restored.query('SELECT 1 FROM pg_replication_slots')).rows).toEqual([]);
        const view = { slot: 'missing' as const, leaderSize: 50 * 2 ** 20, migrations: null, old: null, upload: null, lastAttempt: null };
        /* Two views without its slot decide it; the step after says so. */
        for (let views = 0; views < 4 && p.maker.report()?.state !== 'remaking'; views++) await p.maker.tick({ ...view });
        expect(p.maker.report()).toMatchObject({ state: 'remaking' });
      } finally {
        await restored.end().catch(() => undefined);
      }
    } finally {
      await update.stop();
      await sql.close().catch(() => undefined);
      await copy.end().catch(() => undefined);
    }
  });
});
