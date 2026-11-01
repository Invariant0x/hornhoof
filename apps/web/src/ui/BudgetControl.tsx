import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';

type Props = {
  subscriptionId: string;
  budgetPercent?: number;
  canManage: boolean;
  onConfirmed?: (budgetPercent: number) => void;
};

type Identity = Pick<Props, 'subscriptionId' | 'budgetPercent'>;
const sameBudget = (a: Identity, b: Identity) => a.subscriptionId === b.subscriptionId && a.budgetPercent === b.budgetPercent;

export function BudgetControl({ subscriptionId, budgetPercent = 100, canManage, onConfirmed }: Props) {
  const t = useT();
  const [confirmed, setConfirmed] = useState(budgetPercent);
  const [draft, setDraft] = useState(budgetPercent);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const previous = useRef({ subscriptionId, budgetPercent });
  const id = `budget-${subscriptionId}`;

  useEffect(() => {
    if (!sameBudget(previous.current, { subscriptionId, budgetPercent })) {
      setConfirmed(budgetPercent);
      setDraft(budgetPercent);
      previous.current = { subscriptionId, budgetPercent };
    }
  }, [subscriptionId, budgetPercent]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy || !canManage) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await api.patch<{ subscription: { budgetPercent: number } }>(`/api/subscriptions/${subscriptionId}/budget`, { budgetPercent: draft });
      const next = res.subscription.budgetPercent;
      setConfirmed(next);
      setDraft(next);
      onConfirmed?.(next);
    } catch (err) {
      setDraft(confirmed);
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="budget-control" onSubmit={save}>
      <label htmlFor={id}>{t.subs.budgetLabel}</label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={draft}
        disabled={!canManage || busy}
        aria-describedby={`${id}-hint ${id}-confirmed`}
        onChange={e => setDraft(Number(e.target.value))}
      />
      <output id={`${id}-confirmed`} htmlFor={id}>{t.subs.budgetConfirmed(confirmed)}</output>
      <p className="muted" id={`${id}-hint`}>{t.subs.budgetHint}</p>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {canManage && (
        <div className="actions">
          <button className="btn" type="submit" disabled={busy}>{busy ? t.subs.budgetSaving : t.subs.budgetSave}</button>
        </div>
      )}
    </form>
  );
}
