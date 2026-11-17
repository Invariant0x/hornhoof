import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Peer } from '../../net/peer-server.js';
import { stampOf } from './copy.js';
import { reasonOf, writePrivately } from './machine-keys.js';

/* In the control folder of the machine that uploads: what its keeper asks its updater for, { id }. */
export const UPLOAD_FILE = 'upload.json';
/* In the control folder of the leader: what its keeper asks its updater to load, { id, machine, file, database,
   unpackMax }. The updater removes it once the load ended, and says how beside the upload's place: <file's name
   without .tar.gz>.done or .failed. */
export const LOAD_FILE = 'load.json';
export const UPLOADS_DIR = 'uploads';
const PACKED = '.tar.gz';
/* What an upload may be larger by than the leader's own database, three times over, and four unpacked. */
export const UPLOAD_SPARE = 2 ** 30;
/* A machine offers its upload again until the leader's view says it has it: this long after the leader took it, as a
   load that failed there leaves it wanted again, and each minute after any other answer. */
export const RETRY_UPLOAD_MS = 600_000;
export const UPLOAD_AGAIN_MS = 60_000;
/* In the control folder of the machine that leaves: what its keeper asks its updater to wipe, { id, step? }, and the
   updater's word that it is done, { id, at }. */
export const WIPE_FILE = 'wipe.json';
export const WIPED_FILE = 'wiped.json';

/* A machine that owes an upload, as the app names it: the row of the machine, its id in the network, and how large its
   upload may be, packed and unpacked. */
export type UploadAllowed = { machine: string; networkId: string; max: number; unpackMax: number };
export type PeerUploads = { put(peer: Peer, id: string, body: Readable, length: number | null): Promise<201 | 400 | 403 | 409 | 413> };


/* Takes what a machine held when it stopped holding the company's data: only from a machine the app says owes it, one
   at a time, up to the size the app allows and only whole, into a folder only the keeper and the updater read. Nothing
   of it is read here: the updater loads it, as data alone, into a database of its own, and the leader's merge reads
   that. A machine offers the same upload until the leader says it has it: one that was loaded is answered as taken and
   not taken twice, and one whose load failed is taken again. */
export class UploadTaker {
  /* An upload is being written now. */
  private taking = false;

  constructor(private readonly opts: { controlDir: string; allowed: () => UploadAllowed[]; log: (line: string) => void; now?: () => Date }) {}

  private dir(): string {
    return join(this.opts.controlDir, UPLOADS_DIR);
  }

  /* What a keeper that stopped in the middle of an upload left is no upload, and neither is one it took and asked no
     load of. */
  start(): void {
    const loading = existsSync(join(this.opts.controlDir, LOAD_FILE));
    try {
      for (const name of existsSync(this.dir()) ? readdirSync(this.dir()) : []) {
        if (name.endsWith('.part') || (!loading && name.endsWith(PACKED))) rmSync(join(this.dir(), name), { force: true });
      }
    } catch (err) {
      this.opts.log(`Could not clear what an upload left half done: ${reasonOf(err)}`);
    }
  }

  /* What the updater said of the uploads of machines that owe none any more is of no use. */
  private forget(allowed: UploadAllowed[]): void {
    for (const name of existsSync(this.dir()) ? readdirSync(this.dir()) : []) {
      if ((name.endsWith('.done') || name.endsWith('.failed')) && !allowed.some(one => name.startsWith(`${one.networkId}-`))) rmSync(join(this.dir(), name), { force: true });
    }
  }

  peer(): PeerUploads {
    return { put: (peer, id, body, length) => this.put(peer, id, body, length) };
  }

  private async put(peer: Peer, id: string, body: Readable, length: number | null): Promise<201 | 400 | 403 | 409 | 413> {
    const all = this.opts.allowed();
    const allowed = all.find(one => one.machine === peer.machine);
    if (!allowed) return 403;
    this.forget(all);
    const place = join(this.dir(), `${allowed.networkId}-${id}`);
    /* Loaded already: the app says so to the machine within the minute. */
    if (existsSync(`${place}.done`)) return 201;
    if (length === null) return 400;
    if (length > allowed.max) return 413;
    /* One at a time, until the updater took the load's request away. */
    if (this.taking || existsSync(join(this.opts.controlDir, LOAD_FILE))) return 409;
    /* Taken before the first byte is read, so a second machine never writes beside the first. */
    this.taking = true;
    const file = `${place}${PACKED}`;
    const part = `${file}.part`;
    let size = 0;
    let tooLarge = false;
    try {
      mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
      rmSync(`${place}.failed`, { force: true });
      await pipeline(
        body,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            size += chunk.length;
            if (size > allowed.max) {
              tooLarge = true;
              throw new Error('the upload is larger than it may be');
            }
            yield chunk;
          }
        },
        createWriteStream(part, { mode: 0o600 }),
      );
      /* A peer that left in the middle ends the stream as one that sent everything does. */
      if (size !== length) throw new Error('the upload was cut');
      renameSync(part, file);
      const database = `hornhoof_upload_${allowed.networkId.slice(0, 16).toLowerCase()}_${stampOf(this.opts.now?.() ?? new Date())}`;
      writePrivately(join(this.opts.controlDir, LOAD_FILE), JSON.stringify({ id, machine: allowed.machine, file, database, unpackMax: allowed.unpackMax }));
      return 201;
    } catch {
      rmSync(part, { force: true });
      return tooLarge ? 413 : 400;
    } finally {
      this.taking = false;
    }
  }
}
