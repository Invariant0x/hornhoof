import { DISK_CLEANED_MAX, DISK_KEPT_MAX, NODE_DISK_PARTS, type DiskReport } from '@hornhoof/protocol';
import { latestReport } from './host-load.js';

const OWN = new Set<string>(NODE_DISK_PARTS);

/* A machine's disk from what its nodes say, each with when it said it. The disk, Docker's own and Docker's parts are the
   machine's, the same in every report, so the newest counts, the removals of Docker's parts too, which every node repeats;
   what each node measures in its own folder, removes from it and keeps there adds up. The machine is short of space while
   any of its nodes is, since the first of them said so. */
export function machineDisk(said: { at: number; disk?: DiskReport | undefined }[]): DiskReport | undefined {
  const reports = said.flatMap(s => (s.disk ? [{ at: s.at, disk: s.disk }] : []));
  const newest = latestReport(reports)?.disk;
  if (!newest) return undefined;
  const disks = reports.map(r => r.disk);
  const sums = NODE_DISK_PARTS.flatMap(part => {
    const measured = disks.flatMap(disk => (disk.parts[part] === undefined ? [] : [disk.parts[part]]));
    return measured.length ? [[part, measured.reduce((sum, bytes) => sum + bytes, 0)] as const] : [];
  });
  const parts: DiskReport['parts'] = { ...Object.fromEntries(Object.entries(newest.parts).filter(([part]) => !OWN.has(part))), ...Object.fromEntries(sums) };
  const since = disks.flatMap(disk => (disk.low ? [disk.low.since] : [])).toSorted((a, b) => Date.parse(a) - Date.parse(b))[0];
  const cleaned = disks
    .flatMap(disk => disk.cleaned.filter(c => disk === newest || OWN.has(c.part)))
    .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, DISK_CLEANED_MAX);
  const kept = disks.some(disk => disk.kept) ? disks.flatMap(disk => disk.kept ?? []).toSorted((a, b) => b.bytes - a.bytes).slice(0, DISK_KEPT_MAX) : undefined;
  return { ...newest, parts, low: since ? { since } : null, cleaned, ...(kept ? { kept } : {}) };
}

/* The employees' working folders of each node of a machine, by the plan the node serves (none for the machine's own node),
   the biggest first; a node that did not measure them, or says nothing of its disk, has none. */
export function workingFolders(nodes: { plan: string | null; disk: DiskReport | undefined }[]): { plan: string | null; bytes: number }[] {
  return nodes
    .flatMap(({ plan, disk }) => (disk?.parts.workingCopies === undefined ? [] : [{ plan, bytes: disk.parts.workingCopies }]))
    .toSorted((a, b) => b.bytes - a.bytes);
}
