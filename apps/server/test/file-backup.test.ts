import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, attachments, machines } from '../src/db/schema.js';
import { fileStoreState } from '../src/modules/files/copies.js';
import { storeRound } from '../src/modules/files/sweep.js';
import { backupCompany, MACHINE_ID } from './helpers-backups.js';

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
  return { ...c, dir, server: server!, sent, round, backedUp, live, recorded };
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
