import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorText, Phrase, useT, type Messages } from '../i18n';
import type { ApprovalMode, ApprovalPolicyView, ApprovalRule, AutonomousReleaseEntry } from '../types';
import { ConfirmAction, useConfirmAction, type Question } from './ConfirmAction';
import { Field } from './Field';
import { TickBox } from './TickBox';

type Props = {
  departmentId: string;
  departmentName?: string;
  /* The owner as the company reads it now, so a change made elsewhere shows here too. */
  ownerPersonId?: string | null;
};

/* What a row shows of a rule that may be changed: its way and, for a limit, what is being typed. */
type Draft = { mode: ApprovalMode; limit: string; unit: string };

const draftOf = (rule: ApprovalRule): Draft => (rule.mode === 'within_limits' ? { mode: rule.mode, limit: String(rule.limit), unit: rule.unit ?? '' } : { mode: rule.mode, limit: '', unit: '' });

const MODES: ApprovalMode[] = ['every', 'new_kinds', 'within_limits', 'none'];

type RuleBody = { mode: ApprovalMode; limit?: number; unit?: string };

const deptTarget = (departmentName: string | undefined, fallback: string) => (departmentName ? <bdi>{departmentName}</bdi> : fallback);

function ruleLabel(t: Messages['dept']['approvals'], modes: Record<ApprovalMode, string>, body: RuleBody): string {
  return body.mode === 'within_limits' ? t.limitIs(body.limit!, body.unit ?? '') : modes[body.mode];
}

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

type PendingRule = { body: RuleBody; revert: boolean };

function useRuleSave(path: string, rule: ApprovalRule, onDraft: (draft: Draft) => void, onSaved: (view: ApprovalPolicyView) => void) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingRule | null>(null);
  const committed = useRef(false);

  async function save(body: RuleBody, revert: boolean) {
    setBusy(true);
    try {
      const next = await api.put<ApprovalPolicyView>(`${path}/${rule.channel}`, body);
      const updated = next.rules.find(r => r.channel === rule.channel);
      if (updated) onDraft(draftOf(updated));
      committed.current = true;
      onSaved(next);
    } catch (err) {
      /* A way saved as it is picked goes back to what is stored; a typed limit stays to fix. */
      if (revert) onDraft(draftOf(rule));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  function ask(body: RuleBody, revert: boolean) {
    committed.current = false;
    setPending({ body, revert });
  }

  function close() {
    if (pending?.revert && !committed.current) onDraft(draftOf(rule));
    committed.current = false;
    setPending(null);
  }

  return { busy, pending, ask, save, close };
}

/* One channel's rule to change. A way without a limit asks to confirm as it is picked; a limit waits for its number. */
function RuleForm({ path, departmentName, rule, modes, onSaved }: { path: string; departmentName?: string; rule: ApprovalRule; modes: Record<ApprovalMode, string>; onSaved(view: ApprovalPolicyView): void }) {
  const tt = useT();
  const t = tt.dept.approvals;
  const [draft, setDraft] = useState(() => draftOf(rule));
  const { busy, pending, ask, save, close } = useRuleSave(path, rule, setDraft, onSaved);

  function pick(mode: ApprovalMode) {
    setDraft({ ...draft, mode });
    if (mode !== 'within_limits') ask({ mode }, true);
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
          <button className="btn" type="button" disabled={busy || !body} onClick={() => body && ask(body, false)}>
            {tt.common.save}
          </button>
        </div>
      )}
      {pending && (
        <ConfirmAction
          title={t.confirm.rule.title}
          effect={<Phrase words={t.confirm.rule.effect} values={[<bdi>{t.channels[rule.channel]}</bdi>, deptTarget(departmentName, t.confirm.thisDepartment), <bdi>{ruleLabel(t, modes, pending.body)}</bdi>]} />}
          yes={t.confirm.rule.yes}
          working={t.confirm.rule.working}
          danger={pending.body.mode === 'none'}
          onYes={() => save(pending.body, pending.revert)}
          onClose={close}
        />
      )}
    </div>
  );
}

const candidateLabel = (c: ApprovalPolicyView['candidates'][number]) => (c.title ? `${c.name}, ${c.title}` : c.name);

function ownerConfirmQuestion(t: Messages['dept']['approvals'], view: ApprovalPolicyView, personId: string | null, departmentName: string | undefined, onYes: () => Promise<void>): Question | null {
  if (personId === (view.owner?.id ?? null)) return null;
  const ownerName = personId ? (view.candidates.find(c => c.id === personId)?.name ?? personId) : t.confirm.ceo;
  const words = t.confirm.owner;
  return {
    title: words.title,
    effect: <Phrase words={personId ? words.effect : words.effectCeo} values={[<bdi>{ownerName}</bdi>, deptTarget(departmentName, t.confirm.thisDepartment)]} />,
    yes: words.yes,
    working: words.working,
    danger: false,
    onYes,
  };
}

