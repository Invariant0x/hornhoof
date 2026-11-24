import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { machines } from '../src/db/schema.js';
import { Files } from '../src/modules/files/files.js';
import { refreshFileHolders } from '../src/modules/files/network.js';
import { checkOwnCopies, dropDue } from '../src/modules/files/sweep.js';
import { FILE_PATH, FileHolder, type FileLink } from '../src/modules/keeper/file-holder.js';
import { LeaderFiles } from '../src/modules/keeper/leader-files.js';
import { backupCompany, from, MACHINE_ID } from './helpers-backups.js';
import { until } from './helpers.js';

/* The files of the store as they go between the company's machines: the leading app and its keeper on one machine, and
   the keepers of the machines that hold the files, which reach them through the peer link. Synthetic bytes only. */

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-net-files-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const rowsOf = <T>(answer: unknown): T[] => (answer as { rows: T[] }).rows;
const empty = () => Readable.from([]);

async function stand() {
  const c = await backupCompany();
  const leaderDir = folder();
  c.app.ctx.config.filesDir = leaderDir;
  const leader = new LeaderFiles(c.db, join(leaderDir, 'store'), MACHINE_ID);
  const [server] = await c.db.select().from(machines).where(eq(machines.networkId, MACHINE_ID));
  /* A machine's keeper as it reaches the leader: its asks go to the leading app's routes under its id, as the peer door
     names it, and its streams to the leading keeper. */
  const holderOn = (machine: string) => {
    const dir = folder();
    const link: FileLink = {
      leader: () => true,
      request: async (method, path, body) => {
        const res = await c.app.inject({ method, url: path, ...(body === undefined ? {} : { payload: body as object }), ...from(machine) });
        return { status: res.statusCode, body: res.json() };
      },
      stream: async (method, path, body) => {
        const sha256 = path.slice(FILE_PATH.length);
        if (method === 'PUT') return { status: await leader.take(machine, sha256, body!), length: null, body: empty() };
        const found = await leader.give(machine, sha256);
        return found.status === 200 ? { status: 200, length: found.length, body: found.stream() } : { status: found.status, length: null, body: empty() };
      },
    };
    return { dir, holder: new FileHolder({ dir: join(dir, 'store'), link, log: () => undefined }) };
  };
  const copiesOf = async (sha256: string) =>
    rowsOf<{ machine_id: string }>(await c.db.execute(sql`SELECT machine_id FROM net.file_copies WHERE sha256 = ${sha256} ORDER BY machine_id`)).map(row => row.machine_id).sort();
  const holders = async () => rowsOf<{ machine_id: string }>(await c.db.execute(sql`SELECT machine_id FROM net.file_holders`)).map(row => row.machine_id).sort();
  return { ...c, server: server!, leaderDir, leader, holderOn, copiesOf, holders };
}

