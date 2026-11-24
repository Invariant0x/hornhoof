import type { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { recordFile } from '../files/files.js';
import { holdsFiles } from '../files/network.js';
import { FileStore, StoreRefused } from '../files/store.js';

/* A file no record describes is taken back at most this long, sealed. */
const UNRECORDED_BYTES = 2 * 1024 ** 3;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);

/* The leading keeper's side of the company's files: it gives a sealed file of the store, which it shares with its app,
   only to a machine the leading app named to hold the files, and takes one back only when its app asked for it, and only
   as long and with the sealed hash the record says. */
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

  /* A file a row names and no record describes, from a machine that holds the files: kept once it opens to its name. */
  private async takeUnrecorded(machine: string, sha256: string, body: Readable): Promise<number> {
    const [named] = rowsOf<{ size: string }>(
      await this.db.execute(sql`SELECT max(a.size) AS size FROM attachments a WHERE a.sha256 = ${sha256} AND NOT EXISTS (SELECT 1 FROM net.files f WHERE f.sha256 = ${sha256}) HAVING count(*) > 0`),
    );
    if (!named || !this.key || !(await holdsFiles(this.db, machine))) return 403;
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

  async give(machine: string, sha256: string): Promise<{ status: 200; length: number; stream(): Readable } | { status: 403 | 404 }> {
    if (!(await holdsFiles(this.db, machine))) return { status: 403 };
    const sealed = this.store.sealed(sha256);
    return sealed ? { status: 200, length: sealed.length, stream: sealed.stream } : { status: 404 };
  }

  async take(machine: string, sha256: string, body: Readable): Promise<number> {
    const [asked] = rowsOf<{ sealed_sha256: string; sealed_size: string }>(
      await this.db.execute(sql`SELECT f.sealed_sha256, f.sealed_size FROM net.files f WHERE f.sha256 = ${sha256} AND f.wanted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = f.sha256 AND c.machine_id = ${machine})`),
    );
    if (!asked) return this.takeUnrecorded(machine, sha256, body);
    try {
      await this.store.take(sha256, body, { sealedSha256: asked.sealed_sha256, sealedSize: Number(asked.sealed_size) });
    } catch (err) {
      if (err instanceof StoreRefused) return 400;
      throw err;
    }
    await this.db.execute(sql`UPDATE net.files SET wanted_at = NULL WHERE sha256 = ${sha256}`);
    const own = await this.ownRow();
    if (own) await this.db.execute(sql`INSERT INTO net.file_copies (sha256, machine_id) VALUES (${sha256}, ${own}) ON CONFLICT DO NOTHING`);
    return 201;
  }
}
