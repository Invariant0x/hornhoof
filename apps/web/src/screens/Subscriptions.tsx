import { RouteUnavailable, unavailableFailure } from './RouteUnavailable';
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { api, ApiFailure } from '../api';
import { useStream } from '../live';
import { doneOf, useHeldRows, useLoad } from '../ui/Loading';
import { PlanConnection, ReadySaid } from '../ui/PlanConnection';
import { errorText, useLanguage, useT, type Language, type Messages } from '../i18n';
import { PROGRAM_NAMES, PROVIDER_NAMES, programName } from '../providers';
import type { JobView, Me, PlanFallback, ShownCommand, SubView } from '../types';
import { PlanFallbacks } from '../ui/PlanFallbacks';
import { Ask } from '../ui/Ask';
import { CommandBox, type ActiveCommand } from '../ui/CommandBox';
import { usePlanCommands } from './use-plan-commands';
import { commandForPlan, SubscriptionCommandBlocks, SubscriptionInstall } from './SubscriptionCommands';
import { ConnectPanel } from '../ui/ConnectPanel';
import { isKeyPlan, KeyForm } from '../ui/KeyForm';
import { resetDurationAt, useNow } from '../ui/reset';
import { SignInPanel } from '../ui/SignInPanel';
import { CardFrame, CardHead, Facts, MachineMark, NameWithSign, Part } from '../ui/Cards';
import { PayIcon, ProviderMark } from '../ui/icons';
import { AgentsCell, agentAmounts, RunningNow } from '../ui/RunningNow';
import { LimitCell, PlanLimitParts } from '../ui/PlanLimits';
import { providerFilter, type FilterGroup } from '../ui/TableTools';
import { HeldTable, SortTable, type TableColumn } from '../ui/SortTable';
import type { TableSearch } from '../ui/TableTools';
import { ApiForm } from '../ui/ApiForm';
import { TokenCount, TokenGauges } from '../ui/Tokens';
import { Edge } from '../ui/Edge';
import { LoadFailure } from '../ui/LoadFailure';
import { clock, limitState, planStateOnMachine, shortName, stateOf, subName, TERMINAL_SIGNIN, waitsThere, windowName, windowUsage } from '../ui/subscription';
import { PlanSteps } from '../ui/PlanSteps';
import { keepUnits } from '../ui/units';
import { replaceSubscription } from './subscription-list';
export { clock } from '../ui/subscription';

const POLL_MS = 1000;
const POLL_LIMIT_MS = 150_000;

type Test = { phase: 'running' } | { phase: 'done'; text: string } | { phase: 'failed'; text: string; tail: string | null };
/* A sign-in the owner runs now, in a terminal on one of the plan's machines. */
type Signing = { subId: string; nodeId: string; hostname: string };

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/* Where a personal plan's sign-in works: on any of its owner's machines once signed in from Hornhoof (Codex on one of
   them at a time), else only on the machines it was signed in on by hand. */
function signinLine(t: Messages, language: Language, s: SubView): string | null {
  if (s.kind !== 'personal') return null;
  if (s.signedInOnce) {
    if (s.provider === 'codex' && s.leaseMachine) return t.subs.leaseOn(s.leaseMachine);
    return keepUnits(t.subs.signedInOnce(s.owner.name, s.machines.filter(m => m.online).length));
  }
  const ready = s.machines.filter(m => m.status === 'ready').map(m => m.hostname);
  return ready.length ? t.subs.signedInOn(new Intl.ListFormat(language, { type: 'conjunction' }).format(ready)) : null;
}

/* The tier the plan's machines say they run on. A Claude plan signed in from Hornhoof holds a sign-in for a year that does
   not name its tier. */
function tierLine(t: Messages, s: SubView): string | null {
  if (s.kind !== 'personal' || s.accountsDiffer) return null;
  if (s.provider === 'codex' && s.tier) return s.tier === 'free' ? t.subs.codexFree : t.subs.tier('Codex', capital(s.tier));
  if (s.provider === 'claude') return s.tier ? t.subs.tier('Claude', capital(s.tier)) : s.signedInOnce ? t.subs.claudeYear : null;
  return null;
}

/* Two machines of the plan on different accounts or tiers. */
function differLine(t: Messages, s: SubView): string | null {
  const [first, ...rest] = s.accounts;
  if (!s.accountsDiffer || !first || !rest.length) return null;
  const other = rest.find(a => a.tier !== first.tier || (a.email ?? null) !== (first.email ?? null)) ?? rest[0]!;
  return t.subs.differentAccounts(first.hostname, other.hostname);
}

/* The address the plan's machines are signed in with, when the viewer may see it and all of them agree. */
function accountEmail(s: SubView): string | null {
  const emails = new Set(s.accounts.map(a => a.email ?? null));
  return !s.accountsDiffer && emails.size === 1 ? [...emails][0]! : null;
}

/* The shares of a plan's limits tasks may be given. */
const SHARES = [90, 80, 70, 60, 50];

const STATUS_ORDER = ['builtin_offline', 'offline', 'needs_login', 'needs_setup', 'limit', 'waiting_machine', 'ready'];

