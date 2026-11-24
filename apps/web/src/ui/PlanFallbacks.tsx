import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useLanguage, useT } from '../i18n';
import type { AgentCardView, PlanFallback, SubView } from '../types';
import { FallbackIcon } from './icons';
import { servingLabel } from './StaffCard';
import { formatTagOf } from '@hornhoof/protocol';

const planLabel = (s: SubView) => servingLabel({ kind: s.kind, label: s.label, provider: s.provider, owner: s.owner.name });

type Change = (fallbacks: PlanFallback[]) => unknown;

/* What the person did last to the list, so that once the server has saved it the focus stays where they work: in the plan
   they moved, or on the record after the one they took away. */
type Intent = { kind: 'move'; plan: string; move: 'up' | 'down' } | { kind: 'remove'; at: number };

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

const entriesOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.fallback-list > .entry')];
const firstControl = (entry: HTMLElement | undefined) => entry?.querySelector<HTMLElement>('select, button:not(:disabled)');

/* Where the focus goes once a change of the list is saved, and what a screen reader hears about it. */
function focusAfter(root: HTMLElement, intent: Intent, add: HTMLElement | null): HTMLElement | null {
  const entries = entriesOf(root);
  if (intent.kind === 'remove') return firstControl(entries[Math.min(intent.at, entries.length - 1)]) ?? add;
  const entry = entries.find(e => e.dataset.plan === intent.plan);
  const wanted = entry?.querySelector<HTMLButtonElement>(`[data-move="${intent.move}"]`);
  const other = entry?.querySelector<HTMLButtonElement>(`[data-move="${intent.move === 'up' ? 'down' : 'up'}"]`);
  return wanted && !wanted.disabled ? wanted : (other ?? null);
}

/* The band of a plan's fallback plans in their order, each with its model, for whoever may change the plan to order, add
   and remove; none named means any plan of the company with room. */
export function PlanFallbacks({ sub, plans, editable, onChange }: { sub: SubView; plans: SubView[]; editable: boolean; onChange: Change }) {
  const t = useT();
  const heading = useId();
  const list = sub.fallbacks ?? [];
  const named = namedIn(list, plans);
  const root = useRef<HTMLElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const intent = useRef<Intent | null>(null);
  const [said, setSaid] = useState('');
  const order = list.map(f => f.subscription).join(' ');
  useEffect(() => {
    const done = intent.current;
    intent.current = null;
    if (!done || !root.current) return;
    focusAfter(root.current, done, add.current)?.focus();
    if (done.kind !== 'move') return;
    const at = list.findIndex(f => f.subscription === done.plan);
    const plan = plans.find(p => p.id === done.plan);
    if (plan && at >= 0) setSaid(t.subs.fallbackMoved(planLabel(plan), at + 1));
    /* The list's order is what a saved change shows; the rest is read as it stands then. */
  }, [order]);
  const change = (next: PlanFallback[], what: Intent | null) => {
    intent.current = what;
    return onChange(next);
  };
  return (
    <section className="plan-fallbacks" aria-labelledby={heading} ref={root}>
      <h4 id={heading}>{t.subs.fallbacks}</h4>
      {named.length ? (
        <>
          <p className="part-note" dir="auto">{t.subs.fallbacksHint}</p>
          <ol className="fallback-list">
            {named.map(({ fallback, plan }, i) => (
              <FallbackItem key={plan.id} fallback={fallback} plan={plan} list={list} place={i + 1} first={i === 0} last={i === named.length - 1} editable={editable} onChange={change} />
            ))}
          </ol>
        </>
      ) : (
        <p className="part-note" dir="auto">{t.subs.fallbacksAny}</p>
      )}
      {editable && <AddFallback sub={sub} plans={plans} list={list} onChange={change} button={add} />}
      <p className="sr" role="status">{said}</p>
    </section>
  );
}

type Item = { fallback: PlanFallback; plan: SubView; list: PlanFallback[]; place: number; first: boolean; last: boolean; editable: boolean; onChange: (next: PlanFallback[], what: Intent | null) => unknown };

function FallbackItem(item: Item) {
  return (
    <li className="entry" data-plan={item.plan.id}>
      <span className="fallback-position" aria-hidden="true">{item.place}</span>
      <p className="fallback-name"><bdi dir="auto">{planLabel(item.plan)}</bdi></p>
      {item.editable ? <FallbackControls {...item} /> : <FallbackModel fallback={item.fallback} plan={item.plan} />}
    </li>
  );
}

/* Its model, and moving it up, down or away. */
function FallbackControls({ fallback, plan, list, first, last, onChange }: Item) {
  const t = useT();
  const name = planLabel(plan);
  const at = list.indexOf(fallback);
  const pick = (model: string) => onChange(list.map(f => (f === fallback ? { ...f, model: model || null } : f)), null);
  const up = t.subs.fallbackUpLabel(name);
  const down = t.subs.fallbackDownLabel(name);
  const away = t.subs.fallbackRemoveLabel(name);
  return (
    <div className="fallback-model field">
      <ModelField fallback={fallback} plan={plan} name={name} pick={pick} />
      <div className="fallback-moves entry-actions">
        <button className="act" type="button" data-move="up" aria-label={up} title={up} disabled={first} onClick={() => onChange(moved(list, at, at - 1), { kind: 'move', plan: plan.id, move: 'up' })}><FallbackIcon name="up" /></button>
        <button className="act" type="button" data-move="down" aria-label={down} title={down} disabled={last} onClick={() => onChange(moved(list, at, at + 1), { kind: 'move', plan: plan.id, move: 'down' })}><FallbackIcon name="down" /></button>
        <button className="act danger" type="button" aria-label={away} title={away} onClick={() => onChange(list.filter(f => f !== fallback), { kind: 'remove', at })}><FallbackIcon name="remove" /></button>
      </div>
    </div>
  );
}

