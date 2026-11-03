import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, useLanguage, useT, type Language, type Messages } from '../i18n';
import { PROGRAM_NAMES, PROVIDER_NAMES } from '../providers';
import type { JobView, Me, SubView } from '../types';
import { Ask } from '../ui/Ask';
import { ActiveCommandPanel, CommandBox, hideShownCommand, livePanel, loadPlansCommand, toActiveCommand, type CommandPanelState } from '../ui/CommandBox';
import { ConnectPanel } from '../ui/ConnectPanel';
import { isKeyPlan, KeyForm } from '../ui/KeyForm';
import { resetDurationAt, useNow } from '../ui/reset';
import { SignInPanel } from '../ui/SignInPanel';
import { CardFrame, CardHead, Facts, MachineMark, Part } from '../ui/Cards';
import { ProviderMark } from '../ui/icons';
import { AgentsCell, agentAmounts, RunningNow } from '../ui/RunningNow';
import { LimitCell, LimitMeters } from '../ui/PlanLimits';
import { providerFilter, type FilterGroup } from '../ui/TableTools';
import { SortTable, type TableColumn } from '../ui/SortTable';
import { clock, limitState, planStateOnMachine, stateOf, subName, waitsThere, windowName, windowUsage } from '../ui/subscription';
export { clock } from '../ui/subscription';

const POLL_MS = 1000;
const POLL_LIMIT_MS = 150_000;
const REFRESH_MS = 5000;

type Test = { phase: 'running' } | { phase: 'done'; text: string } | { phase: 'failed'; text: string; tail: string | null };
/* A sign-in the owner runs now, in a terminal on one of the plan's machines. */
type Signing = { subId: string; nodeId: string; hostname: string };

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/* Plans that sign in once in a terminal on one machine; Hornhoof then passes the sign-in to the owner's others. */
const TERMINAL_SIGNIN = new Set(['claude', 'codex']);

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/* Where a personal plan's sign-in works: on any of its owner's machines once signed in from Hornhoof (Codex on one of
   them at a time), else only on the machines it was signed in on by hand. */
