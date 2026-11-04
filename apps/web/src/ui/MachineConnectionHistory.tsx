import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLanguage, useT, type Messages } from '../i18n';
import type { MachineConnectionEvent, MachineConnectionHistory } from '../types';
import { Part } from './Cards';

function duration(t: Messages, ms: number): string {
  if (ms < 1000) return t.machines.connectionDurationMoment;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return t.machines.connectionDurationSeconds(seconds);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t.machines.connectionDurationMinutes(minutes);
  return t.machines.connectionDurationHours(Math.round(minutes / 60));
}

function cause(t: Messages, key: string | null): string {
  if (key === null) return t.machines.unknown;
  if (key in t.machines.connectionCauses) return t.machines.connectionCauses[key as keyof Messages['machines']['connectionCauses']];
  return key;
}

function nodeCause(t: Messages, report: NonNullable<MachineConnectionEvent['nodeReport']>): string {
  return t.machines.connectionNodeCauses[report.cause];
}

function reportText(t: Messages, report: NonNullable<MachineConnectionEvent['nodeReport']>): string {
  const details = [report.error ?? nodeCause(t, report), t.machines.connectionAttempts(report.attempts)];
  if (report.dnsFailed && report.cause !== 'dns_error') details.push(t.machines.connectionNodeCauses.dns_error);
  if (report.watchdogTimedOut && report.cause !== 'watchdog_timeout') details.push(t.machines.connectionNodeCauses.watchdog_timeout);
  if (report.clockJumpMs) details.push(t.machines.connectionClockJump(duration(t, report.clockJumpMs)));
  if (report.networkChanged) details.push(t.machines.connectionNetworkChanged);
  return t.machines.connectionReport(details.join('; '));
}

function eventText(t: Messages, event: MachineConnectionEvent): string {
  const offline = event.offlineMs === null ? null : t.machines.connectionOffline(duration(t, event.offlineMs));
  if (event.kind === 'connected') return [t.machines.connectionConnected, offline].filter(Boolean).join(', ');
  const reason = cause(t, event.cause);
  const sentence = reason.charAt(0).toUpperCase() + reason.slice(1);
  return [sentence, event.closeCode === null ? null : t.machines.connectionCode(event.closeCode), offline].filter(Boolean).join(', ');
}

function Summary({ summary }: { summary: MachineConnectionHistory['summary'] }) {
  const t = useT();
  if (summary.disconnects === 0) return <p className="connection-summary">{t.machines.connectionQuiet}</p>;
  return <p className="connection-summary">{t.machines.connectionSummary(
    t.machines.connectionDisconnects(summary.disconnects),
    duration(t, summary.averageOfflineMs ?? 0),
    cause(t, summary.topCause),
  )}</p>;
}

function Events({ events }: { events: MachineConnectionEvent[] }) {
  const t = useT();
  const { language } = useLanguage();
  if (events.length === 0) return <p className="part-note">{t.machines.connectionEmpty}</p>;
  const dates = new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'medium' });
  return <ul className="connection-events" aria-label={t.machines.connection}>{events.map(event => (
    <li key={event.id}>
      <div className="connection-event">
        <span>{eventText(t, event)}</span>
        <time dateTime={event.happenedAt}>{dates.format(new Date(event.happenedAt))}</time>
      </div>
      {event.nodeReport && <p className="connection-report">{reportText(t, event.nodeReport)}</p>}
    </li>
  ))}</ul>;
}

export function MachineConnectionHistory({ machineId }: { machineId: string }) {
  const t = useT();
  const [view, setView] = useState<MachineConnectionHistory | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setView(null);
    setFailed(false);
    api.get<MachineConnectionHistory>(`/api/machines/${machineId}/connection-history`)
      .then(history => { if (live) setView(history); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [machineId]);

  return (
    <Part title={t.machines.connection}>
      {!view && !failed && <p className="part-note" role="status">{t.machines.connectionLoading}</p>}
      {failed && <p className="machine-note" role="alert">{t.machines.connectionError}</p>}
      {view && <><Summary summary={view.summary} /><Events events={view.events} /></>}
    </Part>
  );
}
