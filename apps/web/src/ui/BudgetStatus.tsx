import { useT, type Messages } from '../i18n';
import type { BudgetQuality, BudgetReason, BudgetView, ControlCoverage } from '../types';
import { ResetTime, resetDuration, useNow } from './reset';

const reasonText = (t: Messages, reason: BudgetReason | null) => (reason ? t.subs.budgetReasons[reason] : t.subs.budgetWaiting);
const qualityText = (t: Messages, quality: BudgetQuality) => t.subs.budgetQuality[quality];
const controlText = (t: Messages, control: ControlCoverage) => t.subs.budgetControl[control];

function BudgetSample({ sampledAt, now }: { sampledAt: string | null; now: number }) {
  const t = useT();
  const at = sampledAt ? Date.parse(sampledAt) : NaN;
  if (!Number.isFinite(at) || at > now) return <p className="limits">{t.subs.budgetSampleUnknown}</p>;
  return <p className="limits">{t.subs.budgetSampled(resetDuration(t, now - at))}</p>;
}

function BudgetReset({ decision, now, windowName }: { decision: BudgetView['decision']; now: number; windowName: (name: string) => string }) {
  const t = useT();
  if (decision.allowed) return null;
  if (!decision.blockingWindows.length) return <p className="limits"><ResetTime at={decision.resetHintAt} now={now} /></p>;
  return (
    <ul className="limits" aria-label={t.subs.budgetBlockingWindows}>
      {decision.blockingWindows.map(window => (
        <li key={window.name}>
          <span>{windowName(window.name)}</span> <ResetTime at={window.resetsAt} now={now} />
        </li>
      ))}
    </ul>
  );
}

export function BudgetStatus({ budget, windowName }: { budget: BudgetView | null; windowName: (name: string) => string }) {
  const t = useT();
  const now = useNow();
  if (!budget) return null;
  const { decision } = budget;
  return (
    <div className="budget-status">
      <p className="limits">{decision.allowed ? t.subs.budgetAllowed : reasonText(t, decision.reason)}</p>
      {decision.quality !== 'complete' && <p className="limits">{qualityText(t, decision.quality)}</p>}
      {budget.control !== 'complete' && <p className="limits">{controlText(t, budget.control)}</p>}
      <BudgetSample sampledAt={decision.sampledAt} now={now} />
      <BudgetReset decision={decision} now={now} windowName={windowName} />
    </div>
  );
}