function SubscriptionStatus({ sub, now, showUntil = false }: { sub: SubView; now: number; showUntil?: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  const state = stateOf(sub, now);
  const at = showUntil && state === 'limit' ? clock(language, limitState(sub.limits, now).resetsAt) : null;
  return <><span className={`status ${state}`}>{state === 'limit' ? t.subs.limitReached(null) : t.subs.states[state]}</span>{at && <small className="until">{t.cards.until(at)}</small>}</>;
}

/* How the connection is paid, as a sign by its name; its words are its name and tooltip. */
function KindSign({ kind }: { kind: SubView['kind'] }) {
  const t = useT();
  return <span className="pay-sign" role="img" aria-label={t.subs.kindHint[kind]} title={t.subs.kindHint[kind]}><PayIcon kind={kind} /></span>;
}

/* The connection's short name with the sign of how it is paid, the orchestrator's role a small line under it. */
function SubscriptionName({ sub: s }: { sub: SubView }) {
  const t = useT();
  return <span className="nmg"><ProviderMark provider={s.provider} protocol={s.api?.protocol} /><span className="nm"><span className="nm-l"><b><NameWithSign name={shortName(t, s)} sign={<KindSign kind={s.kind} />} /></b></span>{s.isOrchestrator && <small>{t.subs.orchestrator}</small>}</span></span>;
}

/* What the connection's turns used in 30 days, or nothing from an older server. */
function TokensCell({ sub: s }: { sub: SubView }) {
  return s.tokens ? <span className="num"><TokenCount count={s.tokens.month.total} /></span> : null;
}

/* A limit's column name holds its number with its unit in one piece read left to right, between the marks that isolate it
   as a bdi dir="ltr" does on a page: a narrow table shows the name from an attribute, where no element can stand. */
const ltrPiece = (text: string) => `\u2066${text}\u2069`;

/* A limit's column. An API has no plan limits: it says so once across both limit columns, under the name of both. */
function limitColumn(t: Messages, now: number, key: string): TableColumn<SubView> {
  const span = key === 'five_hour' ? (s: SubView) => (s.kind === 'api_key' ? { columns: 2, label: t.subs.limits } : null) : undefined;
  return { key, label: ltrPiece(windowName(t, key)), direction: -1, value: s => windowUsage(s, key, now), cell: s => <LimitCell sub={s} name={key} now={now} />, span };
}

function subscriptionColumns(t: Messages, now: number): TableColumn<SubView>[] {
  return [
    { key: 'name', label: t.subs.columns.subscription, direction: 1, value: s => [shortName(t, s), s.owner.name], cell: s => <SubscriptionName sub={s} /> },
    { key: 'owner', label: t.tables.owner, direction: 1, value: s => s.owner.name, cell: s => s.owner.name },
    { key: 'status', label: t.tables.status, direction: 1, value: s => STATUS_ORDER.indexOf(stateOf(s, now)), className: 'k-status', cell: s => <SubscriptionStatus sub={s} now={now} showUntil /> },
    { key: 'serves', label: t.tables.serves, direction: 1, value: s => [s.place.kind === 'company' ? 0 : 1, s.place.name], cell: s => s.place.kind === 'company' ? t.people.wholeCompany : s.place.name },
    { key: 'machines', label: t.subs.columns.machine, direction: -1, value: s => s.kind === 'api_key' ? null : s.machines.length, cell: s => <MachinesCell sub={s} /> },
    ...['five_hour', 'seven_day'].map(key => limitColumn(t, now, key)),
    { key: 'tokens', label: t.subs.tokensColumn, direction: -1, value: s => s.tokens?.month.total ?? null, cell: s => <TokensCell sub={s} /> },
    { key: 'agents', label: t.tables.agents, direction: -1, value: s => agentAmounts(s.agents ?? []), cell: s => <AgentsCell agents={s.agents ?? []} /> },
  ];
}

function MachinesCell({ sub: s }: { sub: SubView }) {
  const t = useT();
  if (s.kind === 'api_key') return <>{t.subs.builtin}</>;
  if (!s.machines.length) return <span className="muted">{t.subs.noMachine}</span>;
  return <ul className="where-list" aria-label={t.subs.machinesOf(subName(t, s))}>{s.machines.map(m => {
    const note = s.machines.length > 1 && waitsThere(t, m);
    return <li key={m.id}>{m.hostname}{note && <span className="muted">, {note}</span>}</li>;
  })}</ul>;
}

function PlanMachines({ sub: s, now }: { sub: SubView; now: number }) {
  const t = useT();
  const { language } = useLanguage();
  if (s.kind === 'api_key') return <ul className="plist"><li><MachineMark /><span className="nm"><b>{t.subs.builtin}</b><small>{t.cards.builtinSmall}</small></span></li></ul>;
  const line = signinLine(t, language, s);
  return <>{s.machines.length ? <ul className="plist" aria-label={t.subs.machinesOf(subName(t, s))}>{s.machines.map(m => <li key={m.id}><MachineMark /><span className="nm"><b>{m.hostname}</b><small>{s.owner.name}, {planStateOnMachine(t, language, m, s.limits, now, s.limitsUpdatedAt)}</small></span></li>)}</ul> : <p className="part-note" dir="auto">{t.subs.noMachine}</p>}{line && <p className="part-note" dir="auto">{line}</p>}</>;
}

/* What the head of the card says under the state: until when a plan at its limit waits, or where an offline plan waits. */
function stateLine(t: Messages, language: Language, s: SubView, now: number): string | null {
  const state = stateOf(s, now);
  if (state === 'offline' && s.status === 'ready') return t.cards.notes.offline(s.machines.length === 1 ? s.machines[0]!.hostname : '');
  if (state !== 'limit') return null;
  const limit = limitState(s.limits, now);
  const at = clock(language, limit.resetsAt);
  const duration = resetDurationAt(t, limit.resetsAt, now);
  return at && duration ? t.cards.notes.limit(at, duration) : t.cards.notes.limitUnknown;
}

/* What keeps a plan that is not ready from working, and where: it waits for its machine, for the first setup of its
   program, or for its sign-in on a machine that is online, or on one that is not. */
function fixWords(t: Messages, s: SubView): string {
  if (s.status === 'waiting_machine') return t.cards.notes.waiting(s.owner.name);
  if (s.status === 'needs_setup') return setupWords(t, s);
  const online = s.machines.find(m => m.online);
  return online ? t.cards.notes.login(online.hostname, s.owner.name) : t.cards.notes.loginOffline(s.machines[0]?.hostname ?? '');
}

/* A plan signed in on its machine whose program asks its owner there to accept its terms, which nobody else may do. */
function setupWords(t: Messages, s: SubView): string {
  const waiting = s.machines.filter(m => m.status === 'needs_setup');
  const there = waiting.find(m => m.online) ?? waiting[0];
  if (!there?.online) return t.cards.notes.setupOffline(there?.hostname ?? '');
  return t.cards.notes.setup(there.hostname, s.owner.name, PROGRAM_NAMES[s.provider]);
}

function PlanAccount({ sub: s }: { sub: SubView }) {
  const t = useT();
  const tier = tierLine(t, s);
  const email = accountEmail(s);
  const differ = differLine(t, s);
  return <Part title={s.kind === 'api_key' ? t.cards.ownerKey : t.cards.ownerAccount}><Facts items={[
    [t.tables.owner, s.owner.name],
    s.kind === 'api_key' ? [t.cards.key, t.cards.keyEnds(s.last4 ?? '')] : [t.cards.account, <>{tier && <span>{tier}</span>}{email && <small>{email}</small>}{differ && <small className="signin-line warn">{differ}</small>}{!tier && !email && !differ && PROVIDER_NAMES[s.provider]}</>],
    [t.tables.serves, s.place.kind === 'company' ? t.people.wholeCompany : s.place.name],
  ]} /></Part>;
}

function subscriptionFilters(t: Messages, now: number, subs: SubView[]): FilterGroup<SubView>[] {
  const labels: Record<string, string> = { ...t.subs.states, limit: t.subs.limitReached(null) };
  const groups: FilterGroup<SubView>[] = [
    { key: 'pay', label: t.subs.payFilter, values: s => [s.kind], text: kind => t.subs.pay[kind as SubView['kind']] ?? kind, mark: kind => <PayIcon kind={kind as SubView['kind']} /> },
    providerFilter(t.tables.provider, s => [s.provider]),
    { key: 'owner', label: t.tables.owner, values: s => [s.owner.id], text: id => subs.find(s => s.owner.id === id)?.owner.name ?? id },
    { key: 'status', label: t.tables.status, values: s => [stateOf(s, now)], text: value => labels[value] ?? value },
  ];
  /* Each group starts with All, as the Type one does. */
  return groups.map(group => ({ ...group, all: t.tables.all }));
}

/* The search of the plans' table: its hint, its short hint on a phone, the words of a plan it searches, and its count. */
const plansSearch = (t: Messages, language: Language): TableSearch<SubView> => ({
  placeholder: t.tables.searchSubscriptions, short: t.tables.searchSubscriptionsShort, text: s => subscriptionSearch(t, language, s), count: t.tables.subscriptionCount,
});

/* How many plan rows the table holds while they come: as many as it showed last in this tab, else three. */
const HELD_PLANS = 3;
const useHeldPlans = (plans: SubView[] | null): number => useHeldRows('plans', plans ? plans.length : null) ?? HELD_PLANS;

function subscriptionSearch(t: Messages, language: Language, s: SubView): string {
  return [subName(t, s), s.last4, programName(s), s.owner.name, s.place.kind === 'company' ? t.people.wholeCompany : s.place.name, s.tier, ...s.accounts.map(a => a.email), ...s.machines.map(m => m.hostname), ...(s.agents ?? []).flatMap(a => [a.name, a.title?.[language]])].join(' ');
}

function finished(t: Messages, language: Language, sub: SubView, job: JobView): Test {
  if (job.status === 'done') {
    const ms = Date.parse(job.finishedAt ?? job.createdAt) - Date.parse(job.startedAt ?? job.createdAt);
    const seconds = new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.max(0, ms) / 1000);
    return { phase: 'done', text: t.subs.answered((job.result ?? '').trim().slice(0, 80), seconds, job.machine) };
  }
  const errors = t.subs.testErrors;
  const text =
    job.error === 'not_logged_in' && sub.kind === 'api_key'
      ? errors.key_refused
      : (errors[job.error as keyof typeof errors] ?? errors.other);
  return { phase: 'failed', text, tail: job.error === 'agent_failed' && job.tail ? job.tail : null };
}

