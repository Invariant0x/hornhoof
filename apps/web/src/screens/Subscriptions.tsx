import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Language, type Messages } from '../i18n';
import { PROGRAM_NAMES, PROVIDER_NAMES } from '../providers';
import type { JobView, Limits, Me, SubView } from '../types';
import { Ask } from '../ui/Ask';
import { Bar, percent } from '../ui/Bar';
import { CommandBox } from '../ui/CommandBox';
import { ConnectPanel } from '../ui/ConnectPanel';
import { Edge } from '../ui/Edge';
import { isKeyPlan, KeyForm } from '../ui/KeyForm';
import { ResetTime, resetDurationAt, useNow } from '../ui/reset';
import { SignInPanel } from '../ui/SignInPanel';

const POLL_MS = 1000;
const POLL_LIMIT_MS = 150_000;
const REFRESH_MS = 5000;

type Test = { phase: 'running' } | { phase: 'done'; text: string } | { phase: 'failed'; text: string; tail: string | null };
type Panel = { kind: 'connect' } | { kind: 'command'; command: string } | null;
type State = keyof Messages['subs']['states'];
/* A sign-in the owner runs now, in a terminal on one of the plan's machines. */
type Signing = { subId: string; nodeId: string; hostname: string };

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

const subName = (t: Messages, s: SubView) => (s.kind === 'api_key' ? t.subs.keyEnding(PROVIDER_NAMES[s.provider], s.last4 ?? '') : PROVIDER_NAMES[s.provider]);

/* What keeps a plan from working on one of its machines, if anything. */
function waitsThere(t: Messages, on: { status: 'needs_login' | 'ready'; online: boolean }): string | null {
  if (!on.online) return t.subs.waitsThere.offline;
  return on.status === 'needs_login' ? t.subs.waitsThere.needs_login : null;
}

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

function stateOf(s: SubView): State {
  if (s.status === 'waiting_machine') return 'waiting_machine';
  if (!s.online) return s.kind === 'api_key' ? 'builtin_offline' : 'offline';
  return s.status;
}

export function clock(language: Language, iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const today = at.toDateString() === new Date().toDateString();
  const parts: Intl.DateTimeFormatOptions = today ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat(language, parts).format(at);
}

/* Windows by the names Claude Code gives them; Codex names its others by their minutes. */
const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, one_day: 1440, seven_day: 10080 };

function windowName(t: Messages, name: string): string {
  if (name === 'month') return t.subs.month;
  /* A week the plan counts for one model apart, such as Opus. */
  const model = /^seven_day_([a-z]+)$/.exec(name)?.[1];
  if (model) return `${t.subs.days(7)}, ${model[0]!.toUpperCase()}${model.slice(1)}`;
  const minutes = WINDOW_MINUTES[name] ?? Number(/^(\d+)_minutes$/.exec(name)?.[1]);
  if (!minutes) return name.replaceAll('_', ' ');
  if (minutes % 1440 === 0) return t.subs.days(minutes / 1440);
  return minutes % 60 === 0 ? t.subs.hours(minutes / 60) : t.subs.minutes(minutes);
}

/* The windows every plan shows, so plans read alike; a plan's other windows follow them. */
const MAIN_WINDOWS = ['five_hour', 'seven_day'];
/* The shares of a plan's limits tasks may be given. */
const SHARES = [90, 80, 70, 60, 50];

/* A window that started over since the plan last spoke: its share is not known again until the plan speaks. */
const startedOver = (w: Limits['windows'][number], now: number) => w.resetsAt !== null && Date.parse(w.resetsAt) <= now;
const until = (w: Limits['windows'][number]) => (w.resetsAt ? Date.parse(w.resetsAt) : Infinity);

/* Each window of the plan's limits as a bar with its share: five hours and seven days always, empty when the plan has
   no such window or has not said yet. Only a complete list says the plan has none. A plan that reached one says when
   the fullest resets. A key pays as it goes. */
