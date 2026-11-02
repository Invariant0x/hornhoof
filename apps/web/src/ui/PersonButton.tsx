import type { ReactNode } from 'react';
import { useT } from '../i18n';
import type { PersonView } from '../types';

/* A person's card, on the map and in a department alike: it opens the decisions waiting for them, shows how many there are
   and breathes amber while any wait. A count the viewer cannot see shows nothing. */
export function PersonButton({ person, onOpen, children }: { person: PersonView; onOpen(): void; children: ReactNode }) {
  const t = useT();
  const n = person.pendingDecisions ?? null;
  return (
    <button type="button" className={`chip-btn${n ? ' attn' : ''}`} aria-label={t.map.decisionsOf(person.name, n)} onClick={onOpen}>
      {children}
      {n ? (
        <span className="nav-count chip-count" aria-hidden="true">
          {n}
        </span>
      ) : null}
    </button>
  );
}