function signinLine(t: Messages, language: Language, s: SubView): string | null {
  if (s.kind !== 'personal') return null;
  if (s.signedInOnce) {
    if (s.provider === 'codex' && s.leaseMachine) return t.subs.leaseOn(s.leaseMachine);
    return t.subs.signedInOnce(s.owner.name, s.machines.filter(m => m.online).length);
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

const STATUS_ORDER = ['builtin_offline', 'offline', 'needs_login', 'limit', 'waiting_machine', 'ready'];

function SubscriptionStatus({ sub, now, showUntil = false }: { sub: SubView; now: number; showUntil?: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  const state = stateOf(sub, now);
  const at = showUntil && state === 'limit' ? clock(language, limitState(sub.limits, now).resetsAt) : null;
  return <><span className={`status ${state}`}>{state === 'limit' ? t.subs.limitReached(null) : t.subs.states[state]}</span>{at && <small className="until">{t.cards.until(at)}</small>}</>;
}

function subscriptionColumns(t: Messages, now: number): TableColumn<SubView>[] {
  return [
    { key: 'name', label: t.subs.columns.subscription, direction: 1, value: s => [subName(t, s), s.owner.name], cell: s => <><span className="nmg"><ProviderMark provider={s.provider} /><span className="nm"><b>{subName(t, s)}</b>{s.tier && <small>{s.tier}</small>}</span></span>{s.isOrchestrator && <span className="badge">{t.subs.orchestrator}</span>}</> },
    { key: 'owner', label: t.tables.owner, direction: 1, value: s => s.owner.name, cell: s => s.owner.name },
    { key: 'status', label: t.tables.status, direction: 1, value: s => STATUS_ORDER.indexOf(stateOf(s, now)), className: 'k-status', cell: s => <SubscriptionStatus sub={s} now={now} showUntil /> },
    { key: 'serves', label: t.tables.serves, direction: 1, value: s => [s.place.kind === 'company' ? 0 : 1, s.place.name], cell: s => s.place.kind === 'company' ? t.people.wholeCompany : s.place.name },
    { key: 'machines', label: t.subs.columns.machine, direction: -1, value: s => s.kind === 'api_key' ? null : s.machines.length, cell: s => <MachinesCell sub={s} /> },
    ...['five_hour', 'seven_day'].map(key => ({ key, label: windowName(t, key), direction: -1 as const, value: (s: SubView) => windowUsage(s, key, now), cell: (s: SubView) => <LimitCell sub={s} name={key} now={now} /> })),
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
  const line = s.status === 'needs_login' ? null : signinLine(t, language, s);
  return <>{s.machines.length ? <ul className="plist" aria-label={t.subs.machinesOf(subName(t, s))}>{s.machines.map(m => <li key={m.id}><MachineMark /><span className="nm"><b>{m.hostname}</b><small>{s.owner.name}, {planStateOnMachine(t, language, m, s.limits, now)}</small></span></li>)}</ul> : <p className="part-note">{t.subs.noMachine}</p>}{line && <p className="part-note">{line}</p>}</>;
}

function stateLine(t: Messages, language: Language, s: SubView, now: number): string | null {
  const state = stateOf(s, now);
  if (state === 'limit') {
    const limit = limitState(s.limits, now);
    const at = clock(language, limit.resetsAt);
    const duration = resetDurationAt(t, limit.resetsAt, now);
    return at && duration ? t.cards.notes.limit(at, duration) : t.cards.notes.limitUnknown;
  }
  if (state === 'needs_login') return t.cards.notes.login(s.machines.find(m => m.online)?.hostname ?? s.machines[0]?.hostname ?? '', s.owner.name);
  return state === 'waiting_machine' ? t.cards.notes.waiting(s.owner.name) : null;
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
  return [
    providerFilter(t.tables.provider, s => [s.provider]),
    { key: 'owner', label: t.tables.owner, values: s => [s.owner.id], text: id => subs.find(s => s.owner.id === id)?.owner.name ?? id },
    { key: 'status', label: t.tables.status, values: s => [stateOf(s, now)], text: value => labels[value] ?? value },
  ];
}

function subscriptionSearch(t: Messages, language: Language, s: SubView): string {
  return [subName(t, s), s.last4, PROGRAM_NAMES[s.provider], s.owner.name, s.place.kind === 'company' ? t.people.wholeCompany : s.place.name, s.tier, ...s.accounts.map(a => a.email), ...s.machines.map(m => m.hostname), ...(s.agents ?? []).flatMap(a => [a.name, a.title?.[language]])].join(' ');
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
  test: Test | undefined;
  asking: boolean;
  signing: Signing | null;
  note: SignNote | null;
  keying: boolean;
  setBudget: (sub: SubView, budget: number | null) => unknown;
  runTest: (sub: SubView) => unknown;
  makeOrchestrator: (sub: SubView) => unknown;
  signIn: (sub: SubView, fresh: boolean) => unknown;
  setKeyFor: (id: string | null) => void;
  newCommand: (sub: SubView) => unknown;
  setConfirm: (id: string | null) => void;
  remove: (sub: SubView) => unknown;
  endSignIn: (signing: Signing, error: string | null) => void;
  stopSignIn: (signing: Signing) => unknown;
  done: () => void;
};

type PlanProps = { sub: SubView; me: Me; controls: PlanControls };

function PlanSettings({ sub: s, me, controls }: PlanProps) {
  const t = useT();
  if (s.kind !== 'personal') return null;
  const editable = s.owner.id === me.person.id || me.person.scopeKind === 'company';
  const select = (
    <select className="sel" aria-label={t.subs.shareLabel(subName(t, s))} value={s.budget === null ? '' : String(s.budget)} onChange={e => controls.setBudget(s, e.target.value ? Number(e.target.value) : null)}>
      <option value="">{t.subs.shareAll}</option>
      {SHARES.map(n => <option key={n} value={String(n)}>{`${n}%`}</option>)}
    </select>
  );
  return <Part title={t.tables.settings}><Facts items={[[t.subs.share, editable ? select : s.budget === null ? t.subs.shareAll : `${s.budget}%`]]} /></Part>;
}

function TestButtons({ sub: s, me, controls: c }: PlanProps) {
  const t = useT();
  const name = subName(t, s);
  return <>
    {s.status === 'ready' && s.online && <button className="act" type="button" aria-label={t.subs.runTestLabel(name)} disabled={c.test?.phase === 'running'} onClick={() => c.runTest(s)}>{t.subs.runTest}</button>}
    {me.person.scopeKind === 'company' && s.place.kind === 'company' && !s.isOrchestrator && <button className="act" type="button" aria-label={t.subs.useForOrchestratorLabel(name)} onClick={() => c.makeOrchestrator(s)}>{t.subs.useForOrchestrator}</button>}
  </>;
}

function SignInButton({ sub: s, me, controls: c }: PlanProps) {
  const t = useT();
  if (s.owner.id !== me.person.id || s.kind !== 'personal' || c.signing || !s.machines.some(m => m.online) || !TERMINAL_SIGNIN.has(s.provider)) return null;
  const again = s.signedInOnce && s.status === 'ready';
  const name = subName(t, s);
  return <button className="act" type="button" aria-label={again ? t.subs.signInAgainLabel(name) : t.subs.signInLabel(name)} onClick={() => c.signIn(s, again)}>{again ? t.subs.signInAgain : t.subs.signIn}</button>;
}

function KeyButton({ sub: s, me, controls: c }: PlanProps) {
  const t = useT();
  if (s.owner.id !== me.person.id || s.kind !== 'personal' || !isKeyPlan(s.provider) || !s.machines.length || c.keying) return null;
  return <button className="act" type="button" aria-label={t.subs.pasteKeyLabel(subName(t, s))} onClick={() => c.setKeyFor(s.id)}>{t.subs.pasteKey}</button>;
}

function RemoveButtons({ sub: s, me, controls: c }: PlanProps) {
  const t = useT();
  const name = subName(t, s);
  const mine = s.owner.id === me.person.id;
  return <>
    {mine && s.kind === 'personal' && s.status === 'waiting_machine' && <button className="act" type="button" aria-label={t.subs.newCommandLabel(name)} onClick={() => c.newCommand(s)}>{t.subs.newCommand}</button>}
    {(mine || me.person.scopeKind === 'company') && <button className="act danger" type="button" aria-label={t.subs.removeLabel(name)} onClick={() => c.setConfirm(s.id)}>{t.subs.remove}</button>}
  </>;
}

function PlanButtons(props: PlanProps) {
  return <div className="machine-actions"><TestButtons {...props} /><SignInButton {...props} /><KeyButton {...props} /><RemoveButtons {...props} /></div>;
}

function PlanExtra({ sub: s, controls: c }: Omit<PlanProps, 'me'>) {
  const on = c.signing;
  return <>
    {on && <SignInPanel subId={s.id} program={PROGRAM_NAMES[s.provider]} nodeId={on.nodeId} hostname={on.hostname} onEnd={error => c.endSignIn(on, error)} onStop={() => c.stopSignIn(on)} />}
    {c.keying && isKeyPlan(s.provider) && <KeyForm sub={{ ...s, provider: s.provider }} onDone={c.done} onCancel={() => c.setKeyFor(null)} />}
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

/* A sign-in that cannot start says why next to the button that was pressed, not at the top of the page. */
async function startSignIn(t: Messages, sub: SubView, fresh: boolean, started: (s: Signing) => void, note: (n: SignNote | null) => void): Promise<void> {
  note(null);
  try {
    const { nodeId, hostname } = await api.post<{ nodeId: string; hostname: string }>(`/api/subscriptions/${sub.id}/signin`, { fresh });
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

function SubscriptionDetails({ sub: s, me, controls, now }: PlanProps & { now: number }) {
  const t = useT();
  const { language } = useLanguage();
  const name = subName(t, s);
  return (
    <CardFrame label={`${name}, ${s.owner.name}`} accent={s.isOrchestrator}
      head={<CardHead mark={<ProviderMark provider={s.provider} />} name={name} tier={s.tier} badges={s.isOrchestrator && <span className="badge">{t.subs.orchestrator}</span>} state={<SubscriptionStatus sub={s} now={now} />} line={stateLine(t, language, s, now)} />}
      extra={<PlanExtra sub={s} controls={controls} />}>
      <section className="blk blk-facts">
        <h4>{t.cards.aboutPlan}</h4>
        <Part title={t.subs.limits}><LimitMeters sub={s} now={now} /></Part>
        <PlanAccount sub={s} />
      </section>
      <RunningNow title={t.cards.agentsOn} label={t.cards.agentsOn} agents={s.agents ?? []} me={me} plan />
      <section className="blk blk-side">
        <h4>{t.cards.machinesOf}</h4>
        <PlanMachines sub={s} now={now} />
        <PlanSettings sub={s} me={me} controls={controls} />
        <PlanButtons sub={s} me={me} controls={controls} />
        <SignInNote note={controls.note} />
        {controls.asking && <Ask text={s.kind === 'api_key' ? t.subs.removeKeyAsk(name) : t.subs.removeAsk(name)} yes={t.subs.yesRemove} onYes={() => controls.remove(s)} onNo={() => controls.setConfirm(null)} />}
        {controls.test && <TestResult test={controls.test} />}
      </section>
    </CardFrame>
  );
}

function SubscriptionConnect({
  panel,
  setPanel,
  onLoaded,
  onCancel,
}: {
  panel: CommandPanelState;
  setPanel: (next: CommandPanelState) => void;
  onLoaded: () => void;
  onCancel: (id: string) => void;
}) {
  const t = useT();
  if (panel?.kind === 'connect') {
    return (
      <ConnectPanel
        onCommand={shown => {
          setPanel({ kind: 'command', shown });
          onLoaded();
        }}
        onDone={() => {
          setPanel(null);
          onLoaded();
        }}
        onSkip={() => setPanel(null)}
        skipLabel={t.common.cancel}
      />
    );
  }
  if (panel?.kind === 'command') {
    return <ActiveCommandPanel heading={t.subs.connectHeading} run={t.subs.runThis} shown={panel.shown} onCancel={() => onCancel(panel.shown.id)} />;
  }
  return null;
}

export function Subscriptions({ me }: { me: Me }) {
  const t = useT();
  const { language } = useLanguage();
  const now = useNow();
  const [subs, setSubs] = useState<SubView[] | null>(null);
  const [panel, setPanel] = useState<CommandPanelState>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, Test>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [signing, setSigning] = useState<Signing | null>(null);
  /* Why the last sign-in of a plan did not finish. */
  const [signNote, setSignNote] = useState<SignNote | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [list] = await Promise.all([api.get<{ subscriptions: SubView[] }>('/api/subscriptions'), loadPlansCommand(live, setPanel)]);
      if (!live.current) return;
      setSubs(list.subscriptions);
    } catch (err) {
      setFailure(err);
    }
  }, []);

  /* Nodes sign in and come online on their own, so the screen looks again every few seconds. */
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function run(action: () => Promise<void>) {
    setFailure(null);
    try {
      await action();
    } catch (err) {
      setFailure(err);
    }
  }

  const setTest = (id: string, test: Test) => live.current && setTests(all => ({ ...all, [id]: test }));

  async function runTest(sub: SubView) {
    setTest(sub.id, { phase: 'running' });
    try {
      let { job } = await api.post<{ job: JobView }>(`/api/subscriptions/${sub.id}/test`);
      const started = Date.now();
      while (job.status === 'queued' || job.status === 'running') {
        if (Date.now() - started > POLL_LIMIT_MS) return setTest(sub.id, { phase: 'failed', text: t.subs.testErrors.tooLong, tail: null });
        await sleep(POLL_MS);
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
      setSubs(list => list?.map(s => (s.id === subscription.id ? { ...s, ...subscription } : { ...s, isOrchestrator: false })) ?? null);
    });

  const setBudget = (sub: SubView, budget: number | null) =>
    run(async () => {
      const { subscription } = await api.patch<{ subscription: SubView }>(`/api/subscriptions/${sub.id}`, { budget });
      setSubs(list => list?.map(s => (s.id === subscription.id ? { ...s, ...subscription } : s)) ?? null);
    });

  const newCommand = (sub: SubView) =>
    run(async () => {
      const res = await api.post<{ id?: string; command: string; expiresAt?: string }>(`/api/subscriptions/${sub.id}/command`);
      setPanel({ kind: 'command', shown: toActiveCommand(res) });
    });

  const cancelCommand = (id: string) =>
    run(async () => {
      await hideShownCommand(id);
      setPanel(null);
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

  const remove = (sub: SubView) =>
    run(async () => {
      setConfirm(null);
      await api.del(`/api/subscriptions/${sub.id}`);
      await load();
    });

  const activePanel = livePanel(panel, now);

  return (
    <section className="people subs">
      <header className="people-head">
        <div>
          <h1>{t.subs.heading}</h1>
          <p className="muted">{t.subs.intro}</p>
        </div>
        {!activePanel && (
          <div className="head-actions">
            <button className="btn" type="button" onClick={() => setPanel({ kind: 'connect' })}>{t.subs.connect}</button>
          </div>
        )}
      </header>

      <SubscriptionConnect panel={activePanel} setPanel={setPanel} onLoaded={() => void load()} onCancel={id => void cancelCommand(id)} />
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}

      {subs && subs.length === 0 && <p className="muted">{t.subs.empty}</p>}
      {subs && subs.length > 0 && (
        <SortTable
          rows={subs}
          columns={subscriptionColumns(t, now)}
          name={s => subName(t, s)}
          initialSort={{ key: 'status', direction: 1 }}
          search={{ placeholder: t.tables.searchSubscriptions, text: s => subscriptionSearch(t, language, s), count: t.tables.subscriptionCount }}
          filters={subscriptionFilters(t, now, subs)}
          card={s => <SubscriptionDetails sub={s} me={me} now={now} controls={{
            test: tests[s.id], asking: confirm === s.id,
            signing: signing?.subId === s.id ? signing : null,
            note: signNote?.subId === s.id ? signNote : null,
            keying: keyFor === s.id,
            setBudget, runTest, makeOrchestrator, signIn, setKeyFor, newCommand, setConfirm, remove, endSignIn, stopSignIn,
            done: () => { setKeyFor(null); void load(); },
          }} />}
        />
      )}
    </section>
  );
}
