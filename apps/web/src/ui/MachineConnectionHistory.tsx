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
  switch (key) {
    case 'missed_pongs': return t.machines.connectionCauses.missed_pongs;
    case 'node_closed': return t.machines.connectionCauses.node_closed;
    case 'socket_error': return t.machines.connectionCauses.socket_error;
    case 'replaced': return t.machines.connectionCauses.replaced;
    case 'server_close': return t.machines.connectionCauses.server_close;
    case 'server_stop': return t.machines.connectionCauses.server_stop;
    case 'abnormal_close': return t.machines.connectionCauses.abnormal_close;
    default: return key ?? t.machines.unknown;
  }
}

function nodeCause(t: Messages, report: NonNullable<MachineConnectionEvent['nodeReport']>): string {
  switch (report.cause) {
    case 'watchdog_timeout': return t.machines.connectionNodeCauses.watchdog_timeout;
    case 'server_close': return t.machines.connectionNodeCauses.server_close;
    case 'socket_error': return t.machines.connectionNodeCauses.socket_error;
    case 'dns_error': return t.machines.connectionNodeCauses.dns_error;
    case 'handshake_timeout': return t.machines.connectionNodeCauses.handshake_timeout;
    case 'http_rejected': return t.machines.connectionNodeCauses.http_rejected;
    case 'abnormal_close': return t.machines.connectionNodeCauses.abnormal_close;
  }
}

function reportText(t: Messages, report: NonNullable<MachineConnectionEvent['nodeReport']>): string {
  const details = [report.error ?? nodeCause(t, report), t.machines.connectionAttempts(report.attempts)];
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

export function MachineConnectionHistory({ machineId }: { machineId: string }) {
  const t = useT();
  const { language } = useLanguage();
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

  const dates = new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'medium' });
  return (
    <Part title={t.machines.connection}>
      {!view && !failed && <p className="part-note" role="status">{t.machines.connectionLoading}</p>}
      {failed && <p className="machine-note" role="alert">{t.machines.connectionError}</p>}
      {view && <>
        {view.summary.disconnects === 0
          ? <p className="connection-summary">{t.machines.connectionQuiet}</p>
          : <p className="connection-summary">{t.machines.connectionSummary(
              t.machines.connectionDisconnects(view.summary.disconnects),
              duration(t, view.summary.averageOfflineMs ?? 0),
              cause(t, view.summary.topCause),
            )}</p>}
        {view.events.length === 0
          ? <p className="part-note">{t.machines.connectionEmpty}</p>
          : <ul className="connection-events" aria-label={t.machines.connection}>{view.events.map(event => (
              <li key={event.id}>
                <div className="connection-event">
                  <span>{eventText(t, event)}</span>
                  <time dateTime={event.happenedAt}>{dates.format(new Date(event.happenedAt))}</time>
                </div>
                {event.nodeReport && <p className="connection-report">{reportText(t, event.nodeReport)}</p>}
              </li>
            ))}</ul>}
      </>}
    </Part>
  );
}
