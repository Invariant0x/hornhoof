import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, machines, people } from '../src/db/schema.js';
import { Files } from '../src/modules/files/files.js';
import { fileStoreState, pooledCapacity, setCopies } from '../src/modules/files/copies.js';
import { apartFromBackup, type Seat } from '../src/modules/files/place.js';
import { checkOwnCopies, dropDue, storeRound } from '../src/modules/files/sweep.js';
import { FILE_PATH, FileHolder, type FileLink } from '../src/modules/keeper/file-holder.js';
import { LeaderFiles } from '../src/modules/keeper/leader-files.js';
import { backupCompany, from, MACHINE_ID } from './helpers-backups.js';
import { as, invitePerson, until } from './helpers.js';

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
  const leader = new LeaderFiles(c.db, join(leaderDir, 'store'), MACHINE_ID, () => c.app.ctx.files.key(c.db));
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
  const targetsOf = async (sha256: string) =>
    rowsOf<{ machine_id: string }>(await c.db.execute(sql`SELECT machine_id FROM net.file_targets WHERE sha256 = ${sha256}`)).map(row => row.machine_id).sort();
  /* The store's round as the leading app runs it each minute. */
  const round = (now = new Date()) => storeRound(c.app.ctx, now);
  return { ...c, server: server!, leaderDir, leader, holderOn, copiesOf, targetsOf, round };
}

