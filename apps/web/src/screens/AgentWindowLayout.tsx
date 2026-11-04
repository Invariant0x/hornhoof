import { useEffect, useId, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { useT } from '../i18n';
import type { AgentCardView, WaitingRequest } from '../types';
import { TaskPanel } from '../ui/TaskPanel';
import { useOpenAgent } from './AgentWindowContext';

type Waiting = { requests: WaitingRequest[]; onRequestsChanged(): void };
type Props = Waiting & {
  currentTask: AgentCardView['currentTask'] | undefined;
  title: string;
  terminal: boolean;
  box: RefObject<HTMLElement | null>;
  toolbar: ReactNode;
  children: ReactNode;
  openRequest?: number;
  onMinimizedChange?(minimized: boolean): void;
  onClose(): void;
};

function TaskToggle({ currentId, taskId, onTask, panelId, button }: { currentId: string | null; taskId: string | null; onTask(id: string | null): void; panelId: string; button: Ref<HTMLButtonElement> }) {
  const t = useT();
  const [label, other] = currentId ? [t.window.task, t.window.noTask] : [t.window.noTask, t.window.task];
  return <button ref={button} className="btn small ghost agent-task-toggle" data-other={other} type="button" disabled={!currentId} aria-disabled={!currentId} aria-expanded={taskId !== null} aria-controls={panelId} title={label} onClick={() => onTask(taskId ? null : currentId)}>{label}</button>;
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

function useMinimized(openRequest: number | undefined, onChange?: (minimized: boolean) => void) {
  const [minimized, setMinimized] = useState(false);
  useEffect(() => { setMinimized(false); }, [openRequest]);
  useEffect(() => { onChange?.(minimized); }, [minimized, onChange]);
  return { minimized, setMinimized };
}

/* Hiding keeps the live terminal, drafts, task and previous size until the window is restored. */
export function AgentWindowLayout({ currentTask, title, terminal, box, toolbar, children, openRequest, onMinimizedChange, onClose, ...waiting }: Props) {
  const t = useT();
  const currentId = currentTask?.id ?? null;
  const [taskId, setTaskId] = useState<string | null>(null);
  const { minimized, setMinimized } = useMinimized(openRequest, onMinimizedChange);
  const [full, setFull] = useState(false);
  const taskButton = useRef<HTMLButtonElement>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const taskPanelId = useId();
  useEffect(() => { setTaskId(null); }, [currentId]);
  useWindowFocus(minimized, box, restoreButton);
  const closeTask = () => { setTaskId(null); taskButton.current?.focus(); };
  const classes = windowClasses(terminal, taskId !== null, full);
  return <>
    <aside ref={box} className={classes} aria-label={title} tabIndex={-1} hidden={minimized}>
      <div className="t-bar">
        <WindowControls full={full} onFull={() => setFull(v => !v)} onMinimize={() => setMinimized(true)} onClose={onClose} />
        <span className="agent-window-title">{title}</span>
        {toolbar}
        <TaskToggle currentId={currentId} taskId={taskId} onTask={setTaskId} panelId={taskPanelId} button={taskButton} />
        {taskId && <button className="btn small ghost agent-task-back" type="button" onClick={closeTask}>{terminal ? t.window.backToTerminal : t.window.backToConversation}</button>}
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
