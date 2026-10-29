import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT, type Language, type Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { JobView, Limits, MachineView, Me, SubView } from '../types';
import { CommandBox } from '../ui/CommandBox';
import { ConnectPanel } from '../ui/ConnectPanel';
import { Edge } from '../ui/Edge';

const POLL_MS = 1000;
const POLL_LIMIT_MS = 150_000;

type Test = { phase: 'running' } | { phase: 'done'; text: string } | { phase: 'failed'; text: string; tail: string | null };
type Panel = { kind: 'connect' } | { kind: 'command'; command: string } | null;
type Confirm = { kind: 'sub' | 'machine'; id: string } | null;
type State = keyof Messages['subs']['states'];

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

const subName = (t: Messages, s: SubView) => (s.kind === 'api_key' ? t.subs.keyEnding(PROVIDER_NAMES[s.provider], s.last4 ?? '') : PROVIDER_NAMES[s.provider]);

function stateOf(s: SubView): State {
  if (s.status === 'waiting_machine') return 'waiting_machine';
  if (!s.online) return s.kind === 'api_key' ? 'builtin_offline' : 'offline';
  return s.status;
}

function clock(language: Language, iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const today = at.toDateString() === new Date().toDateString();
  const parts: Intl.DateTimeFormatOptions = today ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat(language, parts).format(at);
}

/* The fullest window speaks for the subscription. */
function limitsLine(t: Messages, language: Language, limits: Limits | null): string | null {
  if (!limits) return null;
  const top = [...limits.windows].sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1))[0];
  if (limits.status === 'rejected') return t.subs.limitReached(clock(language, top?.resetsAt ?? null));
  if (!top || top.utilization === null) return null;
  const pct = Math.round(top.utilization * 100);
  const at = clock(language, top.resetsAt);
  return limits.status === 'warning' ? t.subs.limitWarning(pct, at) : t.subs.limitUsed(pct, at);
}

