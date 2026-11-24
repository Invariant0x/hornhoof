import type { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { holdsFiles } from '../files/network.js';
import { FileStore, StoreRefused } from '../files/store.js';

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);

/* The leading keeper's side of the company's files: it gives a sealed file of the store, which it shares with its app,
   only to a machine the leading app named to hold the files, and takes one back only when its app asked for it, and only
   as long and with the sealed hash the record says. */
export class LeaderFiles {
  readonly store: FileStore;

  /* own: the network id of this machine, whose row the copy taken back is recorded under. */
  constructor(private readonly db: Db, dir: string, private readonly own: string | null) {
    this.store = new FileStore(dir);
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
    if (!asked) return 403;
    try {
      await this.store.take(sha256, body, { sealedSha256: asked.sealed_sha256, sealedSize: Number(asked.sealed_size) });
    } catch (err) {
      if (err instanceof StoreRefused) return 400;
      throw err;
    }
    await this.db.execute(sql`UPDATE net.files SET wanted_at = NULL WHERE sha256 = ${sha256}`);
    if (this.own) {
      await this.db.execute(sql`INSERT INTO net.file_copies (sha256, machine_id) SELECT ${sha256}, id FROM machines WHERE network_id = ${this.own} AND revoked_at IS NULL ON CONFLICT DO NOTHING`);
    }
    return 201;
  }
}
