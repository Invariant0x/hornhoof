import { useEffect, useId, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { errorText, useT, type Messages } from '../i18n';
import { useTasks } from '../tasks';
import type { Org, TaskLine, WaitingRequest } from '../types';
import { TaskPanel } from '../ui/TaskPanel';
import { useOpenAgent } from './AgentWindowContext';

type Waiting = { requests: WaitingRequest[]; onRequestsChanged(): void };
type Props = Waiting & {
  agentId: string;
  org: Org;
  title: string;
  terminal: boolean;
  known: boolean;
  box: RefObject<HTMLElement | null>;
  toolbar: ReactNode;
  children: ReactNode;
  openRequest?: number;
  onMinimizedChange?(minimized: boolean): void;
  onClose(): void;
};

type CurrentTask = { id: string | null; why: string };

function employeeTask(org: Org, agentId: string): string | null {
  return org.departments.flatMap(d => d.employees).find(a => a.id === agentId)?.task?.id ?? null;
}

function orchestratorTask(org: Org, tasks: TaskLine[] | undefined): string | null {
  const id = org.orchestrator?.id;
  if (!id) return null;
  return tasks?.find(task => task.assignee?.id === id)?.id ?? null;
}

function taskListWhy(t: Messages, tasks: TaskLine[] | undefined, failure: unknown): string {
  if (failure !== null) return errorText(t, failure);
  return tasks ? t.window.noTaskWhy : t.common.loading;
}

/* Employees already carry their current task on the map. The orchestrator's tasks come from the task list. */
function useCurrentTask(org: Org, agentId: string, known: boolean): CurrentTask {
  const t = useT();
  const orchestrator = agentId === 'orchestrator';
  const { tasks, failure } = useTasks({ status: 'open', department: null }, orchestrator && known);
  return {
    id: orchestrator ? orchestratorTask(org, tasks) : employeeTask(org, agentId),
    why: orchestrator ? taskListWhy(t, tasks, failure) : t.window.noTaskWhy,
  };
}

function TaskToggle({ current, taskId, onTask, panelId, button }: { current: CurrentTask; taskId: string | null; onTask(id: string | null): void; panelId: string; button: Ref<HTMLButtonElement> }) {
  const t = useT();
  const explanationId = useId();
  return <>
    <button ref={button} className="btn small ghost" type="button" disabled={!current.id} aria-disabled={!current.id} aria-expanded={taskId !== null} aria-controls={panelId} aria-describedby={current.id ? undefined : explanationId} title={current.id ? t.window.task : current.why} onClick={() => onTask(taskId ? null : current.id)}>{current.id ? t.window.task : t.window.noTask}</button>
    {!current.id && <p className="t-why agent-task-explanation" id={explanationId} role="status">{current.why}</p>}
  </>;
}

const windowClasses = (terminal: boolean, hasTask: boolean, full: boolean): string => ['orch', terminal && 'term', hasTask && 'with-agent-task', full && 'fullscreen'].filter(Boolean).join(' ');

function WindowControls({ full, onFull, onMinimize, onClose }: { full: boolean; onFull(): void; onMinimize(): void; onClose(): void }) {
  const t = useT();
  const fullLabel = full ? t.window.restoreSize : t.window.fullScreen;
  return <div className="window-controls">
    <button className="window-close" type="button" aria-label={t.window.close} title={t.window.close} onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg></button>
    <button className="window-minimize" type="button" aria-label={t.window.minimize} title={t.window.minimize} onClick={onMinimize}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" /></svg></button>
    <button className="window-full" type="button" aria-label={fullLabel} title={fullLabel} aria-pressed={full} onClick={onFull}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10V6h4M14 6h4v4M18 14v4h-4M10 18H6v-4" /></svg></button>
  </div>;
}

function AgentTask({ taskId, active, onClose, onOpen, requests, onRequestsChanged }: Waiting & { taskId: string; active: boolean; onClose(): void; onOpen(id: string): void }) {
  const openAgent = useOpenAgent();
  return <div className="agent-task">
    <TaskPanel taskId={taskId} active={active} onClose={onClose} onOpen={onOpen} requests={requests.filter(r => r.task.id === taskId)} onRequestsChanged={onRequestsChanged} onOpenAgent={openAgent} />
  </div>;
}

function useWindowFocus(minimized: boolean, box: RefObject<HTMLElement | null>, restore: RefObject<HTMLButtonElement | null>): void {
  const wasMinimized = useRef(false);
  useEffect(() => {
    if (minimized) restore.current?.focus();
    else if (wasMinimized.current) box.current?.focus();
    wasMinimized.current = minimized;
  }, [minimized, box, restore]);
}

/* Hiding keeps the live terminal, drafts, task and previous size until the window is restored. */
export function AgentWindowLayout({ agentId, org, title, terminal, known, box, toolbar, children, openRequest, onMinimizedChange, onClose, ...waiting }: Props) {
  const t = useT();
  const current = useCurrentTask(org, agentId, known);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [full, setFull] = useState(false);
  const taskButton = useRef<HTMLButtonElement>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const taskPanelId = useId();
  useEffect(() => { setTaskId(null); }, [current.id]);
  useEffect(() => { setMinimized(false); }, [openRequest]);
  useEffect(() => { onMinimizedChange?.(minimized); }, [minimized, onMinimizedChange]);
  useWindowFocus(minimized, box, restoreButton);
  const closeTask = () => { setTaskId(null); taskButton.current?.focus(); };
  const classes = windowClasses(terminal, taskId !== null, full);
  return <>
    <aside ref={box} className={classes} aria-label={title} tabIndex={-1} hidden={minimized}>
      <div className="t-bar">
        <span className="agent-window-title">{title}</span>
        {toolbar}
        <TaskToggle current={current} taskId={taskId} onTask={setTaskId} panelId={taskPanelId} button={taskButton} />
        {taskId && <button className="btn small ghost agent-task-back" type="button" onClick={closeTask}>{t.window.backToTerminal}</button>}
        <WindowControls full={full} onFull={() => setFull(v => !v)} onMinimize={() => setMinimized(true)} onClose={onClose} />
      </div>
      <div className="agent-workspace">
        <div id={taskPanelId} className="agent-task-slot">
          {taskId && <AgentTask key={taskId} taskId={taskId} active={!minimized} onClose={closeTask} onOpen={setTaskId} {...waiting} />}
        </div>
        <div className="agent-conversation">{children}</div>
      </div>
    </aside>
    {minimized && <button ref={restoreButton} className="agent-strip" type="button" aria-label={t.window.restoreAgent(title)} title={t.window.restoreAgent(title)} onClick={() => setMinimized(false)}><span aria-hidden="true">{title}</span></button>}
  </>;
}
