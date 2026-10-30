import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import { useTurn } from '../tasks';
import { Field } from './Field';

/* The goal the whole company works on now and how far it got. People with the whole company start and close turns. */
export function TurnBar({ company }: { company: boolean }) {
  const t = useT();
  const { turn, load } = useTurn();
  const [goal, setGoal] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      setAsking(false);
      setGoal('');
      load();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  function start(e: FormEvent) {
    e.preventDefault();
    if (goal.trim()) void run(() => api.post('/api/turns', { goal: goal.trim() }));
  }

  if (turn === undefined) return null;
  const alert = failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>;

  if (!turn) {
    return (
      <section className="turnbar" aria-label={t.tasks.startTurn}>
        <p className="muted">{t.tasks.noTurn}</p>
        {company && (
          <form className="turn-start" onSubmit={start}>
            <Field label={t.tasks.goal}>{p => <input {...p} value={goal} onChange={e => setGoal(e.target.value)} maxLength={600} placeholder={t.tasks.goalPlaceholder} />}</Field>
            <button className="btn" type="submit" disabled={busy || !goal.trim()}>{t.tasks.startTurn}</button>
          </form>
        )}
        {alert}
      </section>
    );
  }

  const share = turn.tasks.total ? Math.round((turn.tasks.done / turn.tasks.total) * 100) : 0;
  return (
    <section className="turnbar" aria-label={t.tasks.turn(turn.number)}>
      <div className="turn-goal">
        <b>{t.tasks.turn(turn.number)}</b>
        <span>{turn.goal}</span>
      </div>
      <div className="turn-progress">
        <span className="turn-track" aria-hidden="true">
          <i style={{ width: `${share}%` }} />
        </span>
        <small>{t.tasks.turnProgress(turn.tasks.done, turn.tasks.total)}</small>
      </div>
      {company &&
        (asking ? (
          <div className="turn-ask">
            <span>{t.tasks.closeTurnAsk}</span>
            <button className="btn small" type="button" disabled={busy} onClick={() => void run(() => api.post(`/api/turns/${turn.id}/close`, {}))}>
              {t.tasks.yesClose}
            </button>
            <button className="btn small ghost" type="button" onClick={() => setAsking(false)}>
              {t.tasks.keep}
            </button>
          </div>
        ) : (
          <button className="btn small ghost" type="button" onClick={() => setAsking(true)}>
            {t.tasks.closeTurn}
          </button>
        ))}
      {alert}
    </section>
  );
}