function TestResult({ test }: { test: Test }) {
  const t = useT();
  if (test.phase === 'running') return <p className="muted" role="status">{t.subs.testing}</p>;
  if (test.phase === 'done') return <p className="test ok" role="status">{test.text}</p>;
  return (
    <div className="test failed" role="status">
      <p>{test.text}</p>
      {test.tail && (
        <details>
          <summary>{t.subs.showOutput}</summary>
          <pre>{test.tail}</pre>
        </details>
      )}
    </div>
  );
}

type PlanControls = {
  command: ShownCommand | null | undefined;
  test: Test | undefined;
  asking: boolean;
  signing: Signing | null;
  note: SignNote | null;
  keying: boolean;
  setBudget: (sub: SubView, budget: number | null) => unknown;
  setFallbacks: (sub: SubView, fallbacks: PlanFallback[]) => unknown;
  /* Every plan of the company this person sees, which a plan's fallbacks are named from. */
  plans: SubView[];
  runTest: (sub: SubView) => unknown;
  makeOrchestrator: (sub: SubView) => unknown;
  signIn: (sub: SubView, fresh: boolean) => unknown;
  setKeyFor: (id: string | null) => void;
  editing: boolean;
  setEditFor: (id: string | null) => void;
  saved: (sub: SubView) => void;
  /* Where an API connection may go: anywhere (null), or only the departments this person runs. */
  places: string[] | null;
  newCommand: (sub: SubView) => unknown;
  setConfirm: (id: string | null) => void;
  remove: (sub: SubView) => unknown;
  endSignIn: (signing: Signing, error: string | null) => void;
  stopSignIn: (signing: Signing) => unknown;
  /* A plan's connection after its sign-in code that failed or takes too long: try it again, or stop it. */
  retryConnection: (sub: SubView) => unknown;
  cancelConnection: (sub: SubView) => unknown;
  done: () => void;
};

