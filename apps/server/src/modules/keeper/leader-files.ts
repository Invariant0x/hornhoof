import { pipeline, Transform, type Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { backsUpStore } from '../files/backup.js';
import { recordFile } from '../files/files.js';
import { keepsFiles, pickedFor } from '../files/network.js';
import { FileStore, StoreRefused } from '../files/store.js';

/* A file no record describes is taken back at most this long, sealed. */
const UNRECORDED_BYTES = 2 * 1024 ** 3;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);

/* The leading keeper's side of the company's files: it gives a sealed file of the store, which it shares with its app,
   only to a machine picked to keep that file, and records that it gave it, so that machine's word that it keeps the file
   counts. A file it lacks it asks the machines that keep it for, so a machine picked for a file the leading one keeps no
   copy of still gets it, through this one. It takes a file back only when its app asked for it, and only as long and
   with the sealed hash the record says. */
export class LeaderFiles {
  readonly store: FileStore;

  /* own: the network id of this machine, whose row the copy taken back is recorded under. key: the store key, which opens
     a file a merge brought a row of and no record describes. */
  constructor(private readonly db: Db, dir: string, private readonly own: string | null, private readonly key?: () => Promise<Buffer>) {
    this.store = new FileStore(dir);
  }

  private async ownRow(): Promise<string | null> {
    if (!this.own) return null;
    const [row] = rowsOf<{ id: string }>(await this.db.execute(sql`SELECT id FROM machines WHERE network_id = ${this.own} AND revoked_at IS NULL`));
    return row?.id ?? null;
  }

  /* A file a row names and no record describes, from a machine that holds the files or keeps their backup: kept once it
     opens to its name. */
  private async takeUnrecorded(machine: string, sha256: string, body: Readable): Promise<number> {
    const [named] = rowsOf<{ size: string }>(
      await this.db.execute(sql`SELECT max(a.size) AS size FROM attachments a WHERE a.sha256 = ${sha256} AND NOT EXISTS (SELECT 1 FROM net.files f WHERE f.sha256 = ${sha256}) HAVING count(*) > 0`),
    );
    if (!named || !this.key || !((await keepsFiles(this.db, machine)) || (await backsUpStore(this.db, machine, sha256)))) return 403;
    try {
      await this.store.takeOpened(sha256, body, await this.key(), UNRECORDED_BYTES);
    } catch (err) {
      if (err instanceof StoreRefused) return 400;
      throw err;
    }
    await recordFile(this.db, { sha256, size: Number(named.size), ...(await this.store.sealedFacts(sha256)) }, await this.ownRow());
    await this.db.execute(sql`INSERT INTO net.file_copies (sha256, machine_id) VALUES (${sha256}, ${machine}) ON CONFLICT DO NOTHING`);
    return 201;
  }

  /* A file for a machine picked to keep it, recorded as given once its whole stream went out, so its word that it keeps
     it counts: a stream cut short, or one the machine let go of unread, records nothing. Or for the machine that keeps the
     store's backup, which takes no copy's place. */
  async give(machine: string, sha256: string): Promise<{ status: 200; length: number; stream(): Readable } | { status: 403 | 404 }> {
    const picked = await pickedFor(this.db, machine, sha256);
    if (!picked && !(await backsUpStore(this.db, machine, sha256))) return { status: 403 };
    const sealed = this.store.sealed(sha256);
    if (!sealed) {
      await this.db.execute(sql`UPDATE net.files SET wanted_at = now() WHERE sha256 = ${sha256}`);
      return { status: 404 };
    }
    if (!picked) return { status: 200, length: sealed.length, stream: sealed.stream };
    const given = () => this.db.execute(sql`INSERT INTO net.file_gives (sha256, machine_id) VALUES (${sha256}, ${machine}) ON CONFLICT (sha256, machine_id) DO UPDATE SET at = now()`);
    return {
      status: 200,
      length: sealed.length,
      stream: () => {
        /* Counted on the way out, without starting the file's flow before the one it goes to reads it. */
        let sent = 0;
        const counted = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            sent += chunk.length;
            done(null, chunk);
          },
        });
        counted.once('end', () => void (sent === sealed.length && given().catch(() => undefined)));
        pipeline(sealed.stream(), counted, () => undefined);
        return counted;
      },
    };
  }

  /* A file sent back: one the leading app asked for, from a machine that keeps it, or one the store's backup restores,
     which is in use again as it comes back. Either is kept only as long and with the sealed hash the record says. */
  async take(machine: string, sha256: string, body: Readable): Promise<number> {
    const restores = await backsUpStore(this.db, machine, sha256);
    const [asked] = rowsOf<{ sealed_sha256: string; sealed_size: string }>(
      await this.db.execute(sql`SELECT f.sealed_sha256, f.sealed_size FROM net.files f WHERE f.sha256 = ${sha256} AND (${restores} OR (f.wanted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = f.sha256 AND c.machine_id = ${machine})))`),
    );
    if (!asked) return this.takeUnrecorded(machine, sha256, body);
    try {
      await this.store.take(sha256, body, { sealedSha256: asked.sealed_sha256, sealedSize: Number(asked.sealed_size) });
    } catch (err) {
      if (err instanceof StoreRefused) return 400;
      throw err;
    }
    await this.db.execute(restores ? sql`UPDATE net.files SET wanted_at = NULL, unused_since = NULL, drop_at = NULL WHERE sha256 = ${sha256}` : sql`UPDATE net.files SET wanted_at = NULL WHERE sha256 = ${sha256}`);
    const own = await this.ownRow();
    if (own) await this.db.execute(sql`INSERT INTO net.file_copies (sha256, machine_id) VALUES (${sha256}, ${own}) ON CONFLICT DO NOTHING`);
    return 201;
  }
}
