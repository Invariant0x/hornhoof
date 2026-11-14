import type { ReactNode } from 'react';
import { useT } from '../i18n';
import type { PersonView } from '../types';
import { FrameBreathe } from './map-motion';

type PersonButtonProps = {
  person: PersonView;
  frame?: { w: number; h: number; cut: number };
  onOpen(): void;
  children: ReactNode;
};

/* A person's card, on the map and in a department alike: it opens the decisions waiting for them, shows how many there are
   and breathes amber while any wait. A count the viewer cannot see shows nothing. */
export function PersonButton({ person, frame, onOpen, children }: PersonButtonProps) {
  const t = useT();
  const n = person.pendingDecisions ?? null;
  return (
    <button type="button" className={`chip-btn${n ? ' attn' : ''}`} aria-label={t.map.decisionsOf(person.name, n)} onClick={onOpen}>
      {children}
      {n && frame ? <FrameBreathe w={frame.w} h={frame.h} cut={frame.cut} /> : null}
      {n ? (
        <span className="nav-count chip-count" aria-hidden="true">
          {n}
        </span>
      ) : null}
    </button>
  );
}