describe('the files of the store between machines', () => {
  it('reads a file uploaded through one machine on another, which took it sealed from the first', async () => {
    const s = await stand();
    const two = await s.worker('two');
    const bytes = randomBytes(200_000);
    const kept = await s.app.ctx.files.putBytes(s.db, bytes);
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id, two].sort());
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

  it('gives a file only to a machine picked to keep it, and takes one back only when it was asked for', async () => {
    const s = await stand();
    const stranger = await s.worker('stranger');
    await setCopies(s.db, 1, 'person:test');
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(1000));
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id]);
    expect((await s.leader.give(stranger, kept.sha256)).status).toBe(403);
    expect((await s.app.inject({ url: '/api/network/files', ...from(stranger) })).json()).toMatchObject({ holds: true, hold: [] });
    expect(await s.leader.take(stranger, kept.sha256, Readable.from([randomBytes(10)]))).toBe(403);
    /* No asker but another machine's keeper reads the view. */
    expect((await s.app.inject({ url: '/api/network/files' })).statusCode).toBe(403);
  });

  it('loses no file with any one machine: the leader gets back what it lost, and a holder that lost its copy is filled again', async () => {
    const s = await stand();
    const [two, three] = [await s.worker('two'), await s.worker('three')];
    const bytes = [randomBytes(70_000), randomBytes(130_000)];
    const kept = [await s.app.ctx.files.putBytes(s.db, bytes[0]!), await s.app.ctx.files.putBytes(s.db, bytes[1]!)];
    const [a, b] = [s.holderOn(two), s.holderOn(three)];
    await a.holder.lookOnce();
    await b.holder.lookOnce();
    /* Two copies of each, as asked: the leader's and one of another machine's. */
    const holderOf = async (sha256: string) => (await s.targetsOf(sha256)).find(id => id !== s.server.id)!;
    for (const file of kept) expect(await s.copiesOf(file.sha256)).toEqual([s.server.id, await holderOf(file.sha256)].sort());
    const of = (id: string) => (id === two ? a : b);

    /* The leader's disk lost a file: a read asks the holder, and it sends it back. */
    await s.app.ctx.files.store().remove(kept[0]!.sha256);
    expect(await checkOwnCopies(s.app.ctx)).toBe(1);
    const reading = s.app.ctx.files.bytes(s.db, kept[0]!.sha256);
    await until(async () => rowsOf<{ n: number }>(await s.db.execute(sql`SELECT count(*)::int AS n FROM net.files WHERE wanted_at IS NOT NULL`))[0]!.n === 1);
    await of(await holderOf(kept[0]!.sha256)).holder.lookOnce();
    expect((await reading).equals(bytes[0]!)).toBe(true);
    expect(await s.copiesOf(kept[0]!.sha256)).toEqual([s.server.id, await holderOf(kept[0]!.sha256)].sort());

    /* A holder's disk lost a file: its census says so, and its next look takes it again. */
    const one = of(await holderOf(kept[1]!.sha256));
    await one.holder.store.remove(kept[1]!.sha256);
    await one.holder.census();
    expect(await s.copiesOf(kept[1]!.sha256)).toEqual([s.server.id]);
    await one.holder.lookOnce();
    expect(one.holder.store.has(kept[1]!.sha256)).toBe(true);

    /* A holder goes for good: its files are placed on a new machine, which takes them, and nothing is lost. */
    const gone = await holderOf(kept[0]!.sha256);
    await s.db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.id, gone));
    await dropDue(s.app.ctx, new Date());
    const four = await s.worker('four');
    await s.round();
    const c = s.holderOn(four);
    await c.holder.lookOnce();
    await a.holder.lookOnce();
    await b.holder.lookOnce();
    await s.round();
    for (const [at, file] of kept.entries()) {
      const copies = await s.copiesOf(file.sha256);
      expect(copies.includes(gone)).toBe(false);
      expect(copies.length).toBe(2);
      expect(copies.includes(s.server.id)).toBe(true);
      const elsewhere = copies.find(id => id !== s.server.id)!;
      const dirOf = elsewhere === four ? c.dir : elsewhere === two ? a.dir : b.dir;
      expect((await new Files({ ...s.config, filesDir: dirOf }).bytes(s.db, file.sha256)).equals(bytes[at]!)).toBe(true);
    }
  });

  it('keeps nothing a holder sends back that is not the file on record', async () => {
    const s = await stand();
    const two = await s.worker('two');
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

/* A machine's area, as its owner sets it in its settings: null for the default, 0 for none. */
const areaOf = (s: Awaited<ReturnType<typeof stand>>, id: string, bytes: number | null) => s.db.execute(sql`UPDATE machines SET file_store_limit_bytes = ${bytes} WHERE id = ${id}`);
/* A machine whose keeper was last heard from this long ago; 0 for just now. */
const silentFor = (s: Awaited<ReturnType<typeof stand>>, id: string, ms: number) => s.db.update(machines).set({ reportAt: new Date(Date.now() - ms) }).where(eq(machines.id, id));
const HOUR = 3_600_000;

describe('where the files of the store are kept', () => {
  it('keeps a file of a company with one machine on that machine, at once', async () => {
    const s = await stand();
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(3000));
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id]);
    expect(await s.app.ctx.files.settled(s.db, kept.sha256, 0)).toBe(true);
    expect(await s.app.ctx.files.copiesStand(s.db, kept.sha256)).toBe(true);
  });

  it('keeps each file on as many machines as the CEO asks, one off site first, and lets a copy go only once the others keep it', async () => {
    const s = await stand();
    /* The machine at home has more room free; the one off site is picked all the same. */
    const home = await s.worker('home');
    const away = await s.worker('away', { path: 'relay', diskFree: 3 * 1024 ** 3 });
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(4000));
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id, away].sort());
    const [h, a] = [s.holderOn(home), s.holderOn(away)];
    await a.holder.lookOnce();
    await h.holder.lookOnce();
    expect([h.holder.store.has(kept.sha256), await s.copiesOf(kept.sha256)]).toEqual([false, [s.server.id, away].sort()]);

    await setCopies(s.db, 3, 'person:test');
    await s.round();
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id, home, away].sort());
    await h.holder.lookOnce();
    expect(await s.copiesOf(kept.sha256)).toEqual([s.server.id, home, away].sort());

    /* Two again: the copy picked last goes, and only after the two kept keep it. */
    await setCopies(s.db, 2, 'person:test');
    await s.round();
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id, away].sort());
    await h.holder.lookOnce();
    expect([h.holder.store.has(kept.sha256), await s.copiesOf(kept.sha256)]).toEqual([false, [s.server.id, away].sort()]);
  });

  it('keeps the files of a leading machine with no area on two others, and lets its own copy go once they keep them, past what it keeps for reads', async () => {
    const s = await stand();
    const [two, three] = [await s.worker('two'), await s.worker('three')];
    await areaOf(s, s.server.id, 0);
    const bytes = randomBytes(9000);
    const kept = await s.app.ctx.files.putBytes(s.db, bytes);
    expect([await s.targetsOf(kept.sha256), await s.copiesOf(kept.sha256)]).toEqual([[two, three].sort(), [s.server.id]]);
    expect(await s.app.ctx.files.copiesStand(s.db, kept.sha256)).toBe(false);
    const [b, c] = [s.holderOn(two), s.holderOn(three)];
    await b.holder.lookOnce();
    await c.holder.lookOnce();
    expect(await s.app.ctx.files.copiesStand(s.db, kept.sha256)).toBe(true);

    /* It keeps what fits the room for reads... */
    s.app.ctx.files.transitBytes = 1024 ** 3;
    await s.round();
    expect(s.app.ctx.files.store().has(kept.sha256)).toBe(true);
    /* ...and lets go of the rest. */
    s.app.ctx.files.transitBytes = 0;
    await s.round();
    expect([s.app.ctx.files.store().has(kept.sha256), await s.copiesOf(kept.sha256)]).toEqual([false, [two, three].sort()]);

    /* A read there takes it from a machine that keeps it. */
    const reading = s.app.ctx.files.bytes(s.db, kept.sha256);
    await until(async () => rowsOf<{ n: number }>(await s.db.execute(sql`SELECT count(*)::int AS n FROM net.files WHERE wanted_at IS NOT NULL`))[0]!.n === 1);
    await b.holder.lookOnce();
    expect((await reading).equals(bytes)).toBe(true);
  });

  it('keeps the files of a machine away for less than a day where they are, and gives it the new ones once it is back', async () => {
    const s = await stand();
    const two = await s.worker('two');
    const old = await s.app.ctx.files.putBytes(s.db, randomBytes(2000));
    const h = s.holderOn(two);
    await h.holder.lookOnce();
    await silentFor(s, two, 3 * HOUR);
    const fresh = await s.app.ctx.files.putBytes(s.db, randomBytes(2500));
    expect(await s.targetsOf(fresh.sha256)).toEqual([s.server.id]);
    /* The upload is answered at once, and the file is not moved out of a row while it waits for its second copy. */
    expect([await s.app.ctx.files.settled(s.db, fresh.sha256, 0), await s.app.ctx.files.copiesStand(s.db, fresh.sha256)]).toEqual([true, false]);
    await s.round();
    expect([await s.targetsOf(old.sha256), await s.targetsOf(fresh.sha256)]).toEqual([[s.server.id, two].sort(), [s.server.id]]);

    await silentFor(s, two, 0);
    await s.round();
    expect(await s.targetsOf(fresh.sha256)).toEqual([s.server.id, two].sort());
    await h.holder.lookOnce();
    expect(await s.app.ctx.files.copiesStand(s.db, fresh.sha256)).toBe(true);
  });

  it('places the files of a machine away for over a day on another, and that machine lets them go once it is back', async () => {
    const s = await stand();
    const ids = [await s.worker('two'), await s.worker('three')];
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(6000));
    const picked = (await s.targetsOf(kept.sha256)).find(id => id !== s.server.id)!;
    const spare = ids.find(id => id !== picked)!;
    const [p, q] = [s.holderOn(picked), s.holderOn(spare)];
    await p.holder.lookOnce();
    await q.holder.lookOnce();
    expect(q.holder.store.has(kept.sha256)).toBe(false);

    await silentFor(s, picked, 25 * HOUR);
    await s.round();
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id, picked, spare].sort());
    await q.holder.lookOnce();
    await s.round();
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id, spare].sort());

    await silentFor(s, picked, 0);
    await p.holder.lookOnce();
    expect([p.holder.store.has(kept.sha256), await s.copiesOf(kept.sha256)]).toEqual([false, [s.server.id, spare].sort()]);
  });

  it('moves the files of a machine whose area was set to nothing elsewhere before it lets them go, and keeps them there while no other has room', async () => {
    const s = await stand();
    const ids = [await s.worker('two'), await s.worker('three')];
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(5000));
    const picked = (await s.targetsOf(kept.sha256)).find(id => id !== s.server.id)!;
    const other = ids.find(id => id !== picked)!;
    const [p, q] = [s.holderOn(picked), s.holderOn(other)];
    await p.holder.lookOnce();

    /* No room on the other machine: the copy stays where it is, and the CEO sees it waits. */
    await areaOf(s, other, 1);
    await areaOf(s, picked, 0);
    await s.round();
    await p.holder.lookOnce();
    expect([await s.targetsOf(kept.sha256), p.holder.store.has(kept.sha256)]).toEqual([[s.server.id, picked].sort(), true]);
    const waiting = await fileStoreState(s.app.ctx);
    expect([waiting.effectiveCopies, waiting.underCopied, waiting.stuckBytes > 0]).toEqual([2, 1, true]);

    /* Room again: it is copied there first, and only then let go of. */
    await areaOf(s, other, null);
    await s.round();
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id, picked, other].sort());
    await p.holder.lookOnce();
    expect(p.holder.store.has(kept.sha256)).toBe(true);
    await q.holder.lookOnce();
    await s.round();
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id, other].sort());
    await p.holder.lookOnce();
    expect([p.holder.store.has(kept.sha256), await s.copiesOf(kept.sha256)]).toEqual([false, [s.server.id, other].sort()]);
    expect(await fileStoreState(s.app.ctx)).toMatchObject({ underCopied: 0, stuckBytes: 0 });
  });

  it("counts a machine's word that it keeps a file only for a file it is picked for and was given", async () => {
    const s = await stand();
    const [two, three] = [await s.worker('two'), await s.worker('three', { path: 'relay' })];
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(3000));
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id, three].sort());
    const say = (machine: string) => s.app.inject({ method: 'POST', url: '/api/network/files', payload: { held: [kept.sha256], dropped: [] }, ...from(machine) });
    /* Picked, but never given it; and not picked at all. */
    expect((await say(three)).json()).toMatchObject({ again: [kept.sha256] });
    expect((await say(two)).json()).toMatchObject({ again: [] });
    expect(await s.copiesOf(kept.sha256)).toEqual([s.server.id]);

    /* A holder that has the file from elsewhere asks for it, and its word counts from then on. */
    const { holder } = s.holderOn(three);
    const facts = await s.app.ctx.files.store().sealedFacts(kept.sha256);
    await holder.store.take(kept.sha256, s.app.ctx.files.store().sealed(kept.sha256)!.stream(), facts);
    await holder.lookOnce();
    expect(await s.copiesOf(kept.sha256)).toEqual([s.server.id, three].sort());
    expect(rowsOf(await s.db.execute(sql`SELECT 1 FROM net.file_gives`)).length).toBe(0);
  });

  it('records a file as given only once its whole stream went out, so a machine that cut it short has nothing to show', async () => {
    const s = await stand();
    const two = await s.worker('two', { path: 'relay' });
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(300_000));
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id, two].sort());
    const gives = async () => rowsOf(await s.db.execute(sql`SELECT 1 FROM net.file_gives WHERE sha256 = ${kept.sha256} AND machine_id = ${two}`)).length;
    const read = (stream: Readable, upTo: number) =>
      new Promise<number>(resolve => {
        let got = 0;
        stream.on('data', (chunk: Buffer) => {
          got += chunk.length;
          if (got >= upTo) stream.destroy();
        });
        stream.on('close', () => resolve(got));
      });

    const cut = await s.leader.give(two, kept.sha256);
    if (cut.status !== 200) throw new Error(`given ${cut.status}`);
    expect(await read(cut.stream(), 1)).toBeLessThan(cut.length);
    expect(await gives()).toBe(0);
    expect((await s.app.inject({ method: 'POST', url: '/api/network/files', payload: { held: [kept.sha256], dropped: [] }, ...from(two) })).json()).toMatchObject({ again: [kept.sha256] });

    /* A file that came out shorter than it was when it was given, as one cut on the disk meanwhile, is not given either. */
    const path = join(s.leaderDir, 'store', kept.sha256.slice(0, 2), kept.sha256);
    const short = await s.leader.give(two, kept.sha256);
    if (short.status !== 200) throw new Error(`given ${short.status}`);
    const sealed = await readFile(path);
    await truncate(path, 1000);
    expect(await read(short.stream(), Infinity)).toBe(1000);
    expect(await gives()).toBe(0);
    await writeFile(path, sealed);

    const whole = await s.leader.give(two, kept.sha256);
    if (whole.status !== 200) throw new Error(`given ${whole.status}`);
    expect(await read(whole.stream(), Infinity)).toBe(whole.length);
    expect(await gives()).toBe(1);
  });

  it('asks at most two machines online that keep a file the leading machine lacks to send it back', async () => {
    const s = await stand();
    const ids = [await s.worker('two'), await s.worker('three'), await s.worker('four'), await s.worker('five')];
    await setCopies(s.db, 5, 'person:test');
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(3000));
    for (const id of ids) await s.holderOn(id).holder.lookOnce();
    expect(await s.copiesOf(kept.sha256)).toEqual([s.server.id, ...ids].sort());
    /* One of them is away: it is not asked, and two of those online are. */
    await silentFor(s, ids[0]!, 10 * 60_000);
    await s.db.execute(sql`UPDATE net.files SET wanted_at = now() WHERE sha256 = ${kept.sha256}`);
    const asked = [];
    for (const id of ids) {
      const view = (await s.app.inject({ url: '/api/network/files', ...from(id) })).json() as { want: string[] };
      if (view.want.includes(kept.sha256)) asked.push(id);
    }
    expect(asked.length).toBe(2);
    expect(asked).not.toContain(ids[0]);
  });

  it('takes back a file only a refused merge still names, which no record here knows, from a machine that keeps it', async () => {
    const s = await stand();
    const two = await s.worker('two');
    const bytes = randomBytes(5000);
    const kept = await s.app.ctx.files.putBytes(s.db, bytes);
    const { holder } = s.holderOn(two);
    await holder.lookOnce();
    expect(holder.store.has(kept.sha256)).toBe(true);
    /* The record is gone and so is the leading machine's copy, as after a restore of an older database; a merge since
       refused a row that names the file, and nobody picked a side yet. */
    await s.db.execute(sql`DELETE FROM net.files WHERE sha256 = ${kept.sha256}`);
    await s.app.ctx.files.store().remove(kept.sha256);
    const [merge] = rowsOf<{ id: string }>(await s.db.execute(sql`INSERT INTO net.merges (source, label, status) VALUES ('machine:another', 'a copy', 'merged') RETURNING id`));
    await s.db.execute(sql`INSERT INTO net.merge_conflicts (merge, tbl, key, op, kind, topic, here, there, why)
      VALUES (${merge!.id}, 'attachments', '{"id": "00000000-0000-4000-8000-0000000000ab"}', 'insert', 'refused', 'work', NULL, ${JSON.stringify({ sha256: kept.sha256, size: bytes.length })}::jsonb, 'refused')`);
    const said = (await s.app.inject({ method: 'POST', url: '/api/network/files', payload: { held: [kept.sha256], dropped: [] }, ...from(two) })).json();
    expect(said).toMatchObject({ unknown: [], send: [kept.sha256] });
    /* Sent longer than the row says, it is refused before it is opened. */
    await s.db.execute(sql`UPDATE net.merge_conflicts SET there = jsonb_set(there, '{size}', '100') WHERE tbl = 'attachments'`);
    await holder.census();
    expect(s.app.ctx.files.store().has(kept.sha256)).toBe(false);
    await s.db.execute(sql`UPDATE net.merge_conflicts SET there = jsonb_set(there, '{size}', ${String(bytes.length)}::jsonb) WHERE tbl = 'attachments'`);
    await holder.census();
    expect(s.app.ctx.files.store().has(kept.sha256)).toBe(true);
    expect(rowsOf(await s.db.execute(sql`SELECT 1 FROM net.files WHERE sha256 = ${kept.sha256} AND size = ${bytes.length}`)).length).toBe(1);
  });

  it('counts a copy a machine was given only once it shows it keeps the bytes, and none of one that cannot', async () => {
    const s = await stand();
    const two = await s.worker('two', { path: 'relay' });
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(300_000));
    const verified = async () => rowsOf<{ verified: boolean }>(await s.db.execute(sql`SELECT verified FROM net.file_copies WHERE sha256 = ${kept.sha256} AND machine_id = ${two}`)).map(row => row.verified);
    const say = (payload: object) => s.app.inject({ method: 'POST', url: '/api/network/files', payload: { held: [], dropped: [], ...payload }, ...from(two) });

    /* Given whole and thrown away, as into /dev/null: its word puts a copy that does not count, and it is asked to show it. */
    const given = await s.leader.give(two, kept.sha256);
    if (given.status !== 200) throw new Error(`given ${given.status}`);
    for await (const _chunk of given.stream()) void _chunk;
    const [challenge] = (await say({ held: [kept.sha256] })).json().prove as { sha256: string; nonce: string; slices: { offset: number; length: number }[] }[];
    expect(challenge).toMatchObject({ sha256: kept.sha256 });
    expect(challenge!.slices.length).toBe(4);
    expect(await verified()).toEqual([false]);
    expect(await s.app.ctx.files.copiesStand(s.db, kept.sha256)).toBe(false);
    /* The view asks it again, so a machine that went away before it showed the slices shows them later. */
    expect(((await s.app.inject({ url: '/api/network/files', ...from(two) })).json() as { prove: { nonce: string }[] }).prove).toEqual([expect.objectContaining({ nonce: challenge!.nonce })]);
    /* What it sends without the bytes does not match: the copy is gone and it is to fetch the file again. */
    const mac = createHash('sha256').update(randomBytes(32)).digest('hex');
    await say({ proofs: [{ sha256: kept.sha256, nonce: challenge!.nonce, mac }] });
    expect(await verified()).toEqual([]);
    expect(rowsOf(await s.db.execute(sql`SELECT 1 FROM net.file_gives WHERE machine_id = ${two}`)).length).toBe(0);

    /* A holder that keeps the bytes shows them in the same look, and its copy counts. */
    const { holder } = s.holderOn(two);
    await holder.lookOnce();
    expect(await verified()).toEqual([true]);
    expect(await s.app.ctx.files.copiesStand(s.db, kept.sha256)).toBe(true);
  });

  it('lets no copy go on the word of a machine that has not shown it keeps the file', async () => {
    const s = await stand();
    const [two, three] = [await s.worker('two'), await s.worker('three', { path: 'relay' })];
    await setCopies(s.db, 3, 'person:test');
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(3000));
    const b = s.holderOn(two);
    await b.holder.lookOnce();
    /* The machine off site was given the file, says it keeps it, and never shows it. */
    const given = await s.leader.give(three, kept.sha256);
    if (given.status !== 200) throw new Error(`given ${given.status}`);
    for await (const _chunk of given.stream()) void _chunk;
    await s.app.inject({ method: 'POST', url: '/api/network/files', payload: { held: [kept.sha256], dropped: [] }, ...from(three) });

    /* Fewer copies asked: the one that goes is the one that does not count, never the machine at home that showed it,
       though the machine off site was picked first. */
    await s.db.execute(sql`UPDATE net.file_targets SET at = at - interval '1 hour' WHERE sha256 = ${kept.sha256} AND machine_id = ${three}`);
    await setCopies(s.db, 2, 'person:test');
    await s.round();
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id, two].sort());
    /* Even picked again, the machine off site, while it shows nothing, does not let the one at home go. */
    await s.db.execute(sql`DELETE FROM net.file_targets WHERE sha256 = ${kept.sha256} AND machine_id = ${two}`);
    await s.db.execute(sql`INSERT INTO net.file_targets (sha256, machine_id) VALUES (${kept.sha256}, ${three})`);
    await b.holder.lookOnce();
    expect(b.holder.store.has(kept.sha256)).toBe(true);
  });

  it('seals a file uploaded again, which the leading machine let go of, under the salt its copies elsewhere have', async () => {
    const s = await stand();
    const two = await s.worker('two');
    await areaOf(s, s.server.id, 0);
    const bytes = randomBytes(150_000);
    const kept = await s.app.ctx.files.putBytes(s.db, bytes);
    const { holder } = s.holderOn(two);
    await holder.lookOnce();
    s.app.ctx.files.transitBytes = 0;
    await s.round();
    expect(s.app.ctx.files.store().has(kept.sha256)).toBe(false);
    const record = async () => rowsOf<{ sealed_sha256: string; salt: string }>(await s.db.execute(sql`SELECT sealed_sha256, salt FROM net.files WHERE sha256 = ${kept.sha256}`))[0]!;
    const before = await record();

    await s.app.ctx.files.putBytes(s.db, bytes);
    expect(await record()).toEqual(before);
    expect((await s.app.ctx.files.store().sealedFacts(kept.sha256)).sealedSha256).toBe(before.sealed_sha256);
    expect((await holder.store.sealedFacts(kept.sha256)).sealedSha256).toBe(before.sealed_sha256);
  });

  it("shows the CEO how the store stands and takes the copies he asks for, from him or the orchestrator for him alone", async () => {
    const s = await stand();
    await s.worker('two');
    const [owner] = await s.db.select().from(people).where(eq(people.isOwner, true));
    const [orchestrator] = await s.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const zed = await invitePerson(s.app, s.ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    const inside = { headers: orchestratorHeaders(owner!.id, orchestrator!.id) };
    const read = (who: object) => s.app.inject({ url: '/api/company/file-store', ...who });
    const set = (payload: object, who: object) => s.app.inject({ method: 'PATCH', url: '/api/company/file-store', payload, ...who });
    await s.app.ctx.files.putBytes(s.db, randomBytes(1000));

    for (const [who, status] of [[as(zed), 403], [{}, 401]] as const) expect([(await read(who)).statusCode, (await set({ copies: 3 }, who)).statusCode]).toEqual([status, status]);
    expect((await read(as(s.ceo))).json()).toMatchObject({ copies: 2, effectiveCopies: 2, machines: 2, filesBytes: 1000, underCopied: 1, stuckBytes: 0, capacityBytes: 10 * 1024 ** 3 });
    for (const bad of [{ copies: 0 }, { copies: 6 }, { copies: 2.5 }, { copies: 2, more: 1 }]) expect((await set(bad, as(s.ceo))).statusCode).toBe(400);
    expect((await set({ copies: 3 }, inside)).json()).toMatchObject({ copies: 3, effectiveCopies: 2 });
    expect((await set({ copies: 1 }, as(s.ceo))).json()).toMatchObject({ copies: 1, effectiveCopies: 1, underCopied: 0, capacityBytes: 20 * 1024 ** 3 });
    expect(rowsOf<{ set_by: string }>(await s.db.execute(sql`SELECT set_by FROM net.file_settings`))[0]!.set_by).toBe(`person:${owner!.id}`);
  });

  it('lets a machine not picked for a file keep its copy while fewer machines picked for it that count keep it than wanted', async () => {
    const s = await stand();
    const [two, three] = [await s.worker('two'), await s.worker('three')];
    await setCopies(s.db, 3, 'person:test');
    const kept = await s.app.ctx.files.putBytes(s.db, randomBytes(3000));
    const [b, c] = [s.holderOn(two), s.holderOn(three)];
    await b.holder.lookOnce();
    await c.holder.lookOnce();
    await setCopies(s.db, 2, 'person:test');
    await s.round();
    const picked = await s.targetsOf(kept.sha256);
    expect(picked.length).toBe(2);
    const spare = picked.includes(two) ? three : two;
    const other = spare === two ? three : two;
    /* The other picked machine goes silent for over a day before the one not picked looks: its copy stays. */
    await silentFor(s, other, 25 * HOUR);
    const holderOfSpare = spare === two ? b : c;
    await holderOfSpare.holder.lookOnce();
    expect(holderOfSpare.holder.store.has(kept.sha256)).toBe(true);
    /* And it is picked again, as it keeps the file. */
    await s.round();
    expect(await s.targetsOf(kept.sha256)).toEqual([s.server.id, spare].sort());
  });

  it('keeps no live copy on the machine that keeps the store backup while the others are as many as the copies asked for', () => {
    const seat = (id: string, over: Partial<Seat> = {}): Seat => ({ id, leader: false, fit: true, online: true, lost: false, addresses: [], relayed: false, area: 100, assigned: 0, room: 100, backup: false, ...over });
    const all = [seat('a', { leader: true }), seat('b'), seat('c')];
    expect(apartFromBackup(all, ['c'], 2).map(one => [one.id, one.fit, one.backup])).toEqual([['a', true, false], ['b', true, false], ['c', false, true]]);
    expect(apartFromBackup(all, ['c'], 3).map(one => [one.id, one.fit, one.backup])).toEqual([['a', true, false], ['b', true, false], ['c', true, true]]);
    expect(apartFromBackup([all[0]!, seat('b', { lost: true }), all[2]!], ['c'], 2).find(one => one.id === 'c')!.fit).toBe(true);
  });

  it('calls no file a machine keeps unknown while a database set aside may be merged back', async () => {
    const s = await stand();
    const two = await s.worker('two');
    const stranger = createHash('sha256').update(randomBytes(16)).digest('hex');
    const say = () => s.app.inject({ method: 'POST', url: '/api/network/files', payload: { held: [stranger], dropped: [] }, ...from(two) });
    expect((await say()).json()).toMatchObject({ unknown: [stranger] });
    await s.db.execute(sql.raw('CREATE DATABASE hornhoof_before_20261124_090000'));
    expect((await say()).json()).toMatchObject({ unknown: [] });
  });

  it('counts what the areas hold of files kept on as many machines', () => {
    const GIB = 1024 ** 3;
    expect(pooledCapacity([100 * GIB, 10 * GIB, 10 * GIB], 2)).toBe(20 * GIB);
    expect(pooledCapacity([100 * GIB, 10 * GIB, 10 * GIB], 1)).toBe(120 * GIB);
    expect(pooledCapacity([100 * GIB, 10 * GIB, 10 * GIB], 3)).toBe(10 * GIB);
    expect(pooledCapacity([30, 30, 30], 2)).toBe(45);
    expect(pooledCapacity([10 * GIB], 2)).toBe(0);
  });
});