function lastSeen(t: Messages, language: Language, iso: string | null): string {
  if (!iso) return t.subs.notSeen;
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return t.subs.lastSeenNow;
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (s < 3600) return t.subs.lastSeen(rtf.format(-Math.round(s / 60), 'minute'));
  if (s < 86400) return t.subs.lastSeen(rtf.format(-Math.round(s / 3600), 'hour'));
  return t.subs.lastSeen(rtf.format(-Math.round(s / 86400), 'day'));
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

function Ask({ text, yes, onYes, onNo }: { text: string; yes: string; onYes: () => void; onNo: () => void }) {
  const t = useT();
  return (
    <div className="ask">
      <span>{text}</span>
      <button className="btn small" type="button" onClick={onYes}>{yes}</button>
      <button className="btn small ghost" type="button" onClick={onNo}>{t.common.cancel}</button>
    </div>
  );
}

export function Subscriptions({ me }: { me: Me }) {
  const t = useT();
  const { language } = useLanguage();
  const [subs, setSubs] = useState<SubView[] | null>(null);
  const [machines, setMachines] = useState<MachineView[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [tests, setTests] = useState<Record<string, Test>>({});
  const [failure, setFailure] = useState<unknown>(null);
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
      const [list, hosts] = await Promise.all([api.get<{ subscriptions: SubView[] }>('/api/subscriptions'), api.get<{ machines: MachineView[] }>('/api/machines')]);
      if (!live.current) return;
      setSubs(list.subscriptions);
      setMachines(hosts.machines);
    } catch (err) {
      setFailure(err);
    }
  }, []);

  useEffect(() => {
    void load();
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

  const makeChief = (sub: SubView) =>
    run(async () => {
      const { subscription } = await api.post<{ subscription: SubView }>(`/api/subscriptions/${sub.id}/chief`);
      setSubs(list => list?.map(s => (s.id === subscription.id ? subscription : { ...s, isChief: false })) ?? null);
    });

  const newCommand = (sub: SubView) =>
    run(async () => {
      const { command } = await api.post<{ command: string }>(`/api/subscriptions/${sub.id}/command`);
      setPanel({ kind: 'command', command });
    });

  const remove = (sub: SubView) =>
    run(async () => {
      setConfirm(null);
      await api.del(`/api/subscriptions/${sub.id}`);
      await load();
    });

  const disconnect = (m: MachineView) =>
    run(async () => {
      setConfirm(null);
      await api.post(`/api/machines/${m.id}/disconnect`);
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
          <button className="btn" type="button" onClick={() => setPanel({ kind: 'connect' })}>{t.subs.connect}</button>
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
            <button className="btn" type="button" onClick={() => setPanel(null)}>{t.common.done}</button>
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
              const limits = limitsLine(t, language, s.limits);
              const test = tests[s.id];
              const mine = s.owner.id === me.person.id;
              const asking = confirm?.kind === 'sub' && confirm.id === s.id;
              return (
                <Fragment key={s.id}>
                  <tr>
                    <td>
                      <span className="sub-name">
                        <span className="pname">{name}</span>
                        {s.isChief && (
                          <>
                            {' '}
                            <span className="badge">{t.subs.chief}</span>
                          </>
                        )}
                      </span>
                    </td>
                    <td>{s.place.kind === 'company' ? t.people.wholeCompany : s.place.name}</td>
                    <td>{s.kind === 'api_key' ? t.subs.builtin : (s.machine?.hostname ?? <span className="muted">{t.subs.noMachine}</span>)}</td>
                    <td>
                      <span className={`status ${state}`}>{t.subs.states[state]}</span>
                      {limits && <small className="limits">{limits}</small>}
                    </td>
                    <td className="row-actions">
                      {s.status === 'ready' && s.online && (
                        <button className="linkbtn" type="button" aria-label={t.subs.runTestLabel(name)} disabled={test?.phase === 'running'} onClick={() => runTest(s)}>{t.subs.runTest}</button>
                      )}
                      {company && s.place.kind === 'company' && !s.isChief && (
                        <button className="linkbtn" type="button" aria-label={t.subs.useForChiefLabel(name)} onClick={() => makeChief(s)}>{t.subs.useForChief}</button>
                      )}
                      {mine && s.kind === 'personal' && s.status === 'waiting_machine' && (
                        <button className="linkbtn" type="button" aria-label={t.subs.newCommandLabel(name)} onClick={() => newCommand(s)}>{t.subs.newCommand}</button>
                      )}
                      {(mine || company) && (
                        <button className="linkbtn" type="button" aria-label={t.subs.removeLabel(name)} onClick={() => setConfirm({ kind: 'sub', id: s.id })}>{t.subs.remove}</button>
                      )}
                    </td>
                  </tr>
                  {(asking || test) && (
                    <tr className="row-extra">
                      <td colSpan={5}>
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

      <div className="subs-machines">
        <h2>{t.subs.machines}</h2>
        <p className="muted">{t.subs.machinesIntro}</p>
      </div>
      {subs && machines.length === 0 && <p className="muted">{t.subs.noMachines}</p>}
      {machines.length > 0 && (
        <table className="ptable">
          <thead>
            <tr>
              <th scope="col">{t.subs.machineColumns.machine}</th>
              <th scope="col">{t.subs.machineColumns.owner}</th>
              <th scope="col">{t.subs.machineColumns.state}</th>
              <th scope="col"><span className="sr">{t.subs.machineColumns.actions}</span></th>
            </tr>
          </thead>
          <tbody>
            {machines.map(m => {
              const asking = confirm?.kind === 'machine' && confirm.id === m.id;
              return (
                <Fragment key={m.id}>
                  <tr>
                    <td><span className="pname">{m.hostname}</span></td>
                    <td>{m.owner.name}</td>
                    <td>{m.online ? <span className="status ready">{t.subs.online}</span> : <span className="muted">{lastSeen(t, language, m.lastSeenAt)}</span>}</td>
                    <td className="row-actions">
                      {(company || m.owner.id === me.person.id) && (
                        <button className="linkbtn" type="button" aria-label={t.subs.disconnectLabel(m.hostname)} onClick={() => setConfirm({ kind: 'machine', id: m.id })}>{t.subs.disconnect}</button>
                      )}
                    </td>
                  </tr>
                  {asking && (
                    <tr className="row-extra">
                      <td colSpan={4}>
                        <Ask text={t.subs.disconnectAsk(m.hostname)} yes={t.subs.yesDisconnect} onYes={() => disconnect(m)} onNo={() => setConfirm(null)} />
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
