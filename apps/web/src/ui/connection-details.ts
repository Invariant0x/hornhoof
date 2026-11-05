import type { Messages } from '../i18n';
import type { MachineDrop, NodeDropView } from '../types';
import { resetDuration } from './reset';

const SECOND = 1000;
const MINUTE = 60_000;
type Report = NonNullable<NodeDropView['report']>;

export function lengthOf(t: Messages, ms: number): string {
  if (ms < SECOND) return t.machines.connection.moment;
  return ms < MINUTE ? t.machines.connection.seconds(Math.round(ms / SECOND)) : resetDuration(t, ms);
}

function reportCauseFacts(t: Messages, cause: MachineDrop['cause'], report: Report) {
  const text = t.machines.connection;
  return [
    report.cause !== cause && text.causes[report.cause],
    report.errorCode ?? report.error,
    report.attempts > 1 && text.tries(report.attempts),
  ];
}

function reportEnvironmentFacts(t: Messages, report: Report) {
  const text = t.machines.connection;
  return [
    report.dnsFailed && report.cause !== 'dns_error' && text.causes.dns_error,
    report.watchdogTimedOut && report.cause !== 'watchdog_timeout' && text.causes.watchdog_timeout,
    report.clockJumpMs !== null && text.slept(lengthOf(t, report.clockJumpMs)),
    report.networkChanged && text.networkChanged,
  ];
}

/* What the machine itself has to add to what the server saw, in the first of its connections that said anything. */
export function sawOf(t: Messages, event: MachineDrop): string | null {
  const report = event.drops.find(d => d.report)?.report;
  if (!report) return null;
  const parts = [...reportCauseFacts(t, event.cause, report), ...reportEnvironmentFacts(t, report)].filter(Boolean);
  return parts.length ? t.machines.connection.saw(parts.join(', ')) : null;
}

export function dropFacts(t: Messages, event: MachineDrop): (string | number | false | null | undefined)[] {
  const text = t.machines.connection;
  const [first] = event.drops;
  return [
    first?.closeCode != null && text.code(first.closeCode),
    /* A machine's own words; those the server closed with its cause says already, in the language of the screen. */
    first?.cause === 'node_closed' && first.closeReason,
    first?.error,
    event.drops.length > 1 && text.together(event.drops.length),
  ].filter(Boolean);
}
