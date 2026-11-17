import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { ApprovalMode, ApprovalPolicyView, ApprovalRule, AutonomousReleaseEntry } from '../types';
import { Field } from './Field';
import { TickBox } from './TickBox';

type Props = {
  departmentId: string;
  /* The owner as the company reads it now, so a change made elsewhere shows here too. */
  ownerPersonId?: string | null;
};

/* What a row shows of a rule that may be changed: its way and, for a limit, what is being typed. */
type Draft = { mode: ApprovalMode; limit: string; unit: string };

const draftOf = (rule: ApprovalRule): Draft => (rule.mode === 'within_limits' ? { mode: rule.mode, limit: String(rule.limit), unit: rule.unit ?? '' } : { mode: rule.mode, limit: '', unit: '' });

const MODES: ApprovalMode[] = ['every', 'new_kinds', 'within_limits', 'none'];

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
          <button className="btn" type="button" disabled={busy || !body} onClick={() => body && void save(body)}>{tt.common.save}</button>
        </div>
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(tt, failure)}</p>}
    </div>
  );
}

const candidateLabel = (c: ApprovalPolicyView['candidates'][number]) => (c.title ? `${c.name}, ${c.title}` : c.name);

/* The CEO picks the owner among those who may be. */
function OwnerPick({ view, path, onChanged }: { view: ApprovalPolicyView; path: string; onChanged(): Promise<void> }) {
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

  return (
    <div className="appr-owner">
      <Field label={t.owner} hint={t.ownerHint}>
        {p => (
          <select {...p} value={view.owner?.id ?? ''} disabled={busy} onChange={e => void name(e.target.value || null)}>
            <option value="">{t.ownerCeo}</option>
            {view.candidates.map(c => (
              <option key={c.id} value={c.id}>{candidateLabel(c)}</option>
            ))}
          </select>
        )}
      </Field>
      {view.candidates.length === 0 && <p className="muted">{t.noCandidates}</p>}
      {failure !== null && <p className="alert" role="alert">{errorText(tt, failure)}</p>}
    </div>
  );
}

/* Who owns the department, in words for anyone but the one who picks it. */
function OwnerWords({ owner }: { owner: ApprovalPolicyView['owner'] }) {
  const t = useT().dept.approvals;
  return <p className="appr-owner">{owner ? t.ownerIs(owner.name) : t.ownerNone}</p>;
}

function useAutonomousJournal(departmentId: string, active: boolean, refreshKey: boolean): AutonomousReleaseEntry[] | null {
  const [entries, setEntries] = useState<AutonomousReleaseEntry[] | null>(null);
  useEffect(() => {
    if (!active) {
      setEntries(null);
      return;
    }
    let alive = true;
    void api
      .get<{ entries: AutonomousReleaseEntry[] }>(`/api/autonomous-releases?department=${encodeURIComponent(departmentId)}`)
      .then(res => alive && setEntries(res.entries))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [departmentId, active, refreshKey]);
  return entries;
}

function AutonomousJournalView({ entries }: { entries: AutonomousReleaseEntry[] | null }) {
  const t = useT().dept.approvals;
  if (entries === null) return null;
  return (
    <div className="appr-auto-journal">
      <p className="muted">{t.autonomousJournalTitle}</p>
      {entries.length === 0 ? (
        <p className="muted">{t.autonomousJournalEmpty}</p>
      ) : (
        <ul>
          {entries.map(entry => (
            <li key={entry.id}>
              {t.autonomousJournalWho(entry.agentName, String(entry.taskNumber))}:{' '}
              <code>{entry.commitSha}</code> ({t.autonomousJournalProof(String(entry.testRunNumber), entry.reviewerName)})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AutonomousToggleOrState({
  canSet,
  enabled,
  busy,
  onToggle,
}: {
  canSet: boolean;
  enabled: boolean;
  busy: boolean;
  onToggle(next: boolean): void;
}) {
  const t = useT().dept.approvals;
  if (!canSet) return <p className="muted">{t.autonomousReleaseState(enabled)}</p>;
  /* Its state is said in a word beside the box, in a frame, not by the box alone. */
  return (
    <label className="appr-auto-toggle">
      <TickBox role="switch" aria-label={t.autonomousRelease} checked={enabled} disabled={busy} onChange={e => onToggle(e.target.checked)} />
      <span className="appr-auto-name">{t.autonomousRelease}</span>
      <span className={enabled ? 'status active' : 'status'}>{t.autonomousReleaseWord(enabled)}</span>
    </label>
  );
}

/* The department's own switch for exact-commit autonomous release to main, for the people who run it, and its journal. */
function AutonomousReleaseControl({
  departmentId,
  path,
  view,
  onSaved,
}: {
  departmentId: string;
  path: string;
  view: ApprovalPolicyView;
  onSaved(next: ApprovalPolicyView): void;
}) {
  const tt = useT();
  const t = tt.dept.approvals;
  const enabled = Boolean(view.autonomousRelease);
  const showJournal = enabled || Boolean(view.hasAutonomousReleases);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const entries = useAutonomousJournal(departmentId, showJournal, enabled);

  async function toggle(next: boolean) {
    setBusy(true);
    setFailure(null);
    try {
      onSaved(await api.put<ApprovalPolicyView>(`${path}/autonomous-release`, { enabled: next }));
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="appr-auto">
      <AutonomousToggleOrState canSet={Boolean(view.canSetAutonomousRelease)} enabled={enabled} busy={busy} onToggle={next => void toggle(next)} />
      <p className="muted">{t.autonomousReleaseHint}</p>
      {failure !== null && (
        <p className="alert" role="alert">
          {errorText(tt, failure)}
        </p>
      )}
      <AutonomousJournalView entries={entries} />
    </div>
  );
}

function ChannelFieldset({
  departmentId,
  path,
  view,
  rule,
  modes,
  onSaved,
}: {
  departmentId: string;
  path: string;
  view: ApprovalPolicyView;
  rule: ApprovalRule;
  modes: Record<ApprovalMode, string>;
  onSaved(next: ApprovalPolicyView): void;
}) {
  const t = useT().dept.approvals;
  const editable = view.canChangePolicy && rule.channel !== 'commit';
  return (
    <fieldset className="field-group appr-rule">
      <legend>{t.channels[rule.channel]}</legend>
      <div className="field-group-body">
        {editable ? <RuleForm path={path} rule={rule} modes={modes} onSaved={onSaved} /> : <RuleWords rule={rule} />}
        {rule.channel === 'commit' && <AutonomousReleaseControl departmentId={departmentId} path={path} view={view} onSaved={onSaved} />}
      </div>
    </fieldset>
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
      {view.canSetOwner ? <OwnerPick view={view} path={departmentPath} onChanged={load} /> : <OwnerWords owner={view.owner} />}
      <p className="muted">{t.rulesHint}</p>
      <div className="appr-rules">
        {view.rules.map(rule => (
          <ChannelFieldset key={rule.channel} departmentId={departmentId} path={path} view={view} rule={rule} modes={modes} onSaved={setView} />
        ))}
      </div>
    </div>
  );
}
