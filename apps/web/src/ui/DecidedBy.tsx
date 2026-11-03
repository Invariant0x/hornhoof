import { useT } from '../i18n';
import type { DecidedBy } from '../types';

/* Who takes a decision this person sees and may not take, in place of its buttons. */
export function DecidedByNote({ by = CEO_DECIDES }: { by?: DecidedBy }) {
  const t = useT();
  return <p className="muted decided-by">{by.kind === 'department_and_ceo' && by.department ? t.tasks.decidedByDepartment(by.department.name) : t.tasks.decidedByCeo}</p>;
}

/* The CEO's own decisions: the orchestrator's cards and the computer. */
export const CEO_DECIDES: DecidedBy = { kind: 'ceo_and_delegate', department: null };
