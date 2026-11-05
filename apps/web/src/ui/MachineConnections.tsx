import { useEffect, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Messages } from '../i18n';
import type { ConnectionHistory, MachineDrop } from '../types';
import { dropFacts, lengthOf, sawOf } from './connection-details';

/* A history kept for days changes little: half a minute, and at once when the machine goes or comes. */
const REFRESH_MS = 30_000;
const LISTED = 5;
const SECOND = 1000;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function DaySummary({ summary }: { summary: ConnectionHistory['summary'] }) {
  const t = useT();
  const text = t.machines.connection;
  if (!summary.cause) return <p className="part-note">{text.quiet}</p>;
  const cause = text.causes[summary.cause];
  const length = summary.averageMs === null ? null : lengthOf(t, summary.averageMs);
  return <p>{summary.drops === 1 ? text.one(length, cause) : text.many(summary.drops, length, cause)}</p>;
}

function backText(t: Messages, offlineMs: number | null): string {
  const text = t.machines.connection;
  if (offlineMs === null) return text.notBack;
  return offlineMs < SECOND ? text.backAtOnce : text.back(lengthOf(t, offlineMs));
}

function Drop({ event }: { event: MachineDrop }) {
  const t = useT();
  const { language } = useLanguage();
  const text = t.machines.connection;
  const when = new Date(event.at).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const facts = dropFacts(t, event);
  const saw = sawOf(t, event);
  return (
    <li className={event.offlineMs === null ? 'away' : undefined}>
      <span className="conn-when"><b>{when}</b><span>{backText(t, event.offlineMs)}</span></span>
      <span>{sentence(text.causes[event.cause])}</span>
      {facts.length > 0 && <small>{facts.join(', ')}</small>}
      {saw && <small>{saw}</small>}
    </li>
  );
}

function Drops({ events, hostname }: { events: MachineDrop[]; hostname: string }) {
  const t = useT();
  const text = t.machines.connection;
  const [all, setAll] = useState(false);
  return <>
    <ul className="conn-list" aria-label={text.list(hostname)}>{(all ? events : events.slice(0, LISTED)).map(event => <Drop key={event.at} event={event} />)}</ul>
    {events.length > LISTED && <button className="btn small ghost" type="button" aria-expanded={all} onClick={() => setAll(!all)}>{all ? text.showFewer : text.showAll(events.length)}</button>}
  </>;
}

/* How a machine's connection to the server has been holding: why it dropped, and for how long. */
export function MachineConnections({ id, hostname, online }: { id: string; hostname: string; online: boolean }) {
  const t = useT();
  const [history, setHistory] = useState<ConnectionHistory | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const next = await api.get<ConnectionHistory>(`/api/machines/${id}/connections`);
        if (!live) return;
        setHistory(next);
        setFailure(null);
      } catch (err) {
        if (live) setFailure(err);
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id, online]);

  return (
    <section className="blk blk-link">
      <h4>{t.machines.connection.heading}</h4>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {!history && failure === null && <p className="part-note">{t.common.loading}</p>}
      {history && (history.events.length ? <><DaySummary summary={history.summary} /><Drops events={history.events} hostname={hostname} /></> : <p className="part-note">{t.machines.connection.none}</p>)}
    </section>
  );
}
