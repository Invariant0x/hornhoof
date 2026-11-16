import { useCallback, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useLanguage, useT } from '../i18n';
import { humanStatus, type Asks, type HumanStatus } from '../task-board';
import { boardColumns, layoutTree, listGroups, NODE, type BoardColumn, type Crumb, type GraphNode, type ListGroup, type Placed, type TaskTree } from '../tracker';
import type { Pipeline, TaskLine } from '../types';
import { CANVAS_ZOOM_LIMITS, usePanZoom, ZoomBar } from './canvas';
import { Fold } from './TaskBoard';
import { dueText, waitText } from './tracker-words';

/* How a view opens a task's card and marks the open one. asksYou: an open question on a task is the person's to answer. */
export type Rows = { selected: string | null; onOpenTask: (id: string) => void; asksYou?: Asks };

/* The look of a state on the strip of a node or a card: the task lists' own classes, the person's answer in the colour of
   attention. The words always go with it. */
export const STATE_CLASS: Record<HumanStatus, string> = {
  notStarted: 'open', working: 'working', review: 'review', waiting: 'waiting', waitingYou: 'you', stopped: 'blocked', paused: 'blocked', done: 'done', cancelled: 'cancelled',
};

export function StateWord({ status }: { status: HumanStatus }) {
  const t = useT();
  return <span className={`tstate ${STATE_CLASS[status]}`}>{t.tracker.groups[status]}</span>;
}

/* A value of a row with its name, which shows beside it only where the row is too narrow for the names above the list. */
function Cell({ name, children }: { name: string; children: ReactNode }) {
  return (
    <span className="tr-cell">
      <span className="tr-k">{name}</span>
      <span className="tr-v">{children}</span>
    </span>
  );
}

