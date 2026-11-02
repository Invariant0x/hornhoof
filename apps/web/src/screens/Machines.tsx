import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { NodeLoad } from '@hornhoof/protocol';
import { api } from '../api';
import { errorText, useLanguage, useT, type Language, type Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { BuiltinView, MachineView, Me, Running, SubView } from '../types';
import { Ask } from '../ui/Ask';
import { Bar } from '../ui/Bar';
import { CommandBox } from '../ui/CommandBox';
import { Edge } from '../ui/Edge';

const REFRESH_MS = 5000;
const GIB = 1024 ** 3;
/* Docker's system on a Mac keeps a little of what it is given, so only a clear gap says it was set smaller. */
const SMALLER = 1.1;

/* A plan being added to a machine: first which one, then the command to run there. */
type Adding = { machineId: string; command: string | null } | null;

const SYSTEMS: Record<string, string> = { darwin: 'macOS', linux: 'Linux' };

const subName = (t: Messages, s: SubView) => (s.kind === 'api_key' ? t.subs.keyEnding(PROVIDER_NAMES[s.provider], s.last4 ?? '') : PROVIDER_NAMES[s.provider]);

const gigabytes = (language: Language, bytes: number) => new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(Math.round((bytes / GIB) * 10) / 10);

const busyShare = (load: number, cpus: number) => Math.min(100, Math.round((load / Math.max(1, cpus)) * 100));

function lastSeen(t: Messages, language: Language, iso: string | null): string {
  if (!iso) return t.machines.notSeen;
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return t.machines.lastSeenNow;
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (s < 3600) return t.machines.lastSeen(rtf.format(-Math.round(s / 60), 'minute'));
  if (s < 86400) return t.machines.lastSeen(rtf.format(-Math.round(s / 3600), 'hour'));
  return t.machines.lastSeen(rtf.format(-Math.round(s / 86400), 'day'));
}

/* Labels and their values, as one card or the pool shows them. */
function Facts({ items, className = 'facts' }: { items: [label: string, value: ReactNode][]; className?: string }) {
  return (
    <dl className={className}>
      {items.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/* The company's machines as one: how many are online, and the processors and memory of those that are. */
function Pool({ loads, online, all }: { loads: NodeLoad[]; online: number; all: number }) {
  const t = useT();
  const { language } = useLanguage();
  const sum = (pick: (l: NodeLoad) => number) => loads.reduce((n, l) => n + pick(l), 0);
  const cores = sum(l => l.cpus);
  return (
    <section aria-label={t.machines.pool}>
      <Edge className="pool" cut={12}>
        <Facts
          className="pool-facts"
          items={[
            [t.machines.poolOnline, t.machines.of(String(online), String(all))],
            [t.machines.poolCores, cores ? String(cores) : t.machines.unknown],
            [t.machines.poolMemory, loads.length ? t.machines.gbOf(gigabytes(language, sum(l => l.memFree)), gigabytes(language, sum(l => l.memTotal))) : t.machines.unknown],
            [t.machines.poolBusy, cores ? `${busyShare(sum(l => l.load), cores)}%` : t.machines.unknown],
          ]}
        />
      </Edge>
    </section>
  );
}

/* What the node says it can use of its machine, and whether that is less than the machine has. */
function hardware(t: Messages, language: Language, os: string, load: NodeLoad | null): { items: [string, ReactNode][]; note: string | null } {
  if (!load) return { items: [t.machines.processor, t.machines.memory, t.machines.load, t.machines.disk].map(label => [label, t.machines.unknown]), note: null };
  const fewerCores = load.hostCpus !== undefined && load.hostCpus > load.cpus;
  const lessMemory = load.hostMemory !== undefined && load.hostMemory > load.memTotal * SMALLER;
  const cores = fewerCores ? t.machines.coresOf(load.cpus, load.hostCpus!) : t.machines.cores(load.cpus);
  const memory = t.machines.gbFree(gigabytes(language, load.memFree), gigabytes(language, load.memTotal));
  const busy = busyShare(load.load, load.cpus);
  return {
    items: [
      [t.machines.processor, load.cpuModel ? `${load.cpuModel}, ${cores}` : cores],
      [t.machines.memory, lessMemory ? `${memory}, ${t.machines.machineHas(gigabytes(language, load.hostMemory!))}` : memory],
      [
        t.machines.load,
        <span className="load-now">
          <Bar used={busy / 100} />
          <b>{busy}%</b>
        </span>,
      ],
      [t.machines.disk, load.diskTotal !== undefined && load.diskFree !== undefined ? t.machines.gbFree(gigabytes(language, load.diskFree), gigabytes(language, load.diskTotal)) : t.machines.unknown],
    ],
    note: fewerCores || lessMemory ? (os === 'darwin' ? t.machines.smallerMac : t.machines.smaller) : null,
  };
}

function RunningNow({ host, running }: { host: string; running: Running }) {
  const t = useT();
  if (!running.agents.length && !running.parts.length) return <span className="muted">{t.machines.nothing}</span>;
  return (
    <ul className="where-list" aria-label={t.machines.runningOn(host)}>
      {running.agents.map(a => (
        <li key={a.id}>
          {a.name}
          {a.busy && <span className="muted">, {t.machines.working}</span>}
        </li>
      ))}
      {running.parts.map(p => (
        <li key={`${p.kind}-${p.run}-${p.part}`}>{t.machines.part(p)}</li>
      ))}
    </ul>
  );
}

/* The machine the company's server runs on now. */
function Leader() {
  const t = useT();
  return <span className="badge lead" title={t.machines.leaderAbout}>{t.machines.leader}</span>;
}

export function Machines({ me }: { me: Me }) {
  const t = useT();
  const { language } = useLanguage();
  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [builtin, setBuiltin] = useState<BuiltinView | null>(null);
  const [subs, setSubs] = useState<SubView[]>([]);
  const [command, setCommand] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [adding, setAdding] = useState<Adding>(null);
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
      const [hosts, list] = await Promise.all([api.get<{ machines: MachineView[]; builtin?: BuiltinView | null }>('/api/machines'), api.get<{ subscriptions: SubView[] }>('/api/subscriptions')]);
      if (!live.current) return;
      setMachines(hosts.machines);
      setBuiltin(hosts.builtin ?? null);
      setSubs(list.subscriptions);
    } catch (err) {
      setFailure(err);
    }
  }, []);

  /* Machines come online, sign in and take work on their own, so the screen looks again every few seconds. */
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

  const machineCommand = () =>
    run(async () => {
      setCommand((await api.post<{ command: string }>('/api/machines/command')).command);
    });

  const addPlan = (m: MachineView, sub: SubView) =>
    run(async () => {
      const { command } = await api.post<{ command: string }>(`/api/machines/${m.id}/plans`, { subscription: sub.id });
      setAdding({ machineId: m.id, command });
    });

  const lend = (m: MachineView, lendsTests: boolean) =>
    run(async () => {
      await api.patch(`/api/machines/${m.id}`, { lendsTests });
      setMachines(list => list?.map(x => (x.id === m.id ? { ...x, lendsTests } : x)) ?? null);
    });

  const disconnect = (m: MachineView) =>
    run(async () => {
      setConfirm(null);
      await api.post(`/api/machines/${m.id}/disconnect`);
      await load();
    });

  /* The built-in node on a machine that joined runs on that machine's computer, which the pool counts once and the list
     shows as one card: online while either is, with what either says it has and what runs on either. */
  const host = builtin?.machine ? ((machines ?? []).find(m => m.id === builtin.machine!.id) ?? null) : null;
  const apart = host ? null : builtin;
  const loads = [...(machines ?? []).map(m => (m === host ? (m.load ?? builtin!.load) : m.load)), apart?.load ?? null].filter((l): l is NodeLoad => l !== null);
  const online = (machines ?? []).filter(m => m.online || (m === host && builtin!.online)).length + (apart?.online ? 1 : 0);

  return (
    <section className="people machines">
      <header className="people-head">
        <div>
          <h1>{t.machines.heading}</h1>
          <p className="muted">{t.machines.intro}</p>
        </div>
        {!command && (
          <div className="head-actions">
            <button className="btn" type="button" onClick={machineCommand}>{t.machines.connect}</button>
          </div>
        )}
      </header>

      {command && (
        <Edge className="panel" cut={12}>
          <h2>{t.machines.connectHeading}</h2>
          <p className="muted">{t.machines.runThis}</p>
          <CommandBox command={command} trust={t.machines.trust} />
          <p className="muted">{t.subs.joinOnce}</p>
          <div className="actions">
            <button
              className="btn"
              type="button"
              onClick={() => {
                setCommand(null);
                void load();
              }}
            >
              {t.common.done}
            </button>
          </div>
        </Edge>
      )}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}

      {machines && <Pool loads={loads} online={online} all={machines.length + (apart ? 1 : 0)} />}
      {machines && machines.length === 0 && !builtin && <p className="muted">{t.machines.noMachines}</p>}
      {machines && (machines.length > 0 || builtin) && (
        <ul className="machine-list">
          {machines.map(m => {
            const mine = m.owner.id === me.person.id;
            const here = m === host ? builtin : null;
            const { items, note } = hardware(t, language, m.os, here ? (m.load ?? here.load) : m.load);
            const running = here ? { agents: [...m.running.agents, ...here.running.agents], parts: [...m.running.parts, ...here.running.parts] } : m.running;
            /* The person's own plans that do not run here yet, offered on their own machines only. */
            const addable = mine ? subs.filter(s => s.kind === 'personal' && s.owner.id === me.person.id && !m.plans.some(p => p.id === s.id)) : [];
            const add = adding?.machineId === m.id ? adding : null;
            return (
              <li key={m.id}>
                <article aria-label={m.hostname}>
                  <Edge className="machine" cut={12} accent={here !== null} corner={here !== null}>
                    <header className="machine-head">
                      <div className="machine-name">
                        <h2>{m.hostname}</h2>
                        {here && <Leader />}
                      </div>
                      {m.online || here?.online ? <span className="status ready">{t.machines.online}</span> : <span className="muted">{lastSeen(t, language, m.lastSeenAt)}</span>}
                    </header>
                    <Facts
                      items={[
                        [t.machines.owner, m.owner.name],
                        [t.machines.system, `${SYSTEMS[m.os] ?? m.os}, ${m.arch}`],
                        ...items,
                        [
                          t.machines.plans,
                          m.plans.length ? (
                            <ul className="where-list" aria-label={t.machines.plansOn(m.hostname)}>
                              {m.plans.map(p => (
                                <li key={p.id}>
                                  {PROVIDER_NAMES[p.provider]}
                                  {p.status === 'needs_login' && <span className="muted">, {t.subs.waitsThere.needs_login}</span>}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <span className="muted">{t.machines.noPlan}</span>
                          ),
                        ],
                        [t.machines.runningNow, <RunningNow host={m.hostname} running={running} />],
                      ]}
                    />
                    {note && <p className="machine-note">{note}</p>}
                    {here && <p className="machine-note">{t.machines.builtinHere}</p>}
                    <div className="machine-actions">
                      {company || mine ? (
                        <label className="lend">
                          <input type="checkbox" aria-label={t.machines.lendLabel(m.hostname)} checked={m.lendsTests} onChange={e => lend(m, e.target.checked)} />
                          <span aria-hidden="true">{t.machines.lend}</span>
                        </label>
                      ) : (
                        <span className="muted">{m.lendsTests ? t.machines.lent : t.machines.notLent}</span>
                      )}
                      {addable.length > 0 && !add && (
                        <button className="act" type="button" aria-label={t.machines.addPlanLabel(m.hostname)} onClick={() => setAdding({ machineId: m.id, command: null })}>{t.machines.addPlan}</button>
                      )}
                      {(company || mine) && (
                        <button className="act danger" type="button" aria-label={t.machines.disconnectLabel(m.hostname)} onClick={() => setConfirm(m.id)}>{t.machines.disconnect}</button>
                      )}
                    </div>
                    {confirm === m.id && <Ask text={t.machines.disconnectAsk(m.hostname)} yes={t.machines.yesDisconnect} onYes={() => disconnect(m)} onNo={() => setConfirm(null)} />}
                    {add && !add.command && (
                      <div className="ask">
                        <span>{t.machines.addPlanAsk(m.hostname)}</span>
                        {addable.map(s => (
                          <button key={s.id} className="btn small" type="button" aria-label={t.machines.addPlanTo(subName(t, s), m.hostname)} onClick={() => addPlan(m, s)}>{subName(t, s)}</button>
                        ))}
                        <button className="btn small ghost" type="button" onClick={() => setAdding(null)}>{t.common.cancel}</button>
                      </div>
                    )}
                    {add?.command && (
                      <div className="add-plan">
                        <p className="muted">{t.machines.runOn(m.hostname)}</p>
                        <CommandBox command={add.command} />
                        <p className="muted">{t.subs.joinOnce}</p>
                        <div className="actions">
                          <button
                            className="btn small"
                            type="button"
                            onClick={() => {
                              setAdding(null);
                              void load();
                            }}
                          >
                            {t.common.done}
                          </button>
                        </div>
                      </div>
                    )}
                  </Edge>
                </article>
              </li>
            );
          })}
          {apart && (
            <li>
              <article aria-label={t.machines.builtin}>
                <Edge className="machine" cut={12} accent corner>
                  <header className="machine-head">
                    <div className="machine-name">
                      <h2>{t.machines.builtin}</h2>
                      <Leader />
                    </div>
                    {apart.online ? <span className="status ready">{t.machines.online}</span> : <span className="muted">{t.subs.states.builtin_offline}</span>}
                  </header>
                  <p className="muted">{t.machines.builtinAbout}</p>
                  <Facts items={[...hardware(t, language, 'linux', apart.load).items, [t.machines.runningNow, <RunningNow host={t.machines.builtin} running={apart.running} />]]} />
                </Edge>
              </article>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
