import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Language, type Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { DecidedBy, MaterialStampView, ProviderId, RoleOption, Roster, Serving, StaffLine } from '../types';
import { BusyLabel } from './BusyLabel';
import { DecidedByNote, frozenBy, WaitsForNote } from './DecidedBy';
import { AlertIcon, StaffIcon } from './icons';
import { ProposalMaterialsSection, useProposalCardPost, useProposalMaterials } from './RequestMaterials';

type Props = {
  department: { id: string; name: string };
  /* The orchestrator's card; without it, the department's default roster by hand. */
  proposal?: MaterialStampView & { id: string; brief: string; people: StaffLine[] };
  onCorrect?(): void;
  /* Called once the people are hired. */
  onDone?(): void;
  onHide?(): void;
  /* Someone who may not take the card reads it, with who takes it, and changes nothing. */
  locked?: DecidedBy;
  /* Whom the card waits for, on a list of what waits for more people than one. */
  waitsFor?: string;
};

/* A line with the CEO's choices: the subscription and model start from the line, or from the role and Default. */
type Row = { line: StaffLine; role: RoleOption; checked: boolean; subscription: string | null; model: string };

export const servingLabel = (s: { kind: Serving['kind']; label: string; provider: Serving['provider']; owner: string }) =>
  s.kind === 'api_key' ? `${s.label} (${PROVIDER_NAMES[s.provider]})` : `${PROVIDER_NAMES[s.provider]}, ${s.owner}`;

/* Subscriptions grouped by provider, in the order Hornhoof lists providers. */
export function byProvider<T>(items: T[], provider: (item: T) => ProviderId): [ProviderId, T[]][] {
  return (Object.keys(PROVIDER_NAMES) as ProviderId[]).flatMap(p => {
    const mine = items.filter(i => provider(i) === p);
    return mine.length ? [[p, mine] as [ProviderId, T[]]] : [];
  });
}

function applySkillChanges(base: readonly string[], onList: readonly string[], offList: readonly string[]): string[] {
  const on = new Set(base);
  for (const id of onList) on.add(id);
  for (const id of offList) on.delete(id);
  return [...on];
}

/* The skills a line starts with: the role's, with the line's changes. */
function skillsOf(role: RoleOption, line: StaffLine): string[] {
  if (Array.isArray(line.skills)) return line.skills;
  const spec = line.skills ?? {};
  return applySkillChanges(role.skills, spec.on ?? [], spec.off ?? []);
}

function missingRequiredLines(roster: Roster, lines: StaffLine[]): StaffLine[] {
  /* A card older than a required role still has to show it. */
  return roster.roles.filter(r => r.required && !lines.some(l => l.role === r.id)).map(r => ({ role: r.id }));
}

function resolveLineSubscription(line: StaffLine, role: RoleOption, serving: Set<string>): string | null {
  const picked = line.subscription !== undefined ? line.subscription : role.subscription;
  return picked && serving.has(picked) ? picked : null;
}

function toStaffRow(roster: Roster, serving: Set<string>, line: StaffLine): Row[] {
  const role = roster.roles.find(r => r.id === line.role);
  if (!role) return [];
  const checked = role.required || (line.checked ?? true);
  return [{ line, role, checked, subscription: resolveLineSubscription(line, role, serving), model: line.model ?? '' }];
}

function rowsOf(roster: Roster, lines: StaffLine[]): Row[] {
  const serving = new Set(roster.subscriptions.map(s => s.id));
  return [...missingRequiredLines(roster, lines), ...lines].flatMap(line => toStaffRow(roster, serving, line));
}

function staffName(r: Row, roster: Roster | null, language: Language): string {
  if (r.line.name) return r.line.name;
  const product = roster?.products.find(p => p.id === r.line.product);
  return product ? `${r.role.title[language]} (${product.name})` : r.role.title[language];
}

function StaffPersonBadges({ r, language, t }: { r: Row; language: Language; t: Messages }) {
  const { required, holder, kind } = r.role;
  return (
    <>
      {kind === 'head' && <span className="badge head">{t.dept.head}</span>}
      {required && <span className="badge required">{t.staff.required}</span>}
      {r.line.name && <small>{r.role.title[language]}</small>}
      {holder && <small>{t.staff.present(holder)}</small>}
    </>
  );
}

