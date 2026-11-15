import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Messages } from '../i18n';
import type { ConnectionHistory, MachineDrop } from '../types';
import { dropFacts, lengthOf, sawOf } from './connection-details';
import { everyVisible } from '../guard';

/* A history kept for days changes little: half a minute, and at once when the machine goes or comes. */
const REFRESH_MS = 30_000;
const LISTED = 5;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

type Health = keyof Messages['machines']['connection']['health'];

/* How the connection stands, in a word: away while its latest drop has not ended, drops while the last day had any. */
function healthOf(history: ConnectionHistory): Health {
  if (history.events[0]?.back === null) return 'away';
  return history.summary.drops > 0 ? 'drops' : 'stable';
}

/* The day in a sentence: nothing ever, a quiet day, or how many drops and why most often. */
function dayText(t: Messages, history: ConnectionHistory): string {
  const text = t.machines.connection;
  const { summary } = history;
  if (!history.events.length) return text.none;
  if (!summary.cause) return text.quiet;
  const cause = text.causes[summary.cause];
  const length = summary.averageMs === null ? null : lengthOf(t, summary.averageMs);
  return summary.drops === 1 ? text.one(length, cause) : text.many(summary.drops, length, cause);
}

/* What a person reads first: whether the connection holds, then the day. */
function Summary({ history }: { history: ConnectionHistory }) {
  const t = useT();
  const health = healthOf(history);
  return <p className="mc-sum"><span className={`status ${health === 'stable' ? 'ready' : 'unsteady'}`}>{t.machines.connection.health[health]}</span> <span>{dayText(t, history)}</span></p>;
}

const offText = (t: Messages, offlineMs: number | null): string =>
  offlineMs === null ? t.machines.connection.stillOff : t.machines.connection.offFor(lengthOf(t, offlineMs));

/* The codes, errors and what the machine itself saw of a drop: for whoever asks, never in the way of the rest. */
function technicalOf(t: Messages, event: MachineDrop): string[] {
  const facts = dropFacts(t, event);
  return [facts.length > 0 ? facts.join(', ') : null, sawOf(t, event)].filter((line): line is string => line !== null);
}

/* A drop in one line: when, how long the machine was off, and why in plain words; its technical lines when asked. */
function Drop({ event, technical }: { event: MachineDrop; technical: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  const when = new Date(event.at).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const lines = technical ? technicalOf(t, event) : [];
  return (
    <li className={event.offlineMs === null ? 'away' : undefined}>
      <span className="mc-drop-when">{when}</span>
      <span className="mc-drop-off">{offText(t, event.offlineMs)}</span>
      <span className="mc-drop-cause">{sentence(t.machines.connection.causes[event.cause])}</span>
      {lines.length > 0 && <div className="mc-tech">{lines.map(line => <span key={line}>{line}</span>)}</div>}
    </li>
  );
}

function Drops({ events, hostname }: { events: MachineDrop[]; hostname: string }) {
  const t = useT();
  const text = t.machines.connection;
  const id = useId();
  const [all, setAll] = useState(false);
  const [technical, setTechnical] = useState(false);
  const more = events.length > LISTED;
  const detailed = events.some(event => technicalOf(t, event).length > 0);
  return <>
    <ul id={id} className="mc-drops" aria-label={text.list(hostname)}>{(all ? events : events.slice(0, LISTED)).map(event => <Drop key={event.at} event={event} technical={technical} />)}</ul>
    {(more || detailed) && (
      <div className="entry-actions">
        {more && <button className="btn ghost" type="button" aria-controls={id} aria-expanded={all} onClick={() => setAll(!all)}>{all ? text.showFewer : text.showAll(events.length)}</button>}
        {detailed && <button className="btn ghost" type="button" aria-controls={id} aria-expanded={technical} onClick={() => setTechnical(!technical)}>{technical ? text.hideDetails : text.showDetails}</button>}
      </div>
    )}
  </>;
}

/* The connection's story: whether it holds, then its drops, if it had any. */
function Story({ history, hostname }: { history: ConnectionHistory; hostname: string }) {
  return <>
    <Summary history={history} />
    {history.events.length > 0 && <Drops events={history.events} hostname={hostname} />}
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
    const stop = everyVisible(() => void load(), REFRESH_MS);
    return () => {
      live = false;
      stop();
    };
  }, [id, online]);

  const heading = useId();
  return (
    <section className="blk blk-link" aria-labelledby={heading}>
      <h4 id={heading}>{t.machines.connection.heading}</h4>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {!history && failure === null && <p className="part-note">{t.common.loading}</p>}
      {history && <Story history={history} hostname={hostname} />}
    </section>
  );
}