/* The CEO picks the owner among those who may be. */
function OwnerPick({ view, path, departmentName, onChanged }: { view: ApprovalPolicyView; path: string; departmentName?: string; onChanged(): Promise<void> }) {
  const tt = useT();
  const t = tt.dept.approvals;
  const [busy, setBusy] = useState(false);
  const confirmation = useConfirmAction();

  async function name(personId: string | null) {
    setBusy(true);
    try {
      await api.put(`${path}/owner`, { personId });
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  function askOwner(personId: string | null) {
    const question = ownerConfirmQuestion(t, view, personId, departmentName, () => name(personId));
    if (question) confirmation.ask(question);
  }

  return (
    <div className="appr-owner">
      <Field label={t.owner} hint={t.ownerHint}>
        {p => (
          <select {...p} value={view.owner?.id ?? ''} disabled={busy} onChange={e => askOwner(e.target.value || null)}>
            <option value="">{t.ownerCeo}</option>
            {view.candidates.map(c => (
              <option key={c.id} value={c.id}>{candidateLabel(c)}</option>
            ))}
          </select>
        )}
      </Field>
      {view.candidates.length === 0 && <p className="muted">{t.noCandidates}</p>}
      {confirmation.question}
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
              <code>{entry.commitSha}</code> ({entry.testRunNumber === null ? t.autonomousJournalCi(entry.ciChecks, entry.reviewerName) : t.autonomousJournalProof(String(entry.testRunNumber), entry.reviewerName)})
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
  departmentName,
  path,
  view,
  onSaved,
}: {
  departmentId: string;
  departmentName?: string;
  path: string;
  view: ApprovalPolicyView;
  onSaved(next: ApprovalPolicyView): void;
}) {
  const tt = useT();
  const t = tt.dept.approvals;
  const enabled = Boolean(view.autonomousRelease);
  const showJournal = enabled || Boolean(view.hasAutonomousReleases);
  const [busy, setBusy] = useState(false);
  const confirmation = useConfirmAction();
  const entries = useAutonomousJournal(departmentId, showJournal, enabled);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      onSaved(await api.put<ApprovalPolicyView>(`${path}/autonomous-release`, { enabled: next }));
    } finally {
      setBusy(false);
    }
  }

  function askToggle(next: boolean) {
    const words = next ? t.confirm.enableAutonomous : t.confirm.disableAutonomous;
    confirmation.ask({
      title: words.title,
      effect: <Phrase words={words.effect} values={[deptTarget(departmentName, t.confirm.thisDepartment)]} />,
      yes: words.yes,
      working: words.working,
      danger: next,
      onYes: () => toggle(next),
    });
  }

  return (
    <div className="appr-auto">
      <AutonomousToggleOrState canSet={Boolean(view.canSetAutonomousRelease)} enabled={enabled} busy={busy} onToggle={askToggle} />
      <p className="muted">{t.autonomousReleaseHint}</p>
      <AutonomousJournalView entries={entries} />
      {confirmation.question}
    </div>
  );
}

function ChannelFieldset({
  departmentId,
  departmentName,
  path,
  view,
  rule,
  modes,
  onSaved,
}: {
  departmentId: string;
  departmentName?: string;
  path: string;
  view: ApprovalPolicyView;
  rule: ApprovalRule;
  modes: Record<ApprovalMode, string>;
  onSaved(next: ApprovalPolicyView): void;
}) {
  const t = useT().dept.approvals;
  const editable = view.canChangePolicy;
  return (
    <fieldset className="field-group appr-rule">
      <legend>{t.channels[rule.channel]}</legend>
      <div className="field-group-body">
        {editable ? <RuleForm path={path} departmentName={departmentName} rule={rule} modes={modes} onSaved={onSaved} /> : <RuleWords rule={rule} />}
        {rule.channel === 'commit' && <AutonomousReleaseControl departmentId={departmentId} departmentName={departmentName} path={path} view={view} onSaved={onSaved} />}
      </div>
    </fieldset>
  );
}

/* Who owns a department and how its approvals go on each channel. The rules stay when the owner changes. */
export function ApprovalPolicy({ departmentId, departmentName, ownerPersonId }: Props) {
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
      {view.canSetOwner ? <OwnerPick view={view} path={departmentPath} departmentName={departmentName} onChanged={load} /> : <OwnerWords owner={view.owner} />}
      <p className="muted">{t.defaultHint}</p>
      <p className="muted">{t.rulesHint}</p>
      <div className="appr-rules">
        {view.rules.map(rule => (
          <ChannelFieldset key={rule.channel} departmentId={departmentId} departmentName={departmentName} path={path} view={view} rule={rule} modes={modes} onSaved={setView} />
        ))}
      </div>
    </div>
  );
}
