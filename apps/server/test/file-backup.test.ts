import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, attachments, machines } from '../src/db/schema.js';
import { fileStoreState } from '../src/modules/files/copies.js';
import { machineSeats } from '../src/modules/files/place.js';
import { storeRound } from '../src/modules/files/sweep.js';
import { BACKUP_FILE_PATH, FILE_PATH, FileHolder, type FileLink } from '../src/modules/keeper/file-holder.js';
import { LeaderFiles } from '../src/modules/keeper/leader-files.js';
import { backupCompany, from, MACHINE_ID } from './helpers-backups.js';

/* The store's own backup (#2056): every content a row names, kept apart from the live store, for 30 days after no row
   names it any more. Synthetic files and machines only; the rounds run at the times the test names. */

const DAY = 24 * 60 * 60 * 1000;
const rowsOf = <T>(answer: unknown): T[] => (answer as { rows: T[] }).rows;

async function stand() {
  const c = await backupCompany();
  const dir = mkdtempSync(join(tmpdir(), 'hornhoof-backup-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  c.app.ctx.config.filesDir = dir;
  const [server] = await c.db.select().from(machines).where(eq(machines.networkId, MACHINE_ID));
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  /* A file a person sent: its bytes in the store, and its row. */
  const sent = async (bytes: Buffer) => {
    const { sha256, size } = await c.app.ctx.files.putBytes(c.db, bytes);
    const [row] = await c.db.insert(attachments).values({ companyId: c.acme.id, agentId: orchestrator!.id, personId: c.owner.id, name: 'notes.bin', mediaType: 'application/octet-stream', sha256, size }).returning();
    return row!;
  };
  const round = (at: Date) => storeRound(c.app.ctx, at);
  const backedUp = (sha256: string) => existsSync(join(dir, 'store-backup', sha256.slice(0, 2), sha256));
  const live = (sha256: string) => c.app.ctx.files.store().has(sha256);
  const recorded = async (sha256: string) => rowsOf(await c.db.execute(sql`SELECT 1 FROM net.file_backups WHERE sha256 = ${sha256}`)).length === 1;
  const leader = new LeaderFiles(c.db, join(dir, 'store'), MACHINE_ID, () => c.app.ctx.files.key(c.db));
  /* A machine's keeper as it reaches the leader: its asks go to the leading app's routes under its id, and its streams to
     the leading keeper. Its backup lies beside its store. */
  const holderOn = (machine: string) => {
    const own = mkdtempSync(join(tmpdir(), 'hornhoof-holder-'));
    onTestFinished(() => rmSync(own, { recursive: true, force: true }));
    const link: FileLink = {
      leader: () => true,
      request: async (method, path, body) => {
        const res = await c.app.inject({ method, url: path, ...(body === undefined ? {} : { payload: body as object }), ...from(machine) });
        return { status: res.statusCode, body: res.json() };
      },
      stream: async (method, path, body) => {
        const backup = path.startsWith(BACKUP_FILE_PATH);
        const sha256 = path.slice((backup ? BACKUP_FILE_PATH : FILE_PATH).length);
        if (method === 'PUT') return { status: await leader.take(machine, sha256, body!, backup), length: null, body: Readable.from([]) };
        const found = await leader.give(machine, sha256, backup);
        return found.status === 200 ? { status: 200, length: found.length, body: found.stream() } : { status: found.status, length: null, body: Readable.from([]) };
      },
    };
    const holder = new FileHolder({ dir: join(own, 'store'), link, log: () => undefined });
    return { holder, backedUp: (sha256: string) => existsSync(join(own, 'store-backup', sha256.slice(0, 2), sha256)), backupDir: join(own, 'store-backup') };
  };
  const targetsOf = async (sha256: string) =>
    rowsOf<{ machine_id: string }>(await c.db.execute(sql`SELECT machine_id FROM net.file_targets WHERE sha256 = ${sha256}`)).map(row => row.machine_id).sort();
  return { ...c, dir, server: server!, sent, round, backedUp, live, recorded, leader, holderOn, targetsOf };
}

describe("the store's own backup", () => {
  it('keeps every content a row names in a backup of its own on the leading machine, apart from its live store, and says so', async () => {
    const s = await stand();
    const t0 = new Date();
    const one = await s.sent(randomBytes(3000));
    const two = await s.sent(randomBytes(70_000));
    expect(s.backedUp(one.sha256!)).toBe(false);
    await s.round(t0);
    expect([s.backedUp(one.sha256!), s.backedUp(two.sha256!)]).toEqual([true, true]);
    /* A copy of its own: the live file can go and the backup keeps it. */
    await s.app.ctx.files.store().remove(one.sha256!);
    expect(s.backedUp(one.sha256!)).toBe(true);
    const sealed = rowsOf<{ bytes: string }>(await s.db.execute(sql`SELECT sum(sealed_size) AS bytes FROM net.files`))[0]!.bytes;
    expect((await fileStoreState(s.app.ctx)).backup).toEqual({
      machineId: s.server.id,
      apart: false,
      away: false,
      files: 2,
      bytes: Number(sealed),
      waiting: 0,
      keptAt: t0.toISOString(),
      oldestAt: t0.toISOString(),
      keepDays: 30,
    });
  });

  it('keeps a deleted file 30 days after its row went, and lets it go after them', async () => {
    const s = await stand();
    const t0 = new Date();
    const row = await s.sent(randomBytes(5000));
    await s.round(t0);
    await s.db.delete(attachments).where(eq(attachments.id, row.id));
    const gone = new Date(t0.getTime() + 60_000);
    await s.round(gone);
    /* The live store lets it go a day after no row names it; the backup keeps it. */
    await s.round(new Date(gone.getTime() + 2 * DAY));
    expect([s.live(row.sha256!), s.backedUp(row.sha256!)]).toEqual([false, true]);
    await s.round(new Date(gone.getTime() + 30 * DAY - 60_000));
    expect([s.backedUp(row.sha256!), await s.recorded(row.sha256!)]).toEqual([true, true]);
    await s.round(new Date(gone.getTime() + 30 * DAY + 60_000));
    expect([s.backedUp(row.sha256!), await s.recorded(row.sha256!)]).toEqual([false, false]);
    expect(rowsOf(await s.db.execute(sql`SELECT 1 FROM net.file_backup_names WHERE attachment_id = ${row.id}`))).toEqual([]);
  });

  it('keeps what a row named before it was overwritten, with when it named it, for 30 days', async () => {
    const s = await stand();
    const t0 = new Date();
    const row = await s.sent(randomBytes(4000));
    await s.round(t0);
    const after = await s.app.ctx.files.putBytes(s.db, randomBytes(4100));
    await s.db.update(attachments).set({ sha256: after.sha256, size: after.size }).where(eq(attachments.id, row.id));
    const changed = new Date(t0.getTime() + 60_000);
    await s.round(changed);
    const names = rowsOf<{ sha256: string; since: Date | string; until: Date | string | null }>(
      await s.db.execute(sql`SELECT sha256, since, until FROM net.file_backup_names WHERE attachment_id = ${row.id} ORDER BY since`),
    ).map(name => ({ sha256: name.sha256, since: new Date(name.since).toISOString(), until: name.until === null ? null : new Date(name.until).toISOString() }));
    expect(names).toEqual([
      { sha256: row.sha256, since: t0.toISOString(), until: changed.toISOString() },
      { sha256: after.sha256, since: changed.toISOString(), until: null },
    ]);
    await s.round(new Date(changed.getTime() + 29 * DAY));
    expect([s.live(row.sha256!), s.backedUp(row.sha256!), s.backedUp(after.sha256)]).toEqual([false, true, true]);
    await s.round(new Date(changed.getTime() + 31 * DAY));
    expect([s.backedUp(row.sha256!), s.backedUp(after.sha256)]).toEqual([false, true]);
  });

  it('never lets go of a content a row names, however long ago it came, and keeps the days the CEO set', async () => {
    const s = await stand();
    const t0 = new Date();
    const kept = await s.sent(randomBytes(3000));
    const other = await s.sent(randomBytes(3000));
    await s.round(t0);
    await s.db.execute(sql`INSERT INTO net.file_backup_settings (keep_days, set_by) VALUES (7, 'person:test') ON CONFLICT (one) DO UPDATE SET keep_days = 7`);
    await s.db.delete(attachments).where(eq(attachments.id, other.id));
    await s.round(new Date(t0.getTime() + 60_000));
    await s.round(new Date(t0.getTime() + 8 * DAY));
    expect([s.backedUp(kept.sha256!), s.backedUp(other.sha256!)]).toEqual([true, false]);
    await s.round(new Date(t0.getTime() + 400 * DAY));
    expect([s.backedUp(kept.sha256!), await s.recorded(kept.sha256!)]).toEqual([true, true]);
    expect((await fileStoreState(s.app.ctx)).backup).toMatchObject({ files: 1, keepDays: 7 });
  });

  it('keeps what a merge refused still names, and every content while a database set aside may be merged back', async () => {
    const s = await stand();
    const t0 = new Date();
    const at = (days: number) => new Date(t0.getTime() + days * DAY);
    const held = await s.sent(randomBytes(2000));
    const aside = await s.sent(randomBytes(2000));
    await s.round(t0);
    const [merge] = rowsOf<{ id: string }>(await s.db.execute(sql`INSERT INTO net.merges (source, label, status) VALUES ('machine:another', 'a copy', 'merged') RETURNING id`));
    const [conflict] = rowsOf<{ id: string }>(
      await s.db.execute(sql`INSERT INTO net.merge_conflicts (merge, tbl, key, op, kind, topic, here, there, why)
        VALUES (${merge!.id}, 'attachments', '{"id": "00000000-0000-4000-8000-0000000000aa"}', 'insert', 'refused', 'work', NULL, ${JSON.stringify({ sha256: held.sha256 })}::jsonb, 'refused') RETURNING id`),
    );
    await s.db.delete(attachments).where(eq(attachments.id, held.id));
    await s.db.delete(attachments).where(eq(attachments.id, aside.id));
    await s.round(at(0.01));
    await s.db.execute(sql.raw('CREATE DATABASE hornhoof_before_backup_test'));
    onTestFinished(() => s.db.execute(sql.raw('DROP DATABASE IF EXISTS hornhoof_before_backup_test')).then(() => undefined));
    await s.round(at(31));
    expect([s.backedUp(held.sha256!), s.backedUp(aside.sha256!)]).toEqual([true, true]);
    await s.db.execute(sql.raw('DROP DATABASE hornhoof_before_backup_test'));
    await s.round(at(32));
    expect([s.backedUp(held.sha256!), s.backedUp(aside.sha256!)]).toEqual([true, false]);
    /* A side picked, nothing names it. */
    await s.db.execute(sql`UPDATE net.merge_conflicts SET picked = 'here' WHERE id = ${conflict!.id}`);
    await s.round(at(33));
    expect(s.backedUp(held.sha256!)).toBe(false);
  });
});

describe("the store's backup on another machine", () => {
  it('keeps the backup on a machine apart from the live copies when the store has more machines than copies, and says so', async () => {
    const s = await stand();
    const machinesNow = [await s.worker('one'), await s.worker('two')];
    await s.round(new Date());
    const picked = (await fileStoreState(s.app.ctx)).backup.machineId!;
    expect(machinesNow).toContain(picked);
    const other = machinesNow.find(id => id !== picked)!;
    const row = await s.sent(randomBytes(6000));
    /* Its live copies are on the other machines; the leading one keeps none of the backup. */
    expect(await s.targetsOf(row.sha256!)).toEqual([s.server.id, other].sort());
    await s.round(new Date());
    expect(s.backedUp(row.sha256!)).toBe(false);
    expect((await fileStoreState(s.app.ctx)).backup).toMatchObject({ machineId: picked, apart: true, files: 0, waiting: 1 });
    /* The backup takes room on its machine, still to come and once there. */
    const sealed = Number(rowsOf<{ sealed_size: string }>(await s.db.execute(sql`SELECT sealed_size FROM net.file_backups WHERE sha256 = ${row.sha256}`))[0]!.sealed_size);
    const taken = async () => (await machineSeats(s.db, s.server.id)).filter(seat => seat.id === picked).map(seat => seat.area - seat.room);
    expect(await taken()).toEqual([sealed]);
    const there = s.holderOn(picked);
    await there.holder.lookOnce();
    expect([there.backedUp(row.sha256!), there.holder.store.has(row.sha256!)]).toEqual([true, false]);
    expect((await fileStoreState(s.app.ctx)).backup).toMatchObject({ machineId: picked, apart: true, files: 1, waiting: 0 });
    expect(await taken()).toEqual([sealed]);
  });

  it('keeps the backup beside a live copy on the one other machine there is, and says it is not apart', async () => {
    const s = await stand();
    const one = await s.worker('one');
    await s.round(new Date());
    const row = await s.sent(randomBytes(6000));
    expect(await s.targetsOf(row.sha256!)).toEqual([s.server.id, one].sort());
    await s.round(new Date());
    const there = s.holderOn(one);
    await there.holder.lookOnce();
    expect([there.backedUp(row.sha256!), there.holder.store.has(row.sha256!)]).toEqual([true, true]);
    expect((await fileStoreState(s.app.ctx)).backup).toMatchObject({ machineId: one, apart: false, files: 1, waiting: 0 });
  });

  it('lets the backup machine let go of a content no row named for the days kept, and of nothing a row names', async () => {
    const s = await stand();
    const one = await s.worker('one');
    const t0 = new Date();
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    await s.round(t0);
    const [kept, gone] = [await s.sent(randomBytes(3000)), await s.sent(randomBytes(3000))];
    await s.round(at(1));
    const there = s.holderOn(one);
    await there.holder.lookOnce();
    expect([there.backedUp(kept.sha256!), there.backedUp(gone.sha256!)]).toEqual([true, true]);
    await s.db.execute(sql`INSERT INTO net.file_backup_settings (keep_days, set_by) VALUES (1, 'person:test') ON CONFLICT (one) DO UPDATE SET keep_days = 1`);
    await s.db.delete(attachments).where(eq(attachments.id, gone.id));
    await s.round(at(2));
    /* The machine keeps reporting: a day and more later, the content goes from its backup, and then its record. */
    await s.db.update(machines).set({ reportAt: at(2 + 24 * 60 + 2) }).where(eq(machines.id, one));
    await s.round(at(2 + 24 * 60 + 2));
    expect(await s.recorded(gone.sha256!)).toBe(true);
    await there.holder.lookOnce();
    expect([there.backedUp(kept.sha256!), there.backedUp(gone.sha256!), await s.recorded(gone.sha256!)]).toEqual([true, false, false]);
  });

  it('fetches again a backup file its machine lost, as its census shows', async () => {
    const s = await stand();
    const one = await s.worker('one');
    await s.round(new Date());
    const row = await s.sent(randomBytes(3000));
    await s.round(new Date());
    const there = s.holderOn(one);
    await there.holder.lookOnce();
    await rm(join(there.backupDir, row.sha256!.slice(0, 2), row.sha256!));
    await there.holder.censusBackup(30);
    expect((await fileStoreState(s.app.ctx)).backup).toMatchObject({ files: 0, waiting: 1 });
    await there.holder.lookOnce();
    expect(there.backedUp(row.sha256!)).toBe(true);
    expect((await fileStoreState(s.app.ctx)).backup).toMatchObject({ files: 1, waiting: 0 });
  });

  it('keeps the backup on its machine while it is away, and moves it, with what only that machine keeps, once that machine keeps no files', async () => {
    const s = await stand();
    const t0 = new Date();
    /* One machine: the leading one keeps the backup, of a file deleted since and gone from the live store. */
    const old = await s.sent(randomBytes(4000));
    await s.round(t0);
    await s.db.delete(attachments).where(eq(attachments.id, old.id));
    await s.round(new Date(t0.getTime() + 60_000));
    await s.app.ctx.files.store().remove(old.sha256!);
    expect(s.backedUp(old.sha256!)).toBe(true);
    /* A machine joins: the backup goes to it, the content only the leading backup keeps too, and the leading one lets its go. */
    const one = await s.worker('one');
    await s.round(new Date());
    const first = s.holderOn(one);
    await first.holder.lookOnce();
    expect(first.backedUp(old.sha256!)).toBe(true);
    await s.round(new Date());
    expect(s.backedUp(old.sha256!)).toBe(false);
    expect((await fileStoreState(s.app.ctx)).backup).toMatchObject({ machineId: one, away: false, files: 1, waiting: 0 });
    /* Away for a day, it keeps the backup: what only it keeps is not left behind. */
    const two = await s.worker('two');
    await s.db.update(machines).set({ reportAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) }).where(eq(machines.id, one));
    await s.round(new Date());
    expect((await fileStoreState(s.app.ctx)).backup).toMatchObject({ machineId: one, away: true, files: 1 });
    /* Back, its owner gives the files no room on it: the other machine is picked, and fetches what only the first kept once
       the first gave it back; then the first lets its backup go. */
    await s.db.update(machines).set({ reportAt: new Date(), fileStoreLimitBytes: 0 }).where(eq(machines.id, one));
    await s.round(new Date());
    expect((await fileStoreState(s.app.ctx)).backup).toMatchObject({ machineId: two, files: 0, waiting: 1 });
    const second = s.holderOn(two);
    await second.holder.lookOnce();
    expect(second.backedUp(old.sha256!)).toBe(false);
    await first.holder.lookOnce();
    await second.holder.lookOnce();
    expect(second.backedUp(old.sha256!)).toBe(true);
    await first.holder.lookOnce();
    expect(first.backedUp(old.sha256!)).toBe(false);
    await s.round(new Date());
    expect(s.backedUp(old.sha256!)).toBe(false);
    expect((await fileStoreState(s.app.ctx)).backup).toMatchObject({ machineId: two, files: 1, waiting: 0 });
    /* A machine that keeps nothing of the backup any more neither fetches a content of it nor gives one back. */
    expect((await s.leader.give(one, old.sha256!, true)).status).toBe(403);
    expect(await s.leader.take(one, old.sha256!, Readable.from([randomBytes(4100)]), true)).toBe(403);
  });
});
