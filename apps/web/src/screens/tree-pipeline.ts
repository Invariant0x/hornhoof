import type { PackageTime, PipelineHead, PipelineRow, FileTime } from '@hornhoof/protocol/pipeline-report';
import type { Messages } from '../i18n';

const MINUS = '−';
const PACKAGE = 'tests.package.';
/* More of these is neither better nor worse: how much work there was, not how it went. */
const NO_VERDICT = /^(tasks\.|kinds\.[^.]+\.tasks$|tests\.files$|agents\.(total|work)$|waits\..+\.parts$)/;

function pairLabel(prefix: string, names: Record<string, string>, parts: Record<string, string>, key: string): string | null {
  if (!key.startsWith(prefix)) return null;
  const dot = key.lastIndexOf('.');
  const name = names[key.slice(prefix.length, dot)], part = parts[key.slice(dot + 1)];
  return name && part ? `${name}: ${part}` : null;
}

/* The words of a number. One from a newer server has none yet and keeps its key. */
export function metricLabel(t: Messages, key: string): string {
  const P = t.dept.tree.pipe;
  if (key.startsWith(PACKAGE)) return key.slice(PACKAGE.length);
  const fixed: Record<string, string> = P.metrics;
  return fixed[key]
    ?? pairLabel('waits.', P.waits, P.waitParts, key)
    ?? pairLabel('kinds.', { ...t.tasks.workKinds, unset: P.kindUnset }, P.kindParts, key)
    ?? key;
}

/* Below a minute in seconds: a test file is measured in them, and it would read as 0 minutes. */
function secondsText(t: Messages, seconds: number): string {
  const L = t.dept.tree;
  return seconds < 60 ? L.pipe.secs(Math.round(seconds * 10) / 10) : L.dur(seconds / 60);
}

export const msText = (t: Messages, ms: number): string => secondsText(t, ms / 1000);

export function valueText(t: Messages, row: PipelineRow): string {
  const P = t.dept.tree.pipe;
  if (row.value === null) return row.key === 'selectionMisses' ? P.noSelection : P.noData;
  return row.unit === 'seconds' ? secondsText(t, row.value) : P.num(row.value);
}

export function changeText(t: Messages, value: number | null, base: number | null, change: number | null): string {
  const P = t.dept.tree.pipe;
  if (value === null || base === null) return P.noData;
  if (change === null) return P.wasZero;
  if (change === 0) return '0%';
  return `${change > 0 ? '+' : MINUS}${Math.abs(change)}%`;
}

/* Every number with a verdict is one the department wants lower. */
export function changeTone(key: string, change: number | null): '' | 'good' | 'bad' {
  if (!change || NO_VERDICT.test(key)) return '';
  return change < 0 ? 'good' : 'bad';
}

export type Compared = { number: number; value: 'previous' | 'baseline'; change: 'vsPrevious' | 'vsBaseline' };

/* The turns a number is compared with; one that is both the previous and the baseline turn once. */
export function comparedTurns({ previous, baseline }: Pick<PipelineHead, 'previous' | 'baseline'>): Compared[] {
  const turns: Compared[] = previous ? [{ number: previous.number, value: 'previous', change: 'vsPrevious' }] : [];
  if (baseline && baseline.number !== previous?.number) turns.push({ number: baseline.number, value: 'baseline', change: 'vsBaseline' });
  return turns;
}

export function comparedLine(t: Messages, head: Pick<PipelineHead, 'previous' | 'baseline'>): string {
  const P = t.dept.tree.pipe, [first, second] = comparedTurns(head);
  if (!first) return P.comparedNone;
  return second ? P.comparedBoth(first.number, second.number) : P.comparedOne(first.number);
}

/* What a log said of a file or a package; one from before the timing lines gives its total only. */
export function phasesText(t: Messages, time: Pick<FileTime, 'setupMs' | 'testsMs' | 'teardownMs'>): string[] {
  const { phases } = t.dept.tree.pipe;
  const phase = (name: string, ms: number | null) => (ms === null ? [] : [`${name} ${msText(t, ms)}`]);
  return [...phase(phases.setup, time.setupMs), ...phase(phases.tests, time.testsMs), ...phase(phases.teardown, time.teardownMs)];
}

export function packageTestsText(t: Messages, { tests, medianTestMs, slowerThanMedian }: PackageTime): string | null {
  if (tests === null || medianTestMs === null || slowerThanMedian === null) return null;
  return t.dept.tree.pipe.packageTests(tests, msText(t, medianTestMs), slowerThanMedian);
}
