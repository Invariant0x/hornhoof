import { ApiFailure } from '../api';
import { useT } from '../i18n';
import type { Org } from '../types';

export type CardRoute = { selected?: string | null; onSelect?: (id: string | null) => void; onHome?: () => void };

export function unavailableFailure(failure: unknown): boolean {
  return failure instanceof ApiFailure && (failure.status === 403 || failure.status === 404);
}

export function departmentIsMissing({ deptId, org, orgFailure, company, personId }: { deptId: string | null; org: Org | null; orgFailure: unknown; company: boolean; personId: string }): boolean {
  const dept = deptId ? org?.departments.find(d => d.id === deptId) : undefined;
  const reachedDepartment = company || Boolean(dept?.people.some(person => person.id === personId));
  return deptId !== null && (unavailableFailure(orgFailure) || (org !== null && (!dept || !reachedDepartment)));
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
