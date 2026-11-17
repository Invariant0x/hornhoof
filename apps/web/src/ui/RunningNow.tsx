import { useState } from 'react';
import { useLanguage, useT } from '../i18n';
import { useOpenAgent } from '../screens/AgentWindowContext';
import type { Me, Running, RunningAgent } from '../types';
import { EmptyBox } from './Cards';
import { Edge } from './Edge';
import { AgentIcon, ProviderMark } from './icons';
import { useNow } from './reset';

export const workingCount = (agents: readonly RunningAgent[]) => agents.filter(a => a.busy).length;
export const agentAmounts = (agents: readonly RunningAgent[]) => [agents.length, workingCount(agents)];

export function AgentsCell({ agents }: { agents: RunningAgent[] }) {
  const t = useT();
  const busy = workingCount(agents);
  return <span><span className="num">{agents.length}</span>{busy > 0 && <>, <span className="tk">{t.running.working(busy)}</span></>}</span>;
}

function RunHead({ title, agents, parts }: { title: string; agents: RunningAgent[]; parts: Running['parts'] }) {
  const t = useT();
  const busy = workingCount(agents);
  const counts = [agents.length ? t.running.agents(agents.length) : null, busy ? t.running.working(busy) : null, parts.length ? t.running.tests(parts.length) : null].filter(Boolean);
  return <header className="run-h"><h4>{title}</h4>{counts.length > 0 && <p className="run-count">{counts.join(', ')}</p>}</header>;
}

function AgentActivity({ agent: a, me, now }: { agent: RunningAgent; me: Me; now: number }) {
  const t = useT();
  if (!a.busy) return <>{t.running.free}</>;
  return <>
    {a.task ? <span className="tk" title={a.task.title}>#{a.task.number}</span> : a.withCeo && me.person.isOwner && <span className="tk">{t.running.withYou}</span>}
    {a.since && <span className="tm">{t.running.minutes(Math.floor(Math.max(0, now - Date.parse(a.since)) / 60_000))}</span>}
  </>;
}

function AgentChip({ agent: a, me, now }: { agent: RunningAgent; me: Me; now: number }) {
  const openAgent = useOpenAgent();
  const t = useT();
  const { language } = useLanguage();
  const role = a.title?.[language];
  const chip = <Edge className={`run-chip${a.busy ? ' on' : ''}`} cut={8} halo={a.canOpen}>
    <span className="l1"><span className={`ag${a.busy ? ' on' : ''}`}><AgentIcon /></span><b>{a.name}</b><ProviderMark provider={a.provider} /></span>
    {role && role !== a.name && <span className="l2">{role}</span>}
    <span className="l3"><AgentActivity agent={a} me={me} now={now} /></span>
  </Edge>;
  return a.canOpen ? <button type="button" className="run-open" aria-label={t.window.openAgent(a.name)} onClick={() => openAgent(a.id)}>{chip}</button> : chip;
}

function AgentGroup({ name, agents, foldable, me, now }: { name: string; agents: RunningAgent[]; foldable: boolean; me: Me; now: number }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const busy = workingCount(agents);
  const sorted = [...agents].sort((a, b) => Number(b.busy) - Number(a.busy));
  const folded = foldable && !expanded;
  const shown = folded ? sorted.slice(0, 5) : sorted;
  return <section className="dg" aria-label={name}>
    <header className="dg-h"><h5>{name}</h5><span className="c">{t.running.agents(agents.length)}{busy ? `, ${t.running.working(busy)}` : ''}</span><span className="ticks" aria-hidden="true">{sorted.map(a => <i key={a.id} className={a.busy ? 'on' : undefined} />)}</span></header>
    <ul className="run-chips">{shown.map(a => <li key={a.id}><AgentChip agent={a} me={me} now={now} /></li>)}
      {foldable && <li><button className="chip-more" type="button" aria-expanded={expanded} aria-label={folded ? t.running.moreIn(agents.length - 5, name) : t.running.showLess} onClick={() => setExpanded(!expanded)}>{folded ? `+${agents.length - 5}` : t.running.showLess}</button></li>}
    </ul>
  </section>;
}

function TestGroup({ parts, now }: { parts: Running['parts']; now: number }) {
  const t = useT();
  return <section className="dg" aria-label={t.running.testGroup}><header className="dg-h"><h5>{t.running.testGroup}</h5><span className="c">{parts.length}</span></header>
    <ul className="run-chips">{parts.map(p => <li key={`${p.kind}-${p.run}-${p.part}`}><Edge className="run-chip on" cut={8}>
      <span className="l1"><svg className="ic fl" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1h6M6 1v5l-4 7c-.5 1 .5 2 1 2h10c.5 0 1.5-1 1-2l-4-7V1M4.5 10h7" /></svg><b>{t.machines.part(p)}</b></span>
      {p.agent && <span className="l2">{t.running.startedBy(p.agent)}</span>}
      <span className="l3"><span className="segs" aria-hidden="true">{Array.from({ length: p.parts }, (_, i) => <i key={i} className={i + 1 === p.part ? 'here' : undefined} />)}</span>{p.startedAt && <span className="tm">{t.running.minutes(Math.floor(Math.max(0, now - Date.parse(p.startedAt)) / 60_000))}</span>}</span>
    </Edge></li>)}</ul>
  </section>;
}

function departmentGroups(agents: RunningAgent[], company: string) {
  const groups = new Map<string, { name: string; agents: RunningAgent[] }>();
  for (const agent of agents) {
    const key = agent.department?.id ?? '';
    if (!groups.has(key)) groups.set(key, { name: agent.department?.name ?? company, agents: [] });
    groups.get(key)!.agents.push(agent);
  }
  return [...groups.entries()].sort(([a], [b]) => Number(b === '') - Number(a === ''));
}

type Props = { title: string; label: string; agents: RunningAgent[]; parts?: Running['parts']; me: Me; online?: boolean; plan?: boolean };

export function RunningNow({ title, label, agents, parts = [], me, online = true, plan = false }: Props) {
  const t = useT();
  const now = useNow();
  const ordered = departmentGroups(agents, t.running.company);
  const emptyTitle = plan ? t.cards.noAgents : online ? t.machines.nothing : t.running.offlineNothing;
  const hint = plan ? t.cards.noAgentsHint : online ? t.running.nothingHint : undefined;
  return <section className="blk blk-run" aria-label={label}><RunHead title={title} agents={agents} parts={parts} />
    {agents.length || parts.length ? <div className="vb">
      {ordered.map(([id, group]) => <AgentGroup key={id} {...group} foldable={agents.length > 12 && group.agents.length > 6} me={me} now={now} />)}
      {parts.length > 0 && <TestGroup parts={parts} now={now} />}
    </div> : <EmptyBox title={emptyTitle} hint={hint} />}
  </section>;
}