/* About as many characters as one line of the model field holds on a 375 px phone. A browser's own menu of choices cuts a
   longer name there, so a field with one opens a list of whole names under itself instead. */
const LONG_MODEL = 30;

type ModelOption = { id: string; name: string };

/* The model a fallback plan runs: the role's own, or one its plan names. The field shows the whole name of the one chosen,
   wrapped when long. */
function ModelField({ fallback, plan, name, pick }: { fallback: PlanFallback; plan: SubView; name: string; pick: (model: string) => unknown }) {
  const t = useT();
  const id = useId();
  const options: ModelOption[] = [{ id: '', name: t.subs.fallbackModel }, ...(plan.models ?? []).map(m => ({ id: m.id, name: m.name }))];
  const value = fallback.model ?? '';
  const chosen = options.find(o => o.id === value)?.name ?? value;
  const label = t.subs.fallbackModelLabel(name);
  const long = options.some(o => o.name.length > LONG_MODEL);
  return (
    <>
      <label htmlFor={id}>{t.subs.fallbackModelField}</label>
      {long ? <ModelList id={id} label={label} options={options} value={value} chosen={chosen} pick={pick} /> : (
        <span className="select-wrap model-select">
          <select id={id} className="sel" aria-label={label} value={value} onChange={e => pick(e.target.value)}>
            {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <span className="model-value" aria-hidden="true"><bdi dir="auto">{chosen}</bdi></span>
        </span>
      )}
    </>
  );
}

/* Escape closes a list that opened under its button, and gives the focus back to that button. */
function closer(open: boolean, close: () => void, button: RefObject<HTMLButtonElement | null>) {
  return (e: KeyboardEvent) => {
    if (!open || e.key !== 'Escape') return;
    e.preventDefault();
    close();
    button.current?.focus();
  };
}

/* The model field of long names: a button that shows the one chosen and opens the whole names as radio buttons under it. */
function ModelList({ id, label, options, value, chosen, pick }: { id: string; label: string; options: ModelOption[]; value: string; chosen: string; pick: (model: string) => unknown }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const choices = `${id}-choices`;
  const closeOnEscape = closer(open, () => setOpen(false), trigger);
  const choose = (model: string) => {
    setOpen(false);
    trigger.current?.focus();
    pick(model);
  };
  return (
    <>
      <button ref={trigger} id={id} className="select-wrap model-trigger" type="button" aria-label={label} aria-expanded={open} aria-controls={choices} onClick={() => setOpen(!open)} onKeyDown={closeOnEscape}>
        <span className="model-value"><bdi dir="auto">{chosen}</bdi></span>
      </button>
      {open && (
        <fieldset id={choices} className="choice-list" onKeyDown={closeOnEscape}>
          <legend className="sr">{label}</legend>
          {options.map(o => (
            <label key={o.id} className="model-choice">
              <input type="radio" name={choices} value={o.id} checked={o.id === value} onChange={() => choose(o.id)} />
              <bdi dir="auto">{o.name}</bdi>
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}

/* The model named for it, to someone who may not change it; none means the role's own. */
function FallbackModel({ fallback, plan }: { fallback: PlanFallback; plan: SubView }) {
  if (!fallback.model) return null;
  const known = (plan.models ?? []).find(m => m.id === fallback.model);
  return <p className="fallback-model part-note"><bdi dir="auto">{known?.name ?? fallback.model}</bdi></p>;
}

/* Another plan of the company to add after the ones named, from a list of their whole names that opens under Add. */
function AddFallback({ sub, plans, list, onChange, button }: { sub: SubView; plans: SubView[]; list: PlanFallback[]; onChange: Item['onChange']; button: RefObject<HTMLButtonElement | null> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const choices = useId();
  const free = plans.filter(p => p.id !== sub.id && !list.some(f => f.subscription === p.id));
  if (!free.length) return null;
  const label = t.subs.fallbackAddLabel(planLabel(sub));
  const add = (plan: SubView) => {
    setOpen(false);
    button.current?.focus();
    onChange([...list, { subscription: plan.id, model: null }], null);
  };
  return (
    <div className="fallback-add" onKeyDown={closer(open, () => setOpen(false), button)}>
      <button ref={button} className="btn ghost" type="button" aria-label={label} aria-expanded={open} aria-controls={choices} onClick={() => setOpen(!open)}>
        <FallbackIcon name="add" />{t.subs.fallbackAdd}
      </button>
      {open && (
        <ul id={choices} className="choice-list" aria-label={label}>
          {free.map(p => <li key={p.id}><button className="act" type="button" onClick={() => add(p)}><bdi dir="auto">{planLabel(p)}</bdi></button></li>)}
        </ul>
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
  const until = card.fallback.until ? new Date(card.fallback.until).toLocaleString(formatTagOf(language), { dateStyle: 'short', timeStyle: 'short' }) : null;
  return <p className="warn-line" role="status">{t.agent.onFallback(planLabel(card.subscription), planLabel(card.fallback.home), until)}</p>;
}
