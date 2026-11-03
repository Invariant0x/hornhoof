import { useState } from 'react';
import { api } from '../api';
import { deptLabel, errorText, useT, type Messages } from '../i18n';
import { TEMPLATES } from '../templates';
import type { DecidedBy, NewItem, Org, StructureItem, TemplateKey } from '../types';
import { Decides, frozenBy } from './DecidedBy';

type Props = {
  proposal?: { id: string; brief: string; items: StructureItem[] };
  /* Building by hand: the templates the company does not have yet, with the default ticks. */
  manual?: { existing: TemplateKey[] };
  departments: Org['departments'];
  onCorrect(): void;
  /* Called once its departments are created. */
  onDone?(): void;
  /* Only the hand-made card can be put away; his proposal stays until it is applied or replaced. */
  onHide?(): void;
  /* Someone who may not take the card reads it, with who takes it, and changes nothing. */
  locked?: DecidedBy;
};

const isNew = (item: StructureItem): item is NewItem => 'template' in item;
/* Operations is always there: a new one cannot be left out. */
const fixed = (item: StructureItem) => isNew(item) && item.template === 'operations';

function nameOf(t: Messages, item: StructureItem, departments: Org['departments']): string {
  if (isNew(item)) return item.name ?? t.templates[item.template].name;
  const dept = departments.find(d => d.id === item.department);
  return dept ? deptLabel(t, dept) : '';
}

/* The orchestrator's proposal, or the hand-made one: ticks, and one click that creates them. */
export function StructureCard({ proposal, manual, departments, onCorrect, onDone, onHide, locked }: Props) {
  const t = useT();
  const [items] = useState<StructureItem[]>(
    () => proposal?.items ?? TEMPLATES.filter(x => !manual?.existing.includes(x.key)).map(x => ({ template: x.key, checked: x.ticked, note: '' })),
  );
  const [ticks, setTicks] = useState(() => items.map(i => i.checked || fixed(i)));
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const chosen = items.filter((_, i) => ticks[i]);
  const label = chosen.length && chosen.every(i => !isNew(i)) ? t.card.apply(chosen.length) : t.card.create(chosen.length);

  async function create() {
    setBusy(true);
    setFailure(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip UI-only checked flag from payload items
      const picked = chosen.map(({ checked: _checked, ...rest }) => rest);
      await api.post('/api/departments/build', proposal ? { proposalId: proposal.id, items: picked } : { items: picked });
      setSent(true);
      onDone?.();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`t-card${sent ? ' done' : ''}`}>
      <h4>{t.card.title}</h4>
      {items.map((item, i) => {
        const note = item.note || (isNew(item) ? t.templates[item.template].description : '');
        return (
          <label key={i} className={fixed(item) ? 'lock' : ''}>
            <input
              type="checkbox"
              data-template={isNew(item) ? item.template : undefined}
              checked={ticks[i]}
              disabled={frozenBy(sent, locked) || fixed(item)}
              onChange={e => setTicks(ticks.map((v, j) => (j === i ? e.target.checked : v)))}
            />
            <span>
              <b>{nameOf(t, item, departments)}</b>
              {!isNew(item) && item.remove && <em className="t-card-tag">{t.card.remove}</em>}
              {note && <small>{note}</small>}
              {!!item.products?.length && (
                <small>
                  {t.card.products}: <span>{item.products.join(', ')}</span>
                </small>
              )}
            </span>
          </label>
        );
      })}
      {failure !== null && (
        <p className="alert" role="alert">
          {errorText(t, failure)}
        </p>
      )}
      <div className="f">
        <Decides locked={locked}>
          <button className="btn" type="button" disabled={sent || busy || !chosen.length} onClick={() => void create()}>
            {label}
          </button>
          {!sent && (
            <button className="btn ghost" type="button" onClick={onCorrect}>
              {t.card.correct}
            </button>
          )}
        </Decides>
        {!sent && onHide && (
          <button className="btn ghost" type="button" onClick={onHide}>
            {t.card.hide}
          </button>
        )}
        {sent && <span className="t-card-state">{t.card.applied}</span>}
      </div>
    </div>
  );
}