function ListRow({ tree, rows, sub = false }: { tree: TaskTree; rows: Rows; sub?: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  const [open, setOpen] = useState(false);
  const { task } = tree;
  const words = t.tracker.list;
  const due = dueText(t, language, task);
  const waits = waitText(t, task);
  return (
    <li className={`tr-row${rows.selected === task.id ? ' on' : ''}`} aria-label={`#${task.number} ${task.title}`}>
      <div className="tr-cells">
        <span className="tr-name">
          <span className="tr-no">#{task.number}</span>
          <button className="linkish tr-title" type="button" onClick={() => rows.onOpenTask(task.id)}>{task.title}</button>
          {sub && <StateWord status={humanStatus(task, rows.asksYou?.(task.id) ?? false)} />}
          {task.urgent && <span className="badge urgent">{t.tracker.card.urgent}</span>}
          {waits && <small className="tr-wait">{waits}</small>}
        </span>
        <Cell name={words.executor}>{task.assignee?.name ?? t.tracker.nobody}</Cell>
        <Cell name={words.responsible}>{task.responsible?.name ?? t.tracker.nobody}</Cell>
        <Cell name={words.goal}>{task.goal?.title ?? t.tracker.noGoal}</Cell>
        <Cell name={words.due}>{due ? <span className={due.late ? 'tp-late' : undefined}>{due.text}</span> : ''}</Cell>
      </div>
      {tree.children.length > 0 && (
        <>
          <Fold open={open} onToggle={() => setOpen(!open)}>{words.subtasks(tree.done, tree.total)}</Fold>
          {open && <ul className="tr-rows sub">{tree.children.map(child => <ListRow key={child.task.id} tree={child} rows={rows} sub />)}</ul>}
        </>
      )}
    </li>
  );
}

/* One group of the list: the state in words with how many, the names of the columns, and its tasks; what is over folded. */
function Group({ group, rows }: { group: ListGroup; rows: Rows }) {
  const t = useT();
  const id = useId();
  const over = group.status === 'done' || group.status === 'cancelled';
  const [open, setOpen] = useState(!over);
  const words = t.tracker.list;
  const name = `${t.tracker.groups[group.status]}: ${group.trees.length}`;
  return (
    <section className={`tr-group ${STATE_CLASS[group.status]}`} aria-labelledby={id}>
      <h2 id={id} className="tr-group-head">{over ? <Fold open={open} onToggle={() => setOpen(!open)}>{name}</Fold> : name}</h2>
      {open && (
        <>
          <div className="tr-cells tr-head" aria-hidden="true">
            <span>{words.task}</span><span>{words.executor}</span><span>{words.responsible}</span><span>{words.goal}</span><span>{words.due}</span>
          </div>
          <ul className="tr-rows">{group.trees.map(tree => <ListRow key={tree.task.id} tree={tree} rows={rows} />)}</ul>
        </>
      )}
    </section>
  );
}

/* What a search found, best match first, each task with its state in words. */
export function TrackerFound({ tasks, rows }: { tasks: TaskLine[]; rows: Rows }) {
  return (
    <div className="tr-list">
      <ul className="tr-rows">{tasks.map(task => <ListRow key={task.id} tree={{ task, children: [], done: 0, total: 0, progress: 0 }} rows={rows} sub />)}</ul>
    </div>
  );
}

/* The list: the tasks at the top grouped by their state in words, newest first, their subtasks folded under them. */
export function TrackerList({ tasks, rows, empty }: { tasks: TaskLine[]; rows: Rows; empty: string }) {
  const t = useT();
  const groups = listGroups(tasks, rows.asksYou);
  return (
    <section className="tr-list" aria-label={t.tracker.views.list}>
      {groups.length ? groups.map(group => <Group key={group.status} group={group} rows={rows} />) : <p className="muted">{empty}</p>}
    </section>
  );
}

function BoardCard({ tree, rows, stage }: { tree: TaskTree; rows: Rows; stage: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  const { task } = tree;
  const words = t.tracker.board;
  const due = dueText(t, language, task);
  const waits = waitText(t, task);
  const status = humanStatus(task, rows.asksYou?.(task.id) ?? false);
  return (
    <article className={`tr-card ${STATE_CLASS[status]}${rows.selected === task.id ? ' on' : ''}`} aria-label={`#${task.number} ${task.title}`}>
      <span className="tr-no">#{task.number}</span>
      <h3 className="tr-card-title"><button className="linkish" type="button" onClick={() => rows.onOpenTask(task.id)}>{task.title}</button></h3>
      {(stage || status === 'waitingYou' || status === 'paused' || status === 'stopped') && <StateWord status={status} />}
      <ul className="tr-card-facts">
        <li>{words.executor(task.assignee?.name ?? t.tracker.nobody)}</li>
        <li>{words.responsible(task.responsible?.name ?? t.tracker.nobody)}</li>
        {due && <li className={due.late ? 'tp-late' : undefined}>{words.due(due.text)}</li>}
        {tree.total > 0 && <li>{words.subtasks(tree.done, tree.total)}</li>}
        {waits && <li className="tr-wait">{waits}</li>}
        {task.urgent && <li><span className="badge urgent">{t.tracker.card.urgent}</span></li>}
      </ul>
    </article>
  );
}

function Column({ column, rows }: { column: BoardColumn; rows: Rows }) {
  const t = useT();
  const name = column.stage ? column.stage.name : t.tracker.statuses[column.status!];
  return (
    <section className={`tr-col${column.stage ? ' stage' : ''}`} aria-label={name}>
      <h2 className="tr-col-head">{name} <span className="tr-count">{column.cards.length}</span></h2>
      {column.cards.length ? column.cards.map(card => <BoardCard key={card.task.id} tree={card} rows={rows} stage={!!column.stage} />) : <p className="muted">{t.tracker.board.empty}</p>}
    </section>
  );
}

/* The board: a column per state, or per stage of a chosen pipeline, as many side by side as the width holds, one under
   another where it is narrow. The engine moves the cards; nobody drags them. */
export function TrackerBoard({ tasks, pipeline, cancelled, rows }: { tasks: TaskLine[]; pipeline: Pipeline | null; cancelled: boolean; rows: Rows }) {
  const t = useT();
  const columns = boardColumns(tasks, pipeline, { cancelled }, rows.asksYou);
  return (
    <section className="tr-board" aria-label={t.tracker.views.board}>
      <div className="tr-columns">{columns.map(column => <Column key={column.id} column={column} rows={rows} />)}</div>
    </section>
  );
}

const GOAL_CLASS = { active: 'working', reached: 'done', dropped: 'cancelled' } as const;

function Node({ placed, rows, onOpenGoal }: { placed: Placed; rows: Rows; onOpenGoal: (id: string) => void }) {
  const t = useT();
  const { node, x, y } = placed;
  const style = { left: x, top: y, width: NODE.w, minHeight: NODE.h };
  if (node.kind === 'task') {
    const status = humanStatus(node.task, rows.asksYou?.(node.task.id) ?? false);
    return (
      <button className={`tr-node ${STATE_CLASS[status]}${rows.selected === node.id ? ' on' : ''}`} type="button" style={style} data-node={node.id} onClick={() => rows.onOpenTask(node.id)}>
        <span className="tr-node-title"><b>#{node.task.number}</b> {node.task.title}</span>
        <small>{t.tracker.groups[status]}</small>
      </button>
    );
  }
  if (node.kind === 'goal') {
    return (
      <button className={`tr-node goal ${GOAL_CLASS[node.goal.status]}`} type="button" style={style} data-node={node.id} onClick={() => onOpenGoal(node.id)}>
        <span className="tr-node-title">{node.goal.title}</span>
        <small>{t.tracker.graph.goal}: {t.tracker.goal.statuses[node.goal.status]}</small>
      </button>
    );
  }
  const name = node.kind === 'loose' ? t.tracker.graph.loose : node.kind === 'pipeline' ? node.pipeline.name : node.stage.name;
  return (
    <div className={`tr-node plain${node.kind === 'loose' ? '' : ' stage'}`} style={style} data-node={node.id}>
      <span className="tr-node-title">{name}</span>
      {node.kind !== 'loose' && <small>{t.tracker.graph.count(node.count)}</small>}
    </div>
  );
}

/* A line from the end of one node to the start of another, bent in the middle. */
function wire(a: Placed, b: Placed): string {
  const [x1, y1, x2, y2] = [a.x + NODE.w, a.y + a.h / 2, b.x, b.y + b.h / 2];
  const mid = (x1 + x2) / 2;
  return x2 > x1 ? `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}` : `M${a.x + NODE.w / 2} ${a.y + a.h}C${a.x + NODE.w / 2} ${y2} ${b.x + NODE.w / 2} ${y1} ${b.x + NODE.w / 2} ${b.y}`;
}

/* The least scale a tree opens at, where the words of its nodes still read. */
const READABLE = 0.6;

/* The tree on a canvas like the map's: dots, drag to move, the wheel and the map's zoom bar to zoom, no scrollbars. It opens
   at its natural size, or smaller until all of it fits, but never smaller than its words read at. A node grows to hold its words; the tree is placed again by the
   heights measured before the page is drawn. */
function Canvas({ forest, rows, onOpenGoal }: { forest: GraphNode[]; rows: Rows; onOpenGoal: (id: string) => void }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const layout = layoutTree(forest, id => heights.get(id));
  useLayoutEffect(() => {
    const measured = new Map(heights);
    for (const el of world.current?.querySelectorAll<HTMLElement>('[data-node]') ?? []) {
      const h = el.offsetHeight;
      if (h > 0 && h !== Math.max(NODE.h, heights.get(el.dataset.node!) ?? 0)) measured.set(el.dataset.node!, h);
    }
    if (measured.size !== heights.size || [...measured].some(([id, h]) => heights.get(id) !== h)) setHeights(measured);
  });
  const pan = usePanZoom(box, layout.nodes.length > 0, CANVAS_ZOOM_LIMITS);
  const { setView, touched } = pan;
  const root = layout.nodes.find(p => p.depth === 0);
  const rootMiddle = root ? root.y + root.h / 2 : 0;
  /* all: the whole tree as small as it takes. Otherwise a tree too big for the canvas opens at a size its words read at,
     on the middle of its first root. */
  const place = useCallback((all: boolean) => {
    const el = box.current;
    const [w, h] = [el?.clientWidth ?? 0, el?.clientHeight ?? 0];
    const whole = w && h && layout.width && layout.height ? Math.max(CANVAS_ZOOM_LIMITS.min, Math.min(1, (w - 24) / layout.width, (h - 24) / layout.height)) : 1;
    const k = all ? whole : Math.max(whole, Math.min(1, READABLE));
    const y = k === whole ? 12 : Math.min(12, h / 2 - rootMiddle * k);
    setView({ k, x: Math.max(12, (w - layout.width * k) / 2), y, smooth: false });
  }, [layout.width, layout.height, rootMiddle, setView]);
  const fit = useCallback(() => place(true), [place]);
  /* New work on the tree places it again, until the person moved or zoomed it. */
  useLayoutEffect(() => {
    if (!touched()) place(false);
  }, [place, touched]);
  const at = new Map(layout.nodes.map(p => [p.node.id, p]));
  const ignoreDragged = (e: MouseEvent) => {
    if (!e.detail || !pan.dragged()) return;
    e.preventDefault();
    e.stopPropagation();
  };
  if (!layout.nodes.length) return <p className="muted">{t.tracker.graph.empty}</p>;
  return (
    <div className="tr-canvas">
      <div className="map tr-map" ref={box} role="region" aria-label={t.tracker.graph.canvas} {...pan.handlers} onClickCapture={ignoreDragged}>
        <div className="world" ref={world} style={{ transform: `translate(${pan.view.x}px, ${pan.view.y}px) scale(${pan.view.k})` }}>
          <svg className="wires tr-wires" width={layout.width} height={layout.height} aria-hidden="true">
            {layout.parts.map(p => <path key={`${p.from}-${p.to}`} className="part" d={wire(at.get(p.from)!, at.get(p.to)!)} />)}
            {layout.waits.map(w => {
              const [a, b] = [at.get(w.from)!, at.get(w.to)!];
              return (
                <g key={`${w.from}~${w.to}`} className="wait">
                  <path d={`M${a.x + NODE.w / 2} ${a.y}L${b.x + NODE.w / 2} ${b.y + b.h}`} />
                  <text x={a.x + NODE.w / 2 + 6} y={a.y - 6}>{t.tracker.graph.waitsFor}</text>
                  <text x={b.x + NODE.w / 2 + 6} y={b.y + b.h + 14}>{t.tracker.graph.neededFor}</text>
                </g>
              );
            })}
          </svg>
          {layout.nodes.map(p => <Node key={p.node.id} placed={p} rows={rows} onOpenGoal={onOpenGoal} />)}
        </div>
      </div>
      <ZoomBar k={pan.view.k} onZoom={pan.zoomAt} onFit={fit} />
    </div>
  );
}

const crumbText = (c: Crumb) => (c.kind === 'task' ? `#${c.number} ${c.title}` : c.title);

/* The graph: the way back up as a breadcrumb, the choice of what to draw when a pipeline is chosen, and the canvas. */
export function TrackerGraph({ forest, crumbs, top, onCrumb, rows, onOpenGoal, stages }: {
  forest: GraphNode[]; crumbs: Crumb[]; top: string; onCrumb: (crumb: Crumb | null) => void; rows: Rows; onOpenGoal: (id: string) => void;
  stages?: { on: boolean; onChange: (on: boolean) => void };
}) {
  const t = useT();
  const name = useId();
  const words = t.tracker.graph;
  return (
    <section className="tr-graph" aria-label={t.tracker.views.graph}>
      <nav className="tr-crumbs" aria-label={words.path}>
        <ol>
          <li>{crumbs.length ? <button className="linkish" type="button" onClick={() => onCrumb(null)}>{top}</button> : <span aria-current="page">{top}</span>}</li>
          {crumbs.map((c, i) => (
            <li key={c.id}>{i === crumbs.length - 1 ? <span aria-current="page">{crumbText(c)}</span> : <button className="linkish" type="button" onClick={() => onCrumb(c)}>{crumbText(c)}</button>}</li>
          ))}
        </ol>
      </nav>
      {stages && (
        <fieldset className="segments tr-modes">
          <legend className="sr">{words.mode}</legend>
          {(['work', 'stages'] as const).map(mode => (
            <label key={mode} className={(mode === 'stages') === stages.on ? 'on' : ''}>
              <input type="radio" name={name} checked={(mode === 'stages') === stages.on} onChange={() => stages.onChange(mode === 'stages')} />
              {words.modes[mode]}
            </label>
          ))}
        </fieldset>
      )}
      <Canvas key={stages?.on ? 'stages' : 'work'} forest={forest} rows={rows} onOpenGoal={onOpenGoal} />
    </section>
  );
}
