import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useT } from '../i18n';
import type { AgentCardView, WaitingRequest } from '../types';
import { SidePanelRow, useSidePanels, type SidePanel, type WindowPanel } from '../ui/SidePanels';
import { TaskPanel } from '../ui/TaskPanel';
import { useOpenAgent } from './AgentWindowContext';

type Waiting = { requests: WaitingRequest[]; onRequestsChanged(): void };
type Props = Waiting & {
  currentTask: AgentCardView['currentTask'] | undefined;
  title: string;
  terminal: boolean;
  box: RefObject<HTMLElement | null>;
  toolbar: ReactNode;
  /* What else slides out of this window besides its task, each opened by its icon in the bar. */
  panels?: WindowPanel[];
  children: ReactNode;
  openRequest?: number;
  onMinimizedChange?(minimized: boolean): void;
  onClose(): void;
};

const TASK_PANEL = 'task';

function TaskToggle({ currentId, open, onToggle, panelsId }: { currentId: string | null; open: boolean; onToggle(opener: HTMLElement): void; panelsId: string }) {
  const t = useT();
  const [label, other] = currentId ? [t.window.task, t.window.noTask] : [t.window.noTask, t.window.task];
  return <button className="btn small ghost agent-task-toggle" data-other={other} type="button" disabled={!currentId} aria-disabled={!currentId} aria-expanded={open} aria-controls={panelsId} title={label} onClick={e => onToggle(e.currentTarget)}>{label}</button>;
}

function PanelToggle({ panel, open, onToggle, panelsId }: { panel: WindowPanel; open: boolean; onToggle(opener: HTMLElement): void; panelsId: string }) {
  return <button type="button" aria-label={panel.label} title={panel.label} aria-expanded={open} aria-controls={panelsId} onClick={e => onToggle(e.currentTarget)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={panel.icon} /></svg></button>;
}

const windowClasses = (terminal: boolean, withPanels: boolean, full: boolean): string => ['orch', terminal && 'term', withPanels && 'with-panels', full && 'fullscreen'].filter(Boolean).join(' ');

function WindowControls({ full, onFull, onMinimize, onClose }: { full: boolean; onFull(): void; onMinimize(): void; onClose(): void }) {
  const t = useT();
  const fullLabel = full ? t.window.restoreSize : t.window.fullScreen;
  return <div className="window-controls">
    <button className="window-close" type="button" aria-label={t.window.close} title={t.window.close} onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg></button>
    <button className="window-minimize" type="button" aria-label={t.window.minimize} title={t.window.minimize} onClick={onMinimize}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" /></svg></button>
    <button className="window-full" type="button" aria-label={fullLabel} title={fullLabel} aria-pressed={full} onClick={onFull}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10V6h4M14 6h4v4M18 14v4h-4M10 18H6v-4" /></svg></button>
  </div>;
}

/* The agent's task as a panel of its window. Links in it open others in its place. Escape is the panels' own here. */
function useTaskPanel(currentId: string | null, { requests, onRequestsChanged }: Waiting) {
  const openAgent = useOpenAgent();
  const [taskId, setTaskId] = useState<string | null>(null);
  useEffect(() => { setTaskId(null); }, [currentId]);
  const panels: SidePanel[] = taskId
    ? [{ id: TASK_PANEL, render: close => <TaskPanel key={taskId} taskId={taskId} active={false} onClose={close} onOpen={setTaskId} requests={requests.filter(r => r.task.id === taskId)} onRequestsChanged={onRequestsChanged} onOpenAgent={openAgent} /> }]
    : [];
  return { panels, showCurrent: () => setTaskId(currentId) };
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

/* Hiding keeps the live terminal, drafts, panels and previous size until the window is restored. */
export function AgentWindowLayout({ currentTask, title, terminal, box, toolbar, panels = [], children, openRequest, onMinimizedChange, onClose, ...waiting }: Props) {
  const t = useT();
  const currentId = currentTask?.id ?? null;
  const task = useTaskPanel(currentId, waiting);
  const { minimized, setMinimized } = useMinimized(openRequest, onMinimizedChange);
  const [full, setFull] = useState(false);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const panelsId = useId();
  const stack = useSidePanels([...panels, ...task.panels], box, !minimized);
  const newest = stack.shown.at(-1);
  useWindowFocus(minimized, box, restoreButton);
  const classes = windowClasses(terminal, newest !== undefined, full);
  return <>
    <aside ref={box} className={classes} aria-label={title} tabIndex={-1} hidden={minimized}>
      <div className="t-bar">
        <WindowControls full={full} onFull={() => setFull(v => !v)} onMinimize={() => setMinimized(true)} onClose={onClose} />
        <span className="agent-window-title">{title}</span>
        {toolbar}
        {panels.map(panel => <PanelToggle key={panel.id} panel={panel} open={stack.isOpen(panel.id)} onToggle={opener => stack.toggle(panel.id, opener)} panelsId={panelsId} />)}
        <TaskToggle currentId={currentId} open={stack.isOpen(TASK_PANEL)} onToggle={opener => { task.showCurrent(); stack.toggle(TASK_PANEL, opener); }} panelsId={panelsId} />
        {newest && <button className="btn small ghost agent-task-back" type="button" onClick={() => stack.close(newest.id)}>{terminal ? t.window.backToTerminal : t.window.backToConversation}</button>}
      </div>
      <div className="agent-workspace">
        <SidePanelRow stack={stack} id={panelsId} />
        <div className="agent-conversation">{children}</div>
      </div>
    </aside>
    {minimized && <button ref={restoreButton} className="agent-strip" type="button" aria-label={t.window.restoreAgent(title)} title={t.window.restoreAgent(title)} onClick={() => setMinimized(false)}><span aria-hidden="true">{title}</span></button>}
  </>;
}
