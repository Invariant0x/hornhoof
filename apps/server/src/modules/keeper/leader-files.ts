import { dirname, join } from 'node:path';
import { pipeline, Transform, type Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { backsUpStore } from '../files/backup.js';
import { recordFile, sealedAsRecorded } from '../files/files.js';
import { keepsFiles, pickedFor } from '../files/network.js';
import { placeFiles } from '../files/place.js';
import { challengeOf, macOf } from '../files/proof.js';
import { sealedSizeOf } from '../files/seal.js';
import { namedUnrecorded } from '../files/sweep.js';
import { FileStore, StoreRefused } from '../files/store.js';

/* A file no record describes is taken back at most as long as the size its row names, sealed, and never longer than this. */
const UNRECORDED_BYTES = 2 * 1024 ** 3;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);

/* The leading keeper's side of the company's files: it gives a sealed file of the store, which it shares with its app,
   only to a machine picked to keep that file, and records that it gave it, so that machine's word that it keeps the file
   counts. A file it lacks it asks the machines that keep it for, so a machine picked for a file the leading one keeps no
   copy of still gets it, through this one. It takes a file back only when its app asked for it, and only as long and
   with the sealed hash the record says. */
export class LeaderFiles {
  readonly store: FileStore;
  /* The store's backup on this machine, beside its store, as the leading app keeps it while no other machine does. */
  readonly backup: FileStore;

  /* own: the network id of this machine, whose row the copy taken back is recorded under. key: the store key, which opens
     a file a merge brought a row of and no record describes. */
  constructor(private readonly db: Db, dir: string, private readonly own: string | null, private readonly key?: () => Promise<Buffer>) {
    this.store = new FileStore(dir);
    this.backup = new FileStore(join(dirname(dir), 'store-backup'));
  }

  private async ownRow(): Promise<string | null> {
    if (!this.own) return null;
    const [row] = rowsOf<{ id: string }>(await this.db.execute(sql`SELECT id FROM machines WHERE network_id = ${this.own} AND revoked_at IS NULL`));
    return row?.id ?? null;
  }

  /* A file a row names and no record describes, as one a merge brought or keeps refused, from a machine the leading app
     asked for it, or one that keeps the store's backup: kept once it opens to its name. */
  private async takeUnrecorded(machine: string, sha256: string, body: Readable): Promise<number> {
    const [named] = rowsOf<{ size: string | null }>(await this.db.execute(namedUnrecorded(sql`n.sha256 = ${sha256}`)));
    if (!named || named.size === null || !this.key) return 403;
    const restores = await backsUpStore(this.db, machine, sha256);
    const [asked] = rowsOf<{ asked: boolean }>(await this.db.execute(sql`SELECT EXISTS (SELECT 1 FROM net.file_wants WHERE sha256 = ${sha256} AND machine_id = ${machine} AND until > now()) AS asked`));
    if (!restores && !(asked?.asked && (await keepsFiles(this.db, machine)))) return 403;
    try {
      await this.store.takeOpened(sha256, body, await this.key(), Math.min(UNRECORDED_BYTES, sealedSizeOf(Number(named.size))));
    } catch (err) {
      if (err instanceof StoreRefused) return 400;
      throw err;
    }
    await recordFile(this.db, { sha256, size: Number(named.size), ...(await this.store.sealedFacts(sha256)) }, await this.ownRow());
    await this.db.execute(sql`INSERT INTO net.file_copies (sha256, machine_id, verified) VALUES (${sha256}, ${machine}, true) ON CONFLICT (sha256, machine_id) DO UPDATE SET verified = true`);
    await this.db.execute(sql`DELETE FROM net.file_wants WHERE sha256 = ${sha256}`);
    return 201;
  }