describe('the files of the store between machines', () => {
  it('reads a file uploaded through one machine on another, which took it sealed from the first', async () => {
    const s = await stand();
    const two = await s.worker('two');
    await refreshFileHolders(s.db);
    expect(await s.holders()).toEqual([two]);
    const bytes = randomBytes(200_000);
    const kept = await s.app.ctx.files.putBytes(s.db, bytes);
    expect(await s.app.ctx.files.settled(s.db, kept.sha256, 0)).toBe(false);

    const { dir, holder } = s.holderOn(two);
    await holder.lookOnce();
    expect(holder.store.has(kept.sha256)).toBe(true);
    expect(await s.copiesOf(kept.sha256)).toEqual([s.server.id, two].sort());
    expect(await s.app.ctx.files.settled(s.db, kept.sha256, 0)).toBe(true);

    /* That machine leads now, with only its own store: it opens the file with the key the database keeps. */
    const there = new Files({ ...s.config, filesDir: dir });
    expect((await there.bytes(s.db, kept.sha256)).equals(bytes)).toBe(true);
  });

  it('gives a file only to a machine named to hold the files, and takes one back only when it was asked for', async () => {
    const s = await stand();
    const stranger = await s.worker('stranger', { keepsBackups: false });
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(1000));
    expect((await s.leader.give(stranger, kept.sha256)).status).toBe(403);
    expect((await s.app.inject({ url: '/api/network/files', ...from(stranger) })).json()).toMatchObject({ holds: false, hold: [] });
    expect(await s.leader.take(stranger, kept.sha256, Readable.from([randomBytes(10)]))).toBe(403);
    /* No asker but another machine's keeper reads the view. */
    expect((await s.app.inject({ url: '/api/network/files' })).statusCode).toBe(403);
  });

  it('loses no file with any one machine: the leader gets back what it lost, and a holder that lost its copy is filled again', async () => {
    const s = await stand();
    const [two, three] = [await s.worker('two'), await s.worker('three')];
    await refreshFileHolders(s.db);
    const bytes = [randomBytes(70_000), randomBytes(130_000)];
    const kept = [await s.app.ctx.files.putBytes(s.db, bytes[0]!), await s.app.ctx.files.putBytes(s.db, bytes[1]!)];
    const [a, b] = [s.holderOn(two), s.holderOn(three)];
    await a.holder.lookOnce();
    await b.holder.lookOnce();
    for (const file of kept) expect(await s.copiesOf(file.sha256)).toEqual([s.server.id, two, three].sort());

    /* The leader's disk lost a file: a read asks the holders, and one sends it back. */
    await s.app.ctx.files.store().remove(kept[0]!.sha256);
    expect(await checkOwnCopies(s.app.ctx)).toBe(1);
    const reading = s.app.ctx.files.bytes(s.db, kept[0]!.sha256);
    await until(async () => rowsOf<{ n: number }>(await s.db.execute(sql`SELECT count(*)::int AS n FROM net.files WHERE wanted_at IS NOT NULL`))[0]!.n === 1);
    await a.holder.lookOnce();
    expect((await reading).equals(bytes[0]!)).toBe(true);
    expect(await s.copiesOf(kept[0]!.sha256)).toEqual([s.server.id, two, three].sort());

    /* A holder's disk lost a file: its census says so, and its next look takes it again. */
    await a.holder.store.remove(kept[1]!.sha256);
    await a.holder.census();
    expect(await s.copiesOf(kept[1]!.sha256)).toEqual([s.server.id, three].sort());
    await a.holder.lookOnce();
    expect(a.holder.store.has(kept[1]!.sha256)).toBe(true);

    /* A holder goes for good: the files are still on two machines, and a new one is filled. */
    await s.db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.id, three));
    await refreshFileHolders(s.db);
    await dropDue(s.app.ctx, new Date());
    const four = await s.worker('four');
    await refreshFileHolders(s.db);
    expect(await s.holders()).toEqual([two, four].sort());
    const c = s.holderOn(four);
    await c.holder.lookOnce();
    for (const [at, file] of kept.entries()) {
      expect(await s.copiesOf(file.sha256)).toEqual([s.server.id, two, four].sort());
      expect((await new Files({ ...s.config, filesDir: c.dir }).bytes(s.db, file.sha256)).equals(bytes[at]!)).toBe(true);
    }
  });

  it('keeps nothing a holder sends back that is not the file on record', async () => {
    const s = await stand();
    const two = await s.worker('two');
    await refreshFileHolders(s.db);
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(5000));
    const { holder } = s.holderOn(two);
    await holder.lookOnce();
    await s.app.ctx.files.store().remove(kept.sha256);
    await s.db.execute(sql`UPDATE net.files SET wanted_at = now() WHERE sha256 = ${kept.sha256}`);
    expect(await s.leader.take(two, kept.sha256, Readable.from([randomBytes(5000)]))).toBe(400);
    expect(s.app.ctx.files.store().has(kept.sha256)).toBe(false);
    expect(await s.leader.take(two, kept.sha256, holder.store.sealed(kept.sha256)!.stream())).toBe(201);
    expect(s.app.ctx.files.store().has(kept.sha256)).toBe(true);
  });
});
