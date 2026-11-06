import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { MAX_RUN_FILES, RUN_FILE_BYTES, RunFile } from '@hornhoof/protocol';

export type ReadOutputFile =
  | { path: string; status: 'read'; bytes: Buffer; size: number; sha256: string }
  | { path: string; status: 'refused'; reason: 'output_unavailable' | 'output_too_large' };

const refused = (path: string, reason: 'output_unavailable' | 'output_too_large' = 'output_unavailable'): ReadOutputFile => ({ path, status: 'refused', reason });

function declarations(paths: readonly string[]): void {
  if (paths.length > MAX_RUN_FILES || new Set(paths).size !== paths.length || paths.some(path => !RunFile.safeParse(path).success)) throw new Error('Invalid output declarations.');
}

const ownedFile = (stat: Stats, uid: number): boolean => stat.isFile() && stat.uid === uid && stat.nlink === 1;
const unchanged = (before: Stats, after: Stats): boolean => before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;

async function fileBytes(file: FileHandle, path: string, ownerUid: number): Promise<ReadOutputFile> {
  const before = await file.stat();
  if (!ownedFile(before, ownerUid)) return refused(path);
  if (before.size > RUN_FILE_BYTES) return refused(path, 'output_too_large');
  // One extra byte detects a file that grew during its bounded read without allocating its new size.
  const bytes = Buffer.alloc(before.size + 1);
  let length = 0;
  while (length < bytes.length) {
    const read = await file.read(bytes, length, bytes.length - length, length);
    if (!read.bytesRead) break;
    length += read.bytesRead;
  }
  const after = await file.stat();
  if (length !== before.size || !ownedFile(after, ownerUid) || !unchanged(before, after)) return refused(path);
  const content = bytes.subarray(0, length);
  return { path, status: 'read', bytes: content, size: length, sha256: createHash('sha256').update(content).digest('hex') };
}

async function readOne(directory: FileHandle, path: string, ownerUid: number): Promise<ReadOutputFile> {
  let file: FileHandle | undefined;
  try {
    // Linux descriptor-relative lookup pins the opened directory even if its pathname is replaced.
    file = await open(`/proc/self/fd/${directory.fd}/${path}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return await fileBytes(file, path, ownerUid);
  } catch { return refused(path); }
  finally { await file?.close(); }
}

// Reads diagnostic bytes only; content checks, authorization and upload belong to the runner lifecycle.
export async function readOutputFiles(folder: string, paths: readonly string[], ownerUid: number): Promise<ReadOutputFile[]> {
  declarations(paths);
  let directory: FileHandle | undefined;
  try {
    directory = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if ((await directory.stat()).uid !== ownerUid) return paths.map(path => refused(path));
    const files: ReadOutputFile[] = [];
    for (const path of paths) files.push(await readOne(directory, path, ownerUid));
    return files;
  } catch { return paths.map(path => refused(path)); }
  finally { await directory?.close(); }
}
