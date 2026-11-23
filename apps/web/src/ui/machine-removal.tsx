import { Fragment, type ReactNode } from 'react';
import type { Language, Messages } from '../i18n';
import type { MachineRow } from '../screens/machine-rows';
import type { KeptWork, MachineView, RemovalWarnings } from '../types';
import { clock } from './subscription';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
/* Below 0.1 GiB, show megabytes or kilobytes so a small worktree never reads as 0 GB. */
const MIN_GB = Math.floor(0.1 * GIB);

function formatSize(t: Messages, language: Language, bytes: number): string {
  if (bytes >= MIN_GB) {
    const gb = new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(Math.round((bytes / GIB) * 10) / 10);
    return t.machines.removal.sizeGb(gb);
  }
  if (bytes >= MIB) return t.tasks.fileMb(Math.ceil(bytes / MIB));
  return t.tasks.fileKb(Math.max(1, Math.ceil(bytes / 1024)));
}

/* Any machine that is not the leader can be removed by its owner or someone who sees the whole company, including a
   former server. The leader can never be removed. */
export function canRemoveMachine(row: Pick<MachineRow, 'server' | 'source'>, editable: boolean): boolean {
  return editable && row.source !== null && !row.server;
}

function ignoredSuffix(ignored: string[] | undefined): ReactNode {
  if (!ignored?.length) return null;
  return (
    <>
      {': '}
      {ignored.map((item, i) => <Fragment key={i}>{i > 0 && ', '}<bdi>{item}</bdi></Fragment>)}
    </>
  );
}

/* One inline line of kept work, safe inside ConfirmAction's <p> list, with names and paths isolated in <bdi>. */
function keptLine(t: Messages, language: Language, entry: KeptWork): ReactNode {
  const r = t.machines.removal;
  const detail = r.keptRow(entry.task, formatSize(t, language, entry.bytes), r.keptWhy[entry.why]);
  if (entry.agent === null && entry.path === null) return `${r.keptPrivate}: ${detail}`;
  const who = entry.agentName ?? entry.agent ?? r.keptPrivate;
  return (
    <>
      <bdi>{who}</bdi>
      {entry.path ? <>, <bdi>{entry.path}</bdi></> : null}
      {': '}
      {detail}
      {ignoredSuffix(entry.ignored)}
    </>
  );
}

function keptWarningLines(t: Messages, language: Language, warnings: Pick<RemovalWarnings, 'kept' | 'keptAt'>): ReactNode[] {
  const r = t.machines.removal;
  if (warnings.kept === null) return [r.localWorkUnknown];
  const at = clock(language, warnings.keptAt) ?? '';
  if (warnings.kept.length === 0) return [r.keptNone(at)];
  return [r.keptHeading(at), ...warnings.kept.map(entry => keptLine(t, language, entry)), r.keptActiveNote];
}

/* Plain-language warnings shown in the shared ConfirmAction dialog before removing a machine. */
export function removalWarningLines(
  t: Messages,
  language: Language,
  machine: Pick<MachineView, 'plans'>,
  warnings: RemovalWarnings,
): ReactNode[] {
  const r = t.machines.removal;
  const lines: ReactNode[] = [];
  if (warnings.lastReplica) lines.push(r.lastReplica);
  if (warnings.onlyBackup) lines.push(r.onlyBackup);
  if (warnings.uncollectedData) lines.push(r.uncollectedData);
  lines.push(...keptWarningLines(t, language, warnings));
  if (machine.plans.some(plan => plan.provider === 'claude')) lines.push(t.machines.disconnectClaude);
  return lines;
}