function LimitBars({ sub }: { sub: SubView }) {
  const t = useT();
  const now = useNow();
  if (sub.kind === 'api_key') return <small className="limits">{t.subs.noPlanLimits}</small>;
  const limits: Limits | null = sub.limits;
  /* A plan stops at a full window, or at one it names without a share. It stays at its limit until each such window
     starts over, and says when the last one does; with no such window it stays until it says otherwise. */
  const causes = (limits?.windows ?? []).filter(w => w.utilization === null || w.utilization >= 1);
  const open = causes.filter(w => !startedOver(w, now)).sort((a, b) => until(b) - until(a));
  const reached = limits?.status === 'rejected' && (!causes.length || open.length > 0);
  const top = open[0] ?? [...(limits?.windows ?? [])].sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1))[0];
  const rows = [
    ...MAIN_WINDOWS.map(name => ({ name, window: limits?.windows.find(w => w.name === name) })),
    ...(limits?.windows ?? []).filter(w => !MAIN_WINDOWS.includes(w.name) && w.utilization !== null).map(w => ({ name: w.name, window: w })),
  ];
  return (
    <>
      {reached && <small className="limits">{t.subs.limitReached(resetDurationAt(t, top?.resetsAt ?? null, now))}</small>}
      <ul className="limit-bars" aria-label={t.subs.limits}>
        {rows.map(({ name, window: w }) => {
          if (!w || w.utilization === null || startedOver(w, now)) {
            return (
              <li key={name}>
                <span>{windowName(t, name)}</span>
                <span className="bar none" />
                <em>{limits?.complete && !w ? t.subs.notOnPlan : t.subs.noDataYet}</em>
                {w && <ResetTime at={w.resetsAt} now={now} />}
              </li>
            );
          }
          return (
            <li key={name}>
              <span>{windowName(t, name)}</span>
              <Bar used={w.utilization} />
              <b>{percent(w.utilization)}%</b>
              <ResetTime at={w.resetsAt} now={now} />
            </li>
          );
        })}
      </ul>
    </>
  );
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

