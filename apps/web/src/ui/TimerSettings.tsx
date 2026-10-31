import { useEffect, useId, useState } from 'react';
import { useLanguage, useT } from '../i18n';
import type { AgentCardView } from '../types';

/* The intervals offered, in minutes; one set elsewhere shows too. */
const EVERY = [10, 15, 30, 60, 120, 180, 360, 720, 1440];

type Props = { timer: AgentCardView['timer']; editable: boolean; onChange(body: { timer: { minutes: number; order: string } | null }): void };

/* An employee's timer on its card: whether it wakes on its own, how often, and what it does each time. Ticking it off
   takes the timer away at once; a new or changed timer is saved with its button. */
export function TimerSettings({ timer, editable, onChange }: Props) {
  const t = useT();
  const { language } = useLanguage();
  const id = useId();
  const [on, setOn] = useState(timer !== null);
  const [minutes, setMinutes] = useState(timer?.minutes ?? 60);
  const [order, setOrder] = useState(timer?.order ?? '');
  useEffect(() => {
    setOn(timer !== null);
    setMinutes(timer?.minutes ?? 60);
    setOrder(timer?.order ?? '');
  }, [timer]);

  function toggle(next: boolean) {
    setOn(next);
    if (!next && timer) onChange({ timer: null });
  }

  const offered = EVERY.includes(minutes) ? EVERY : [...EVERY, minutes].sort((a, b) => a - b);
  const unchanged = timer !== null && timer.minutes === minutes && timer.order === order.trim();
  /* The timer counts from the last round, or from when it was set; a due round waits until the employee is free. */
  const next = timer?.lastAt ? Date.parse(timer.lastAt) + timer.minutes * 60_000 : null;
  const when =
    next === null ? null : next <= Date.now() ? t.agent.nextRoundSoon : t.agent.nextRound(new Intl.DateTimeFormat(language, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(next)));

  return (
    <section className="ac-timer" aria-labelledby={`${id}-timer`}>
      <h4 id={`${id}-timer`}>{t.agent.timer}</h4>
      <p className="muted">{t.agent.timerAbout}</p>
      <label className="check">
        <input type="checkbox" checked={on} disabled={!editable} onChange={e => toggle(e.target.checked)} />
        <span>{t.agent.timerOn}</span>
      </label>
      {on && (
        <form
          onSubmit={e => {
            e.preventDefault();
            if (order.trim()) onChange({ timer: { minutes, order: order.trim() } });
          }}
        >
          <div className="field">
            <label htmlFor={`${id}-every`}>{t.agent.timerEvery}</label>
            <select id={`${id}-every`} value={minutes} disabled={!editable} onChange={e => setMinutes(Number(e.target.value))}>
              {offered.map(m => (
                <option key={m} value={m}>
                  {t.agent.every(m)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-order`}>{t.agent.timerOrder}</label>
            <textarea id={`${id}-order`} rows={3} maxLength={2000} value={order} readOnly={!editable} placeholder={t.agent.timerPlaceholder} onChange={e => setOrder(e.target.value)} />
          </div>
          {when && <small>{when}</small>}
          {editable && (
            <button className="btn small" type="submit" disabled={!order.trim() || unchanged}>
              {t.agent.saveTimer}
            </button>
          )}
        </form>
      )}
    </section>
  );
}