type PlanProps = { sub: SubView; me: Me; controls: PlanControls };

/* The share of the plan's limits its tasks may use, a field under its label in a band of its own. */
function PlanSettings({ sub: s, me, controls }: PlanProps) {
  const t = useT();
  const heading = useId();
  const field = useId();
  const editable = s.owner.id === me.person.id || me.person.scopeKind === 'company';
  return (
    <section className="plan-settings" aria-labelledby={heading}>
      <h4 id={heading}>{t.tables.settings}</h4>
      <div className="field">
        {editable ? <>
          <label htmlFor={field}>{t.subs.share}</label>
          <span className="select-wrap">
            <select id={field} className="sel" aria-label={t.subs.shareLabel(subName(t, s))} value={s.budget === null ? '' : String(s.budget)} onChange={e => controls.setBudget(s, e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t.subs.shareAll}</option>
              {SHARES.map(n => <option key={n} value={String(n)}>{`${n}%`}</option>)}
            </select>
          </span>
        </> : <>
          <span className="label">{t.subs.share}</span>
          <span>{s.budget === null ? t.subs.shareAll : `${s.budget}%`}</span>
        </>}
      </div>
    </section>
  );
}

/* One action of a plan: its words, its name that says which plan, and whether it is busy now, as a test that runs. */
type Action = { key: string; text: string; label: string; run: () => unknown; busy?: boolean };

function testActions(t: Messages, { sub: s, me, controls: c }: PlanProps): Action[] {
  const name = subName(t, s);
  return [
    ...(s.online ? [{ key: 'test', text: t.subs.runTest, label: t.subs.runTestLabel(name), run: () => c.runTest(s), busy: c.test?.phase === 'running' }] : []),
    ...(me.person.scopeKind === 'company' && s.place.kind === 'company' && !s.isOrchestrator ? [{ key: 'orchestrator', text: t.subs.useForOrchestrator, label: t.subs.useForOrchestratorLabel(name), run: () => c.makeOrchestrator(s) }] : []),
  ];
}

function signInAction(t: Messages, { sub: s, me, controls: c }: PlanProps): Action | null {
  if (s.owner.id !== me.person.id || s.kind !== 'personal' || c.signing || !s.machines.some(m => m.online) || !TERMINAL_SIGNIN.has(s.provider)) return null;
  const again = s.signedInOnce && s.status === 'ready';
  const name = subName(t, s);
  return { key: 'signin', text: again ? t.subs.signInAgain : t.subs.signIn, label: again ? t.subs.signInAgainLabel(name) : t.subs.signInLabel(name), run: () => c.signIn(s, again) };
}

function keyAction(t: Messages, { sub: s, me, controls: c }: PlanProps): Action | null {
  if (s.owner.id !== me.person.id || s.kind !== 'personal' || !isKeyPlan(s.provider) || !s.machines.length || c.keying) return null;
  return { key: 'key', text: t.subs.pasteKey, label: t.subs.pasteKeyLabel(subName(t, s)), run: () => c.setKeyFor(s.id) };
}

/* Company scope changes an API connection's name, models and place, and so does a person who runs the department it serves. */
const changesApi = (s: SubView, me: Me) => s.kind === 'api_key' && (me.person.scopeKind === 'company' || s.canChange === true);

function editAction(t: Messages, { sub: s, me, controls: c }: PlanProps): Action | null {
  if (!changesApi(s, me) || c.editing) return null;
  return { key: 'edit', text: t.subs.editApi, label: t.subs.editApiLabel(subName(t, s)), run: () => c.setEditFor(s.id) };
}

const SUB_ACTION_ANCHORS: Record<string, string> = { signin: 'Subscriptions.signIn', orchestrator: 'Subscriptions.orchestrator' };

/* A busy action keeps its focus and its place, and does nothing until it is done. */
function ActionButton({ action: a, className }: { action: Action; className: string }) {
  return <button className={className} type="button" data-guide-anchor={SUB_ACTION_ANCHORS[a.key]} aria-label={a.label} aria-disabled={a.busy || undefined} onClick={() => { if (!a.busy) a.run(); }}>{a.text}</button>;
}

const removable = (s: SubView, me: Me) => s.owner.id === me.person.id || me.person.scopeKind === 'company' || changesApi(s, me);

function RemoveButtons({ sub: s, me, controls: c }: PlanProps) {
  const t = useT();
  return removable(s, me) ? <button className="act danger" type="button" aria-label={t.subs.removeLabel(subName(t, s))} onClick={() => c.setConfirm(s.id)}>{t.subs.remove}</button> : null;
}

/* Whether a foot's buttons stand in one row with each label on one line, measured as the foot is laid out: each button
   is as wide as its words on one line while the foot is measured, and back as it was before anything is drawn. */
function useOneRow(foot: RefObject<HTMLDivElement | null>, actions: string): boolean {
  const [one, setOne] = useState(true);
  useLayoutEffect(() => {
    const row = foot.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      row.classList.add('measuring');
      const buttons = [...row.children].map(b => b.getBoundingClientRect().width + parseFloat(getComputedStyle(b).marginInlineStart));
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      row.classList.remove('measuring');
      setOne(buttons.reduce((sum, w) => sum + w, 0) + gap * (buttons.length - 1) <= row.clientWidth + 0.5);
    };
    const watch = new ResizeObserver(measure);
    watch.observe(row);
    void document.fonts?.ready.then(measure);
    return () => watch.disconnect();
  }, [foot, actions]);
  return one;
}

