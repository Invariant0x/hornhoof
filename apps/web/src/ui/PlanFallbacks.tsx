import { useLanguage, useT } from '../i18n';
import type { AgentCardView, PlanFallback, SubView } from '../types';
import { servingLabel } from './StaffCard';

const planLabel = (s: SubView) => servingLabel({ kind: s.kind, label: s.label, provider: s.provider, owner: s.owner.name });

type Change = (fallbacks: PlanFallback[]) => unknown;

/* The list with one fallback moved from one place to another. */
function moved(list: PlanFallback[], from: number, to: number): PlanFallback[] {
  const next = [...list];
  const [one] = next.splice(from, 1);
  next.splice(to, 0, one!);
  return next;
}

/* The named fallbacks whose plans the screen knows, in their order. */
const namedIn = (list: PlanFallback[], plans: SubView[]) =>
  list.flatMap(fallback => plans.filter(p => p.id === fallback.subscription).map(plan => ({ fallback, plan })));

/* The fallback plans of a plan in their order, each with its model, for whoever may change the plan to order, add and
   remove; none named means any plan of the company with room. */
export function PlanFallbacks({ sub, plans, editable, onChange }: { sub: SubView; plans: SubView[]; editable: boolean; onChange: Change }) {
  const t = useT();
  const list = sub.fallbacks ?? [];
  const named = namedIn(list, plans);
  return (
    <div className="plan-fallbacks">
      <small>{t.subs.fallbacksHint}</small>
      {named.length ? (
        <ol className="fallback-list">
          {named.map(({ fallback, plan }, i) => (
            <FallbackItem key={plan.id} fallback={fallback} plan={plan} list={list} first={i === 0} last={i === named.length - 1} editable={editable} onChange={onChange} />
          ))}
        </ol>
      ) : (
        <p className="part-note">{t.subs.fallbacksAny}</p>
      )}
      {editable && <AddFallback sub={sub} plans={plans} list={list} onChange={onChange} />}
    </div>
  );
}

type Item = { fallback: PlanFallback; plan: SubView; list: PlanFallback[]; first: boolean; last: boolean; editable: boolean; onChange: Change };

function FallbackItem(item: Item) {
  return (
    <li>
      <span className="fallback-name">{planLabel(item.plan)}</span>
      {item.editable ? <FallbackControls {...item} /> : <FallbackModel fallback={item.fallback} plan={item.plan} />}
    </li>
  );
}

/* Its model, and moving it up, down or away. */
function FallbackControls({ fallback, plan, list, first, last, onChange }: Item) {
  const t = useT();
  const name = planLabel(plan);
  const at = list.indexOf(fallback);
  const pick = (model: string) => onChange(list.map(f => (f === fallback ? { ...f, model: model || null } : f)));
  return (
    <>
      <select className="sel" aria-label={t.subs.fallbackModelLabel(name)} value={fallback.model ?? ''} onChange={e => pick(e.target.value)}>
        <option value="">{t.subs.fallbackModel}</option>
        {(plan.models ?? []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <span className="fallback-moves">
        <button className="act" type="button" aria-label={t.subs.fallbackUpLabel(name)} disabled={first} onClick={() => onChange(moved(list, at, at - 1))}>{t.subs.fallbackUp}</button>
        <button className="act" type="button" aria-label={t.subs.fallbackDownLabel(name)} disabled={last} onClick={() => onChange(moved(list, at, at + 1))}>{t.subs.fallbackDown}</button>
        <button className="act danger" type="button" aria-label={t.subs.fallbackRemoveLabel(name)} onClick={() => onChange(list.filter(f => f !== fallback))}>{t.subs.fallbackRemove}</button>
      </span>
    </>
  );
}

/* The model named for it, to someone who may not change it; none means the role's own. */
function FallbackModel({ fallback, plan }: { fallback: PlanFallback; plan: SubView }) {
  if (!fallback.model) return null;
  const known = (plan.models ?? []).find(m => m.id === fallback.model);
  return <span className="part-note">{known?.name ?? fallback.model}</span>;
}

/* Another plan of the company to add after the ones named. */
function AddFallback({ sub, plans, list, onChange }: { sub: SubView; plans: SubView[]; list: PlanFallback[]; onChange: Change }) {
  const t = useT();
  const free = plans.filter(p => p.id !== sub.id && !list.some(f => f.subscription === p.id));
  if (!free.length) return null;
  return (
    <select className="sel" aria-label={t.subs.fallbackAddLabel(planLabel(sub))} value="" onChange={e => e.target.value && onChange([...list, { subscription: e.target.value, model: null }])}>
      <option value="">{t.subs.fallbackAdd}</option>
      {free.map(p => <option key={p.id} value={p.id}>{planLabel(p)}</option>)}
    </select>
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
