import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { FileNote, KEPT_BYTES, RepositoryPath, type FileOutcome } from '@hornhoof/protocol';
import { z } from 'zod';

/* What a suite's runner says of its files, in the file $HH_TEST_REPORT names: { files: [{ file, status, ms?, note? }] }, each file
   absolute or from the repository root. A runner that writes none is judged as a whole, by its exit. */
export const REPORT_BYTES = 64 * 1024 * 1024;
const Report = z.object({ files: z.array(z.object({ file: z.string().min(1).max(4096), status: z.enum(['passed', 'failed']), ms: z.number().nonnegative().optional(), note: FileNote.optional() })).max(10_000) });
type Kept = { path: string; text: string };

/* A plain file only its job user can have left there. A link is not followed, and anything else reads as nothing. */
export function readJobFile(path: string, owner: number, limit: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== owner || stat.size > limit) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd));
  } catch { return null; }
  finally { if (fd !== null) closeSync(fd); }
}

function readReport(text: string | null): z.infer<typeof Report>['files'] {
  if (text === null) return [];
  try { return Report.parse(JSON.parse(text)).files; }
  catch { return []; }
}
/* A suite that failed with no file named failed cannot say whose failure it was, so it proves nothing of any of them. */
export function parseFileReport(text: string | null, context: { checkout: string; suiteId: string; selected: string[]; suiteFailed: boolean }): FileOutcome[] {
  const selected = new Set(context.selected);
  const files = readReport(text).flatMap(({ file, ...said }) => {
    const path = relative(context.checkout, resolve(context.checkout, file));
    return selected.has(path) ? [{ suiteId: context.suiteId, file: path, ...said }] : [];
  });
  return context.suiteFailed && !files.some(file => file.status === 'failed') ? [] : files;
}

const under = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);
/* The folders on the way to a path are real ones: a link there would lead out of the checkout. */
function plainWay(checkout: string, path: string, create: boolean): boolean {
  const parts = path.split('/').slice(0, -1);
  let at = checkout;
  for (const part of parts) {
    at = join(at, part);
    try { if (!lstatSync(at).isDirectory()) return false; }
    catch { if (!create) return false; mkdirSync(at); }
  }
  return true;
}
function restoreFile(checkout: string, file: Kept): void {
  try { if (plainWay(checkout, file.path, true)) writeFileSync(join(checkout, file.path), file.text, { flag: 'wx', mode: 0o600 }); }
  catch { /* What stands in its way stays: the suite then starts without this file. */ }
}
/* Puts back what a suite kept, before anything of a job has run in its checkout. Only a commit's own tree can be in the way. */
export function restoreKept(checkout: string, keep: string[], files: Kept[]): void {
  for (const file of files) if (RepositoryPath.safeParse(file.path).success && keep.some(folder => under(file.path, folder))) restoreFile(checkout, file);
}

/* What a suite leaves under what it keeps, read once its processes have stopped, without what came back as it went in: another
   part of the run may change that file meanwhile. What is too much goes whole: part of a tool's memory could mislead it, and
   none only costs it time. */
export function collectKept(checkout: string, keep: string[], owner: number, restored: Kept[] = []): Kept[] {
  const found: Kept[] = [], before = new Map(restored.map(file => [file.path, file.text]));
  let bytes = 0;
  const visit = (path: string): void => {
    const full = join(checkout, path), stat = lstatSync(full, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { for (const name of readdirSync(full).sort()) visit(`${path}/${name}`); return; }
    const text = readJobFile(full, owner, KEPT_BYTES);
    if (text !== null && before.get(path) === text) return;
    bytes += stat.size;
    if (text !== null) found.push({ path, text });
  };
  for (const folder of keep) if (plainWay(checkout, folder, false)) visit(folder);
  return bytes > KEPT_BYTES ? [] : found;
}
