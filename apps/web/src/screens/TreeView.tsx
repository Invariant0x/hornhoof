import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from 'react';
import { useT } from '../i18n';
import type { Department, DepartmentTree, TreeAgent } from '../types';
import { Pulse, toD, useReducedMotion } from '../ui/wires';
import {
  idleClass, treeClock, treeLayout, latestLines, trunkBranch, reviewsOf,
  type TreeLayout, type TreeBadge, type TreeMark, type TreePick, type TreeRow, type TreeTarget,
} from './tree';
import { TreeCardBody, TreeWho } from './TreeCard';
import { AgentState } from '../ui/AgentState';

type Props = {
  tree: DepartmentTree;
  department: Department;
  zoom: number;
  fit: number;
  openAgent: { id: string; key: number; top: number } | null;
  onOpenTask(id: string): void;
};
type Selection = { pick: TreePick; x: number; y: number };

function VerdictSymbol({ m }: { m: TreeMark }) {
  const { x, y, verdict } = m;
  if (verdict?.findings) return <text className="mk a" x={x} y={y}>{verdict.findings}</text>;
  if (verdict?.pass) return <path className="ic-ok" d={`M${x - 3} ${y}l2 2.2 4-4.4`} />;
  return null;
}

function Mark({ m }: { m: TreeMark }) {
  const { x, y, kind } = m;
  if (kind === 'done' || m.move?.kind === 'report') return <rect className="sq" x={x - 4.5} y={y - 4.5} width="9" height="9" />;
  if (kind === 'verdict') {
    return (
      <>
        <circle className={`ring ${m.cls}`} cx={x} cy={y} r="8.5" />
        <VerdictSymbol m={m} />
      </>
    );
  }
  if (kind === 'head') {
    return (
      <>
        <circle className={`hd-c ${m.cls}`} cx={x} cy={y} r="5.5" />
        {(m.cls === 'w' || m.cls === 'st') && <circle className={`hd-d ${m.cls}`} cx={x} cy={y} r="2.4" />}
      </>
    );
  }
  if (m.move?.kind === 'asked') {
    return (
      <>
        <circle className={`ring p${m.cls.includes('br') ? ' br' : ''}`} cx={x} cy={y} r="7" />
        <text className="mk p" x={x} y={y}>?</text>
      </>
    );
  }
  if (m.move?.kind === 'answered') {
    return (
      <>
        <circle className="ring p" cx={x} cy={y} r="4.2" />
        <circle className="answer" cx={x} cy={y} r="1.8" />
      </>
    );
  }
  const r = { start: 3.4, fork: 2.8, merge: 4.4, review: 5, move: 3.6 };
  return <circle className={m.cls} cx={x} cy={y} r={r[kind]} />;
}

function Badge({ badge: b }: { badge: TreeBadge }) {
  const L = useT().dept.tree;
  const text = b.kind === 'after' ? b.waitsFor.map(L.after).join(', ') : L.dur(b.minutes);
  const width = Math.ceil(text.length * 6.7 + 14 + (b.kind === 'after' ? 0 : 12)), x = b.x, y = b.y;
  const points = [
    `${x},${y - 10}`, `${x + width - 5},${y - 10}`, `${x + width},${y - 5}`,
    `${x + width},${y + 10}`, `${x + 5},${y + 10}`, `${x},${y + 5}`,
  ].join(' ');
  return (
    <g className={`bdg ${idleClass(b.kind)}`}>
      <polygon points={points} />
      {b.kind === 'stall' && <path className="bdg-i" d={`M${x + 8.5} ${y - 3.5}v7M${x + 12.5} ${y - 3.5}v7`} />}
      {b.kind === 'person' && <text className="bdg-q" x={x + 10.5} y={y}>?</text>}
      <text className="bdg-t" x={x + (b.kind === 'after' ? 7 : 19)} y={y + .5}>{text}</text>
    </g>
  );
}

