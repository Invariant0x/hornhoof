import { DISK_CLEANED_MAX, DISK_KEPT_MAX, NODE_DISK_PARTS, type DiskReport } from '@hornhoof/protocol';
import { latestReport } from './host-load.js';
import { nodeIdentity, type NodeHub, type NodeIdentity } from './hub.js';

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
  const machine = Object.fromEntries(Object.entries(newest.parts).filter(([part]) => !OWN.has(part)));
  return { ...newest, parts: { ...machine, ...ownSums(disks) }, low: lowSince(disks), cleaned: cleanedOf(disks, newest), ...keptOf(disks) };
}

/* What the nodes measure in their own folders, added up; a part none of them measured is left out. */
function ownSums(disks: DiskReport[]): DiskReport['parts'] {
  return Object.fromEntries(
    NODE_DISK_PARTS.flatMap(part => {
      const measured = disks.flatMap(disk => (disk.parts[part] === undefined ? [] : [disk.parts[part]]));
      return measured.length ? [[part, measured.reduce((sum, bytes) => sum + bytes, 0)] as const] : [];
    }),
  );
}

/* Since when the first of the nodes that are low said so; none while no node is. */
function lowSince(disks: DiskReport[]): DiskReport['low'] {
  const since = disks.flatMap(disk => (disk.low ? [disk.low.since] : [])).toSorted((a, b) => Date.parse(a) - Date.parse(b))[0];
  return since ? { since } : null;
}

/* The removals of Docker's parts from the newest report, as every node repeats them, and every node's own, newest first. */
const cleanedOf = (disks: DiskReport[], newest: DiskReport): DiskReport['cleaned'] =>
  disks
    .flatMap(disk => disk.cleaned.filter(c => disk === newest || OWN.has(c.part)))
    .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, DISK_CLEANED_MAX);

/* What every node keeps, the biggest first; nothing said while no node says it. */
const keptOf = (disks: DiskReport[]): Pick<DiskReport, 'kept'> =>
  disks.some(disk => disk.kept) ? { kept: disks.flatMap(disk => disk.kept ?? []).toSorted((a, b) => b.bytes - a.bytes).slice(0, DISK_KEPT_MAX) } : {};

/* The employees' working folders of each node of a machine that says how big they are, by the plan the node serves (none
   for the machine's own node), the biggest first. */
export const machineFolders = (hub: NodeHub, nodes: { id: string; subscriptionId: string | null }[], builtin: NodeIdentity | null = null) =>
  workingFolders([
    ...nodes.map(n => ({ plan: n.subscriptionId, disk: hub.loadOf(nodeIdentity(n.id))?.disk })),
    ...(builtin ? [{ plan: null, disk: hub.loadOf(builtin)?.disk }] : []),
  ]);

/* The same from what each node said: a node that did not measure its working copies, or says nothing of its disk, has none. */
export function workingFolders(nodes: { plan: string | null; disk: DiskReport | undefined }[]): { plan: string | null; bytes: number }[] {
  return nodes
    .flatMap(({ plan, disk }) => (disk?.parts.workingCopies === undefined ? [] : [{ plan, bytes: disk.parts.workingCopies }]))
    .toSorted((a, b) => b.bytes - a.bytes);
}
