import { useState } from 'react';
import { useLanguage, useT } from '../i18n';
import type { AgentCardView, OfflineMachine as Offline, SubView } from '../types';
import { servingLabel } from './StaffCard';
import { formatTagOf } from '@hornhoof/protocol';

/* Which machine of the plan is offline and since when, on the card of the employee and of its task. */
export function OfflineMachine({ offline }: { offline: Offline }) {
  const t = useT();
  const { language } = useLanguage();
  const at = offline.since ? new Date(offline.since).toLocaleString(formatTagOf(language), { dateStyle: 'short', timeStyle: 'short' }) : null;
  return <p className="warn-line" role="status">{t.agent.offlineSince(offline.hostname, at)}</p>;
}

/* The plans of the employee's own department it can move to in one click: online, signed in and set up, and not its own. */
function movesFor(card: Pick<AgentCardView, 'subscription' | 'runsOn' | 'department'>): SubView[] {
  const home = card.department?.id;
  return card.runsOn
    .map(r => r.subscription)
    .filter(s => s.id !== card.subscription?.id && s.online && s.status === 'ready' && s.place.kind === 'department' && s.place.id === home);
}

const label = (s: SubView) => servingLabel({ kind: s.kind, label: s.label, provider: s.provider, owner: s.owner.name });

/* The offline line on an employee's card, with a move to each plan of its department that can take its work now for whoever
   may change the card. */
export function OfflinePlan({ card, editable, onMove }: { card: AgentCardView; editable: boolean; onMove(subscription: string): Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (!card.offline) return null;
  const moves = editable ? movesFor(card) : [];
  return (
    <div className="offline-plan">
      <OfflineMachine offline={card.offline} />
      {editable && !moves.length && <p className="part-note">{t.agent.noPlanOnline}</p>}
      {moves.length > 0 && (
        <div className="offline-moves" role="group" aria-label={t.agent.movesLabel}>
          {moves.map(s => (
            <button key={s.id} className="btn small ghost" type="button" disabled={busy} onClick={() => { setBusy(true); void onMove(s.id).finally(() => setBusy(false)); }}>
              {t.agent.moveTo(label(s))}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