function LegendSymbol({ index, repository }: { index: number; repository: boolean }) {
  if (index < 5) {
    return (
      <>
        <path className={`seg ${['w', 'af', 'ps', 'st', 'w'][index]}`} d="M2 8H32" />
        {(index === 0 || index === 4) && <circle className={index ? 'mv' : 'pt'} cx="20" cy="8" r="3" />}
      </>
    );
  }
  if (index === 6) {
    return (
      <>
        <circle className="ring a" cx="9" cy="8" r="7" />
        <text className="mk a" x="9" y="8">2</text>
        <circle className="ring ok" cx="26" cy="8" r="7" />
        <path className="ic-ok" d="M23 8l2 2.2 4-4.4" />
      </>
    );
  }
  if (!repository) {
    return (
      <>
        <path className="seg w dn" d="M2 8H17" />
        <rect className="sq" x="17" y="3.5" width="9" height="9" />
      </>
    );
  }
  return (
    <>
      <path className="cn ok" d="M4 14H14L22 6V2" />
      <path className="tk turn" d="M2 2H32" />
      <circle className="via ok" cx="22" cy="2" r="3.6" />
    </>
  );
}

function Legend({ tree }: { tree: DepartmentTree }) {
  const [open, setOpen] = useState(false), L = useT().dept.tree;
  const labels = [
    L.lg.w, L.lg.af, L.lg.ps, L.lg.st, L.lg.mv,
    tree.repository ? L.lg.mg(tree.turn!.branch) : L.lg.dn,
    ...(tree.repository ? [L.lg.vd] : []),
  ];
  return (
    <div className="lgd">
      <button type="button" className="lgd-b glass" aria-label={L.lgH} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h3M2 8h3M2 12h3M7 4h7M7 8h7M7 12h7" /></svg>
        <span>{L.lgH}</span>
      </button>
      {open && (
        <ul className="lgd-l glass">
          {labels.map((label, i) => (
            <li key={label}>
              <svg viewBox="0 0 34 16" aria-hidden="true"><LegendSymbol index={i} repository={tree.repository} /></svg>
              {label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function pickLabel(pick: TreePick, tree: DepartmentTree, department: Department, L: ReturnType<typeof useT>['dept']['tree']): string {
  const row = tree.lines.find(l => l.taskId === pick.taskId);
  if (row) return `${department.employees.find(e => e.id === row.agent.id)?.name ?? row.agent.name}, #${row.number} ${row.title}`;
  if (pick.agentId) {
    const employee = department.employees.find(e => e.id === pick.agentId);
    const reviewer = reviewsOf(tree).flatMap(r => r.reviewers).find(r => r.agent.id === pick.agentId);
    return employee?.name ?? reviewer?.agent.name ?? '';
  }
  if (pick.kind === 'review') return L.reviewH(tree.turn!.number);
  if (pick.kind === 'main') return trunkBranch(department);
  return tree.turn!.branch;
}

/* What a lane's agent does now: its program, the server's alarm in red, or what its turn waits for. */
function LaneState({ agent, department, now }: { agent: TreeAgent; department: Department; now: string }) {
  return <AgentState agent={department.employees.find(e => e.id === agent.id)} serverNow={now} />;
}

function Label({ row, tree, department }: { row: TreeRow; tree: DepartmentTree; department: Department }) {
  const L = useT().dept.tree;
  if (!row.agent) return <b>{row.type === 'main' ? trunkBranch(department) : tree.turn!.branch}</b>;
  return (
    <>
      <span className="r1"><b><TreeWho agent={row.agent} department={department} /></b></span>
      <span className="r2">
        #{row.line?.number ?? row.review?.number}
        <span className="tv-title"> {row.line?.title ?? (tree.turn ? L.reviewH(tree.turn.number) : '')}</span>
      </span>
      <LaneState agent={row.agent} department={department} now={tree.now} />
    </>
  );
}

type CanvasProps = Pick<Props, 'tree' | 'department'> & {
  layout: TreeLayout;
  selected: TreePick | null;
  select(pick: TreePick, e: MouseEvent): void;
};

function Target({ hit, tree, department, selected, select }: Omit<CanvasProps, 'layout'> & { hit: TreeTarget }) {
  const L = useT().dept.tree;
  const on = selected && selected.kind === hit.pick.kind
    && selected.agentId === hit.pick.agentId && selected.moveIndex === hit.pick.moveIndex;
  const props = {
    className: `${hit.round ? 'hit' : 'rowhit'}${on ? ' on' : ''}`,
    'data-row': hit.row,
    role: 'button',
    tabIndex: 0,
    'aria-label': pickLabel(hit.pick, tree, department, L),
    onClick: (e: MouseEvent) => select(hit.pick, e),
    onKeyDown(e: React.KeyboardEvent<SVGElement>) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.currentTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    },
  };
  return hit.round
    ? <circle {...props} cx={hit.x} cy={hit.y} r={hit.width / 2} />
    : <rect {...props} x={hit.x} y={hit.y} width={hit.width} height={hit.height} />;
}

function Graph(props: CanvasProps) {
  const { layout, tree } = props, L = useT().dept.tree, still = useReducedMotion();
  const targets = (round: boolean) => layout.targets
    .filter(h => h.round === round)
    .map((hit, i) => <Target key={i} {...props} hit={hit} />);
  return (
    <svg
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="group"
      aria-label={L.treeAria(tree.turn!.number)}
    >
      <g className="nohit">
        {layout.paths.filter(p => p.kind === 'grid' || p.kind === 'now').map((p, i) => (
          <path key={i} className={p.cls} d={toD(p.points)} />
        ))}
        {layout.grid.map(g => <text key={g.at} className="g-hl" x={g.x} y="15">{treeClock(g.at)}</text>)}
      </g>
      {targets(false)}
      <g className="nohit">
        {['main', 'turn', 'segment', 'bridge', 'fork', 'merge'].map(kind => layout.paths
          .filter(p => p.kind === kind)
          .map((p, i) => <path key={`${kind}${i}`} className={`${p.cls}${p.dim ? ' dn' : ''}`} d={toD(p.points)} />))}
        {layout.marks.map((m, i) => <g key={i} className={m.dim ? 'dn' : undefined}><Mark m={m} /></g>)}
        {layout.badges.map(b => <Badge key={b.row} badge={b} />)}
        {!still && layout.pulses.map((pts, i) => <Pulse key={i} pts={pts} speed={60} />)}
        <rect className="g-now-chip" x={layout.nowX - 25} y="4" width="50" height="18" />
        <text className="g-now-t" x={layout.nowX} y="13.5">{treeClock(tree.now)}</text>
      </g>
      {targets(true)}
    </svg>
  );
}

function labelClass(row: TreeRow, selected: TreePick | null): string {
  const trunk = row.type === 'lane' ? '' : ` tk ${row.type}`;
  const on = row.pick?.agentId && selected?.agentId === row.pick.agentId;
  return `lchip${trunk}${on ? ' on' : ''}`;
}

function Labels({ layout, tree, department, selected, select }: CanvasProps) {
  return (
    <div className="tv-labs" style={{ width: layout.labelWidth, height: layout.height }}>
      {layout.rows.filter(r => r.pick).map((r, i) => (
        <button
          type="button"
          key={i}
          className={labelClass(r, selected)}
          style={{ top: r.y + (r.agent ? 6 : 4), height: r.h - (r.agent ? 12 : 8) }}
          onClick={e => select(r.pick!, e)}
        >
          <span className="in"><Label row={r} tree={tree} department={department} /></span>
        </button>
      ))}
    </div>
  );
}

function useTreeBox(root: RefObject<HTMLDivElement | null>) {
  const [box, setBox] = useState({
    width: window.innerWidth - 32,
    height: window.innerHeight - 144,
    phone: window.innerWidth <= 760,
  });
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setBox({
      width: el.clientWidth || window.innerWidth - 32,
      height: el.clientHeight || window.innerHeight - 144,
      phone: window.innerWidth <= 760,
    });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);
  return box;
}

function agentPick(tree: DepartmentTree, layout: TreeLayout, agentId: string): TreePick | undefined {
  const row = layout.rows.find(r => r.agent?.id === agentId);
  if (row?.pick) return row.pick;
  const line = latestLines(tree.lines).find(l => l.agent.id === agentId);
  return line ? { kind: 'line', taskId: line.taskId, agentId } : undefined;
}

function useTreeSelection(root: RefObject<HTMLDivElement | null>, props: Props, layout: TreeLayout, width: number) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const opened = useRef<number | null>(null), card = useRef<HTMLDivElement>(null);
  const { tree, openAgent } = props;
  useEffect(() => {
    if (!openAgent || opened.current === openAgent.key) return;
    opened.current = openAgent.key;
    const pick = agentPick(tree, layout, openAgent.id);
    if (pick) {
      setSelection({
        pick,
        x: Math.max(0, width - 348),
        y: openAgent.top - (root.current?.getBoundingClientRect().top ?? 0) - 20,
      });
    }
  }, [openAgent, tree, layout, width, root]);
  useEffect(() => {
    if (!selection) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setSelection(null);
    };
    const outside = (e: PointerEvent) => {
      if (!card.current?.contains(e.target as Node)) setSelection(null);
    };
    /* The card handles Escape before the drawer's document listener. */
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', outside);
    };
  }, [selection]);
  function select(pick: TreePick, e: MouseEvent) {
    const rect = root.current!.getBoundingClientRect(), anchor = e.currentTarget.getBoundingClientRect();
    const x = e.currentTarget.classList.contains('lchip')
      ? anchor.right - rect.left + 8
      : (e.clientX || anchor.left + anchor.width / 2) - rect.left - 40;
    setSelection({ pick, x, y: anchor.bottom - rect.top + 8 });
  }
  return { selection, card, select, close: () => setSelection(null) };
}

type FloatingCardProps = Pick<Props, 'tree' | 'department' | 'onOpenTask'> & {
  selection: Selection;
  card: RefObject<HTMLDivElement | null>;
  box: { width: number; height: number };
  onClose(): void;
};

function FloatingCard({ selection, card, box, tree, department, onOpenTask, onClose }: FloatingCardProps) {
  const t = useT(), [style, setStyle] = useState<CSSProperties>({ left: selection.x, top: selection.y });
  useLayoutEffect(() => {
    const width = card.current?.offsetWidth || 340, height = card.current?.offsetHeight || 0;
    setStyle({
      left: Math.max(0, Math.min(selection.x, box.width - width)),
      top: Math.max(0, Math.min(selection.y, box.height - height)),
    });
  }, [selection, box, card]);
  return (
    <div
      className="tv-card"
      ref={card}
      style={style}
      role="dialog"
      aria-label={pickLabel(selection.pick, tree, department, t.dept.tree)}
    >
      <div className="tv-card-edge">
        <div className="tv-card-in">
          <button type="button" className="x" aria-label={t.dept.close} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
          <TreeCardBody tree={tree} department={department} pick={selection.pick} onOpenTask={onOpenTask} />
        </div>
      </div>
    </div>
  );
}

function orderedTree(tree: DepartmentTree, department: Department): DepartmentTree {
  const ranks = new Map(department.employees.map((e, i) => [e.id, i]));
  const rank = (id: string) => ranks.get(id) ?? ranks.size;
  return { ...tree, lines: [...tree.lines].sort((a, b) => rank(a.agent.id) - rank(b.agent.id)) };
}

export function TreeView(props: Props) {
  const { tree, department, zoom, fit } = props, t = useT();
  const root = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null);
  const box = useTreeBox(root);
  const ordered = useMemo(() => orderedTree(tree, department), [tree, department]);
  const layout = useMemo(() => treeLayout(ordered, box, zoom), [ordered, box, zoom]);
  const { selection, card, select, close } = useTreeSelection(root, props, layout, box.width);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth;
  }, [fit, box, zoom]);
  const canvas = { layout, tree, department, selected: selection?.pick ?? null, select };
  return (
    <div className="tview" ref={root}>
      {!tree.turn ? <p className="tv-empty glass">{t.dept.treeNoTurn}</p> : (
        <>
          <div className="tv-scroll" ref={scroll}>
            <div className="tv-in">
              <Labels {...canvas} />
              <Graph {...canvas} />
            </div>
          </div>
          <Legend tree={tree} />
          {selection && <FloatingCard {...props} selection={selection} card={card} box={box} onClose={close} />}
        </>
      )}
    </div>
  );
}
