import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { useLanguage, useT } from '../i18n';
import { humanStatus, isClosed, taskWaits, type Asks, type TaskTree } from '../task-tree';
import { boardColumns, doerOf, layoutTree, listGroups, NODE, type BoardColumn, type Crumb, type GraphNode, type ListGroup, type Placed } from '../tracker';
import type { GoalView, Pipeline, PipelineStage, TaskLine } from '../types';
import { CANVAS_ZOOM_LIMITS, usePanZoom, ZoomBar } from './canvas';
import { dueText } from './tracker-words';
import { routePath } from '../routes';
import { TrackerIcon, type Program } from './icons';
import { Progress } from './TaskBoard';
import { DepartmentMark, ExecutorMark, PersonMark } from './TrackerMarks';
import { WorkerMark } from './WorkerMark';
import { QuestionButton, STATE_CLASS, StateWord, WaitLine } from './TaskActivity';
import { GOAL_CLASS, goalProgress } from './GoalPanel';

/* How a view opens a task's card and marks the open one. asksYou: an open question on a task is the person's to answer. */
export type Rows = { selected: string | null; onOpenTask: (id: string) => void; asksYou?: Asks; questionAt?: (id: string) => string | undefined; onOpenGoal?: (id: string) => void; placeName?: (place: TaskLine['department']) => string; departmentTemplate?: (id: string) => string | null | undefined; programOf?: (id: string) => Program | null; turnkeyOf?: (id: string) => boolean | undefined; stageOwner?: (stage: PipelineStage) => string | undefined };

/* A value of a row with its name, which shows beside it only where the row is too narrow for the names above the list. The
   pair keeps its own direction, so "Executor: Hana" reads in that order right to left, and so does the value alone, so the
   parts of a date and the dot of a name stay in place. */
function Cell({ name, person, children }: { name: string; person?: boolean; children: ReactNode }) {
  return (
    <span className={person ? 'tr-cell tr-cell-person' : 'tr-cell'} dir="auto">
      <span className="tr-k">{name}</span>
      <span className="tr-v" dir="auto">{children}</span>
    </span>
  );
}

type Relations = ReadonlyMap<number, TaskLine[]>;

