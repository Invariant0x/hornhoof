import { taskWaitText } from '../ui/task-wait';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type RefObject, type UIEvent } from 'react';
import { useLanguage, useT } from '../i18n';
import type { Department, DepartmentTree, TreeAgent } from '../types';
import { Pulse, motionSpeed, toD, useReducedMotion } from '../ui/wires';
import {
  idleClass, plateHeight, plateKey, plateRoom, treeClock, treeLayout, trunkBranch, reviewsOf, rowTaskNumber, statePriority,
  type PlateHeights, type TreeLayout, type TreeBadge, type TreeMark, type TreePick, type TreeRow, type TreeTarget,
} from './tree';
import { TreeCardBody, TreeWho } from './TreeCard';
import { segmentText } from './tree-state';
import { AgentState } from '../ui/AgentState';
import { useOpenAgent } from './AgentWindowContext';
import { CANVAS_ZOOM_LIMITS, usePanZoom, ZoomBar } from '../ui/canvas';

type Props = {
  tree: DepartmentTree;
  department: Department;
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

function badgeText(t: ReturnType<typeof useT>, badge: TreeBadge): string {
  if (badge.kind === 'after' && !badge.waitsForAgent && !badge.externalWait) return badge.waitsFor.map(t.dept.tree.after).join(', ');
  return segmentText(t, { ...badge, to: null }, new Date(Date.parse(badge.from) + badge.minutes * 60_000).toISOString());
}

function badgeWidth(text: string, badge: TreeBadge): number {
  return Math.ceil(text.length * 6.7 + 14 + (badge.kind === 'after' ? 0 : 12));
}

function Badge({ badge: b }: { badge: TreeBadge }) {
  const t = useT();
  const text = badgeText(t, b);
  const width = badgeWidth(text, b), x = b.x, y = b.y, half = 10;
  const points = [
    `${x},${y - half}`, `${x + width - 5},${y - half}`, `${x + width},${y - half + 5}`,
    `${x + width},${y + half}`, `${x + 5},${y + half}`, `${x},${y + half - 5}`,
  ].join(' ');
  return (
    <g className={`bdg ${idleClass(b.kind)}`}>
      <title>{text}</title>
      <polygon points={points} />
      {b.kind === 'stall' && <path className="bdg-i" d={`M${x + 8.5} ${y - 3.5}v7M${x + 12.5} ${y - 3.5}v7`} />}
      {b.kind === 'person' && <text className="bdg-q" x={x + 10.5} y={y}>?</text>}
      <text className="bdg-t" x={x + (b.kind === 'after' ? 7 : 19)} y={y + .5}>{text}</text>
    </g>
  );
}

function LegendSymbol({ index, repository }: { index: number; repository: boolean }) {
  if (index < 9) {
    return (
      <>
        <path className={`seg ${['w', 'af', 'ps', 'st', 'ls', 'al', 'q', 'u', 'w'][index]}`} d="M2 8H32" />
        {(index === 0 || index === 8) && <circle className={index ? 'mv' : 'pt'} cx="20" cy="8" r="3" />}
      </>
    );
  }
  if (index === 10) {
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
    L.lg.w, L.lg.af, L.lg.ps, L.lg.st, L.lg.ls, L.lg.al, L.lg.q, L.lg.u, L.lg.mv,
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

function reviewLabel(pick: TreePick, review: NonNullable<DepartmentTree['review']>, tree: DepartmentTree, department: Department, L: ReturnType<typeof useT>['dept']['tree']): string {
  const who = department.employees.find(e => e.id === pick.agentId)?.name ?? review.reviewers.find(r => r.agent.id === pick.agentId)?.agent.name;
  const label = `#${review.number} ${L.reviewH(tree.turn!.number)}`;
  return who ? `${who}, ${label}` : label;
}

function pickLabel(pick: TreePick, tree: DepartmentTree, department: Department, L: ReturnType<typeof useT>['dept']['tree']): string {
  const row = tree.lines.find(l => l.taskId === pick.taskId);
  if (row) return `${department.employees.find(e => e.id === row.agent.id)?.name ?? row.agent.name}, #${row.number} ${row.title}`;
  const review = reviewsOf(tree).find(r => r.taskId === pick.taskId);
  if (review) return reviewLabel(pick, review, tree, department, L);
  if (pick.agentId) return department.employees.find(e => e.id === pick.agentId)?.name ?? '';
  if (pick.kind === 'main') return trunkBranch(department);
  return tree.turn!.branch;
}

/* What a lane's agent does now: its program, the server's alarm in red, or what its turn waits for. */
function LaneState({ agent, department, now }: { agent: TreeAgent; department: Department; now: string }) {
  return <AgentState agent={department.employees.find(e => e.id === agent.id)} serverNow={now} />;
}

function ExternalWaitState({ wait }: { wait: NonNullable<DepartmentTree['lines'][number]['externalWait']> }) {
  const text = taskWaitText(useT(), wait, treeClock(wait.until));
  return <span className="ast calm" title={text}>{text}</span>;
}

function LaneDescription({ agent, tree, department, line }: { agent: TreeAgent; tree: DepartmentTree; department: Department; line?: DepartmentTree['lines'][number] }) {
  const L = useT().dept.tree;
  const external = line?.externalWait;
  if (external && external.until > tree.now) return <ExternalWaitState wait={external} />;
  const wait = tree.waiting?.find(w => w.agent.id === agent.id);
  if (!wait) return <LaneState agent={agent} department={department} now={tree.now} />;
  const text = L.waitingFor(wait.waitsForAgent.name, treeClock(wait.from));
  return <span className="ast calm" title={text}>{text}</span>;
}

function rowTitle(row: TreeRow, tree: DepartmentTree, L: ReturnType<typeof useT>['dept']['tree']): string {
  if (row.line) return row.line.title;
  if (row.review) return L.reviewH(tree.turn!.number);
  return row.activity?.task?.title ?? L.noTask;
}

function RowTask({ row, tree }: { row: TreeRow; tree: DepartmentTree }) {
  const L = useT().dept.tree, number = rowTaskNumber(row);
  return <>{number !== undefined && `#${number}`}<span className="tv-title"> {rowTitle(row, tree, L)}</span></>;
}

/* An employee named after its role says it once. */
function LaneRole({ agent, department }: { agent: TreeAgent; department: Department }) {
  const { language } = useLanguage(), employee = department.employees.find(e => e.id === agent.id);
  const role = employee?.title?.[language];
  return role && role !== employee?.name ? <small className="tv-role">{role}</small> : null;
}

function Label({ row, tree, department }: { row: TreeRow; tree: DepartmentTree; department: Department }) {
  if (!row.agent) return <b>{row.type === 'main' ? trunkBranch(department) : tree.turn!.branch}</b>;
  return <>
    <span className="r1"><b><TreeWho agent={row.agent} department={department} /></b><LaneRole agent={row.agent} department={department} /></span>
    <span className="r2"><RowTask row={row} tree={tree} /></span>
    <LaneDescription agent={row.agent} department={department} tree={tree} line={row.line} />
  </>;
}

type CanvasProps = Pick<Props, 'tree' | 'department'> & {
  layout: TreeLayout;
  selected: TreePick | null;
  select(pick: TreePick, e: MouseEvent): void;
};

function pickKey(pick: TreePick): string {
  return JSON.stringify([pick.kind, pick.agentId, pick.taskId, pick.moveIndex, pick.jobId, pick.segmentIndex]);
}

function samePick(a: TreePick | null, b: TreePick): boolean {
  return !!a && pickKey(a) === pickKey(b);
}

function hitPriority(hit: TreeTarget): number {
  return hit.segment ? statePriority(hit.segment.kind) : -2;
}

function pathPriority(path: TreeLayout['paths'][number]): number {
  return path.segmentKind === undefined ? -2 : statePriority(path.segmentKind);
}

function graphPaths(layout: TreeLayout, kind: string) {
  return layout.paths.filter(p => p.kind === kind).sort((a, b) => pathPriority(a) - pathPriority(b));
}

function Target({ hit, tree, department, selected, select }: Omit<CanvasProps, 'layout'> & { hit: TreeTarget }) {
  const t = useT(), L = t.dept.tree;
  const on = samePick(selected, hit.pick);
  const label = hit.segment ? `${pickLabel(hit.pick, tree, department, L)}: ${segmentText(t, hit.segment, tree.now)}` : pickLabel(hit.pick, tree, department, L);
  const props = {
    className: `${hit.round ? 'hit' : 'rowhit'}${on ? ' on' : ''}`,
    'data-row': hit.row,
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    onClick: (e: MouseEvent) => select(hit.pick, e),
    onKeyDown(e: React.KeyboardEvent<SVGElement>) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.currentTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    },
  };
  return hit.round
    ? <circle {...props} cx={hit.x} cy={hit.y} r={hit.width / 2}><title>{label}</title></circle>
    : <rect {...props} x={hit.x} y={hit.y} width={hit.width} height={hit.height}><title>{label}</title></rect>;
}

function Graph(props: CanvasProps) {
  const { layout, tree } = props, L = useT().dept.tree, still = useReducedMotion();
  const targets = (round: boolean) => layout.targets
    .filter(h => h.round === round).sort((a, b) => hitPriority(a) - hitPriority(b))
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
        {['main', 'turn', 'segment', 'bridge', 'fork', 'merge'].map(kind => graphPaths(layout, kind)
          .map((p, i) => <path key={`${kind}${i}`} className={`${p.cls}${p.dim ? ' dn' : ''}`} d={toD(p.points)} />))}
        {layout.marks.map((m, i) => <g key={i} className={m.dim ? 'dn' : undefined}><Mark m={m} /></g>)}
        {layout.badges.map(b => <Badge key={b.row} badge={b} />)}
        {layout.pulses.map((pts, i) => <Pulse key={i} pts={pts} speed={motionSpeed(60, still)} />)}
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

/* A plate's text decides its height and its row follows. Moving and zooming resize no plate; a new text or font does. */
function useMeasuredPlates(labs: RefObject<HTMLDivElement | null>, keys: string, onPlates: (heights: PlateHeights) => void) {
  useLayoutEffect(() => {
    const plates = [...labs.current!.querySelectorAll<HTMLElement>('.lchip')];
    const measure = () => onPlates(Object.fromEntries(plates.map(plate => [plate.dataset.row!, plate.offsetHeight])));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    plates.forEach(plate => observer.observe(plate));
    return () => observer.disconnect();
  }, [labs, keys, onPlates]);
}

function Labels({ layout, tree, department, selected, select, onPlates }: CanvasProps & { onPlates(heights: PlateHeights): void }) {
  const labs = useRef<HTMLDivElement>(null), rows = layout.rows.filter(r => r.pick);
  useMeasuredPlates(labs, rows.map(plateKey).join(), onPlates);
  return (
    <div className="tv-labs" ref={labs} style={{ width: layout.labelWidth, height: layout.height }}>
      {rows.map(r => (
        <button
          type="button"
          key={plateKey(r)}
          data-row={plateKey(r)}
          className={labelClass(r, selected)}
          style={{ top: r.y + plateRoom(r), minHeight: plateHeight(r) }}
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

function useTreeSelection(root: RefObject<HTMLDivElement | null>) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const card = useRef<HTMLDivElement>(null), openAgent = useOpenAgent();
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
    if (pick.agentId) {
      setSelection(null);
      openAgent(pick.agentId);
      return;
    }
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

/* A row can be clicked as far as the drawing goes. */
function fitBadges(layout: TreeLayout, t: ReturnType<typeof useT>): TreeLayout {
  const width = Math.max(layout.width, ...layout.badges.map(b => b.x + badgeWidth(badgeText(t, b), b) + 12));
  return { ...layout, width, targets: layout.targets.map(hit => hit.round || hit.segment ? hit : { ...hit, width }) };
}

export function TreeView(props: Props) {
  const { tree, department } = props, t = useT();
  const root = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null);
  const box = useTreeBox(root);
  const [plates, setPlates] = useState<PlateHeights>({});
  const onPlates = useCallback((next: PlateHeights) => setPlates(old => JSON.stringify(old) === JSON.stringify(next) ? old : next), []);
  const layout = useMemo(() => fitBadges(treeLayout(tree, { ...box, plates, agentOrder: department.employees.map(e => e.id) }, 1), t), [tree, department, box, plates, t]);
  const { view, zoomAt, handlers, dragged, fit, onScroll } = useTreeNavigation(scroll, layout, box, !!tree.turn);
  const { selection, card, select, close } = useTreeSelection(root);
  const canvas = { layout, tree, department, selected: selection?.pick ?? null, select };
  return (
    <>
      <div className="tview" ref={root}>
        {!tree.turn ? <p className="tv-empty glass">{t.dept.treeNoTurn}</p> : (
          <>
            <div className="tv-scroll" ref={scroll} role="region" aria-label={t.dept.treeCanvas} {...handlers} onScroll={onScroll}
              onClickCapture={e => ignoreDraggedClick(e, dragged)}>
              <div className="tv-in" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
                <Labels {...canvas} onPlates={onPlates} />
                <Graph {...canvas} />
              </div>
            </div>
            <Legend tree={tree} />
            {selection && <FloatingCard {...props} selection={selection} card={card} box={box} onClose={close} />}
          </>
        )}
      </div>
      <ZoomBar k={view.k} onZoom={zoomAt} onFit={fit} />
    </>
  );
}

/* The tree opens at its natural size from its root, and zooms out as far as showing all of it. */
function useTreeNavigation(viewport: RefObject<HTMLDivElement | null>, layout: TreeLayout, box: { width: number; height: number }, ready: boolean) {
  const width = layout.labelWidth + layout.width;
  const whole = Math.min(1, (box.width - 24) / width, (box.height - 24) / layout.height);
  const [floor, setFloor] = useState(CANVAS_ZOOM_LIMITS.min);
  if (whole < floor) setFloor(whole);
  const pan = usePanZoom(viewport, ready, { min: floor, max: CANVAS_ZOOM_LIMITS.max });
  const { setView } = pan;
  const placed = useRef(''), frame = `${box.width}:${ready}`;
  const place = useCallback((k: number) => {
    setView({ k, x: Math.max(12, (box.width - width * k) / 2), y: 12, smooth: false });
  }, [width, box.width, setView]);
  useLayoutEffect(() => {
    if (placed.current === frame) return;
    placed.current = frame;
    place(1);
  }, [place, frame]);
  /* Keyboard focus scrolls a clipped row into view: that becomes a move like a drag, so zoom keeps its anchor. */
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget, dx = el.scrollLeft, dy = el.scrollTop;
    if (!dx && !dy) return;
    el.scrollLeft = 0;
    el.scrollTop = 0;
    setView(v => ({ ...v, x: v.x - dx, y: v.y - dy, smooth: false }));
  }, [setView]);
  return { ...pan, fit: () => place(whole), onScroll };
}

function ignoreDraggedClick(event: MouseEvent, dragged: () => boolean): void {
  if (!event.detail || !dragged()) return;
  event.preventDefault();
  event.stopPropagation();
}
