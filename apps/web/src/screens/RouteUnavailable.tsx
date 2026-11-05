import { ApiFailure } from '../api';
import { useT } from '../i18n';

export type CardRoute = { selected?: string | null; onSelect?: (id: string | null) => void; onHome?: () => void };

export function unavailableFailure(failure: unknown): boolean {
  return failure instanceof ApiFailure && (failure.status === 403 || failure.status === 404);
}

export function RouteUnavailable({ onHome = () => location.assign('/'), dialog = false }: { onHome?: () => void; dialog?: boolean }) {
  const t = useT();
  const content = <section className={dialog ? 'settings-part' : 'people'}>
    <h1>{t.routes.accessDenied}</h1>
    <p className="muted">{t.routes.explanation}</p>
    <button className="btn" type="button" onClick={onHome}>{t.routes.home}</button>
  </section>;
  return dialog ? <div className="dialog-back"><div className="dialog" role="dialog" aria-label={t.routes.accessDenied}>{content}</div></div> : content;
}
