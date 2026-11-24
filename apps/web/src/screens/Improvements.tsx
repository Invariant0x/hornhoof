import { RouteUnavailable, unavailableFailure } from './RouteUnavailable';
import { useId, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT } from '../i18n';
import { useOrg } from '../org';
import { placeName } from '../tasks';
import type { Improvement, ImprovementParts, Org, SentFate } from '../types';
import { BusyLabel } from '../ui/BusyLabel';
import { LoadFailure } from '../ui/LoadFailure';
import { Markdown } from '../ui/Markdown';
import { Feedback, type FeedbackStart } from './Feedback';
import { formatTagOf } from '@hornhoof/protocol';

function TaskLinks({ item, onTask }: { item: Improvement; onTask: (taskId: string) => void }) {
  const t = useT();
  if (!item.tasks?.length) return null;
  return (
    <div className="imp-tasks">
      <b>{t.improvements.relatedTasks}</b>
      <div className="imp-task-list">
        {item.tasks.map(task => (
          <button key={task.id} className="act" type="button" onClick={() => onTask(task.id)}>{`#${task.number} ${task.title}`}</button>
        ))}
      </div>
    </div>
  );
}

/* A case in the order a person reads it, each part under its heading and the ones it lacks left out. The facts, each with
   its source, and the guesses are lists of their own, so one is never taken for the other. */