  /* A file for a machine picked to keep it, recorded as given once its whole stream went out, so its word that it keeps
     it counts: a stream cut short, or one the machine let go of unread, records nothing. Or for the machine that keeps the
     store's backup, which takes no copy's place. */
  async give(machine: string, sha256: string, backup = false): Promise<{ status: 200; length: number; stream(): Readable } | { status: 403 | 404 }> {
    if (backup) return this.giveBackup(machine, sha256);
    const picked = await pickedFor(this.db, machine, sha256);
    if (!picked && !(await backsUpStore(this.db, machine, sha256))) return { status: 403 };
    const sealed = this.store.sealed(sha256);
    if (!sealed) {
      await this.db.execute(sql`UPDATE net.files SET wanted_at = now() WHERE sha256 = ${sha256}`);
      return { status: 404 };
    }
    if (!picked) return { status: 200, length: sealed.length, stream: sealed.stream };
    /* With the receipt, what the machine is to show it keeps the bytes: a few slices of this very copy, under a nonce. */
    const given = async () => {
      const { nonce, slices } = challengeOf(sealed.length);
      const mac = macOf(nonce, await this.store.slicesOf(sha256, slices));
      await this.db.execute(sql`INSERT INTO net.file_gives (sha256, machine_id, nonce, slices, mac) VALUES (${sha256}, ${machine}, ${nonce}, ${JSON.stringify(slices)}::jsonb, ${mac})
        ON CONFLICT (sha256, machine_id) DO UPDATE SET at = now(), nonce = EXCLUDED.nonce, slices = EXCLUDED.slices, mac = EXCLUDED.mac`);
    };
    return {
      status: 200,
      length: sealed.length,
      stream: () => {
        /* Counted on the way out, without starting the file's flow before the one it goes to reads it. */
        let sent = 0;
        /* Recorded before the stream ends, so the machine's word that it keeps the file, which comes after, finds it. */
        const counted = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            sent += chunk.length;
            done(null, chunk);
          },
          flush(done) {
            if (sent !== sealed.length) return done();
            given().then(() => done(), () => done());
          },
        });
        pipeline(sealed.stream(), counted, () => undefined);
        return counted;
      },
    };
  }

  /* A file sent back: one the leading app asked for, from a machine that keeps it, or one the store's backup restores,
     which is in use again as it comes back. Either is kept only as long and with the sealed hash the record says. */
  /* A content of the backup for the machine picked to keep it, from the live store here or, where it went from there, the
     backup folder here: no receipt, as a backup copy is no live copy. */
  private async giveBackup(machine: string, sha256: string): Promise<{ status: 200; length: number; stream(): Readable } | { status: 403 | 404 }> {
    if (!(await backsUpStore(this.db, machine, sha256))) return { status: 403 };
    const sealed = this.store.sealed(sha256) ?? this.backup.sealed(sha256);
    if (!sealed) await this.db.execute(sql`UPDATE net.files SET wanted_at = now() WHERE sha256 = ${sha256} AND drop_at IS NULL`);
    return sealed ? { status: 200, length: sealed.length, stream: sealed.stream } : { status: 404 };
  }

  /* A content of the backup a machine gives back as the backup moves off it: only one the record says it keeps, only as
   long and with the sealed hash the record says, sealed again where it was sealed before. The backup folder here keeps
   it, until the machine picked fetches it. */
  private async takeBackup(machine: string, sha256: string, body: Readable): Promise<number> {
    const [row] = rowsOf<{ size: string; sealed_sha256: string; sealed_size: string; salt: string; restore: boolean }>(
      await this.db.execute(sql`SELECT size, sealed_sha256, sealed_size, salt, restore_at IS NOT NULL AS restore FROM net.file_backups
        WHERE sha256 = ${sha256} AND machine_id = ${machine} AND kept_at IS NOT NULL AND drop_at IS NULL`),
    );
    if (!row) {
      body.destroy();
      return 403;
    }
    if (row.restore) return this.takeRestored(sha256, body, row);
    try {
      await this.backup.take(sha256, body, { sealedSha256: row.sealed_sha256, sealedSize: Number(row.sealed_size) }, this.key ? { key: await this.key(), salt: row.salt } : undefined);
    } catch (err) {
      if (err instanceof StoreRefused) return 400;
      throw err;
    }
    await this.db.execute(sql`UPDATE net.file_backups SET machine_id = ${await this.ownRow()}, kept_at = now() WHERE sha256 = ${sha256} AND machine_id = ${machine}`);
    return 201;
  }

  /* A content a restore of the CEO asked the backup's machine for: into the live store, once it opens with the store key
     to bytes of its name, and recorded and placed as an upload is. The backup keeps its copy where it was. */
  private async takeRestored(sha256: string, body: Readable, row: { size: string; sealed_size: string }): Promise<number> {
    if (!this.key) {
      body.destroy();
      return 403;
    }
    const key = await this.key();
    try {
      await this.store.takeOpened(sha256, body, key, Number(row.sealed_size), true);
    } catch (err) {
      if (err instanceof StoreRefused) return 400;
      throw err;
    }
    const own = await this.ownRow();
    const restored = { sha256, size: Number(row.size), ...(await this.store.sealedFacts(sha256)) };
    await recordFile(this.db, await sealedAsRecorded(this.db, this.store, restored, key), own);
    await placeFiles(this.db, own, { only: [sha256] });
    await this.db.execute(sql`UPDATE net.file_backups SET restore_at = NULL WHERE sha256 = ${sha256}`);
    return 201;
  }

  async take(machine: string, sha256: string, body: Readable, backup = false): Promise<number> {
    if (backup) return this.takeBackup(machine, sha256, body);
    const restores = await backsUpStore(this.db, machine, sha256);
    const [asked] = rowsOf<{ sealed_sha256: string; sealed_size: string; salt: string; wanted: boolean }>(
      await this.db.execute(sql`SELECT f.sealed_sha256, f.sealed_size, f.salt, f.wanted_at IS NOT NULL AS wanted FROM net.files f WHERE f.sha256 = ${sha256} AND (${restores} OR (f.wanted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = f.sha256 AND c.machine_id = ${machine})))`),
    );
    if (!asked) return this.takeUnrecorded(machine, sha256, body);
    try {
      /* A copy a holder kept as it was sealed before is sealed again as the record says, where this machine has the key. */
      const again = this.key ? { key: await this.key(), salt: asked.salt } : undefined;
      await this.store.take(sha256, body, { sealedSha256: asked.sealed_sha256, sealedSize: Number(asked.sealed_size) }, again, asked.wanted);
    } catch (err) {
      if (err instanceof StoreRefused) return 400;
      throw err;
    }
    await this.db.execute(restores ? sql`UPDATE net.files SET wanted_at = NULL, unused_since = NULL, drop_at = NULL WHERE sha256 = ${sha256}` : sql`UPDATE net.files SET wanted_at = NULL WHERE sha256 = ${sha256}`);
    const own = await this.ownRow();
    if (own) await this.db.execute(sql`INSERT INTO net.file_copies (sha256, machine_id, verified) VALUES (${sha256}, ${own}, true) ON CONFLICT (sha256, machine_id) DO UPDATE SET verified = true`);
    return 201;
  }
}
