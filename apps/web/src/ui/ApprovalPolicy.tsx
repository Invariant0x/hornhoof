import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { ApprovalMode, ApprovalPolicyView, ApprovalRule } from '../types';
import { Field } from './Field';

type Props = {
  departmentId: string;
  /* The owner as the company reads it now, so a change made elsewhere shows here too. */
  ownerPersonId?: string | null;
};

/* What a row shows of a rule that may be changed: its way and, for a limit, what is being typed. */
type Draft = { mode: ApprovalMode; limit: string; unit: string };

const draftOf = (rule: ApprovalRule): Draft => (rule.mode === 'within_limits' ? { mode: rule.mode, limit: String(rule.limit), unit: rule.unit ?? '' } : { mode: rule.mode, limit: '', unit: '' });

const MODES: ApprovalMode[] = ['every', 'new_kinds', 'within_limits'];

type RuleBody = { mode: ApprovalMode; limit?: number; unit?: string };

/* A rule as typed, ready to send; none until a limit is typed. */
function ruleBody(draft: Draft): RuleBody | null {
  if (draft.mode !== 'within_limits') return { mode: draft.mode };
  const limit = draft.limit.trim() === '' ? NaN : Number(draft.limit);
  if (!Number.isFinite(limit) || limit < 0) return null;
  const unit = draft.unit.trim();
  return { mode: draft.mode, limit, ...(unit ? { unit } : {}) };
}

/* One channel's rule in words, for someone who may read it and not change it. */
function RuleWords({ rule }: { rule: ApprovalRule }) {
  const t = useT().dept.approvals;
  return <span>{rule.mode === 'within_limits' ? t.limitIs(rule.limit, rule.unit ?? '') : t.readModes[rule.mode]}</span>;
}

/* One channel's rule to change. A way without a limit is saved as it is picked; a limit waits for its number. */
function RuleForm({ path, rule, modes, onSaved }: { path: string; rule: ApprovalRule; modes: Record<ApprovalMode, string>; onSaved(view: ApprovalPolicyView): void }) {
  const tt = useT();
  const t = tt.dept.approvals;
  const [draft, setDraft] = useState(() => draftOf(rule));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  async function save(body: RuleBody) {
    setBusy(true);
    setFailure(null);
    try {
      onSaved(await api.put<ApprovalPolicyView>(`${path}/${rule.channel}`, body));
    } catch (err) {
      setFailure(err);
      /* A way saved as it is picked goes back to what is stored; a typed limit stays to fix. */
      if (body.mode !== 'within_limits') setDraft(draftOf(rule));
    } finally {
      setBusy(false);
    }
  }

  function pick(mode: ApprovalMode) {
    setDraft({ ...draft, mode });
    if (mode !== 'within_limits') void save({ mode });
  }

  const body = ruleBody(draft);
  return (
    <div className="appr-form">
      <select aria-label={t.mode} value={draft.mode} disabled={busy} onChange={e => pick(e.target.value as ApprovalMode)}>
        {MODES.map(mode => (
          <option key={mode} value={mode}>{modes[mode]}</option>
        ))}
      </select>
      {draft.mode === 'within_limits' && (
        <div className="appr-limit">
          <Field label={t.limit}>{p => <input {...p} type="number" min={0} step="any" value={draft.limit} onChange={e => setDraft({ ...draft, limit: e.target.value })} />}</Field>
          <Field label={t.unit}>{p => <input {...p} value={draft.unit} maxLength={16} placeholder={t.unitPlaceholder} onChange={e => setDraft({ ...draft, unit: e.target.value })} />}</Field>
          <button className="btn small" type="button" disabled={busy || !body} onClick={() => body && void save(body)}>{tt.common.save}</button>
        </div>
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(tt, failure)}</p>}
    </div>
  );
}

/* Who owns the department: the CEO picks among those who may, everyone else reads it. */
function OwnerLine({ view, path, onChanged }: { view: ApprovalPolicyView; path: string; onChanged(): Promise<void> }) {
  const tt = useT();
  const t = tt.dept.approvals;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  async function name(personId: string | null) {
    setBusy(true);
    setFailure(null);
    try {
      await api.put(`${path}/owner`, { personId });
      await onChanged();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  if (!view.canSetOwner) return <p className="appr-owner">{view.owner ? t.ownerIs(view.owner.name) : t.ownerNone}</p>;
  return (
    <div className="appr-owner">
      <Field label={t.owner} hint={t.ownerHint}>
        {p => (
          <select {...p} value={view.owner?.id ?? ''} disabled={busy} onChange={e => void name(e.target.value || null)}>
            <option value="">{t.ownerCeo}</option>
            {view.candidates.map(c => (
              <option key={c.id} value={c.id}>{c.title ? `${c.name}, ${c.title}` : c.name}</option>
            ))}
          </select>
        )}
      </Field>
      {view.candidates.length === 0 && <p className="muted">{t.noCandidates}</p>}
      {failure !== null && <p className="alert" role="alert">{errorText(tt, failure)}</p>}
    </div>
  );
}

/* Who owns a department and how its approvals go on each channel. The rules stay when the owner changes. */
export function ApprovalPolicy({ departmentId, ownerPersonId }: Props) {
  const tt = useT();
  const t = tt.dept.approvals;
  const [view, setView] = useState<ApprovalPolicyView | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const departmentPath = `/api/departments/${departmentId}`;
  const path = `${departmentPath}/approval-policy`;

  const load = useCallback(async () => {
    try {
      setView(await api.get<ApprovalPolicyView>(path));
      setFailure(null);
    } catch (err) {
      setFailure(err);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load, ownerPersonId]);

  if (failure !== null && !view) return <p className="alert" role="alert">{errorText(tt, failure)}</p>;
  if (!view) return <p className="muted">{tt.common.loading}</p>;
  /* "To me" is for the one the approvals go to; the CEO looking at a department with its own owner is not. */
  const modes = view.owner && view.canSetOwner ? { ...t.modes, every: t.everyToOwner } : t.modes;
  return (
    <div className="appr">
      <OwnerLine view={view} path={departmentPath} onChanged={load} />
      <p className="muted">{t.rulesHint}</p>
      <div className="appr-rules">
        {view.rules.map(rule => (
          <fieldset key={rule.channel} className="appr-rule">
            <legend>{t.channels[rule.channel]}</legend>
            {view.canChangePolicy ? <RuleForm path={path} rule={rule} modes={modes} onSaved={setView} /> : <RuleWords rule={rule} />}
          </fieldset>
        ))}
      </div>
    </div>
  );
}