/* The foot of a working plan's card: what its test says, then its actions on one end edge. The first of them is the one
   filled button, Run a test when the plan can run one; Remove ends the foot, apart from the rest. While Remove asks, its
   question stands in the foot's place, and Cancel gives the focus back to Remove. When they do not fit in one row with each
   label whole, they stand in two matched columns, Remove in the end one. */
function PlanFoot(props: PlanProps) {
  const t = useT();
  const { sub: s, me, controls: c } = props;
  const actions = [...testActions(t, props), editAction(t, props), signInAction(t, props), keyAction(t, props)].filter((a): a is Action => a !== null);
  const remove = removable(s, me);
  const removeButton = useRef<HTMLButtonElement>(null);
  const question = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const oneRow = useOneRow(row, `${actions.map(a => a.text).join(' ')} ${remove} ${c.asking}`);
  /* In two columns Remove ends the second; it has a button beside it when an odd number of actions comes before it. */
  const apart = actions.length > 0 && (oneRow || actions.length % 2 === 1);
  const asked = useRef(false);
  useEffect(() => {
    if (c.asking) question.current?.querySelector<HTMLButtonElement>('button.ghost')?.focus();
    else if (asked.current) removeButton.current?.focus();
    asked.current = c.asking;
  }, [c.asking]);
  if (!actions.length && !remove && !c.test && !c.note) return null;
  return (
    <div className="plan-card-actions">
      {c.test && <TestResult test={c.test} />}
      <SignInNote note={c.note} />
      {c.asking ? <div className="plan-ask" ref={question}><RemoveAsk sub={s} controls={c} /></div> : (actions.length > 0 || remove) && (
        <div className={oneRow ? 'form-foot' : 'form-foot two-columns'} ref={row}>
          {actions.map((a, i) => <ActionButton key={a.key} action={a} className={i === 0 ? 'btn' : 'btn ghost'} />)}
          {remove && <button ref={removeButton} className={apart ? 'btn ghost danger plan-remove apart' : 'btn ghost danger plan-remove'} type="button" aria-label={t.subs.removeLabel(subName(t, s))} onClick={() => c.setConfirm(s.id)}>{t.subs.remove}</button>}
        </div>
      )}
    </div>
  );
}

/* Its sign-in window when open, which shows the plan's connection after the code; else the connection on the card. The
   plan's status for the moment it is ready stays through both. */
function PlanExtra({ sub: s, controls: c, now }: Omit<PlanProps, 'me'> & { now: number }) {
  const on = c.signing;
  const connection = s.connecting ? <PlanConnection sub={s} connecting={s.connecting} now={now} onRetry={() => c.retryConnection(s)} onCancel={() => c.cancelConnection(s)} /> : null;
  return <>
    <ReadySaid sub={s} />
    {on && <SignInPanel subId={s.id} program={PROGRAM_NAMES[s.provider]} nodeId={on.nodeId} hostname={on.hostname} onEnd={error => c.endSignIn(on, error)} onStop={() => c.stopSignIn(on)} connection={connection} />}
    {!on && connection}
    {c.keying && isKeyPlan(s.provider) && <KeyForm sub={{ ...s, provider: s.provider }} onDone={c.done} onCancel={() => c.setKeyFor(null)} />}
    {c.editing && s.kind === 'api_key' && <ApiForm sub={s} places={c.places} onSaved={c.saved} onCancel={() => c.setEditFor(null)} />}
  </>;
}

