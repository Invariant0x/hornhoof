import { DISK_PARTS, type DiskPart } from '@hornhoof/protocol';
import { useLanguage, useT } from '../i18n';
import type { MachineLowCard } from '../types';
import { gigabytes, measuredParts } from './MachineDisk';

/* Stand-ins the title's words hold where the machine's and its owner's names go, each then read in its own direction. */
const HOST = '\u{F0001}';
const OWNER = '\u{F0002}';
const isolated = (text: string, names: Record<string, string>) =>
  text.split(/(\u{F0001}|\u{F0002})/u).map((piece, i) => (Object.hasOwn(names, piece) ? <bdi key={i}>{names[piece]}</bdi> : piece));

/* The removals of the last day, part by part, the largest first. */
function cleanedByPart(card: MachineLowCard): [DiskPart, number][] {
  const sums = new Map<DiskPart, number>();
  for (const { part, bytes } of card.disk.cleaned) sums.set(part, (sums.get(part) ?? 0) + bytes);
  return DISK_PARTS.flatMap(part => (sums.has(part) ? [[part, sums.get(part)!] as [DiskPart, number]] : [])).toSorted((a, b) => b[1] - a[1]);
}

/* A machine short of disk space, in words for the person who can make room on it. Nothing here waits for an answer: the
   card goes by itself once the machine has room again. */
function Low({ card }: { card: MachineLowCard }) {
  const t = useT();
  const { language } = useLanguage();
  const gb = (bytes: number) => gigabytes(language, bytes);
  const list = (parts: [DiskPart, number][]) => parts.map(([part, bytes]) => `${t.machines.diskParts.words[part]} ${t.machines.diskParts.size(gb(bytes))}`).join(', ');
  const { disk } = card;
  const title = t.tasks.machineLow(card.hostname, card.owner?.name ?? null);
  const takes = measuredParts(disk);
  const cleaned = cleanedByPart(card);
  return (
    <section className="machine-away" aria-label={title}>
      <h3>{isolated(t.tasks.machineLow(HOST, card.owner ? OWNER : null), { [HOST]: card.hostname, [OWNER]: card.owner?.name ?? '' })}</h3>
      <p>{t.tasks.machineLowFree(gb(disk.free), gb(disk.total), gb(disk.threshold))}</p>
      {disk.docker && <p>{t.tasks.machineLowDocker(gb(disk.docker.free), gb(disk.docker.total), gb(disk.docker.threshold))}</p>}
      {takes.length > 0 && <p>{t.tasks.machineLowTakes(list(takes))}</p>}
      {cleaned.length > 0 && <p>{t.tasks.machineLowCleaned(list(cleaned))}</p>}
      <p>{t.tasks.machineLowGoesOn}</p>
      <p>{t.tasks.machineLowDo}</p>
    </section>
  );
}

export function MachineLow({ machines }: { machines: MachineLowCard[] }) {
  return <>{machines.map(card => <Low key={card.id} card={card} />)}</>;
}
