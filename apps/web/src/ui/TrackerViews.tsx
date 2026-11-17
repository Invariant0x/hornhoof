import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { useLanguage, useT } from '../i18n';
import { humanStatus, type Asks, type HumanStatus } from '../task-board';
import { boardColumns, doerOf, layoutTree, listGroups, NODE, type BoardColumn, type Crumb, type GraphNode, type ListGroup, type Placed, type TaskTree } from '../tracker';
import type { Pipeline, TaskLine } from '../types';
import { CANVAS_ZOOM_LIMITS, usePanZoom, ZoomBar } from './canvas';
import { dueText, sinceSeconds, spanText, taskWaits, waitLabel, waitText } from './tracker-words';
import { routePath } from '../routes';
import { TrackerIcon, type Program } from './icons';
import { DepartmentMark, ExecutorMark, PersonMark, PriorityWord } from './TrackerMarks';

/* How a view opens a task's card and marks the open one. asksYou: an open question on a task is the person's to answer. */
export type Rows = { selected: string | null; onOpenTask: (id: string) => void; asksYou?: Asks; onOpenGoal?: (id: string) => void; placeName?: (place: TaskLine['department']) => string; departmentTemplate?: (id: string) => string | null | undefined; programOf?: (id: string) => Program | null };

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

type Relations = ReadonlyMap<number, TaskLine[]>;

function relationsOf(tasks: TaskLine[]): Relations {
  const needed = new Map<number, TaskLine[]>();
  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'cancelled') continue;
    for (const number of task.waitsFor) {
      const list = needed.get(number);
      if (list) list.push(task);
      else needed.set(number, [task]);
    }
  }
  return needed;
}