/* command: the one that updates the nodes on the machines the text names. */
type SignNote = { subId: string; text: string; command?: string };

/* The machines whose nodes are too old for the sign-in, and the command that updates them, as the server names them. */
function oldNodes(err: unknown): { machines: string[]; command: string } | null {
  if (!(err instanceof ApiFailure) || err.reason !== 'signin_unsupported') return null;
  const { machines, command } = err.details ?? {};
  return Array.isArray(machines) && typeof command === 'string' ? { machines, command } : null;
}

/* What a sign-in that cannot start says under its plan: why, and for nodes too old for it, the command to update them. */
function signNoteOf(t: Messages, subId: string, err: unknown): SignNote {
  const old = oldNodes(err);
  return old ? { subId, text: t.subs.oldNodes(old.machines.join(', ')), command: old.command } : { subId, text: errorText(t, err) };
}

/* A sign-in that cannot start says why next to the button that was pressed, not at the top of the page. What it said last
   stays until the server answers again, so the card does not change shape while it is asked. */
async function startSignIn(t: Messages, sub: SubView, fresh: boolean, started: (s: Signing) => void, note: (n: SignNote | null) => void): Promise<void> {
  try {
    const { nodeId, hostname } = await api.post<{ nodeId: string; hostname: string }>(`/api/subscriptions/${sub.id}/signin`, { fresh });
    note(null);
    started({ subId: sub.id, nodeId, hostname });
  } catch (err) {
    note(signNoteOf(t, sub.id, err));
  }
}

/* Why the plan's last sign-in did not start or finish, under its buttons, with the command that helps when there is one. */
function SignInNote({ note }: { note: SignNote | null }) {
  const t = useT();
  if (!note) return null;
  return <>
    <p className="test failed" role="status">{note.text}</p>
    {note.command && <CommandBox command={note.command} trust={t.subs.updateTrust} />}
  </>;
}

/* Remove asks first. */
function RemoveAsk({ sub: s, controls: c }: Omit<PlanProps, 'me'>) {
  const t = useT();
  const name = subName(t, s);
  return c.asking ? <Ask text={s.kind === 'api_key' ? t.subs.removeKeyAsk(name) : t.subs.removeAsk(name)} yes={t.subs.yesRemove} onYes={() => c.remove(s)} onNo={() => c.setConfirm(null)} /> : null;
}

/* A plan works once it is ready. Until then, or while its sign-in has found nodes too old for it, all there is to show is
   what is wrong and what to do: its card is one block. */
const needsFix = (s: SubView, note: SignNote | null): boolean => s.status !== 'ready' || Boolean(note?.command);

/* The card of a plan that does not work, in one block across it: what is wrong and where, or the nodes too old for its
   sign-in with the command that updates them, then what to do about it and Remove. Its owner sees the steps to its work
   with the one to take now, unless those nodes come first, and for a plan waiting for its machine the install command. */
function PlanFix(props: PlanProps) {
  const t = useT();
  const { sub: s, me, controls: c } = props;
  return (
    <section className="blk blk-fix">
      {!c.note?.command && <p>{fixWords(t, s)}</p>}
      {!c.note?.command && !s.connecting && s.owner.id === me.person.id && <PlanSteps sub={s} command={c.command} signing={Boolean(c.signing)} />}
      <SubscriptionInstall sub={s} ownerId={me.person.id} command={c.command} onNew={() => c.newCommand(s)} />
      <SignInNote note={c.note} />
      <div className="machine-actions">{[signInAction(t, props), keyAction(t, props)].map(a => a && <ActionButton key={a.key} action={a} className="act" />)}<RemoveButtons {...props} /></div>
      <RemoveAsk sub={s} controls={c} />
    </section>
  );
}

/* The card of a plan that works: the plan and its limits, the agents on it, and its machines with what to do. */
function PlanWorking({ sub: s, me, controls, now }: PlanProps & { now: number }) {
  const t = useT();
  return <>
    <section className="blk blk-facts">
      <h4>{t.cards.aboutPlan}</h4>
      <PlanLimitParts sub={s} now={now} />
      <Part title={t.subs.tokens.title}><TokenGauges sub={s} /></Part>
      <PlanAccount sub={s} />
    </section>
    <RunningNow title={t.cards.agentsOn} label={t.cards.agentsOn} agents={s.agents ?? []} me={me} plan />
    <section className="blk blk-side">
      <h4>{t.cards.machinesOf}</h4>
      <PlanMachines sub={s} now={now} />
    </section>
    {s.kind === 'personal' && <PlanSettings sub={s} me={me} controls={controls} />}
    <PlanFallbacks sub={s} plans={controls.plans} editable={s.owner.id === me.person.id || me.person.scopeKind === 'company' || changesApi(s, me)} onChange={list => controls.setFallbacks(s, list)} />
    <PlanFoot sub={s} me={me} controls={controls} />
  </>;
}

