import { DISK_PARTS, type DiskPart, type DiskReport, type NodeLoad } from '@hornhoof/protocol';
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
export function DiskParts({ disk }: { disk: DiskReport }) {
  const t = useT();
  const { language } = useLanguage();
  const words = t.machines.diskParts;
  const gb = (bytes: number) => gigabytes(language, bytes);
  const parts = measuredParts(disk);
  const ours = parts.reduce((sum, [, bytes]) => sum + bytes, 0);
  const others = Math.max(0, disk.total - disk.free - ours);
  return (
    <Part title={words.title}>
      {disk.low && <p className="warn-line" role="status">{lowText(t, language, disk)}</p>}
      {parts.length > 0 && (
        <ul className="disk-parts">
          {parts.map(([part, bytes]) => (
            <li key={part}>
              <span className="dp-n">{words.names[part]}</span>
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
