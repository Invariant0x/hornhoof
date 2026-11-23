import { OfflinePlan } from './OfflineMachine';
import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import { errorText, Phrase, useLanguage, useT, type Messages } from '../i18n';
import { cutLine } from '../restarts';
import { effortsOf, ORCHESTRATOR_EFFORT } from '@hornhoof/protocol/efforts';
import { defaultEffort, PROVIDER_NAMES } from '../providers';
import type { AgentCardView, Part, SubView } from '../types';
import { TimerSettings } from './TimerSettings';
import { TelegramBot } from './TelegramBot';
import { useConfirmAction, type Question } from './ConfirmAction';
import { PanelFrame } from './SidePanels';
import { LimitMeters } from './PlanLimits';
import { FallbackLine } from './PlanFallbacks';
import { useNow } from './reset';
import { AgentState, clockAt, type AgentLive } from './AgentState';
import { byProvider, servingLabel } from './StaffCard';
import { employeeKind, WorkerMark } from './WorkerMark';

/* live and serverNow: what its program does and the server's alarm, as the map read them, and the server's clock then. */
/* onRemoved: the agent is gone, and so is what stood for it. */
type Props = { agentId: string; live?: AgentLive; serverNow?: string; onClose(): void; onRemoved?(): void };

const FAILURE_TEXT_MAX = 300;
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const SKILL = /^(<!-- hh:skill [a-z0-9-]+ -->\n## [^\n]*\n\n)([\s\S]*)(\n<!-- \/hh:skill -->)$/;
const ASSIGNMENT = /^(<!-- hh:assignment -->\n## [^\n]*\n\n)([\s\S]*)(\n<!-- \/hh:assignment -->)$/;
type PartFrame = { open: string; body: string; close: string };
type PromptEdits = { base: string | null; skills: Record<string, string> };

function frameOf(part: Part): PartFrame | null {
  const match = (part.kind === 'assignment' ? ASSIGNMENT : part.kind === 'skill' ? SKILL : null)?.exec(part.text);
  return match ? { open: match[1]!, body: match[2]!, close: match[3]! } : null;
}

/* Editable bodies have no markers or heading; identity parts retain their complete text. */
export function bodyOf(part: Part): string {
  return frameOf(part)?.body ?? part.text;
}

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* The wire's base field is the assignment. Identity, part order, headings and markers stay unchanged. */
export function fromRaw(raw: string, parts: Part[]): PromptEdits | null {
  const editable: Part[] = [];
  const pattern = parts.map(part => {
    const frame = frameOf(part);
    if (!frame) return escapePattern(part.text);
    editable.push(part);
    return `${escapePattern(frame.open)}([\\s\\S]*?)${escapePattern(frame.close)}`;
  }).join('\n\n');
  const match = new RegExp(`^${pattern}$`).exec(raw);
  if (!match || match[0] !== raw) return null;
  const edits: PromptEdits = { base: null, skills: {} };
  editable.forEach((part, index) => {
    if (part.kind === 'assignment') edits.base = match[index + 1]!;
    else if (part.id) edits.skills[part.id] = match[index + 1]!;
  });
  return edits;
}

const keyOf = (p: Part) => (p.kind === 'base' || p.kind === 'assignment' ? p.kind : (p.id ?? ''));

/* The raw text with the edits made by skill in place of the parts' own text. */
export function toRaw(parts: Part[], drafts: Record<string, string>): string {
  return parts
    .map(p => {
      const frame = frameOf(p);
      const draft = drafts[keyOf(p)];
      return frame && draft !== undefined ? frame.open + draft + frame.close : p.text;
    })
    .join('\n\n');
}

/* Unsaved editable bodies from raw text, or null when a read-only part or a boundary changed. */
function draftsOf(raw: string, parts: Part[]): Record<string, string> | null {
  const parsed = fromRaw(raw, parts);
  if (!parsed) return null;
  const drafts: Record<string, string> = {};
  for (const p of parts) {
    const text = p.kind === 'assignment' ? parsed.base : p.kind === 'skill' ? parsed.skills[p.id ?? ''] : undefined;
    if (text != null && text !== bodyOf(p)) drafts[keyOf(p)] = text;
  }
  return drafts;
}

/* Its latest turns a node restart cut off: on which task, why and where, and whether it was a retry; nothing without one. */
function Interruptions({ list, headingId, when }: { list: AgentCardView['interrupted']; headingId: string; when(at: string): string }) {
  const t = useT();
  if (!list.length) return null;
  return (
    <section className="ac-history" aria-labelledby={headingId}>
      <h4 id={headingId}>{t.restarts.heading}</h4>
      <ul>
        {list.map(c => (
          <li key={c.job}>
            {c.task && `#${c.task.number}: `}
            {cutLine(t, c, when(c.at))}
            {c.retry && ` ${t.restarts.wasRetry}`}
          </li>
        ))}
      </ul>
    </section>
  );
}

const subLabel = (s: SubView) => servingLabel({ kind: s.kind, label: s.label, provider: s.provider, owner: s.owner.name });

function changeAuthor(t: Messages, change: AgentCardView['changes'][number]): string | null {
  if (change.actingAgent) return t.agent.byHead(change.actingAgent.name, change.personName);
  return change.byOrchestrator ? t.agent.byOrchestrator : change.personName;
}

const hasSubUnits = (card: AgentCardView) => card.kind === 'worker' && Boolean(card.teams?.length || card.team);

function SubUnitField({ card, inputId, editable, onChange }: { card: AgentCardView; inputId: string; editable: boolean; onChange(team: string | null): void }) {
  const t = useT();
  if (!hasSubUnits(card)) return null;
  return (
    <div className="field">
      <label htmlFor={inputId}>{t.agent.subUnit}</label>
      <select id={inputId} value={card.team?.id ?? ''} disabled={!editable} onChange={e => onChange(e.target.value || null)}>
        <option value="">{t.agent.inPipeline}</option>
        {(card.teams ?? []).map(tm => (
          <option key={tm.id} value={tm.id}>
            {tm.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function LastFailure({ failure, when }: { failure: AgentCardView['failure'] | undefined; when(at: string | number): string }) {
  const t = useT();
  if (!failure) return null;
  const today = new Date(failure.at).toDateString() === new Date().toDateString();
  const line = today ? t.agent.lastFailed(clockAt(failure.at), t.failures[failure.kind]) : t.agent.lastFailedOn(when(failure.at), t.failures[failure.kind]);
  const text = clip(failure.text, FAILURE_TEXT_MAX);
  return text || failure.tail ? (
    <details className="ac-failure">
      <summary title={text}>{line}</summary>
      {text && <pre>{text}</pre>}
      {failure.tail && <pre>{failure.tail === 'No output.' ? t.agent.noOutput : failure.tail}</pre>}
    </details>
  ) : (
    <p className="ac-failure">{line}</p>
  );
}

function LastObsolete({ obsolete }: { obsolete: AgentCardView['obsolete'] }) {
  const t = useT();
  return obsolete ? <p className="ac-obsolete">{t.agent.obsolete}</p> : null;
}

function liveState(card: AgentCardView, live: AgentLive | undefined): AgentLive {
  return live
    ? { ...live, retry: live.retry === undefined ? card.retry : live.retry }
    : { id: card.id, program: card.program ?? null, alarm: card.alarm ?? null, held: card.held, retry: card.retry };
}

/* An agent's card in the side panel: where it runs, its skills and the text it runs with, with every change kept. */
const keepLoadedCard = (live: boolean, card: AgentCardView | null, save: (c: AgentCardView) => void) => {
  if (live && card) save(card);
};

function removeAgentQuestion(t: Messages, current: AgentCardView, onYes: () => Promise<void>): Question {
  const words = t.agent.confirm.remove;
  const dept = current.department?.name;
  return {
    ...words,
    effect: dept
      ? <Phrase words={words.effect} values={[<bdi>{current.name}</bdi>, <bdi>{dept}</bdi>]} />
      : <Phrase words={words.effectNoDept} values={[<bdi>{current.name}</bdi>]} />,
    warnings: [words.warning],
    danger: true,
    final: true,
    onYes,
  };
}

function disconnectPlanQuestion(t: Messages, employeeTitle: string, subscription: SubView, onYes: () => Promise<void>): Question {
  const words = t.agent.confirm.disconnectPlan;
  return {
    ...words,
    effect: <Phrase words={words.effect} values={[<bdi>{employeeTitle}</bdi>, <bdi>{subLabel(subscription)}</bdi>]} />,
    danger: true,
    onYes,
  };
}

export function AgentCard({ agentId, live, serverNow, onClose, onRemoved = onClose }: Props) {
  const t = useT();
  const { language } = useLanguage();
  const id = useId();
  const now = useNow();
  const [card, setCard] = useState<AgentCardView | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [raw, setRaw] = useState(false);
  /* What the person typed and has not saved: per part in the view by skill, the whole text in the raw view. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const confirmation = useConfirmAction();
  const base = `/api/agents/${agentId}`;

  useEffect(() => {
    let live = true;
    api.get<AgentCardView>(base).then(
      c => keepLoadedCard(live, c, setCard),
      err => live && setFailure(err),
    );
    return () => {
      live = false;
    };
  }, [base]);

  /* sent: the prompt edits a save carries. Only those clear once it is saved; what the person typed meanwhile stays. */
  async function applyCard(run: () => Promise<AgentCardView>, sent?: { drafts: Record<string, string>; raw: string | null }) {
    setFailure(null);
    setSaved(false);
    setCard(await run());
    if (sent) {
      setDrafts(now => Object.fromEntries(Object.entries(now).filter(([key, text]) => sent.drafts[key] !== text)));
      setRawDraft(now => (now === sent.raw ? null : now));
    } else {
      setDrafts({});
      setRawDraft(null);
    }
    setBroken(false);
    setSaved(true);
  }

  async function save(run: () => Promise<AgentCardView>, sent?: { drafts: Record<string, string>; raw: string | null }) {
    try {
      await applyCard(run, sent);
    } catch (err) {
      setFailure(err);
    }
  }
  const change = (body: object) => save(() => api.patch<AgentCardView>(base, body));

  function savePrompt() {
    if (!card) return;
    let next: PromptEdits;
    if (rawDraft !== null) {
      const parsed = fromRaw(rawDraft, card.parts);
      if (!parsed) return setBroken(true);
      next = parsed;
    } else {
      const { assignment: own, ...skills } = drafts;
      next = { base: own ?? null, skills };
    }
    const body: { base?: string; skillText?: Record<string, string> } = {};
    const assignmentPart = card.parts.find(p => p.kind === 'assignment');
    if (assignmentPart && next.base !== null && next.base !== bodyOf(assignmentPart)) body.base = next.base;
    for (const p of card.parts.filter(x => x.kind === 'skill')) {
      const text = next.skills[p.id ?? ''];
      if (text !== undefined && text !== bodyOf(p)) body.skillText = { ...body.skillText, [p.id!]: text };
    }
    if (body.base === undefined && !body.skillText) {
      setDrafts({});
      setRawDraft(null);
      return;
    }
    void save(() => api.patch<AgentCardView>(base, body), { drafts, raw: rawDraft });
  }

  function askReset(current: AgentCardView) {
    setFailure(null);
    const words = t.agent.confirm.reset;
    confirmation.ask({
      ...words,
      effect: <Phrase words={words.effect} values={[<bdi>{current.name}</bdi>]} />,
      warnings: [words.warning],
      danger: true,
      final: true,
      onYes: () => applyCard(() => api.post<AgentCardView>(`${base}/reset`)),
    });
  }

  function askRemove(current: AgentCardView) {
    setFailure(null);
    confirmation.ask(removeAgentQuestion(t, current, async () => {
      await api.del(base);
      onRemoved();
    }));
  }

  function pickSubscription(current: AgentCardView, employeeTitle: string, next: string) {
    if (!next && current.subscription) {
      setFailure(null);
      confirmation.ask(disconnectPlanQuestion(t, employeeTitle, current.subscription, () => applyCard(() => api.patch<AgentCardView>(base, { subscription: null }))));
      return;
    }
    void change({ subscription: next || null });
  }

  if (!card) {
    return (
      <PanelFrame label={t.window.card} heading="" busy={failure === null} onClose={onClose}>
        {failure !== null && (
          <p className="alert" role="alert">
            {errorText(t, failure)}
          </p>
        )}
      </PanelFrame>
    );
  }

  const orchestrator = card.kind === 'orchestrator';
  const title = orchestrator ? t.window.title : card.name;
  const runs = card.runsOn.find(r => r.subscription.id === card.subscription?.id);
  const subs = card.subscription && !runs ? [{ subscription: card.subscription, models: [] }, ...card.runsOn] : card.runsOn;
  const models = runs?.models ?? [];
  const efforts = effortsOf(models, card.model);
  const roleEffort = orchestrator ? ORCHESTRATOR_EFFORT : card.role?.effort;
  const usual = card.subscription && defaultEffort(card.subscription.provider, models, card.model, roleEffort);
  const effortName = (level: string) => t.agent.efforts[level] ?? level;
  const where = [card.department?.name, card.product?.name].filter(Boolean).join(', ');
  const dirty = rawDraft !== null ? rawDraft !== card.raw : Object.keys(drafts).length > 0;
  const when = (at: string | number) => new Date(at).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
  const editable = card.canEdit;
  const stateAgent = liveState(card, live);
  const assignmentPart = card.parts.find(p => p.kind === 'assignment');
  const rawEdits = rawDraft === null ? null : fromRaw(rawDraft, card.parts);
  const rawInvalid = rawDraft !== null && rawEdits === null;
  const assignment = rawEdits?.base ?? drafts.assignment ?? (assignmentPart ? bodyOf(assignmentPart) : '');

  function editAssignment(text: string) {
    if (!card) return;
    if (raw) {
      const carried = draftsOf(rawDraft ?? card.raw, card.parts);
      if (!carried) return setBroken(true);
      setRawDraft(toRaw(card.parts, { ...carried, assignment: text }));
    } else {
      setDrafts(d => ({ ...d, assignment: text }));
    }
    setBroken(false);
  }

  /* An edit carries over to the other view; a raw text with broken markers stays in the raw view until it is fixed. */
  function showRaw(next: boolean) {
    if (!card || next === raw) return;
    if (next) {
      if (Object.keys(drafts).length) setRawDraft(toRaw(card.parts, drafts));
      setDrafts({});
    } else if (rawDraft !== null) {
      const carried = draftsOf(rawDraft, card.parts);
      if (!carried) return setBroken(true);
      setDrafts(carried);
      setRawDraft(null);
    }
    setBroken(false);
    setRaw(next);
  }

  return (
    <PanelFrame label={t.window.cardOf(title)} heading={title} onClose={onClose}>
        <header className="ac-head">
          <h3>{title}</h3>
          {card.role && card.role.title[language] !== card.name && <p>{card.role.title[language]}</p>}
          {where && <p className="muted">{where}</p>}
          <p className="ac-state">
            {card.kind === 'worker' || card.kind === 'head'
              ? <WorkerMark kind={employeeKind(card.turnkey)} className={card.state} />
              : <i className={`dot ${card.state}`} />}
            {t.dept.states[card.state]}
            <AgentState agent={stateAgent} serverNow={serverNow} />
          </p>
          <LastFailure failure={card.failure} when={when} />
          <LastObsolete obsolete={card.obsolete} />
        </header>
        <OfflinePlan card={card} editable={editable} onMove={subscription => change({ subscription })} />
        <FallbackLine card={card} />
        {!editable && <p className="muted">{t.agent.viewOnly}</p>}

        <div className="ac-pick">
          <div className="field">
            <label htmlFor={`${id}-sub`}>{t.agent.runsOn}</label>
            <select id={`${id}-sub`} value={card.subscription?.id ?? ''} disabled={!editable} onChange={e => pickSubscription(card, title, e.target.value)}>
              {(!orchestrator || !card.subscription) && <option value="">{t.agent.noSubscription}</option>}
              {byProvider(subs, r => r.subscription.provider).map(([p, list]) => (
                <optgroup key={p} label={PROVIDER_NAMES[p]}>
                  {list.map(r => (
                    <option key={r.subscription.id} value={r.subscription.id}>
                      {subLabel(r.subscription)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {card.machine && <span className="hint">{t.agent.onMachine(card.machine.hostname)}</span>}
          </div>
          <div className="field">
            <label htmlFor={`${id}-model`}>{t.agent.model}</label>
            <select id={`${id}-model`} value={card.model} disabled={!editable || !card.subscription} onChange={e => void change({ model: e.target.value })}>
              <option value="">{t.agent.default}</option>
              {card.model && !models.some(m => m.id === card.model) && <option value={card.model}>{card.model}</option>}
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-effort`}>{t.agent.effort}</label>
            <select id={`${id}-effort`} value={card.effort ?? ''} disabled={!editable || (!efforts.length && !card.effort)} onChange={e => void change({ effort: e.target.value || null })}>
              <option value="">{usual ? t.agent.defaultEffort(effortName(usual)) : t.agent.default}</option>
              {card.effort && !efforts.includes(card.effort) && <option value={card.effort}>{effortName(card.effort)}</option>}
              {efforts.map(level => (
                <option key={level} value={level}>
                  {effortName(level)}
                </option>
              ))}
            </select>
          </div>
          <SubUnitField card={card} inputId={`${id}-team`} editable={editable} onChange={team => void change({ team })} />
        </div>
        {card.subscription && <LimitMeters sub={card.subscription} now={now} model={card.model} />}
        {saved && (
          <p className="ac-note" role="status">
            {t.agent.applies}
          </p>
        )}
        {failure !== null && (
          <p className="alert" role="alert">
            {errorText(t, failure)}
          </p>
        )}

        {!orchestrator && <TimerSettings timer={card.timer} editable={editable} onChange={body => void change(body)} />}
        {/* Whoever may remove this agent keeps its bot too: the whole company, or the person responsible for its department. */}
        {(orchestrator || card.kind === 'head') && <TelegramBot agentId={agentId} agentName={title} telegram={card.telegram ?? null} editable={card.canRemove} onChange={telegram => setCard(c => c && { ...c, telegram })} />}

        {!orchestrator && (
          <section className="ac-skills" aria-labelledby={`${id}-skills`}>
            <h4 id={`${id}-skills`}>{t.agent.skills}</h4>
            {card.skills.map(s => (
              <label key={s.id} className={s.locked ? 'lock' : ''}>
                <input type="checkbox" checked={s.on || s.locked} disabled={!editable || s.locked} onChange={e => void change({ skills: { [s.id]: e.target.checked } })} />
                <span>
                  <b>{s.title[language]}</b>
                  <small>{s.description[language]}</small>
                </span>
                {s.templateChanged && s.overridden && <em className="t-card-tag">{t.agent.templateChanged}</em>}
              </label>
            ))}
          </section>
        )}

        {assignmentPart && (
          <section className="ac-prompt" aria-labelledby={`${id}-assignment`}>
            <div className="ac-prompt-top">
              <h4 id={`${id}-assignment`}>
                <label htmlFor={`${id}-assignment-text`}>{t.agent.assignment}</label>
              </h4>
            </div>
            <textarea
              id={`${id}-assignment-text`}
              className="ac-text"
              rows={Math.min(14, Math.max(3, assignment.split('\n').length + 1))}
              value={assignment}
              readOnly={!editable || rawInvalid}
              onChange={e => editAssignment(e.target.value)}
            />
          </section>
        )}

        <section className="ac-prompt" aria-labelledby={`${id}-prompt`}>
          <div className="ac-prompt-top">
            <h4 id={`${id}-prompt`}>{t.agent.prompt}</h4>
            {!orchestrator && (
              <div className="seg">
                <button type="button" aria-pressed={!raw} onClick={() => showRaw(false)}>
                  {t.agent.bySkill}
                </button>
                <button type="button" aria-pressed={raw} onClick={() => showRaw(true)}>
                  {t.agent.raw}
                </button>
              </div>
            )}
          </div>
          {orchestrator && <p className="muted">{t.agent.orchestratorNote}</p>}
          {orchestrator ? (
            <pre className="ac-text">{toRaw(card.parts, drafts)}</pre>
          ) : raw ? (
            <>
              <label className="sr" htmlFor={`${id}-raw`}>
                {t.agent.raw}
              </label>
              <textarea id={`${id}-raw`} className="ac-text" rows={18} value={rawDraft ?? card.raw} readOnly={!editable} onChange={e => setRawDraft(e.target.value)} />
            </>
          ) : (
            card.parts.filter(p => p.kind !== 'assignment').map(p =>
              p.kind === 'header' ? (
                <div key="header" className="ac-part">
                  <span>{t.agent.header}</span>
                  <pre className="ac-text">{p.text}</pre>
                </div>
              ) : (
                <div key={keyOf(p)} className="ac-part">
                  <label htmlFor={`${id}-${keyOf(p)}`}>{p.title?.[language] ?? p.id}</label>
                  {p.templateChanged && p.overridden && <em className="t-card-tag">{t.agent.templateChanged}</em>}
                  <textarea
                    id={`${id}-${keyOf(p)}`}
                    className="ac-text"
                    rows={Math.min(14, Math.max(3, bodyOf(p).split('\n').length + 1))}
                    value={drafts[keyOf(p)] ?? bodyOf(p)}
                    readOnly={!editable || p.kind !== 'skill'}
                    onChange={p.kind === 'skill' ? e => setDrafts(d => ({ ...d, [keyOf(p)]: e.target.value })) : undefined}
                  />
                </div>
              ),
            )
          )}
          {(broken || rawInvalid) && (
            <p className="alert" role="alert">
              {t.agent.rawBroken}
            </p>
          )}
          {editable && dirty && (
            <div className="f">
              <button className="btn small" type="button" onClick={savePrompt}>
                {t.common.save}
              </button>
              <button
                className="btn small ghost"
                type="button"
                onClick={() => {
                  setDrafts({});
                  setRawDraft(null);
                  setBroken(false);
                }}
              >
                {t.common.cancel}
              </button>
            </div>
          )}
        </section>

        {editable && !orchestrator && (
          <div className="ac-actions">
            {card.role && (
              <button className="act" type="button" onClick={() => askReset(card)}>
                {t.agent.reset}
              </button>
            )}
            {card.canRemove && (
              <button className="act danger" type="button" onClick={() => askRemove(card)}>
                {t.agent.remove}
              </button>
            )}
          </div>
        )}

        {confirmation.question}

        <Interruptions list={card.interrupted} headingId={`${id}-restarts`} when={when} />

        {card.changes.length > 0 && (
          <section className="ac-history" aria-labelledby={`${id}-history`}>
            <h4 id={`${id}-history`}>{t.agent.history}</h4>
            <ul>
              {card.changes.map((c, i) => (
                <li key={i}>{t.agent.changed(t.agent.fields[c.field] ?? c.field, changeAuthor(t, c), when(c.at))}</li>
              ))}
            </ul>
          </section>
        )}
    </PanelFrame>
  );
}
