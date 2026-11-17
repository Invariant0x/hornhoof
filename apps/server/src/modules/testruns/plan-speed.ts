import { fileKey, lexical, type FileDuration } from './plan.js';
import { median } from './plan-statistics.js';

/* What a test file took on one computer in an earlier part. */
export type FileTime = FileDuration & { computer: string };
/* How long each computer takes for the same work against the middle one, at pace 1, and what each file takes at that pace. */
type MachinePaces = { paces: Map<string, number>; durations: FileDuration[] };

const ROUNDS = 30;

function grouped<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}
function sizesAt(files: Map<string, FileTime[]>, paces: Map<string, number>): Map<string, number> {
  return new Map([...files].map(([key, times]) => [key, median(times.map(time => time.ms / paces.get(time.computer)!))]));
}
/* A pace is the time a computer took over the time its files take at pace 1; the middle computer is then pace 1 again. */
function nextPaces(computers: Map<string, FileTime[]>, sizes: Map<string, number>): Map<string, number> {
  const raw = new Map([...computers].map(([computer, times]) => [computer, times.reduce((sum, time) => sum + time.ms, 0) / times.reduce((sum, time) => sum + sizes.get(fileKey(time))!, 0)]));
  const middle = median([...raw.values()]);
  return new Map([...raw].map(([computer, pace]) => [computer, pace / middle]));
}

/* Files measured on two computers tie their paces together, so a few runs that split the files differently are enough to tell how
   much faster one machine is. A computer only ever seen with files no other ran keeps the middle pace. The same times give the same
   answer in any order. */
export function machinePaces(times: FileTime[]): MachinePaces {
  const valid = times.filter(time => Number.isFinite(time.ms) && time.ms > 0)
    .sort((a, b) => lexical(a.computer, b.computer) || lexical(fileKey(a), fileKey(b)) || a.ms - b.ms);
  const files = grouped(valid, fileKey), computers = grouped(valid, time => time.computer);
  let paces = new Map([...computers.keys()].map(computer => [computer, 1]));
  for (let round = 0; round < ROUNDS; round++) paces = nextPaces(computers, sizesAt(files, paces));
  const sizes = sizesAt(files, paces);
  return { paces, durations: [...files].map(([key, [first]]) => ({ suiteId: first!.suiteId, file: first!.file, ms: sizes.get(key)! })) };
}

/* How long a part ran, on which computer, and its files. */
export type PartTime = { computer: string; ms: number; files: Pick<FileDuration, 'suiteId' | 'file'>[] };
/* A machine's pace for a part is how long the part ran over how long its files take at the middle size: it counts how many files the
   machine runs at once, which the time of each file does not show. A file no part measured counts at the middle size of the others.
   The sizes come back in the time a part takes at pace 1. */
export function partPaces(parts: PartTime[], sizes: FileDuration[]): MachinePaces {
  const known = new Map(sizes.map(size => [fileKey(size), size.ms])), fallback = sizes.length ? median(sizes.map(size => size.ms)) : 1;
  const valid = parts.filter(part => Number.isFinite(part.ms) && part.ms > 0 && part.files.length)
    .sort((a, b) => lexical(a.computer, b.computer) || a.ms - b.ms || lexical(JSON.stringify(a.files), JSON.stringify(b.files)));
  if (!valid.length) return { paces: new Map(), durations: sizes };
  const work = (part: PartTime): number => part.files.reduce((sum, file) => sum + (known.get(fileKey(file)) ?? fallback), 0);
  const computers = grouped(valid, part => part.computer);
  const raw = new Map([...computers].map(([computer, own]) => [computer, own.reduce((sum, part) => sum + part.ms, 0) / own.reduce((sum, part) => sum + work(part), 0)]));
  const middle = median([...raw.values()]);
  return { paces: new Map([...raw].map(([computer, pace]) => [computer, pace / middle])), durations: sizes.map(size => ({ ...size, ms: size.ms * middle })) };
}
