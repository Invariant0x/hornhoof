import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { ProviderId, RoleOption, Roster, Serving, StaffLine } from '../types';

type Props = {
  department: { id: string; name: string };
  /* The orchestrator's card; without it, the department's default roster by hand. */
  proposal?: { id: string; brief: string; people: StaffLine[] };
  onCorrect?(): void;
  /* Called once the people are hired. */
  onDone?(): void;
  onHide?(): void;
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

/* The skills a line starts with: the role's, with the line's changes. */
function skillsOf(role: RoleOption, line: StaffLine): string[] {
  if (Array.isArray(line.skills)) return line.skills;
  const on = new Set(role.skills);
  for (const id of line.skills?.on ?? []) on.add(id);
  for (const id of line.skills?.off ?? []) on.delete(id);
  return [...on];
}

function rowsOf(roster: Roster, lines: StaffLine[]): Row[] {
  const serving = new Set(roster.subscriptions.map(s => s.id));
  return lines.flatMap(line => {
    const role = roster.roles.find(r => r.id === line.role);
    if (!role) return [];
    const picked = line.subscription !== undefined ? line.subscription : role.subscription;
    return [{ line, role, checked: line.checked ?? true, subscription: picked && serving.has(picked) ? picked : null, model: line.model ?? '' }];
  });
}

/* Who to hire into a department: ticks, a subscription and a model per person, and one click that hires them. */
export function StaffCard({ department, proposal, onCorrect, onDone, onHide }: Props) {
  const t = useT();
  const { language } = useLanguage();
  const [roster, setRoster] = useState<Roster | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  /* A card stays one proposal: a newer one comes as a new card. */
  const lines = useRef(proposal?.people);

  useEffect(() => {
    let live = true;
    api.get<Roster>(`/api/departments/${department.id}/roster`).then(
      r => {
        if (!live) return;
        setRoster(r);
        /* The default roster names people in English; the card names them in the person's language instead. */
        setRows(rowsOf(r, lines.current ?? r.people.map(({ name: _name, ...line }) => line)));
      },
      err => live && setFailure(err),
    );
    return () => {
      live = false;
    };
  }, [department.id]);

  const nameOf = (r: Row) => {
    if (r.line.name) return r.line.name;
    const product = roster?.products.find(p => p.id === r.line.product);
    return product ? `${r.role.title[language]} (${product.name})` : r.role.title[language];
  };
  const chosen = rows.filter(r => r.checked);
  const update = (i: number, change: Partial<Row>) => setRows(list => list.map((r, j) => (j === i ? { ...r, ...change } : r)));

  async function hire() {
    setBusy(true);
    setFailure(null);
    try {
      const people = chosen.map(r => ({ role: r.role.id, name: nameOf(r), product: r.line.product ?? null, model: r.model, subscription: r.subscription, skills: skillsOf(r.role, r.line) }));
      await api.post(`/api/departments/${department.id}/staff`, proposal ? { proposalId: proposal.id, people } : { people });
      setSent(true);
      onDone?.();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`t-card staff${sent ? ' done' : ''}`}>
      <h4>{t.staff.title(department.name)}</h4>
      {proposal?.brief && <p className="t-card-brief">{proposal.brief}</p>}
      {rows.map((r, i) => {
        const name = nameOf(r);
        const sub = roster?.subscriptions.find(s => s.id === r.subscription);
        const off = sent || !r.checked;
        return (
          <div key={i} className="staff-row">
            <label>
              <input type="checkbox" checked={r.checked} disabled={sent} onChange={e => update(i, { checked: e.target.checked })} />
              <span>
                <b>{name}</b>
                {r.role.kind === 'head' && <em className="t-card-tag">{t.dept.head}</em>}
                {r.line.name && <small>{r.role.title[language]}</small>}
              </span>
            </label>
            <div className="staff-pick">
              <select aria-label={t.staff.runsOnOf(name)} value={r.subscription ?? ''} disabled={off} onChange={e => update(i, { subscription: e.target.value || null, model: '' })}>
                <option value="">{t.agent.noSubscription}</option>
                {byProvider(roster?.subscriptions ?? [], s => s.provider).map(([p, subs]) => (
                  <optgroup key={p} label={PROVIDER_NAMES[p]}>
                    {subs.map(s => (
                      <option key={s.id} value={s.id}>
                        {servingLabel(s)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <select aria-label={t.staff.modelOf(name)} value={r.model} disabled={off || !sub} onChange={e => update(i, { model: e.target.value })}>
                <option value="">{t.agent.default}</option>
                {sub?.models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        );
      })}
      {failure !== null && (
        <p className="alert" role="alert">
          {errorText(t, failure)}
        </p>
      )}
      <div className="f">
        <button className="btn" type="button" disabled={!roster || sent || busy || !chosen.length} onClick={hire}>
          {t.staff.hire(chosen.length)}
        </button>
        {!sent && proposal && onCorrect && (
          <button className="btn ghost" type="button" onClick={onCorrect}>
            {t.card.correct}
          </button>
        )}
        {!sent && onHide && (
          <button className="btn ghost" type="button" onClick={onHide}>
            {t.card.hide}
          </button>
        )}
        {sent && <span className="t-card-state">{t.staff.hired}</span>}
      </div>
    </div>
  );
}