function StaffPerson({ r, name, frozen, language, t, onChecked }: { r: Row; name: string; frozen: boolean; language: Language; t: Messages; onChecked(checked: boolean): void }) {
  const { required } = r.role;
  return (
    <label className={required ? 'lock' : ''}>
      <input type="checkbox" checked={r.checked} disabled={frozen || required} onChange={e => onChecked(e.target.checked)} />
      <span>
        <b>{name}</b>
        <StaffPersonBadges r={r} language={language} t={t} />
      </span>
    </label>
  );
}

function StaffChoices({ r, name, sub, off, subscriptions, t, update }: { r: Row; name: string; sub?: Serving; off: boolean; subscriptions: Serving[]; t: Messages; update(change: Partial<Row>): void }) {
  return (
    <div className="staff-pick">
      <label className="staff-field">
        <span>{t.staff.subscription}</span>
        <select aria-label={t.staff.subscriptionOf(name)} value={r.subscription ?? ''} disabled={off} onChange={e => update({ subscription: e.target.value || null, model: '' })}>
          <option value="">{t.agent.noSubscription}</option>
          {byProvider(subscriptions, s => s.provider).map(([p, subs]) => (
            <optgroup key={p} label={PROVIDER_NAMES[p]}>
              {subs.map(s => (
                <option key={s.id} value={s.id}>
                  {servingLabel(s)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="staff-field">
        <span>{t.staff.model}</span>
        <select aria-label={t.staff.modelOf(name)} value={r.model} disabled={off || !sub} onChange={e => update({ model: e.target.value })}>
          <option value="">{t.agent.default}</option>
          {sub?.models.map(m => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function defaultRosterLines(roster: Roster): StaffLine[] {
  /* The default roster names people in English; the card names them in the person's language instead. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omit default English name so the card uses the localized role title
  return roster.people.map(({ name: _name, ...line }) => line);
}

function useDepartmentRoster(departmentId: string, initialProposalPeople: StaffLine[] | undefined, onError: (err: unknown) => void) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  /* A card stays one proposal: a newer one comes as a new card. */
  const lines = useRef(initialProposalPeople);

  useEffect(() => {
    let live = true;
    api.get<Roster>(`/api/departments/${departmentId}/roster`).then(
      r => {
        if (!live) return;
        setRoster(r);
        setRows(rowsOf(r, lines.current ?? defaultRosterLines(r)));
      },
      err => {
        if (live) onError(err);
      },
    );
    return () => {
      live = false;
    };
  }, [departmentId, onError]);

  return { roster, rows, setRows };
}

function StaffRowItem({
  r,
  roster,
  frozen,
  language,
  t,
  onUpdate,
}: {
  r: Row;
  roster: Roster | null;
  frozen: boolean;
  language: Language;
  t: Messages;
  onUpdate: (change: Partial<Row>) => void;
}) {
  const name = staffName(r, roster, language);
  const subscriptions = roster?.subscriptions ?? [];
  const sub = subscriptions.find(s => s.id === r.subscription);
  return (
    <div className="staff-row">
      <StaffPerson r={r} name={name} frozen={frozen} language={language} t={t} onChecked={checked => onUpdate({ checked })} />
      {!r.role.holder && <StaffChoices r={r} name={name} sub={sub} off={frozen || !r.checked} subscriptions={subscriptions} t={t} update={onUpdate} />}
    </div>
  );
}

function buildHireBody(
  proposal: Props['proposal'],
  stamp: Record<string, unknown>,
  sending: Row[],
  roster: Roster | null,
  language: Language,
) {
  const people = sending.map(r => ({
    role: r.role.id,
    name: staffName(r, roster, language),
    product: r.line.product ?? null,
    model: r.model,
    subscription: r.subscription,
    skills: skillsOf(r.role, r.line),
  }));
  return proposal ? { proposalId: proposal.id, ...stamp, people } : { people };
}

function hireButtonText(t: Messages, isProposal: boolean, chosenCount: number, sendingCount: number): string {
  const closeWithoutHiring = isProposal && chosenCount === 0 && sendingCount > 0;
  return closeWithoutHiring ? t.staff.closeCard : t.staff.hire(chosenCount);
}

/* Hire first, then Correct and Hide, in one group at the end of the line; what was done stands on its own line above it. */
function StaffHireControls({
  locked,
  canHire,
  busy,
  showCorrect,
  showHide,
  sent,
  chosenCount,
  hireLabel,
  t,
  onHire,
  onCorrect,
  onHide,
}: {
  locked?: DecidedBy;
  canHire: boolean;
  busy: boolean;
  showCorrect: boolean;
  showHide: boolean;
  sent: boolean;
  chosenCount: number;
  hireLabel: string;
  t: Messages;
  onHire: () => void;
  onCorrect?: () => void;
  onHide?: () => void;
}) {
  /* Someone who may not take the card reads who takes it, on its own line, in place of Hire and Correct. */
  const decides = !locked && (
    <>
      <button className="btn" type="button" data-guide-anchor="StaffCard.hire" aria-busy={busy} disabled={!canHire} onClick={onHire}>
        <BusyLabel busy={busy} idle={hireLabel} working={t.staff.hiring} />
      </button>
      {showCorrect && (
        <button className="btn ghost" type="button" onClick={onCorrect}>
          {t.card.correct}
        </button>
      )}
    </>
  );
  return (
    <>
      {sent && <p className="t-card-state" role="status">{chosenCount > 0 ? t.staff.hired : t.card.applied}</p>}
      {locked && <DecidedByNote by={locked} />}
      {(decides || showHide) && (
        <div className="form-foot">
          {decides}
          {showHide && (
            <button className="btn ghost" type="button" onClick={onHide}>
              {t.card.hide}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function selectHiringRows(rows: Row[], isProposal: boolean): { chosen: Row[]; sending: Row[] } {
  const chosen = rows.filter(r => r.checked && !r.role.holder);
  /* A proposal sends all it ticks: the server skips who came since, says so and closes the card. By hand, who is there is no hire. */
  const sending = isProposal ? rows.filter(r => r.checked) : chosen;
  return { chosen, sending };
}

function patchRowAt(list: Row[], index: number, change: Partial<Row>): Row[] {
  return list.map((r, j) => (j === index ? { ...r, ...change } : r));
}

function lacksDepartmentSubscription(roster: Roster | null, sent: boolean): boolean {
  if (!roster || sent) return false;
  return roster.subscriptions.length === 0;
}

function canClickHire(roster: Roster | null, sent: boolean, busy: boolean, sendingCount: number): boolean {
  if (!roster || sent || busy) return false;
  return sendingCount > 0;
}

function StaffNoServingNote({ roster, sent, t }: { roster: Roster | null; sent: boolean; t: Messages }) {
  if (!lacksDepartmentSubscription(roster, sent)) return null;
  return <p className="warn-line"><AlertIcon />{t.staff.noServing}</p>;
}

function canShowStaffCorrect(sent: boolean, isProposal: boolean, onCorrect: (() => void) | undefined): boolean {
  if (sent || !isProposal) return false;
  return Boolean(onCorrect);
}

/* Who to hire into a department: ticks, a subscription and a model per person, and one click that hires them. */
export function StaffCard({ department, proposal, onCorrect, onDone, onHide, locked, waitsFor }: Props) {
  const t = useT();
  const { language } = useLanguage();
  const { busy, sent, failure, setFailure, postProposal } = useProposalCardPost(onDone);
  const { roster, rows, setRows } = useDepartmentRoster(department.id, proposal?.people, setFailure);
  const proposalMaterials = useProposalMaterials(proposal);

  const isProposal = Boolean(proposal);
  const { chosen, sending } = selectHiringRows(rows, isProposal);
  const update = (i: number, change: Partial<Row>) => setRows(list => patchRowAt(list, i, change));
  const hire = () => void postProposal(`/api/departments/${department.id}/staff`, buildHireBody(proposal, proposalMaterials.stamp, sending, roster, language));

  return (
    <div className={sent ? 't-card staff done' : 't-card staff'}>
      <h4><StaffIcon />{t.staff.title(department.name)}</h4>
      <WaitsForNote text={waitsFor} />
      {proposal?.brief && <p className="t-card-brief">{proposal.brief}</p>}
      <ProposalMaterialsSection state={proposalMaterials} />
      <StaffNoServingNote roster={roster} sent={sent} t={t} />
      {rows.map((r, i) => (
        <StaffRowItem key={i} r={r} roster={roster} frozen={frozenBy(sent, locked)} language={language} t={t} onUpdate={change => update(i, change)} />
      ))}
      {failure !== null && (
        <p className="alert" role="alert">
          {errorText(t, failure)}
        </p>
      )}
      <StaffHireControls
        locked={locked}
        canHire={canClickHire(roster, sent, busy, sending.length)}
        busy={busy}
        showCorrect={canShowStaffCorrect(sent, isProposal, onCorrect)}
        showHide={!sent && Boolean(onHide)}
        sent={sent}
        chosenCount={chosen.length}
        hireLabel={hireButtonText(t, isProposal, chosen.length, sending.length)}
        t={t}
        onHire={hire}
        onCorrect={onCorrect}
        onHide={onHide}
      />
    </div>
  );
}
