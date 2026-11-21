import { errorText, useLanguage, useT } from '../i18n';
import type { CompanyPauseState } from '../pause';
import { useBarFold } from './shellBars';

function pausedTime(language: string, iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(
    language,
    sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  ).format(date);
}

/* Under the top bar: shows everyone when the company is paused and how many turns are still finishing, with Resume for
   people who see the whole company. */
export function CompanyPauseBanner({ state, canControl }: { state: CompanyPauseState; canControl: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  const fold = useBarFold();
  const { view, busy, failure, resume } = state;

  if (!view.paused) {
    if (failure === null) return null;
    return (
      <div className="alert" role="alert" dir="auto">
        {errorText(t, failure)}
      </div>
    );
  }

  const at = pausedTime(language, view.paused.at);
  const text = view.finishingTurns > 0
    ? t.companyPause.bannerRunning(view.finishingTurns, view.paused.byName, at)
    : t.companyPause.bannerIdle(view.paused.byName, at);

  return (
    <div className={fold.className} role="status" aria-label={t.companyPause.label}>
      <span dir="auto">{text}</span>
      {canControl && (
        <button className="btn small" type="button" disabled={busy} onClick={() => void resume()}>
          {t.companyPause.resume}
        </button>
      )}
      {fold.more}
      {failure !== null && <p className="update-error" role="alert" dir="auto">{errorText(t, failure)}</p>}
    </div>
  );
}