export function Subscriptions({ me }: { me: Me }) {
  const t = useT();
  const { language } = useLanguage();
  const [subs, setSubs] = useState<SubView[] | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, Test>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [signing, setSigning] = useState<Signing | null>(null);
  /* Why the last sign-in of a plan did not finish. */
  const [signNote, setSignNote] = useState<{ subId: string; text: string } | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const live = useRef(true);
  const company = me.person.scopeKind === 'company';

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await api.get<{ subscriptions: SubView[] }>('/api/subscriptions');
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
      setSubs(list => list?.map(s => (s.id === subscription.id ? subscription : { ...s, isOrchestrator: false })) ?? null);
    });

  const setBudget = (sub: SubView, budget: number | null) =>
    run(async () => {
      const { subscription } = await api.patch<{ subscription: SubView }>(`/api/subscriptions/${sub.id}`, { budget });
      setSubs(list => list?.map(s => (s.id === subscription.id ? subscription : s)) ?? null);
    });

  const newCommand = (sub: SubView) =>
    run(async () => {
      const { command } = await api.post<{ command: string }>(`/api/subscriptions/${sub.id}/command`);
      setPanel({ kind: 'command', command });
    });

  const signIn = (sub: SubView, fresh: boolean) =>
    run(async () => {
      setSignNote(null);
      const { nodeId, hostname } = await api.post<{ nodeId: string; hostname: string }>(`/api/subscriptions/${sub.id}/signin`, { fresh });
      setSigning({ subId: sub.id, nodeId, hostname });
    });

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

  return (
    <section className="people subs">
      <header className="people-head">
        <div>
          <h1>{t.subs.heading}</h1>
          <p className="muted">{t.subs.intro}</p>
        </div>
        {!panel && (
          <div className="head-actions">
            <button className="btn" type="button" onClick={() => setPanel({ kind: 'connect' })}>{t.subs.connect}</button>
          </div>
        )}
      </header>

      {panel?.kind === 'connect' && (
        <ConnectPanel
          onDone={() => {
            setPanel(null);
            void load();
          }}
          onSkip={() => setPanel(null)}
          skipLabel={t.common.cancel}
        />
      )}
      {panel?.kind === 'command' && (
        <Edge className="panel" cut={12}>
          <h2>{t.subs.newCommand}</h2>
          <p className="muted">{t.subs.runThis}</p>
          <CommandBox command={panel.command} />
          <p className="muted">{t.subs.joinOnce}</p>
          <div className="actions">
            <button
              className="btn"
              type="button"
              onClick={() => {
                setPanel(null);
                void load();
              }}
            >
              {t.common.done}
            </button>
          </div>
        </Edge>
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}

      {subs && subs.length === 0 && <p className="muted">{t.subs.empty}</p>}
      {subs && subs.length > 0 && (
        <table className="ptable">
          <thead>
            <tr>
              <th scope="col">{t.subs.columns.subscription}</th>
              <th scope="col">{t.subs.columns.place}</th>
              <th scope="col">{t.subs.columns.machine}</th>
              <th scope="col">{t.subs.columns.status}</th>
              <th scope="col"><span className="sr">{t.subs.columns.actions}</span></th>
            </tr>
          </thead>
          <tbody>
            {subs.map(s => {
              const name = subName(t, s);
              const state = stateOf(s);
              const test = tests[s.id];
              const mine = s.owner.id === me.person.id;
              const asking = confirm === s.id;
              const line = signinLine(t, language, s);
              const tier = tierLine(t, s);
              const differ = differLine(t, s);
              const email = accountEmail(s);
              const signingHere = signing?.subId === s.id ? signing : null;
              const note = signNote?.subId === s.id ? signNote.text : null;
              const keying = keyFor === s.id && isKeyPlan(s.provider);
              /* Only the owner signs a plan in, on one of its machines that is online. */
              const canSign = mine && s.kind === 'personal' && !signingHere && s.machines.some(m => m.online);
              const again = s.signedInOnce && s.status === 'ready';
              return (
                <Fragment key={s.id}>
                  <tr>
                    <td>
                      <span className="sub-name">
                        <span className="pname">{name}</span>
                        {s.isOrchestrator && (
                          <>
                            {' '}
                            <span className="badge">{t.subs.orchestrator}</span>
                          </>
                        )}
                      </span>
                    </td>
                    <td>{s.place.kind === 'company' ? t.people.wholeCompany : s.place.name}</td>
                    <td>
                      {s.kind === 'api_key' ? (
                        t.subs.builtin
                      ) : s.machines.length ? (
                        <ul className="where-list" aria-label={t.subs.machinesOf(name)}>
                          {s.machines.map(m => {
                            /* With one machine the plan's state says it all. */
                            const note = s.machines.length > 1 && waitsThere(t, m);
                            return (
                              <li key={m.id}>
                                {m.hostname}
                                {note && <span className="muted">, {note}</span>}
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <span className="muted">{t.subs.noMachine}</span>
                      )}
                    </td>
                    <td>
                      <span className={`status ${state}`}>{t.subs.states[state]}</span>
                      {line && <small className="signin-line">{line}</small>}
                      {tier && <small className="signin-line">{tier}</small>}
                      {email && <small className="signin-line muted">{email}</small>}
                      {differ && <small className="signin-line warn">{differ}</small>}
                      <LimitBars sub={s} />
                      {s.kind === 'personal' && (mine || company) && (
                        <label className="share">
                          <span>{t.subs.share}</span>
                          <select aria-label={t.subs.shareLabel(name)} value={s.budget === null ? '' : String(s.budget)} onChange={e => setBudget(s, e.target.value ? Number(e.target.value) : null)}>
                            <option value="">{t.subs.shareAll}</option>
                            {SHARES.map(n => (
                              <option key={n} value={String(n)}>{`${n}%`}</option>
                            ))}
                          </select>
                        </label>
                      )}
                    </td>
                    <td className="row-actions">
                      {s.status === 'ready' && s.online && (
                        <button className="act" type="button" aria-label={t.subs.runTestLabel(name)} disabled={test?.phase === 'running'} onClick={() => runTest(s)}>{t.subs.runTest}</button>
                      )}
                      {company && s.place.kind === 'company' && !s.isOrchestrator && (
                        <button className="act" type="button" aria-label={t.subs.useForOrchestratorLabel(name)} onClick={() => makeOrchestrator(s)}>{t.subs.useForOrchestrator}</button>
                      )}
                      {canSign && TERMINAL_SIGNIN.has(s.provider) && (
                        <button
                          className="act"
                          type="button"
                          aria-label={again ? t.subs.signInAgainLabel(name) : t.subs.signInLabel(name)}
                          onClick={() => signIn(s, again)}
                        >
                          {again ? t.subs.signInAgain : t.subs.signIn}
                        </button>
                      )}
                      {mine && s.kind === 'personal' && isKeyPlan(s.provider) && s.machines.length > 0 && !keying && (
                        <button className="act" type="button" aria-label={t.subs.pasteKeyLabel(name)} onClick={() => setKeyFor(s.id)}>{t.subs.pasteKey}</button>
                      )}
                      {mine && s.kind === 'personal' && s.status === 'waiting_machine' && (
                        <button className="act" type="button" aria-label={t.subs.newCommandLabel(name)} onClick={() => newCommand(s)}>{t.subs.newCommand}</button>
                      )}
                      {(mine || company) && (
                        <button className="act danger" type="button" aria-label={t.subs.removeLabel(name)} onClick={() => setConfirm(s.id)}>{t.subs.remove}</button>
                      )}
                    </td>
                  </tr>
                  {(asking || test || signingHere || note || keying) && (
                    <tr className="row-extra">
                      <td colSpan={5}>
                        {signingHere && (
                          <SignInPanel
                            subId={s.id}
                            program={PROGRAM_NAMES[s.provider]}
                            nodeId={signingHere.nodeId}
                            hostname={signingHere.hostname}
                            onEnd={error => endSignIn(signingHere, error)}
                            onStop={() => stopSignIn(signingHere)}
                          />
                        )}
                        {note && <p className="test failed" role="status">{note}</p>}
                        {keying && isKeyPlan(s.provider) && (
                          <KeyForm
                            sub={{ ...s, provider: s.provider }}
                            onDone={() => {
                              setKeyFor(null);
                              void load();
                            }}
                            onCancel={() => setKeyFor(null)}
                          />
                        )}
                        {asking && (
                          <Ask
                            text={s.kind === 'api_key' ? t.subs.removeKeyAsk(name) : t.subs.removeAsk(name)}
                            yes={t.subs.yesRemove}
                            onYes={() => remove(s)}
                            onNo={() => setConfirm(null)}
                          />
                        )}
                        {test && <TestResult test={test} />}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