function SubscriptionDetails({ sub: s, me, controls, now }: PlanProps & { now: number }) {
  const t = useT();
  const { language } = useLanguage();
  return (
    <CardFrame label={`${subName(t, s)}, ${s.owner.name}`} accent={s.isOrchestrator}
      head={<CardHead mark={<ProviderMark provider={s.provider} protocol={s.api?.protocol} />} name={shortName(t, s)} sign={<KindSign kind={s.kind} />} under={s.isOrchestrator && t.subs.orchestrator} state={<SubscriptionStatus sub={s} now={now} />} line={stateLine(t, language, s, now)} />}
      extra={<PlanExtra sub={s} controls={controls} now={now} />}>
      {needsFix(s, controls.note) ? <PlanFix sub={s} me={me} controls={controls} /> : <PlanWorking sub={s} me={me} controls={controls} now={now} />}
    </CardFrame>
  );
}

type PlanReads = ReturnType<typeof usePlanCommands>;
type ConnectionParts = {
  setSubs: PlanReads['setSubs'];
  load: PlanReads['load'];
  run: (action: () => Promise<void>) => Promise<void>;
  signIn: (sub: SubView, fresh: boolean) => unknown;
};

/* Where a plan's connection is after its sign-in code comes as its node says it; once it ended, the plans are read again
   and show ready or what to do. From one that stalled: a plan that signs in from Hornhoof tries again with a new sign-in,
   one that signs in on its machine has its node check the sign-in there again; or it stops. What stalled goes before the
   asking, so a step the node says before the answer comes stays. */
function usePlanConnections({ setSubs, load, run, signIn }: ConnectionParts) {
  const setConnection = (id: string, connecting: SubView['connecting']) => setSubs(list => list?.map(s => (s.id === id ? { ...s, connecting } : s)) ?? null);
  useStream(m => {
    if (m.type !== 'subscription.connecting') return;
    setConnection(m.subscriptionId, m.connecting);
    if (m.connecting === null) void load();
  });
  const retryConnection = (sub: SubView) =>
    run(async () => {
      setConnection(sub.id, null);
      if (TERMINAL_SIGNIN.has(sub.provider)) await signIn(sub, false);
      else await api.post(`/api/subscriptions/${sub.id}/connecting/retry`);
    });
  const cancelConnection = (sub: SubView) =>
    run(async () => {
      setConnection(sub.id, null);
      await api.post(`/api/subscriptions/${sub.id}/connecting/cancel`);
    });
  return { retryConnection, cancelConnection };
}

/* What could not load, said on top of the page: the plans' own failure stands where they would until they came. */
/* A screen's data once its load is done, so the ring keeps its least time; until then, none. */
const failureOnTop = (subs: SubView[] | null, plans: unknown, commands: unknown) => (subs ? plans ?? commands : commands);

