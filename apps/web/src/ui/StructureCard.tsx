import { DEPARTMENT_TEMPLATES } from '@hornhoof/protocol/catalog';
import { useState } from 'react';
import { deptLabel, errorText, useT, type Messages } from '../i18n';
import type { DecidedBy, MaterialStampView, NewItem, Org, StructureItem, TemplateKey } from '../types';
import { Decides, frozenBy } from './DecidedBy';
import { ProposalMaterialsSection, useProposalCardPost, useProposalMaterials } from './RequestMaterials';

type Props = {
  proposal?: MaterialStampView & { id: string; brief: string; items: StructureItem[] };
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
  /* Whom the card waits for, on a list of what waits for more people than one. */
  waitsFor?: string;
};

const isNew = (item: StructureItem): item is NewItem => 'template' in item;
/* Operations is always there: a new one cannot be left out. */
const fixed = (item: StructureItem) => isNew(item) && item.template === 'operations';

function nameOf(t: Messages, item: StructureItem, departments: Org['departments']): string {
  if (isNew(item)) return item.name ?? t.templates[item.template].name;
  const dept = departments.find(d => d.id === item.department);
  return dept ? deptLabel(t, dept) : '';
}

function defaultStructureItems(existing: TemplateKey[] | undefined): StructureItem[] {
  const taken = existing ?? [];
  return DEPARTMENT_TEMPLATES.filter(x => !taken.includes(x.key)).map(x => ({ template: x.key, checked: x.ticked, note: '' }));
}

function initialStructureItems(proposal: Props['proposal'], manual: Props['manual']): StructureItem[] {
  return proposal ? proposal.items : defaultStructureItems(manual?.existing);
}

function structureActionLabel(t: Messages, chosen: StructureItem[]): string {
  const allExisting = chosen.length > 0 && chosen.every(i => !isNew(i));
  return allExisting ? t.card.apply(chosen.length) : t.card.create(chosen.length);
}

function itemDescription(t: Messages, item: StructureItem): string {
  if (item.note) return item.note;
  return isNew(item) ? t.templates[item.template].description : '';
}

function StructureRowText({ item, departments, t }: { item: StructureItem; departments: Org['departments']; t: Messages }) {
  const note = itemDescription(t, item);
  const showRemove = !isNew(item) && Boolean(item.remove);
  const products = item.products ?? [];
  return (
    <span>
      <b>{nameOf(t, item, departments)}</b>
      {showRemove && <em className="t-card-tag">{t.card.remove}</em>}
      {note && <small>{note}</small>}
      {products.length > 0 && (
        <small>
          {t.card.products}: <span>{products.join(', ')}</span>
        </small>
      )}
    </span>
  );
}

function StructureRow({
  item,
  checked,
  disabled,
  departments,
  t,
  onToggle,
}: {
  item: StructureItem;
  checked: boolean;
  disabled: boolean;
  departments: Org['departments'];
  t: Messages;
  onToggle: (checked: boolean) => void;
}) {
  const lockedRow = fixed(item);
  return (
    <label className={lockedRow ? 'lock' : ''}>
      <input
        type="checkbox"
        data-template={isNew(item) ? item.template : undefined}
        checked={checked}
        disabled={disabled || lockedRow}
        onChange={e => onToggle(e.target.checked)}
      />
      <StructureRowText item={item} departments={departments} t={t} />
    </label>
  );
}

/* A new department comes with the people of its template when the card's tick says so, unless the item itself says. */
function buildStructureBody(proposal: Props['proposal'], stamp: Record<string, unknown>, chosen: StructureItem[], withPeople: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- strip UI-only checked flag from payload items
  const picked = chosen.map(({ checked: _checked, ...rest }) => ('template' in rest ? { ...rest, staff: rest.staff ?? withPeople } : rest));
  return proposal ? { proposalId: proposal.id, ...stamp, items: picked } : { items: picked };
}

function StructureFooter({
  locked,
  sent,
  canCreate,
  label,
  t,
  onCreate,
  onCorrect,
  onHide,
}: {
  locked?: DecidedBy;
  sent: boolean;
  canCreate: boolean;
  label: string;
  t: Messages;
  onCreate: () => void;
  onCorrect: () => void;
  onHide?: () => void;
}) {
  return (
    <div className="f">
      <Decides locked={locked}>
        <button className="btn" type="button" disabled={!canCreate} onClick={onCreate}>
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
  );
}

function canSubmitStructure(sent: boolean, busy: boolean, chosenCount: number): boolean {
  if (sent || busy) return false;
  return chosenCount > 0;
}

function patchTickAt(ticks: boolean[], index: number, nextChecked: boolean): boolean[] {
  return ticks.map((v, j) => (j === index ? nextChecked : v));
}

/* The orchestrator's proposal, or the hand-made one: ticks, and one click that creates them. */
export function StructureCard({ proposal, manual, departments, onCorrect, onDone, onHide, locked, waitsFor }: Props) {
  const t = useT();
  const [items] = useState<StructureItem[]>(() => initialStructureItems(proposal, manual));
  const [ticks, setTicks] = useState(() => items.map(i => i.checked || fixed(i)));
  const { busy, sent, failure, postProposal } = useProposalCardPost(onDone);
  const proposalMaterials = useProposalMaterials(proposal);
  const chosen = items.filter((_, i) => ticks[i]);
  const label = structureActionLabel(t, chosen);

  const toggleRow = (index: number, nextChecked: boolean) => setTicks(prev => patchTickAt(prev, index, nextChecked));
  const rowDisabled = frozenBy(sent, locked);
  const canCreate = canSubmitStructure(sent, busy, chosen.length);
  const [withPeople, setWithPeople] = useState(true);
  const create = () => void postProposal('/api/departments/build', buildStructureBody(proposal, proposalMaterials.stamp, chosen, withPeople));

  return (
    <div className={sent ? 't-card done' : 't-card'}>
      <h4>{t.card.title}</h4>
      {waitsFor && <p className="muted">{waitsFor}</p>}
      <ProposalMaterialsSection state={proposalMaterials} />
      {items.map((item, i) => (
        <StructureRow key={i} item={item} checked={ticks[i]!} disabled={rowDisabled} departments={departments} t={t} onToggle={next => toggleRow(i, next)} />
      ))}
      {chosen.some(isNew) && (
        <label>
          <input type="checkbox" checked={withPeople} disabled={rowDisabled} onChange={e => setWithPeople(e.target.checked)} />
          <span>{t.card.withPeople}</span>
        </label>
      )}
      {failure !== null && (
        <p className="alert" role="alert">
          {errorText(t, failure)}
        </p>
      )}
      <StructureFooter locked={locked} sent={sent} canCreate={canCreate} label={label} t={t} onCreate={create} onCorrect={onCorrect} onHide={onHide} />
    </div>
  );
}
