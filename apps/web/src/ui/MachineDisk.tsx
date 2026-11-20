import { DISK_PARTS, type DiskPart, type DiskReport, type MachineReplicas, type NodeLoad } from '@hornhoof/protocol';
import { Fragment, type ReactNode } from 'react';
import { useLanguage, useT, type Language, type Messages } from '../i18n';
import { Bar } from './Bar';
import { Part } from './Cards';
import { clock } from './subscription';

const GIB = 1024 ** 3;

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

/* The mark of a machine short of disk space, in its row and its card. */
export function LowDisk({ load }: { load: NodeLoad | null }) {
  const t = useT();
  const { language } = useLanguage();
  const disk = load?.disk;
  return disk?.low ? <span className="badge old" title={lowText(t, language, disk)}>{t.machines.diskParts.mark}</span> : null;
}

/* What Hornhoof takes of a machine's disk, part by part and the largest first, each with its share of the whole disk; all of
   it together and everything else; Docker's own disk, set apart, where Docker keeps its data on a disk of its own; and, while the machine is short of space, that it
   takes no new checks or builds. A node too old to say any of it shows none of it. */
export function DiskParts({ disk, replicas }: { disk: DiskReport; replicas: MachineReplicas | null }) {
  const t = useT();
  const { language } = useLanguage();
  const words = t.machines.diskParts;
  const gb = (bytes: number) => gigabytes(language, bytes);
  const parts = measuredParts(disk);
  const ours = parts.reduce((sum, [, bytes]) => sum + bytes, 0);
  const others = Math.max(0, disk.total - disk.free - ours);
  /* The copies already count in the volumes, so they stand as a row of their own but add nothing to Hornhoof's sum. */
  const rows: { key: string; name: ReactNode; bytes: number }[] = [
    ...parts.map(([part, bytes]) => ({ key: part, name: words.names[part], bytes })),
    ...(replicas ? [{ key: 'replicas', name: <>{words.replicas(replicas.count)}<Companies replicas={replicas} /></>, bytes: replicas.bytes }] : []),
  ].toSorted((a, b) => b.bytes - a.bytes);
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
      <p className="part-note">{words.other(gb(others))}</p>
      {disk.docker && <p className="part-note dp-docker">{words.docker(gb(disk.docker.free), gb(disk.docker.total))}</p>}
    </Part>
  );
}