export function Subscriptions({ me, onHome }: { me: Me; onHome?: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const now = useNow();
  const [connecting, setConnecting] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, Test>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [signing, setSigning] = useState<Signing | null>(null);
  /* Why the last sign-in of a plan did not finish. */
  const [signNote, setSignNote] = useState<SignNote | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [editFor, setEditFor] = useState<string | null>(null);
  const [connectingApi, setConnectingApi] = useState(false);
  const live = useRef(true);
  const polls = useRef(new Map<ReturnType<typeof setTimeout>, () => void>());
  useEffect(() => {
    live.current = true;
    const pending = polls.current;
    return () => {
      live.current = false;
      for (const cancel of pending.values()) cancel();
      pending.clear();
    };
  }, []);

  const { subs, setSubs, apiPlaces, commands, load, connected, newCommand: requestCommand, dismissCommand, failure: readFailure, commandsFailure } = usePlanCommands(live);
  /* The plans come with the shared indicator where they will stand, and say why when they do not. */
  const plansLoad = useLoad([{ data: subs, failure: readFailure, load }]);
  const plans = doneOf(subs, plansLoad);
  const heldPlans = useHeldPlans(plans);
  /* Where this person connects an API key: anywhere with the whole company, else only in the departments they run. */
  const places = me.person.scopeKind === 'company' ? null : apiPlaces ?? [];
  const newCommand = (sub: SubView) => run(() => requestCommand(sub));
  const onConnected = (shown: ActiveCommand, added: SubView[]) => { setConnecting(false); connected(shown, added); };

  async function run(action: () => Promise<void>) {
    setFailure(null);
    try {
      await action();
    } catch (err) {
      setFailure(err);
    }
  }

  const setTest = (id: string, test: Test) => live.current && setTests(all => ({ ...all, [id]: test }));

  function sleep() {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        polls.current.delete(timer);
        resolve();
      }, POLL_MS);
      polls.current.set(timer, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function runTest(sub: SubView) {
    setTest(sub.id, { phase: 'running' });
    try {
      let { job } = await api.post<{ job: JobView }>(`/api/subscriptions/${sub.id}/test`);
      const started = Date.now();
      while (job.status === 'queued' || job.status === 'running') {
        if (!live.current) return;
        if (Date.now() - started > POLL_LIMIT_MS) return setTest(sub.id, { phase: 'failed', text: t.subs.testErrors.tooLong, tail: null });
        await sleep();
        if (!live.current) return;
        job = (await api.get<{ job: JobView }>(`/api/jobs/${job.id}`)).job;
      }
      setTest(sub.id, finished(t, language, sub, job));
    } catch (err) {
      setTest(sub.id, { phase: 'failed', text: errorText(t, err), tail: null });
    }
  }

  const makeOrchestrator = (sub: SubView) =>
    run(async () => {
      const { subscription } = await api.post<{ subscription: SubView }>(`/api/subscriptions/${sub.id}/orchestrator`);
      setSubs(list => replaceSubscription(list, subscription, 'orchestrator'));
    });

  const setBudget = (sub: SubView, budget: number | null) =>
    run(async () => {
      const { subscription } = await api.patch<{ subscription: SubView }>(`/api/subscriptions/${sub.id}`, { budget });
      setSubs(list => replaceSubscription(list, subscription, 'update'));
    });

  const setFallbacks = (sub: SubView, fallbacks: PlanFallback[]) =>
    run(async () => {
      const { subscription } = await api.patch<{ subscription: SubView }>(`/api/subscriptions/${sub.id}`, { fallbacks });
      setSubs(list => replaceSubscription(list, subscription, 'update'));
    });

  const signIn = (sub: SubView, fresh: boolean) => startSignIn(t, sub, fresh, setSigning, setSignNote);

  const stopSignIn = (on: Signing) =>
    run(async () => {
      await api.post(`/api/subscriptions/${on.subId}/signin/stop`, { nodeId: on.nodeId });
      setSigning(null);
    });

  const endSignIn = (on: Signing, error: string | null) => {
    setSigning(null);
    setSignNote(error ? { subId: on.subId, text: error } : null);
    void load();
  };

  const { retryConnection, cancelConnection } = usePlanConnections({ setSubs, load, run, signIn });

  const remove = (sub: SubView) =>
    run(async () => {
      setConfirm(null);
      await api.del(`/api/subscriptions/${sub.id}`);
      await load();
    });

  if (unavailableFailure(readFailure)) return <RouteUnavailable onHome={onHome} />;

  return (
    <section className="people subs">
      <header className="people-head">
        <div data-guide-anchor="Subscriptions.status">
          <h1>{t.subs.heading}</h1>
          <p className="muted">{t.subs.intro}</p>
        </div>
        {(!connecting || !connectingApi) && (
          <div className="head-actions">
            {!connecting && <button className="btn" type="button" data-guide-anchor="Subscriptions.connect" onClick={() => setConnecting(true)}>{t.subs.connect}</button>}
            {!connectingApi && (places === null || places.length > 0) && <button className="btn ghost" type="button" data-guide-anchor="Subscriptions.connectApi" onClick={() => setConnectingApi(true)}>{t.subs.connectApi}</button>}
          </div>
        )}
      </header>

      {connecting && <ConnectPanel onCommand={onConnected} onDone={() => setConnecting(false)} onSkip={() => setConnecting(false)} skipLabel={t.common.cancel} />}
      {connectingApi && (
        <Edge className="panel form-card" cut={12}>
          <div className="form-head">
            <h2 className="form-title">{t.subs.connectApi}</h2>
            <p className="muted">{t.subs.apiIntro}</p>
          </div>
          <ApiForm places={places} onSaved={() => { setConnectingApi(false); void load(); }} onCancel={() => setConnectingApi(false)} />
        </Edge>
      )}
      <SubscriptionCommandBlocks subscriptions={subs ?? []} commands={commands ?? []} now={now} onDone={(command, id) => void run(() => dismissCommand(command, id))} />
      <LoadFailure failure={failureOnTop(subs, readFailure, commandsFailure)} />
      {!plans && <HeldTable load={plansLoad} columns={subscriptionColumns(t, now)} search={plansSearch(t, language)} rows={heldPlans} />}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}

      {/* The plans show once their load is done: until then the ring holds their room for at least its least time. */}
      {plans && plans.length === 0 && <p className="muted">{t.subs.empty}</p>}
      {plans && plans.length > 0 && (
        <SortTable
          rows={plans}
          columns={subscriptionColumns(t, now)}
          name={s => subName(t, s)}
          initialSort={{ key: 'status', direction: 1 }}
          search={plansSearch(t, language)}
          filters={subscriptionFilters(t, now, plans)}
          card={s => <SubscriptionDetails sub={s} me={me} now={now} controls={{
            command: commands ? commandForPlan(commands, s, now) : undefined,
            test: tests[s.id], asking: confirm === s.id,
            signing: signing?.subId === s.id ? signing : null,
            note: signNote?.subId === s.id ? signNote : null,
            keying: keyFor === s.id,
            editing: editFor === s.id, setEditFor,
            saved: subscription => { setEditFor(null); setSubs(list => replaceSubscription(list, subscription, 'update')); }, places,
            setBudget, setFallbacks, plans, runTest, makeOrchestrator, signIn, setKeyFor, newCommand, setConfirm, remove, endSignIn, stopSignIn, retryConnection, cancelConnection,
            done: () => { setKeyFor(null); void load(); },
          }} />}
        />
      )}
    </section>
  );
}
