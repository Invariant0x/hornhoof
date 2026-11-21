import { useEffect, useId, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Phrase, useT } from '../i18n';
import type { ComputerAccessView } from '../types';
import { useConfirmAction } from './ConfirmAction';
import { DecidedByNote } from './DecidedBy';

/* Words in the screen's language keep their order in a page drawn right to left. */
const Line = ({ className, children }: { className?: string; children: ReactNode }) => (
  <p className={className}>
    <bdi dir="ltr">{children}</bdi>
  </p>
);

type Action = 'open' | 'close';

export function MachineAccessBlock({ view: given, onChanged }: { view: ComputerAccessView; onChanged(): void }) {
  const t = useT();
  const c = t.machines.computer;
  const heading = useId();
  const [answered, setAnswered] = useState<ComputerAccessView | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const confirmation = useConfirmAction();
  useEffect(() => setAnswered(null), [given]);
  const view = answered ?? given;
  const full = view.scope === 'all_agents';
  const state = view.open ? full ? 'full' : 'open' : 'closed';
  const action = view.open ? 'close' : 'open';
  const label = view.open ? t.window.computerClose : c.reopen;

  async function change(next: Action) {
    setBusy(next);
    try {
      setAnswered(await api.post<ComputerAccessView>(`/api/machines/${view.machine.id}/access/${next}`));
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  function askChange(next: Action) {
    const words = next === 'close' ? t.machines.confirm.closeAccess : t.machines.confirm.openAccess;
    confirmation.ask({
      ...words,
      effect: <Phrase words={words.effect} values={[<bdi>{view.machine.hostname}</bdi>]} />,
      danger: next === 'close',
      onYes: () => change(next),
    });
  }

  return (
    <section className="part acc" aria-labelledby={heading}>
      <h5 className="part-h" id={heading}>
        {t.machines.access}
      </h5>
      <p><span className={`status acc-${state}`}>{c[state]}</span></p>
      {view.open ? (
        <>
          <Line className="acc-who">{full ? c.forTeam : c.forOrchestrator}</Line>
          <Line className="muted">{full ? c.fullText : c.openText}</Line>
          {!full && view.employees.length > 0 && <Line className="muted">{c.forTasks}</Line>}
          {view.machine.os === 'darwin' && <Line className="muted">{t.window.computerMac}</Line>}
        </>
      ) : <Line>{c.closedText}</Line>}
      {!view.reachable && <Line className="muted">{c.offlineText}</Line>}
      {!view.open && !view.canOpen && <DecidedByNote by={{ kind: 'machine_owner', department: null }} />}
      {(view.open ? view.canClose : view.canOpen) && (
        <div className="entry-actions">
          <button className={view.open ? 'act' : 'btn'} type="button" disabled={busy !== null} onClick={() => askChange(action)}>
            {busy ? busy === 'close' ? c.closing : c.opening : label}
          </button>
        </div>
      )}
      {confirmation.question}
    </section>
  );
}