function relationsOf(tasks: TaskLine[]): Relations {
  const needed = new Map<number, TaskLine[]>();
  for (const task of tasks) {
    if (isClosed(task)) continue;
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
  const [open, setOpen] = useState(true);
  const childrenId = useId();
  const hasChildren = showSubtasks && tree.children.length > 0;
  const { task } = tree;
  const words = t.tracker.list;
  const due = dueText(t, language, task);
  const asksYou = rows.asksYou?.(task.id) ?? false;
  const status = humanStatus(task, asksYou);
  const waits = taskWaits(task);
  const prerequisites = new Set(waits.flatMap(wait => wait.kind === 'after' && wait.reason ? [wait.reason] : []));
  const needed = (relations.get(task.number) ?? []).filter(other => other.department && other.department.id !== task.department?.id);
  /* A subtask serves its task's goal, which the task's row already names. */
  const goal = depth === 0 ? task.goal : null;
  const executor = doerOf(task);
  const route = task.echelons;
  const ghostStage = route.phase === 'active' && route.stage && route.oneShot?.[route.stage];
  return (
    <li className="tr-row" aria-label={`#${task.number} ${task.title}`}>
      <div className={`tr-cells tr-row-line${rows.selected === task.id ? ' on' : ''}`} style={{ '--tr-depth': depth } as CSSProperties}>
        <div className="tr-task-name">
          <div className="tr-name">
            {hasChildren && (
              <button className="tr-row-caret" type="button" aria-expanded={open} aria-controls={childrenId}
                aria-label={words.subtasks(tree.done, tree.total)} title={words.subtasks(tree.done, tree.total)} onClick={() => setOpen(!open)}>
                <span className="tr-caret" aria-hidden="true" />
              </button>
            )}
            <span className={`tr-status-dot ${STATE_CLASS[status]}`} role="img" aria-label={t.tracker.groups[status]} />
            <span className="tr-line">
              <button className="linkish tr-title" type="button" dir="auto" onClick={() => rows.onOpenTask(task.id)}>{task.title}</button>
              {tree.total > 0 && <span className="tr-branch-count" title={words.subtasks(tree.done, tree.total)}><TrackerIcon name="branch" />{tree.total}</span>}
              <span className="tr-no" dir="ltr">#{task.number}</span>
              {(asksYou || waits[0]?.kind !== 'after') && <WaitLine task={task} asksYou={status === 'waitingYou'} questionAt={rows.questionAt?.(task.id)} />}
              {task.urgent && <span className="badge urgent">{t.tracker.card.urgent}</span>}
              {[...prerequisites].map(ref => <span className="tr-relation" key={ref}>{t.tracker.wait.after(ref)}</span>)}
              {needed.map(other => {
                const department = other.department!;
                const name = rows.placeName?.(department) ?? department.name;
                return <small className="tr-relation" key={other.id}><DepartmentMark id={department.id} name={name} template={rows.departmentTemplate?.(department.id)} /><span>{words.neededFor(other.number, name)}</span></small>;
              })}
              {asksYou && status !== 'done' && status !== 'cancelled' && <QuestionButton onOpen={() => rows.onOpenTask(task.id)} />}
            </span>
          </div>
        </div>
        <Cell name={words.executor} person>
          {executor ? <ExecutorMark agent={executor} program={rows.programOf?.(executor.id)} turnkey={rows.turnkeyOf?.(executor.id)} /> : t.tracker.nobody}
          {ghostStage && <WorkerMark kind="ghost" className="tr-stage-ghost" />}
        </Cell>
        <Cell name={words.responsible} person>{task.responsible ? <PersonMark person={task.responsible} /> : t.tracker.nobody}</Cell>
        <Cell name={words.goal}>
          {goal && (
            <a className="linkish tr-goal-link" dir="auto" href={routePath({ kind: 'tasks', card: 'goal', id: goal.id })} onClick={e => {
              if (!rows.onOpenGoal || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              rows.onOpenGoal(goal.id);
            }}>{goal.title}</a>
          )}
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

/* The names of the columns, once, under the first group's pill. */
function ListHead() {
  const t = useT();
  const words = t.tracker.list;
  return (
    <div className="tr-cells tr-head" aria-hidden="true">
      <span>{words.task}</span><span>{words.executor}</span><span>{words.responsible}</span><span>{words.goal}</span><span>{words.due}</span>
    </div>
  );
}

/* A status as a coloured pill with its count; the first group carries the names of the columns. Every group can fold. */
function Group({ group, rows, relations, showSubtasks, head }: { group: ListGroup; rows: Rows; relations: Relations; showSubtasks: boolean; head: boolean }) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(group.status !== 'cancelled');
  const label = group.status === 'waitingPerson' ? t.tracker.statuses.waits : group.status === 'failure' ? t.tracker.statuses.failure : t.tracker.groups[group.status];
  const state = group.status === 'waitingPerson' ? 'waiting' : STATE_CLASS[group.status];
  const heading = t.tracker.list.group(label, group.trees.length);
  return (
    <section className={`tr-group ${state}`} aria-label={heading}>
      <h2 className="tr-group-head" aria-label={heading}>
        <button className="tr-group-toggle" type="button" aria-expanded={open} aria-controls={`${id}-rows`} aria-label={heading} onClick={() => setOpen(!open)}>
          <span className={`tr-status-pill ${state}`}>{label}</span>
          <span className="tr-count">{group.trees.length}</span>
        </button>
      </h2>
      {head && <ListHead />}
      <div id={`${id}-rows`} hidden={!open}>
        {open && <ul className="tr-rows">{group.trees.map(tree => <ListRow key={tree.task.id} tree={tree} rows={rows} relations={relations} showSubtasks={showSubtasks} />)}</ul>}
      </div>
    </section>
  );
}

/* What a search found, best match first, each task with its state in words. */
export function TrackerFound({ tasks, all, rows }: { tasks: TaskLine[]; all: TaskLine[]; rows: Rows }) {
  const relations = relationsOf(all);
  return (
    <div className="tr-list">
      <div className="tr-list-grid">
        <ListHead />
        <ul className="tr-rows">{tasks.map(task => <ListRow key={task.id} tree={{ task, children: [], done: 0, total: 0, progress: 0 }} rows={rows} relations={relations} />)}</ul>
      </div>
    </div>
  );
}

export function TrackerList({ tasks, all, rows, empty, showSubtasks = true }: { tasks: TaskLine[]; all: TaskLine[]; rows: Rows; empty: string; showSubtasks?: boolean }) {
  const t = useT();
  const groups = listGroups(tasks, rows.asksYou, all);
  const relations = relationsOf(all);
  return (
    <section className="tr-list" aria-label={t.tracker.views.list}>
      {groups.length ? (
        <div className="tr-list-grid">
          {groups.map((group, i) => <Group key={group.status} group={group} rows={rows} relations={relations} showSubtasks={showSubtasks} head={i === 0} />)}
        </div>
      ) : <p className="muted">{empty}</p>}
    </section>
  );
}

/* The mockup's .bcard: the title, then the employee's and the person's avatars, the due date, the subtasks done of all and
   what it waits for. */
function BoardCard({ tree, rows }: { tree: TaskTree; rows: Rows }) {
  const t = useT();
  const { language } = useLanguage();
  const { task } = tree;
  const due = dueText(t, language, task);
  const asksYou = rows.asksYou?.(task.id) ?? false;
  const status = humanStatus(task, asksYou);
  const executor = doerOf(task);
  return (
    <article className={`tr-card ${STATE_CLASS[status]}${rows.selected === task.id ? ' on' : ''}`} aria-label={`#${task.number} ${task.title}`}>
      <div className="tr-card-body">
        <h3 className="tr-card-title">
          <button className="linkish" type="button" dir="auto" onClick={() => rows.onOpenTask(task.id)}>{task.title}</button>
        </h3>
        {(status === 'waitingYou' || status === 'paused' || status === 'stopped') && <StateWord status={status} />}
        <div className="tr-card-meta">
          {(executor || task.responsible) && (
            <span className="tr-avatars">
              {executor && <ExecutorMark agent={executor} program={rows.programOf?.(executor.id)} turnkey={rows.turnkeyOf?.(executor.id)} />}
              {task.responsible && <PersonMark person={task.responsible} />}
            </span>
          )}
          {due && <span className={due.late ? 'tp-late' : undefined} dir="auto">{due.text}</span>}
          {tree.total > 0 && <span className="tr-branch-count" title={t.tracker.list.subtasks(tree.done, tree.total)}><TrackerIcon name="branch" />{t.tracker.board.subtasks(tree.done, tree.total)}</span>}
          <WaitLine task={task} asksYou={status === 'waitingYou'} questionAt={rows.questionAt?.(task.id)} hasStatus />
          {task.urgent && <span className="badge urgent">{t.tracker.card.urgent}</span>}
        </div>
        {asksYou && status !== 'done' && status !== 'cancelled' && <div className="entry-actions"><QuestionButton onOpen={() => rows.onOpenTask(task.id)} /></div>}
      </div>
    </article>
  );
}

/* The status a column's pill takes its colour from: its own, or for a stage the colour of work going on. */
const columnState = (column: BoardColumn) => (column.stage ? 'working' : STATE_CLASS[column.status === 'waits' ? 'waiting' : column.status!]);

/* The mockup's .bcol: a pill with the column's name, its count and, for a stage, the role that holds it. */
function Column({ column, rows }: { column: BoardColumn; rows: Rows }) {
  const t = useT();
  const name = column.stage ? column.stage.name : t.tracker.statuses[column.status!];
  const who = column.stage ? rows.stageOwner?.(column.stage) : undefined;
  return (
    <section className="tr-col" aria-label={name}>
      <h2 className="tr-col-head">
        <span className={`tr-status-pill ${columnState(column)}`}>{name}</span>{' '}
        <span className="tr-count">{column.cards.length}</span>
        {who && <>{' '}<span className="tr-col-who" dir="auto">{who}</span></>}
      </h2>
      {column.cards.length ? column.cards.map(card => <BoardCard key={card.task.id} tree={card} rows={rows} />) : <p className="muted">{t.tracker.board.empty}</p>}
    </section>
  );
}

type GoalTree = { goal: GoalView; children: GoalTree[] };

function GoalProgressCell({ goal }: { goal: GoalView }) {
  const t = useT();
  if (goal.target !== null) {
    const now = goal.current ?? 0;
    return <Progress done={Math.min(now, goal.target)} total={goal.target} label={t.tracker.card.target(now, goal.target, goal.unit)} />;
  }
  return goal.total > 0 ? <Progress done={goal.done} total={goal.total} label={t.tracker.card.tasksDone(goal.done, goal.total)} /> : null;
}

/* A goal as a row of the list: its mark and title, how far it is, who answers for it and its date; its smaller goals under it. */
function GoalRow({ tree, onOpenGoal, depth = 0 }: { tree: GoalTree; onOpenGoal: (id: string) => void; depth?: number }) {
  const t = useT();
  const { language } = useLanguage();
  const [open, setOpen] = useState(true);
  const childrenId = useId();
  const { goal } = tree;
  const words = t.tracker.list;
  const due = dueText(t, language, { dueAt: goal.dueAt, status: goal.status === 'active' ? 'open' : 'done' });
  return (
    <li className="tr-row" aria-label={goal.title}>
      <div className="tr-cells tr-row-line" style={{ '--tr-depth': depth } as CSSProperties}>
        <div className="tr-task-name">
          <div className="tr-name">
            {tree.children.length > 0 && (
              <button className="tr-row-caret" type="button" aria-expanded={open} aria-controls={childrenId} aria-label={words.parts} title={words.parts} onClick={() => setOpen(!open)}>
                <span className="tr-caret" aria-hidden="true" />
              </button>
            )}
            <span className="tr-goal-mark" aria-hidden="true"><TrackerIcon name="mine" /></span>
            <span className="tr-line">
              <a className="linkish tr-title tr-goal-title" dir="auto" href={routePath({ kind: 'tasks', card: 'goal', id: goal.id })} onClick={e => {
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onOpenGoal(goal.id);
              }}>{goal.title}</a>
              <span className="tr-no" dir="ltr">#{goal.number}</span>
            </span>
          </div>
        </div>
        <span className="tr-cell tr-cell-wide" dir="auto"><span className="tr-k">{words.progress}</span><span className="tr-v"><GoalProgressCell goal={goal} /></span></span>
        <Cell name={words.responsible} person><PersonMark person={goal.responsible} /></Cell>
        <Cell name={words.due}>{due && <span className={due.late ? 'tp-late' : undefined}>{due.text}</span>}</Cell>
      </div>
      {tree.children.length > 0 && (
        <ul id={childrenId} className="tr-rows sub" hidden={!open}>
          {open && tree.children.map(child => <GoalRow key={child.goal.id} tree={child} onOpenGoal={onOpenGoal} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}

/* The goals page: the goals given as the list's rows, the smaller ones under the goal they are part of, grouped by their
   state under the same pills, the names of the columns under the first pill. */
export function TrackerGoals({ goals, label, empty, onOpenGoal }: { goals: GoalView[]; label: string; empty: string; onOpenGoal: (id: string) => void }) {
  const t = useT();
  const words = t.tracker.list;
  const ids = new Set(goals.map(g => g.id));
  const byNumber = (a: GoalView, b: GoalView) => a.number - b.number;
  const grow = (goal: GoalView): GoalTree => ({ goal, children: goals.filter(g => g.parentId === goal.id).sort(byNumber).map(grow) });
  const top = goals.filter(g => !g.parentId || !ids.has(g.parentId)).sort(byNumber).map(grow);
  const groups = (['active', 'reached'] as const).map(status => ({ status, trees: top.filter(tree => tree.goal.status === status) })).filter(g => g.trees.length);
  return (
    <section className="tr-list tr-goals-page" aria-label={label}>
      {groups.length ? (
        <div className="tr-list-grid">
          {groups.map((group, i) => {
            const name = t.tracker.goal.statuses[group.status]!;
            const heading = words.group(name, group.trees.length);
            const state = group.status === 'active' ? 'working' : 'done';
            return (
              <section key={group.status} className={`tr-group ${state}`} aria-label={heading}>
                <h2 className="tr-group-head" aria-label={heading}>
                  <span className="tr-group-toggle"><span className={`tr-status-pill ${state}`}>{name}</span><span className="tr-count">{group.trees.length}</span></span>
                </h2>
                {i === 0 && (
                  <div className="tr-cells tr-head" aria-hidden="true">
                    <span>{words.task}</span><span className="tr-cell-wide">{words.progress}</span><span>{words.responsible}</span><span>{words.due}</span>
                  </div>
                )}
                <div><ul className="tr-rows">{group.trees.map(tree => <GoalRow key={tree.goal.id} tree={tree} onOpenGoal={onOpenGoal} />)}</ul></div>
              </section>
            );
          })}
        </div>
      ) : <p className="muted">{empty}</p>}
    </section>
  );
}

/* The board keeps its state or stage columns together, in one row when they fit and in order down the page otherwise. */
export function TrackerBoard({ tasks, all, pipeline, cancelled, rows }: { tasks: TaskLine[]; all: TaskLine[]; pipeline: Pipeline | null; cancelled: boolean; rows: Rows }) {
  const t = useT();
  const columns = boardColumns(tasks, pipeline, { cancelled, all }, rows.asksYou);
  const group = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = group.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = width >= columns.length * 160 + (columns.length - 1) * 10 ? 'row' : 'stack';
  return (
    <section className="tr-board" aria-label={t.tracker.views.board}>
      <div className="tr-columns" ref={group} data-layout={layout} style={{ '--tr-column-count': columns.length } as CSSProperties}>
        {columns.map(column => <Column key={column.id} column={column} rows={rows} />)}
      </div>
    </section>
  );
}

/* A node as the mockup draws it: a strip of its status at the start, its number and title, and a line of what it is at. A
   goal has its mark, its progress in words and a thin bar of it; a task its status in words and who does it, or what it
   waits for. */
function Node({ placed, rows, onOpenGoal }: { placed: Placed; rows: Rows; onOpenGoal: (id: string) => void }) {
  const t = useT();
  const { language } = useLanguage();
  const { node, x, y } = placed;
  const style = { left: x, top: y, width: NODE.w, minHeight: NODE.h };
  if (node.kind === 'task') {
    const { task } = node;
    const status = humanStatus(task, rows.asksYou?.(task.id) ?? false);
    const waits = taskWaits(task).length > 0;
    const doer = doerOf(task);
    return (
      <button className={`tr-node ${STATE_CLASS[status]}${rows.selected === node.id ? ' on' : ''}`} type="button" style={style} data-node={node.id} onClick={() => rows.onOpenTask(node.id)}>
        <span className="tr-node-title" dir="auto"><span className="tr-node-no">#{task.number}</span> {task.title}</span>
        <small className="tr-node-meta" dir="auto">
          {t.tracker.groups[status]}
          {!waits && doer && ` · ${doer.name}`}
          {waits && <>{' · '}<WaitLine task={task} asksYou={status === 'waitingYou'} questionAt={rows.questionAt?.(node.id)} /></>}
        </small>
      </button>
    );
  }
  if (node.kind === 'goal') {
    const { goal } = node;
    const progress = goalProgress(t, goal);
    const due = dueText(t, language, { dueAt: goal.dueAt, status: goal.status === 'active' ? 'open' : 'done' });
    const meta = [goal.status === 'active' ? null : t.tracker.goal.statuses[goal.status], progress?.label, due && t.tracker.graph.until(due.text)].filter(Boolean).join(' · ');
    return (
      <button className={`tr-node goal ${GOAL_CLASS[goal.status]}`} type="button" style={style} data-node={node.id} onClick={() => onOpenGoal(node.id)}>
        <span className="tr-node-title" dir="auto"><span className="tr-node-mark" aria-hidden="true">◎</span> {goal.title}</span>
        <small className="tr-node-meta" dir="auto">{meta || t.tracker.goal.statuses[goal.status]}</small>
        {progress && progress.total > 0 && <span className="tr-node-bar" aria-hidden="true"><i style={{ inlineSize: `${(progress.done * 100) / progress.total}%` }} /></span>}
      </button>
    );
  }
  const name = node.kind === 'loose' ? t.tracker.graph.loose : node.kind === 'pipeline' ? node.pipeline.name : node.stage.name;
  return (
    <div className="tr-node plain" style={style} data-node={node.id}>
      <span className="tr-node-title" dir="auto">{name}</span>
      {node.kind !== 'loose' && <small className="tr-node-meta">{t.tracker.graph.count(node.count)}</small>}
    </div>
  );
}

/* A line from the end of one node to the start of another, bent in the middle. */
function wire(a: Placed, b: Placed): string {
  const [x1, y1, x2, y2] = [a.x + NODE.w, a.y + a.h / 2, b.x, b.y + b.h / 2];
  const mid = (x1 + x2) / 2;
  return x2 > x1 ? `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}` : `M${a.x + NODE.w / 2} ${a.y + a.h}C${a.x + NODE.w / 2} ${y2} ${b.x + NODE.w / 2} ${y1} ${b.x + NODE.w / 2} ${b.y}`;
}

/* A wait goes out from the end of the waiting node to a lane of its own past the whole tree, along it, and back to the end
   of the node it waits for, where its arrow points. */
const LANE = { first: 24, step: 14, room: 70 };
function waitWire(a: Placed, b: Placed, lane: number): string {
  const [y1, y2] = [Math.round(a.y + a.h / 2 + 6), Math.round(b.y + b.h / 2 + 6)];
  return `M${a.x + NODE.w} ${y1}H${lane}V${y2}H${b.x + NODE.w + 2}`;
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
  /* A font that arrives after the nodes are drawn changes their heights: they are measured again then. */
  const [, setFontsIn] = useState(0);
  useEffect(() => {
    const fonts = document.fonts as FontFaceSet | undefined;
    const again = () => setFontsIn(n => n + 1);
    fonts?.addEventListener?.('loadingdone', again);
    return () => fonts?.removeEventListener?.('loadingdone', again);
  }, []);
  useLayoutEffect(() => {
    const measured = new Map(heights);
    for (const el of world.current?.querySelectorAll<HTMLElement>('[data-node]') ?? []) {
      const h = el.offsetHeight;
      if (h > 0 && h !== Math.max(NODE.h, heights.get(el.dataset.node!) ?? 0)) measured.set(el.dataset.node!, h);
    }
    if (measured.size !== heights.size || [...measured].some(([id, h]) => heights.get(id) !== h)) setHeights(measured);
  });
  const pan = usePanZoom(box, layout.nodes.length > 0, CANVAS_ZOOM_LIMITS);
  const marker = useId();
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
  const right = Math.max(...layout.nodes.map(p => p.x + NODE.w));
  const width = Math.max(layout.width, layout.waits.length ? right + LANE.first + layout.waits.length * LANE.step + LANE.room : 0);
  const arrow = `tr-arrow-${marker.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const legend = t.tracker.graph.legend;
  return (
    <>
      <div className="tr-canvas">
        <div className="map tr-map" ref={box} role="region" aria-label={t.tracker.graph.canvas} {...pan.handlers} onClickCapture={ignoreDragged}>
          <div className="world" ref={world} style={{ transform: `translate(${pan.view.x}px, ${pan.view.y}px) scale(${pan.view.k})` }}>
            <svg className="wires tr-wires" width={width} height={layout.height} aria-hidden="true">
              <defs>
                <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" /></marker>
              </defs>
              {layout.parts.map(p => <path key={`${p.from}-${p.to}`} className="part" d={wire(at.get(p.from)!, at.get(p.to)!)} />)}
              {layout.waits.map((w, i) => {
                const [a, b] = [at.get(w.from)!, at.get(w.to)!];
                return (
                  <g key={`${w.from}~${w.to}`} className="wait">
                    <path d={waitWire(a, b, right + LANE.first + i * LANE.step)} markerEnd={`url(#${arrow})`} />
                    <text x={a.x + NODE.w + 6} y={Math.round(a.y + a.h / 2 + 6) - 5}>{`${t.tracker.graph.waitsFor} →`}</text>
                  </g>
                );
              })}
            </svg>
            {layout.nodes.map(p => <Node key={p.node.id} placed={p} rows={rows} onOpenGoal={onOpenGoal} />)}
          </div>
        </div>
        <ZoomBar k={pan.view.k} onZoom={pan.zoomAt} onFit={fit} />
      </div>
      <ul className="tr-legend" aria-label={legend.label}>
        <li>{legend.parts}</li>
        <li className="wait">{legend.waits}</li>
        <li>{legend.strip}</li>
      </ul>
    </>
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
  /* Re-rooted under a goal: a way straight back to the whole goal at the top. */
  const up = crumbs.length > 1 && crumbs[0]!.kind === 'goal' ? crumbs[0]! : null;
  return (
    <section className="tr-graph" aria-label={t.tracker.views.graph}>
      <div className="tr-gtop">
        <nav className="tr-crumbs" aria-label={words.path}>
          <span className="tr-crumbs-label" aria-hidden="true">{words.from}</span>
          <ol>
            <li>{crumbs.length ? <button className="linkish" type="button" onClick={() => onCrumb(null)}>{top}</button> : <span aria-current="page">{top}</span>}</li>
            {crumbs.map((c, i) => (
              <li key={c.id}>{i === crumbs.length - 1 ? <span aria-current="page">{crumbText(c)}</span> : <button className="linkish" type="button" onClick={() => onCrumb(c)}>{crumbText(c)}</button>}</li>
            ))}
          </ol>
        </nav>
        {up && <button className="gbtn" type="button" onClick={() => onCrumb(up)}>{words.whole}</button>}
      </div>
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
