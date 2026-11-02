import { api } from '../api';
import { useLanguage, useT } from '../i18n';
import { clock } from '../screens/Subscriptions';
import type { ComputerView } from '../types';

/* Access to the computer the server runs on, on the CEO's screen alone: the orchestrator's request with one click to
   open it for a day, then until when it is open with a click to close it. */
export const isOpen = (view: ComputerView) => view.until !== null && Date.parse(view.until) > Date.now();

export function ComputerCard({ view, onChange, onFailure }: { view: ComputerView; onChange(next: ComputerView): void; onFailure(err: unknown): void }) {
  const t = useT();
  const { language } = useLanguage();
  const machine = view.machine ?? t.window.computerServer;
  const act = (action: 'open' | 'close' | 'decline') => api.post<ComputerView>(`/api/computer/${action}`).then(onChange, onFailure);

  if (isOpen(view)) {
    return (
      <section className="t-card" aria-label={t.window.computerAccess(machine)}>
        <h4>{t.window.computerAccess(machine)}</h4>
        <p className="t-card-brief">{t.window.computerOpenUntil(machine, clock(language, view.until)!)}</p>
        <div className="f">
          <button className="btn ghost" type="button" onClick={() => void act('close')}>
            {t.window.computerClose}
          </button>
        </div>
      </section>
    );
  }
  if (!view.asked) return null;
  return (
    <section className="t-card" aria-label={t.window.computerAsks(machine)}>
      <h4>{t.window.computerAsks(machine)}</h4>
      <p className="t-card-brief">{view.asked.reason}</p>
      <p className="t-card-brief">{t.window.computerWhat(machine)}</p>
      <div className="f">
        <button className="btn" type="button" onClick={() => void act('open')}>
          {t.window.computerOpen}
        </button>
        <button className="btn ghost" type="button" onClick={() => void act('decline')}>
          {t.window.computerNotNow}
        </button>
      </div>
    </section>
  );
}
