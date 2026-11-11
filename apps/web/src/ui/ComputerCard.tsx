import { useLanguage, useT } from '../i18n';
import type { ComputerAccessView } from '../types';
import { cannotOpen, decidesAccess, givesLines, isOpen, machineName, useAccess } from './access';
import { DecidedByNote } from './DecidedBy';
import { clock } from './subscription';

/* Computer access to one machine, among what waits for a person: the orchestrator's request with one click of the
   machine's owner to open it for a day, or that it is open, with the click that closes it. Whoever sees it without the
   right reads who takes it. */
export function ComputerCard({ view, onChange, onFailure }: { view: ComputerAccessView; onChange(next: ComputerAccessView): void; onFailure(err: unknown): void }) {
  const t = useT();
  const { language } = useLanguage();
  const { answer, prompt } = useAccess(onChange, onFailure);
  const machine = machineName(t, view.machine);

  if (isOpen(view)) {
    return (
      <section className="t-card" aria-label={t.window.machineAccess(machine)}>
        <h4>{t.window.machineAccess(machine)}</h4>
        <p className="t-card-brief">{t.window.computerOpenUntil(machine, clock(language, view.until) ?? '')}</p>
        {view.canClose && (
          <div className="f">
            <button className="btn ghost" type="button" onClick={() => void answer(view, 'close')}>
              {t.window.computerClose}
            </button>
          </div>
        )}
      </section>
    );
  }
  if (!view.asked) return null;
  const blocked = cannotOpen(t, view);
  return (
    <section className="t-card" aria-label={t.window.computerAsks(machine)}>
      <h4>{t.window.computerAsks(machine)}</h4>
      <p className="t-card-brief">{view.asked.reason}</p>
      <p className="t-card-brief">{t.window.computerWhat(machine)}</p>
      {givesLines(t, view).map(line => (
        <p key={line} className="t-card-brief">
          {line}
        </p>
      ))}
      {!view.canOpen ? (
        <DecidedByNote by={decidesAccess(view)} />
      ) : (
        (prompt ?? (
          <>
            {blocked && <p className="muted">{blocked}</p>}
            <div className="f">
              {!blocked && (
                <button className="btn" type="button" onClick={() => void answer(view, 'open')}>
                  {t.window.computerOpenFor(machine)}
                </button>
              )}
              <button className="btn ghost" type="button" onClick={() => void answer(view, 'decline')}>
                {t.window.computerNotNow}
              </button>
            </div>
          </>
        ))
      )}
    </section>
  );
}