function ListRow({ tree, rows, relations, depth = 0, showSubtasks = true }: { tree: TaskTree; rows: Rows; relations: Relations; depth?: number; showSubtasks?: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  const [open, setOpen] = useState(false);
  const childrenId = useId();
  const hasChildren = showSubtasks && tree.children.length > 0;
  const { task } = tree;
  const words = t.tracker.list;
  const due = dueText(t, language, task);
  const status = humanStatus(task, rows.asksYou?.(task.id) ?? false);
  const waits = taskWaits(task);
  const prerequisites = new Set(waits.flatMap(wait => wait.kind === 'after' && wait.reason ? [wait.reason] : []));
  const needed = (relations.get(task.number) ?? []).filter(other => other.department && other.department.id !== task.department?.id);
  const details = waits.filter(wait => wait.kind !== 'after' || !wait.reason);
  const goal = task.goal;
  const executor = doerOf(task);
  return (
    <li className="tr-row" aria-label={`#${task.number} ${task.title}`}>
      <div className={`tr-cells tr-row-line${rows.selected === task.id ? ' on' : ''}`}>
        <div className="tr-task-name" style={{ '--tr-depth': depth } as CSSProperties}>
          <div className="tr-name">
            {hasChildren && (
              <button className="tr-row-caret" type="button" aria-expanded={open} aria-controls={childrenId}
                aria-label={words.subtasks(tree.done, tree.total)} title={words.subtasks(tree.done, tree.total)} onClick={() => setOpen(!open)}>
                <TrackerIcon name="chevron" />
              </button>
            )}
            <span className={`tr-status-dot ${STATE_CLASS[status]}`} role="img" aria-label={t.tracker.groups[status]} />
            <button className="linkish tr-title" type="button" onClick={() => rows.onOpenTask(task.id)}>{task.title}</button>
            {tree.total > 0 && <span className="tr-no tr-branch-count" title={words.subtasks(tree.done, tree.total)}><TrackerIcon name="branch" />{tree.total}</span>}
            <span className="tr-no">#{task.number}</span>
            {task.urgent && <span className="badge urgent">{t.tracker.card.urgent}</span>}
            {[...prerequisites].map(ref => <span className="tr-relation" key={ref}>{words.waitsFor(ref)}</span>)}
          </div>
          {details.map((wait, i) => (
            <small className="tr-wait" key={i} dir="auto">
              {wait.kind === 'person' && wait.who?.kind === 'person'
                ? words.waitsForPerson(wait.who.name, spanText(t, sinceSeconds(wait.since)))
                : waitLabel(t, task, wait)}
            </small>
          ))}
          {needed.map(other => {
            const department = other.department!;
            const name = rows.placeName?.(department) ?? department.name;
            return <small className="tr-relation" key={other.id}><DepartmentMark id={department.id} name={name} template={rows.departmentTemplate?.(department.id)} /><span>{words.neededFor(other.number, name)}</span></small>;
          })}
        </div>
        <Cell name={words.executor}>{executor ? <ExecutorMark agent={executor} program={rows.programOf?.(executor.id)} /> : t.tracker.nobody}</Cell>
        <Cell name={words.responsible}>{task.responsible ? <PersonMark person={task.responsible} /> : t.tracker.nobody}</Cell>
        <Cell name={t.tracker.priority.label}><PriorityWord task={task} /></Cell>
        <Cell name={words.goal}>
          {goal ? (
            <a className="linkish tr-goal-link" href={routePath({ kind: 'tasks', card: 'goal', id: goal.id })} onClick={e => {
              if (!rows.onOpenGoal || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              rows.onOpenGoal(goal.id);
            }}>{goal.title}</a>
          ) : t.tracker.noGoal}
        </Cell>
        <Cell name={words.due}>{due && <span className={due.late ? 'tp-late' : undefined}>{due.text}</span>}</Cell>
      </div>
      {hasChildren && (
        <ul id={childrenId} className="tr-rows sub" hidden={!open}>
          {open && tree.children.map(child => <ListRow key={child.task.id} tree={child} rows={rows} relations={relations} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}

function ListHead() {
  const t = useT();
  const words = t.tracker.list;
  return (
    <div className="tr-cells tr-head" aria-hidden="true">
      <span>{words.task}</span><span>{words.executor}</span><span>{words.responsible}</span><span>{t.tracker.priority.label}</span><span>{words.goal}</span><span>{words.due}</span>
    </div>
  );
}

/* The count is for the top-level tasks in this status. Every group can fold. */
function Group({ group, rows, relations, onAddTask, showSubtasks }: { group: ListGroup; rows: Rows; relations: Relations; showSubtasks: boolean; onAddTask?: () => void }) {
  const t = useT();
  const id = useId();
  const over = group.status === 'done' || group.status === 'cancelled';
  const [open, setOpen] = useState(group.status !== 'cancelled');
  const label = group.status === 'waitingPerson' ? t.tracker.list.waitingPerson : t.tracker.groups[group.status];
  const state = group.status === 'waitingPerson' ? 'waiting' : STATE_CLASS[group.status];
  const heading = t.tracker.list.group(label, group.trees.length);
  return (
    <section className={`tr-group ${state}`} aria-label={heading}>
      <h2 className="tr-group-head" aria-label={heading}>
        <button className="tr-group-toggle" type="button" aria-expanded={open} aria-controls={`${id}-rows`} aria-label={heading} onClick={() => setOpen(!open)}>
          <span className="tr-group-arrow" aria-hidden="true" />
          <span className="tr-status-pill">{label}</span>
          <span className="tr-count">{group.trees.length}</span>
        </button>
      </h2>
      <div id={`${id}-rows`} hidden={!open}>
        {open && <ul className="tr-rows">{group.trees.map(tree => <ListRow key={tree.task.id} tree={tree} rows={rows} relations={relations} showSubtasks={showSubtasks} />)}</ul>}
        {!over && onAddTask && <button className="tr-add-task" type="button" aria-label={t.tracker.list.addTask} onClick={onAddTask}>+ {t.tracker.list.addTask}</button>}
      </div>
    </section>
  );
}

/* What a search found, best match first, each task with its state in words. */
export function TrackerFound({ tasks, all, rows }: { tasks: TaskLine[]; all: TaskLine[]; rows: Rows }) {
  const relations = relationsOf(all);
  return (
    <div className="tr-list">
      <ListHead />
      <ul className="tr-rows">{tasks.map(task => <ListRow key={task.id} tree={{ task, children: [], done: 0, total: 0, progress: 0 }} rows={rows} relations={relations} />)}</ul>
    </div>
  );
}

export function TrackerList({ tasks, all, rows, empty, onAddTask, showSubtasks = true }: { tasks: TaskLine[]; all: TaskLine[]; rows: Rows; empty: string; onAddTask?: () => void; showSubtasks?: boolean }) {
  const t = useT();
  const groups = listGroups(tasks, rows.asksYou, all);
  const relations = relationsOf(all);
  return (
    <section className="tr-list" aria-label={t.tracker.views.list}>
      {groups.length ? (
        <>
          <ListHead />
          {groups.map(group => <Group key={group.status} group={group} rows={rows} relations={relations} onAddTask={onAddTask} showSubtasks={showSubtasks} />)}
        </>
      ) : <p className="muted">{empty}</p>}
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
        {/* Each fact is a whole phrase in its own direction, so its dot and the parts of its date stay in place in RTL. */}
        <li dir="auto">{words.executor(doerOf(task)?.name ?? t.tracker.nobody)}</li>
        <li dir="auto">{words.responsible(task.responsible?.name ?? t.tracker.nobody)}</li>
        {due && <li className={due.late ? 'tp-late' : undefined} dir="auto">{words.due(due.text)}</li>}
        {tree.total > 0 && <li dir="auto">{words.subtasks(tree.done, tree.total)}</li>}
        {waits && <li className="tr-wait" dir="auto">{waits}</li>}
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
   another where it is narrow, each card's subtasks counted over all the work. The engine moves the cards; nobody drags them. */
export function TrackerBoard({ tasks, all, pipeline, cancelled, rows }: { tasks: TaskLine[]; all: TaskLine[]; pipeline: Pipeline | null; cancelled: boolean; rows: Rows }) {
  const t = useT();
  const columns = boardColumns(tasks, pipeline, { cancelled, all }, rows.asksYou);
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
      {/* A canvas of its own for each place, root and mode drawn: one moved by hand never hides the next root off the screen,
          while new work on the same tree keeps it where the person put it. */}
      <Canvas key={JSON.stringify([stages?.on ? 'stages' : 'work', top, crumbs.map(c => c.id)])} forest={forest} rows={rows} onOpenGoal={onOpenGoal} />
    </section>
  );
}
