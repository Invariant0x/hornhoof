import { useState } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import { useOrg } from '../org';
import { placeName } from '../tasks';
import type { Improvement, Org } from '../types';
import { Markdown } from '../ui/Markdown';

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

/* One thing to improve: what it is, who found it and how often, the orchestrator's word on it, and for one that waits,
   taking it into work or setting it aside. */
function Item({ item, org, onChanged, onTask }: { item: Improvement; org: Org | null; onChanged: () => void; onTask: (taskId: string) => void }) {
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
        <p className="imp-meta">
          <span>{who}</span>
          {item.seen > 1 && <span>{t.improvements.seen(item.seen)}</span>}
          {item.status === 'taken' && item.decidedBy && <span>{t.improvements.takenBy(item.decidedBy)}</span>}
        </p>
      </header>
      <div className="imp-text">
        <Markdown text={item.text} />
      </div>
      {item.result && (
        <p className="imp-result">
          <b>{t.improvements.orchestrator}:</b> {item.result}
        </p>
      )}
      <TaskLinks item={item} onTask={onTask} />
      {item.status === 'open' && (
        <div className="req-actions">
          <button className="btn small" type="button" disabled={busy} onClick={() => void decide('take')}>
            {t.improvements.take}
          </button>
          <button className="btn small ghost" type="button" disabled={busy} onClick={() => void decide('dismiss')}>
            {t.improvements.dismiss}
          </button>
        </div>
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </article>
  );
}

/* What employees found to improve in how the company works, for people who see the whole company: what waits for a
   decision first, then what the orchestrator does now, what was done, and what was set aside, folded away. */
export function Improvements({ improvements, failure, onChanged, onTask }: { improvements: Improvement[] | undefined; failure: unknown; onChanged: () => void; onTask: (taskId: string) => void }) {
  const t = useT();
  const { org } = useOrg();
  const of = (status: Improvement['status']) => improvements?.filter(i => i.status === status) ?? [];
  const list = (items: Improvement[]) => (
    <div className="imps">
      {items.map(i => (
        <Item key={i.id} item={i} org={org} onChanged={onChanged} onTask={onTask} />
      ))}
    </div>
  );
  const open = of('open');
  const later = (['taken', 'done'] as const).filter(s => of(s).length);
  const dismissed = of('dismissed');

  return (
    <section className="tasks">
      <header className="people-head">
        <div>
          <h1>{t.improvements.title}</h1>
          <p className="muted">{t.improvements.intro}</p>
        </div>
      </header>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
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
