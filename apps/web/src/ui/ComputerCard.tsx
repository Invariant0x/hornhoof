import { api } from '../api';
import { useLanguage, useT } from '../i18n';
import { clock } from '../screens/Subscriptions';
import type { ComputerView } from '../types';
import { CEO_DECIDES, DecidedByNote } from './DecidedBy';

/* Access to the computer the server runs on: the orchestrator's request with one click of the CEO or the delegate to open
   it for a day, then until when it is open with a click to close it. People of the whole company read it without them. */
export const isOpen = (view: ComputerView) => view.until !== null && Date.parse(view.until) > Date.now();

export type ComputerAnswer = 'open' | 'close' | 'decline';
export const answerComputer = (action: ComputerAnswer) => api.post<ComputerView>(`/api/computer/${action}`);

export function ComputerCard({ view, onChange, onFailure }: { view: ComputerView; onChange(next: ComputerView): void; onFailure(err: unknown): void }) {
  const t = useT();
  const { language } = useLanguage();
  const machine = view.machine ?? t.window.computerServer;
  const act = (action: ComputerAnswer) => answerComputer(action).then(onChange, onFailure);
  /* An older server shows it to the CEO alone. */
  const decides = view.canAnswer ?? true;

  if (isOpen(view)) {
    return (
      <section className="t-card" aria-label={t.window.computerAccess(machine)}>
        <h4>{t.window.computerAccess(machine)}</h4>
        <p className="t-card-brief">{t.window.computerOpenUntil(machine, clock(language, view.until)!)}</p>
        {decides ? (
          <div className="f">
            <button className="btn ghost" type="button" onClick={() => void act('close')}>
              {t.window.computerClose}
            </button>
          </div>
        ) : (
          <DecidedByNote by={CEO_DECIDES} />
        )}
      </section>
    );
  }
  if (!view.asked) return null;
  return (
    <section className="t-card" aria-label={t.window.computerAsks(machine)}>
      <h4>{t.window.computerAsks(machine)}</h4>
      <p className="t-card-brief">{view.asked.reason}</p>
      <p className="t-card-brief">{t.window.computerWhat(machine)}</p>
      {decides ? (
        <div className="f">
          <button className="btn" type="button" onClick={() => void act('open')}>
            {t.window.computerOpen}
          </button>
          <button className="btn ghost" type="button" onClick={() => void act('decline')}>
            {t.window.computerNotNow}
          </button>
        </div>
      ) : (
        <DecidedByNote by={CEO_DECIDES} />
      )}
    </section>
  );
}
