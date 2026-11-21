import { DISK_PARTS, NODE_DISK_PARTS, type DiskPart, type DiskReport, type MachineReplicas, type NodeLoad } from '@hornhoof/protocol';
import { Fragment, type ReactNode } from 'react';
import { useLanguage, useT, type Language, type Messages } from '../i18n';
import { Bar } from './Bar';
import { Part } from './Cards';
import { clock } from './subscription';

const GIB = 1024 ** 3;
/* What each node keeps in its own folder, a Docker volume of its own: where the volumes are measured, it is inside them. */
const OWN_FOLDER = new Set<DiskPart>(NODE_DISK_PARTS);
/* A stand-in the words hold where a plan's name goes, which then reads in its own direction. */
const PLAN = '\u{F0003}';
const withPlan = (text: string, plan: string): ReactNode => text.split(PLAN).map((piece, i) => <Fragment key={i}>{i > 0 && <bdi>{plan}</bdi>}{piece}</Fragment>);

/* One node's working folders: by the name of the plan it serves, none for the machine's own node. */
export type FolderRow = { plan: string | null; bytes: number };

/* An amount of bytes in gigabytes, to one decimal as its language writes it. */
export const gigabytes = (language: Language, bytes: number) => new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(Math.round((bytes / GIB) * 10) / 10);

/* The parts the node measured with their sizes, the largest first. */
export const measuredParts = (disk: DiskReport): [DiskPart, number][] =>
  DISK_PARTS.flatMap(part => (disk.parts[part] === undefined ? [] : [[part, disk.parts[part]] as [DiskPart, number]])).toSorted((a, b) => b[1] - a[1]);

/* The companies whose copies the server can name, each read in its own direction. */
function Companies({ replicas }: { replicas: MachineReplicas }) {
  if (!replicas.companies.length) return null;
  return <> ({replicas.companies.map((c, i) => <Fragment key={i}>{i > 0 && ', '}<bdi>{c.name}</bdi></Fragment>)})</>;
}

const lowText = (t: Messages, language: Language, disk: DiskReport) => t.machines.diskParts.low(clock(language, disk.low!.since) ?? '');

/* The mark of a machine short of disk space, in its row and its card, while it is on the line. */
export function LowDisk({ row }: { row: { online: boolean; load: NodeLoad | null } }) {
  const t = useT();
  const { language } = useLanguage();
  const disk = row.online ? row.load?.disk : undefined;
  return disk?.low ? <span className="badge old" title={lowText(t, language, disk)}>{t.machines.diskParts.mark}</span> : null;
}

type DiskRow = { key: string; name: ReactNode; bytes: number };
type Words = Messages['machines']['diskParts'];

/* All Hornhoof takes of a disk. The nodes' own folders, and the copies, are inside the volumes where those are measured: rows
   of their own that the sum counts once. */
export function hornhoofBytes(disk: DiskReport): number {
  const parts = measuredParts(disk);
  const own = parts.reduce((sum, [part, bytes]) => (OWN_FOLDER.has(part) ? sum + bytes : sum), 0);
  return parts.reduce((sum, [, bytes]) => sum + bytes, 0) - Math.min(own, disk.parts.volumes ?? 0);
}

/* The rows of a disk's parts, the largest first: the working copies node by node where the server names them, a node's own
   folder said to be in the volumes where those are measured, and the copies of company databases. */
function diskRows(words: Words, disk: DiskReport, replicas: MachineReplicas | null, folders: FolderRow[]): DiskRow[] {
  const inVolumes = (text: string) => (disk.parts.volumes === undefined ? text : words.inVolumes(text));
  const byNode = folders.map((folder, i) => ({ key: `folders-${i}`, name: folder.plan === null ? inVolumes(words.ownNode) : withPlan(inVolumes(words.folders(PLAN)), folder.plan), bytes: folder.bytes }));
  const parts = measuredParts(disk).filter(([part]) => part !== 'workingCopies' || !byNode.length);
  return [
    ...parts.map(([part, bytes]) => ({ key: part, name: OWN_FOLDER.has(part) ? inVolumes(words.names[part]) : words.names[part], bytes })),
    ...byNode,
    ...(replicas ? [{ key: 'replicas', name: <>{words.replicas(replicas.count)}<Companies replicas={replicas} /></>, bytes: replicas.bytes }] : []),
  ].toSorted((a, b) => b.bytes - a.bytes);
}

/* What Hornhoof takes of a machine's disk, part by part and the largest first, each with its share of the whole disk; all of
   it together and everything else; Docker's own disk, set apart, where Docker keeps its data on a disk of its own; and, while
   the machine is short of space, that it takes no new checks or builds. A node too old to say any of it shows none of it. */
export function DiskParts({ disk, replicas, folders = [] }: { disk: DiskReport; replicas: MachineReplicas | null; folders?: FolderRow[] }) {
  const t = useT();
  const { language } = useLanguage();
  const words = t.machines.diskParts;
  const gb = (bytes: number) => gigabytes(language, bytes);
  const ours = hornhoofBytes(disk);
  const rows = diskRows(words, disk, replicas, folders);
  return (
    <Part title={words.title}>
      {disk.low && <p className="warn-line" role="status">{lowText(t, language, disk)}</p>}
      {rows.length > 0 && (
        <ul className="disk-parts">
          {rows.map(({ key, name, bytes }) => (
            <li key={key}>
              <span className="dp-n">{name}</span>
              <bdi className="dp-v">{words.size(gb(bytes))}</bdi>
              <Bar used={disk.total > 0 ? Math.min(1, bytes / disk.total) : 0} />
            </li>
          ))}
        </ul>
      )}
      <p className="part-note">{words.all(gb(ours), gb(disk.total))}</p>
      <p className="part-note">{words.other(gb(Math.max(0, disk.total - disk.free - ours)))}</p>
      {disk.docker && <p className="part-note dp-docker">{words.docker(gb(disk.docker.free), gb(disk.docker.total))}</p>}
    </Part>
  );
}