function Case({ parts }: { parts: ImprovementParts }) {
  const t = useT();
  const id = useId();
  const words = t.improvements.parts;
  const part = (key: 'problem' | 'why' | 'change' | 'gain') =>
    parts[key] && (
      <section className="imp-part" aria-labelledby={`${id}-${key}`}>
        <h4 id={`${id}-${key}`}>{words[key]}</h4>
        <Markdown text={parts[key]} />
      </section>
    );
  const list = (key: 'facts' | 'guesses', items: { text: string; source?: string }[]) =>
    items.length > 0 && (
      <section className={`imp-part imp-${key}`} aria-labelledby={`${id}-${key}`}>
        <h4 id={`${id}-${key}`}>{words[key]}</h4>
        <ul aria-labelledby={`${id}-${key}`}>
          {items.map((item, i) => (
            <li key={i}>
              <Markdown text={item.text} />
              {item.source && <small className="imp-source">{t.improvements.source(item.source)}</small>}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <div className="imp-case">
      {part('problem')}
      {list('facts', parts.facts)}
      {list('guesses', parts.guesses.map(text => ({ text })))}
      {part('why')}
      {part('change')}
      {part('gain')}
    </div>
  );
}

/* Who found it and how often, whether it is about Hornhoof itself, and who decided what became of it. */
function ItemMeta({ item, who }: { item: Improvement; who: string }) {
  const t = useT();
  return (
    <p className="imp-meta">
      <span>{who}</span>
      {item.scope === 'platform' && <span className="badge imp-platform">{t.improvements.platform}</span>}
      {item.seen > 1 && <span>{t.improvements.seen(item.seen)}</span>}
      {item.status === 'taken' && item.decidedBy && <span>{t.improvements.takenBy(item.decidedBy)}</span>}
      {item.status === 'sent' && item.decidedBy && <span>{t.improvements.sentBy(item.decidedBy)}</span>}
    </p>
  );
}

/* The feedback window a finding about Hornhoof itself opens on: a bug when Hornhoof gave an error code. */
const findingStart = (item: Improvement): FeedbackStart => ({ kind: item.code ? 'bug' : 'improvement', title: item.title, text: item.text, improvement: item.id });

/* For one that waits: taking it into work, or setting it aside. A finding about Hornhoof itself is sent to Hornhoof's
   developers instead, except on Hornhoof's own installation (inbox), whose work it is. */
function ItemActions({ item, inbox, busy, onDecide, onChanged }: { item: Improvement; inbox: boolean; busy: boolean; onDecide: (how: 'take' | 'dismiss') => void; onChanged: () => void }) {
  const t = useT();
  const [sending, setSending] = useState(false);
  const elsewhere = item.scope === 'platform' && !inbox;
  return (
    <>
      <div className="req-actions">
        {elsewhere ? (
          <button className="btn small" type="button" disabled={busy} onClick={() => setSending(true)}>
            {t.improvements.send}
          </button>
        ) : (
          <button className="btn small" type="button" disabled={busy} onClick={() => onDecide('take')}>
            {t.improvements.take}
          </button>
        )}
        <button className="btn small ghost" type="button" disabled={busy} onClick={() => onDecide('dismiss')}>
          {t.improvements.dismiss}
        </button>
      </div>
      {sending && <Feedback inbox={inbox} start={findingStart(item)} onClose={() => setSending(false)} onSent={onChanged} />}
    </>
  );
}

/* Only an issue of Hornhoof's own repository becomes a link. */
const ISSUE_PAGE = /^https:\/\/github\.com\/invariant0x\/hornhoof\/issues\/[1-9][0-9]*$/;

/* Tells Hornhoof's developers how many more rounds found it, and the list is read again. */
async function tellRepeats(id: string, set: { busy: (busy: boolean) => void; failure: (failure: unknown) => void }, onChanged: () => void): Promise<void> {
  set.busy(true);
  set.failure(null);
  try {
    await api.post('/api/feedback/repeats', { improvement: id });
    onChanged();
  } catch (err) {
    set.failure(err);
  }
  set.busy(false);
}

/* The press that tells Hornhoof's developers how many more rounds found one they have, while any did. */
function RepeatsPress({ id, repeats, onChanged }: { id: string; repeats: number; onChanged: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  if (repeats < 1) return null;
  return (
    <>
      <div className="req-actions">
        <button className="btn small" type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void tellRepeats(id, { busy: setBusy, failure: setFailure }, onChanged)}>
          <BusyLabel busy={busy} idle={t.improvements.reportRepeats(repeats)} working={t.improvements.reportingRepeats} />
        </button>
      </div>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </>
  );
}

/* What became of one sent to Hornhoof's developers: when it went, its number in their inbox, its issue and the version
   that fixed it, or while it is not fixed, the press that tells them of its repeats. */
function Fate({ id, sent, onChanged }: { id: string; sent: SentFate; onChanged: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const when = new Date(sent.at).toLocaleString(formatTagOf(language), { dateStyle: 'medium', timeStyle: 'short' });
  const issue = sent.issue && ISSUE_PAGE.test(sent.issue.url) ? sent.issue : null;
  return (
    <div className="imp-fate">
      <p className="imp-meta">
        <span>{t.improvements.handed(when)}</span>
        {sent.number !== null && <span>{t.improvements.report(sent.number)}</span>}
        {issue && (
          <a href={issue.url} target="_blank" rel="noopener noreferrer">
            {t.improvements.issue(issue.number)}
          </a>
        )}
      </p>
      {sent.fixedIn ? <p className="imp-fixed">{t.improvements.fixedIn(sent.fixedIn)}</p> : <RepeatsPress id={id} repeats={sent.repeats} onChanged={onChanged} />}
    </div>
  );
}

/* One thing to improve: what it is, who found it and how often, the orchestrator's word on it, and for one that waits,
   what can become of it. One filed as one text shows that text. */
function Item({ item, org, inbox, onChanged, onTask }: { item: Improvement; org: Org | null; inbox: boolean; onChanged: () => void; onTask: (taskId: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  async function decide(how: 'take' | 'dismiss') {
    setBusy(true);
    setFailure(null);
    try {
      await api.post(`/api/improvements/${item.id}/${how}`, {});
      onChanged();
    } catch (err) {
      setFailure(err);
    }
    setBusy(false);
  }

  const who = item.department ? `${item.agent.name}, ${placeName(t, org, item.department)}` : item.agent.name;
  return (
    <article className={`imp imp-${item.status}`} aria-labelledby={`imp-${item.id}`}>
      <header>
        <h3 id={`imp-${item.id}`}>{item.title}</h3>
        <ItemMeta item={item} who={who} />
      </header>
      {item.parts ? (
        <Case parts={item.parts} />
      ) : (
        <div className="imp-text">
          <Markdown text={item.text} />
        </div>
      )}
      {item.result && (
        <p className="imp-result">
          <b>{t.improvements.orchestrator}:</b> {item.result}
        </p>
      )}
      <TaskLinks item={item} onTask={onTask} />
      {item.status === 'sent' && item.sent && <Fate id={item.id} sent={item.sent} onChanged={onChanged} />}
      {item.status === 'open' && <ItemActions item={item} inbox={inbox} busy={busy} onDecide={how => void decide(how)} onChanged={onChanged} />}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </article>
  );
}

/* What employees found to improve in how the company works, for people who see the whole company: what waits for a
   decision first, then what the orchestrator does now, what was done, and what was set aside, folded away. */
function ofStatus(improvements: Improvement[] | undefined, status: Improvement['status']): Improvement[] {
  return improvements?.filter(item => item.status === status) ?? [];
}

export function Improvements({ improvements, failure, inbox, onChanged, onTask, onHome }: { improvements: Improvement[] | undefined; failure: unknown; inbox: boolean; onChanged: () => void; onTask: (taskId: string) => void; onHome?: () => void }) {
  const t = useT();
  const { org } = useOrg();
  const of = (status: Improvement['status']) => ofStatus(improvements, status);
  const list = (items: Improvement[]) => (
    <div className="imps">
      {items.map(i => (
        <Item key={i.id} item={i} org={org} inbox={inbox} onChanged={onChanged} onTask={onTask} />
      ))}
    </div>
  );
  const open = of('open');
  const later = (['taken', 'done', 'sent'] as const).filter(s => of(s).length);
  const dismissed = of('dismissed');
  if (unavailableFailure(failure)) return <RouteUnavailable onHome={onHome} />;

  return (
    <section className="tasks">
      <header className="people-head">
        <div>
          <h1>{t.improvements.title}</h1>
          <p className="muted">{t.improvements.intro}</p>
        </div>
      </header>
      <LoadFailure failure={failure} />
      {improvements && !improvements.length && <p className="muted">{t.improvements.empty}</p>}
      {!!improvements?.length && (
        <section className="waiting" aria-label={t.improvements.open}>
          <h2>{t.improvements.open}</h2>
          {open.length ? list(open) : <p className="muted">{t.improvements.noneOpen}</p>}
        </section>
      )}
      {later.map(s => (
        <section key={s} className="turns" aria-label={t.improvements[s]}>
          <h2>{t.improvements[s]}</h2>
          {list(of(s))}
        </section>
      ))}
      {dismissed.length > 0 && (
        <details className="turns folded">
          <summary>{`${t.improvements.dismissed}: ${dismissed.length}`}</summary>
          {list(dismissed)}
        </details>
      )}
    </section>
  );
}
