import { useLanguage, useT } from '../i18n';
import type { AgentCardView, PlanFallback, SubView } from '../types';
import { servingLabel } from './StaffCard';

const planLabel = (s: SubView) => servingLabel({ kind: s.kind, label: s.label, provider: s.provider, owner: s.owner.name });

/* The fallback plans of a plan in their order, each with its model, for whoever may change the plan to order, add and
   remove; none named means any plan of the company with room. */
export function PlanFallbacks({ sub, plans, editable, onChange }: { sub: SubView; plans: SubView[]; editable: boolean; onChange(fallbacks: PlanFallback[]): unknown }) {
  const t = useT();
  const list = sub.fallbacks ?? [];
  const named = list.flatMap(f => {
    const plan = plans.find(p => p.id === f.subscription);
    return plan ? [{ fallback: f, plan }] : [];
  });
  const free = plans.filter(p => p.id !== sub.id && !list.some(f => f.subscription === p.id));
  const moved = (from: number, to: number) => {
    const next = [...list];
    const [one] = next.splice(from, 1);
    next.splice(to, 0, one!);
    return next;
  };
  return (
    <div className="plan-fallbacks">
      <small>{t.subs.fallbacksHint}</small>
      {!named.length && <p className="part-note">{t.subs.fallbacksAny}</p>}
      {named.length > 0 && (
        <ol className="fallback-list">
          {named.map(({ fallback, plan }, i) => {
            const name = planLabel(plan);
            const at = list.indexOf(fallback);
            return (
              <li key={plan.id}>
                <span className="fallback-name">{name}</span>
                {editable ? (
                  <>
                    <select className="sel" aria-label={t.subs.fallbackModelLabel(name)} value={fallback.model ?? ''} onChange={e => onChange(list.map(f => (f === fallback ? { ...f, model: e.target.value || null } : f)))}>
                      <option value="">{t.subs.fallbackModel}</option>
                      {(plan.models ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <span className="fallback-moves">
                      <button className="act" type="button" aria-label={t.subs.fallbackUpLabel(name)} disabled={i === 0} onClick={() => onChange(moved(at, at - 1))}>{t.subs.fallbackUp}</button>
                      <button className="act" type="button" aria-label={t.subs.fallbackDownLabel(name)} disabled={i === named.length - 1} onClick={() => onChange(moved(at, at + 1))}>{t.subs.fallbackDown}</button>
                      <button className="act danger" type="button" aria-label={t.subs.fallbackRemoveLabel(name)} onClick={() => onChange(list.filter(f => f !== fallback))}>{t.subs.fallbackRemove}</button>
                    </span>
                  </>
                ) : (
                  fallback.model && <span className="part-note">{(plan.models ?? []).find(m => m.id === fallback.model)?.name ?? fallback.model}</span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {editable && free.length > 0 && (
        <select className="sel" aria-label={t.subs.fallbackAddLabel(planLabel(sub))} value="" onChange={e => e.target.value && onChange([...list, { subscription: e.target.value, model: null }])}>
          <option value="">{t.subs.fallbackAdd}</option>
          {free.map(p => <option key={p.id} value={p.id}>{planLabel(p)}</option>)}
        </select>
      )}
    </div>
  );
}

/* The line on an employee's card while Hornhoof keeps it on a fallback plan: which one, until when its own plan's limit
   holds, and the plan it goes back to. */
export function FallbackLine({ card }: { card: Pick<AgentCardView, 'fallback' | 'subscription'> }) {
  const t = useT();
  const { language } = useLanguage();
  if (!card.fallback || !card.subscription) return null;
  const until = card.fallback.until ? new Date(card.fallback.until).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }) : null;
  return <p className="warn-line" role="status">{t.agent.onFallback(planLabel(card.subscription), planLabel(card.fallback.home), until)}</p>;
}
