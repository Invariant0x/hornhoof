import { useId, useState } from 'react';
import { useT } from '../i18n';
import type { AgentTime, Department, DepartmentTree, IdleStretch, SegmentKind, TreeAgent } from '../types';
import { TreeWho } from './TreeCard';
import { idleClass, latestLines, SEGMENT_CLASS, secondsBetween, treeClock } from './tree';

type Props = { tree: DepartmentTree; department: Department; onAgent(id: string, top: number): void };
const amount = (time: AgentTime) => [time.work, time.after + time.person, time.stall];

function taskNumber(tree: DepartmentTree, agentId: string): number | undefined {
  if (tree.review?.reviewers.some(r => r.agent.id === agentId)) return tree.review.number;
  return latestLines(tree.lines).find(l => l.agent.id === agentId)?.number;
}

function Strip({ tree, agent }: { tree: DepartmentTree; agent: TreeAgent }) {
  const L = useT().dept.tree, start = tree.turn!.startedAt;
  const duration = Math.max(1, secondsBetween(start, tree.now));
  const segments = [
    ...tree.lines.filter(l => l.agent.id === agent.id).flatMap(l => l.segments),
    ...(tree.review?.reviewers.find(r => r.agent.id === agent.id)?.segments ?? []),
  ];
  const time = tree.time.find(a => a.agent.id === agent.id)!;
  const label = `${agent.name}: ${amount(time).map((n, i) => `${L.cols[i + 1]} ${L.dur(n / 60)}`).join(', ')}`;
  return (
    <span className="strip" role="img" aria-label={label}>
      {segments.map((s, i) => {
        const from = s.from < start ? start : s.from, to = s.to && s.to < tree.now ? s.to : tree.now;
        return to > from && (
          <i
            key={i}
            className={SEGMENT_CLASS[s.kind]}
            style={{
              left: `${secondsBetween(start, from) / duration * 100}%`,
              width: `${secondsBetween(from, to) / duration * 100}%`,
            }}
          />
        );
      })}
    </span>
  );
}

function amountClass(time: AgentTime, value: number, index: number): string {
  if (!value) return 'z';
  if (index === 2) return 'a';
  if (index === 1 && time.person) return 'p';
  return '';
}

function SpeedRow({ time, tree, department, onAgent }: Props & { time: AgentTime }) {
  const L = useT().dept.tree;
  return (
    <li>
      <button
        type="button"
        className="spl-r"
        onClick={e => onAgent(time.agent.id, e.currentTarget.getBoundingClientRect().top)}
      >
        <span className="who">
          <b><TreeWho agent={time.agent} department={department} /></b>
          <small>#{taskNumber(tree, time.agent.id)}</small>
        </span>
        {amount(time).map((n, i) => (
          <span key={i} className={`n ${amountClass(time, n, i)}`}>{n ? L.dur(n / 60) : '0'}</span>
        ))}
        <Strip tree={tree} agent={time.agent} />
      </button>
    </li>
  );
}

function SpeedRows({ tree, department, onAgent }: Props) {
  const L = useT().dept.tree;
  const totals = tree.time.reduce((sum, time) => sum.map((v, i) => v + amount(time)[i]!), [0, 0, 0]);
  const start = tree.turn!.startedAt;
  const middle = new Date(Date.parse(start) + secondsBetween(start, tree.now) * 500).toISOString();
  return (
    <>
      <dl className="sum">
        {totals.map((n, i) => (
          <div key={i} className={['c', '', 'a'][i]}>
            <dt>{L.cols[i + 1]}</dt>
            <dd>{L.dur(n / 60)}</dd>
          </div>
        ))}
      </dl>
      <div>
        <div className="spl-h">{L.cols.map(col => <span key={col}>{col}</span>)}</div>
        <ul className="spl">
          {tree.time.map(time => (
            <SpeedRow key={time.agent.id} time={time} tree={tree} department={department} onAgent={onAgent} />
          ))}
        </ul>
        <div className="scale">{[start, middle, tree.now].map(at => <span key={at}>{treeClock(at)}</span>)}</div>
      </div>
      <div className="skey">
        {Object.entries(L.key).map(([kind, label]) => (
          <span key={kind}><i className={`sk ${kind}`} />{label}</span>
        ))}
      </div>
    </>
  );
}

function IdleItem({ idle, tree, department, onAgent }: Props & { idle: IdleStretch }) {
  const L = useT().dept.tree;
  const reason = idle.kind === 'after' ? idle.waitsFor.map(L.idleKind.after).join(', ') : L.idleKind[idle.kind];
  return (
    <li>
      <button
        type="button"
        className={`idle ${idleClass(idle.kind)}`}
        onClick={e => onAgent(idle.agent.id, e.currentTarget.getBoundingClientRect().top)}
      >
        <span className="ih">
          <b><TreeWho agent={idle.agent} department={department} /></b>
          <small>#{idle.number}</small>
        </span>
        <span className="d">{L.dur(secondsBetween(idle.from, idle.to ?? tree.now) / 60)}</span>
        <span className="iw">#{idle.number} {idle.title}</span>
        <span className="iw">{reason}{idle.question ? `: ${idle.question}` : ''}</span>
        <span className="it">
          {idle.to ? L.idleClosed(treeClock(idle.from), treeClock(idle.to)) : (
            <>
              {L.idleOpen(treeClock(idle.from))}
              <span className="live">{L.idleGoing}</span>
            </>
          )}
        </span>
      </button>
    </li>
  );
}

function IdleRows(props: Props) {
  const L = useT().dept.tree, open = props.tree.idle.filter(i => !i.to), ended = props.tree.idle.filter(i => i.to);
  const count = (kind: SegmentKind) => open.filter(i => i.kind === kind).length;
  const list = (items: IdleStretch[]) => (
    <ul className="idl">
      {items.map((idle, i) => <IdleItem key={`${idle.taskId}-${idle.from}-${i}`} {...props} idle={idle} />)}
    </ul>
  );
  return (
    <>
      <p className="idle-now">{L.idleNow(count('stall'), count('person'), count('after'))}</p>
      {list(open)}
      {ended.length > 0 && (
        <>
          <p className="idle-past">{L.idlePast}</p>
          {list(ended)}
        </>
      )}
    </>
  );
}

export function SpeedPanel(props: Props) {
  const t = useT(), L = t.dept.tree, [tab, setTab] = useState(0), id = useId();
  return (
    <>
      <div className="spd-tabs" role="tablist" aria-label={t.dept.speed}>
        {L.spdTabs.map((name, i) => (
          <button
            type="button"
            role="tab"
            id={`${id}-tab-${i}`}
            aria-controls={`${id}-body`}
            aria-selected={tab === i}
            tabIndex={tab === i ? 0 : -1}
            key={name}
            onClick={() => setTab(i)}
            onKeyDown={e => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              setTab(1 - tab);
              document.getElementById(`${id}-tab-${1 - tab}`)?.focus();
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="dv-drawer-b" role="tabpanel" id={`${id}-body`} aria-labelledby={`${id}-tab-${tab}`}>
        {props.tree.turn ? (
          <>
            <p className="spd-sub">
              {L.spdSub(props.tree.turn.number, treeClock(props.tree.turn.startedAt), treeClock(props.tree.now))}
            </p>
            {tab === 0 ? <SpeedRows {...props} /> : <IdleRows {...props} />}
          </>
        ) : <p>{t.dept.treeNoTurn}</p>}
      </div>
    </>
  );
}
