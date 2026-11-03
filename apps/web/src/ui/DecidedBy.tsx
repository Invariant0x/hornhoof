import type { ReactNode } from 'react';
import { useT } from '../i18n';
import type { DecidedBy } from '../types';

/* Who takes a decision this person sees and may not take, in place of its buttons. */
export function DecidedByNote({ by = CEO_DECIDES }: { by?: DecidedBy }) {
  const t = useT();
  return <p className="muted decided-by">{by.kind === 'department_and_ceo' && by.department ? t.tasks.decidedByDepartment(by.department.name) : t.tasks.decidedByCeo}</p>;
}

/* The buttons that take a card's decision, or for someone who may not take it, who takes it. */
export function Decides({ locked, children }: { locked?: DecidedBy; children: ReactNode }) {
  return locked ? <DecidedByNote by={locked} /> : <>{children}</>;
}

/* A card's ticks and choices stay as they are once it is sent, or when this person may not take it. */
export const frozenBy = (sent: boolean, locked: DecidedBy | undefined): boolean => sent || locked !== undefined;

/* The CEO's own decisions: the orchestrator's cards and the computer. */
export const CEO_DECIDES: DecidedBy = { kind: 'ceo_and_delegate', department: null };
