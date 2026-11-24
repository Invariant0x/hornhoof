import { useEffect, useId, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import type { AgentCardView, WaitingRequest } from '../types';
import { SidePanelRow, usePanelsCover, useSidePanels, type SidePanel, type WindowPanel } from '../ui/SidePanels';
import { TaskPanel } from '../ui/TaskPanel';
import { useOpenAgent, WindowTaskContext } from './AgentWindowContext';

type Waiting = { requests: WaitingRequest[]; onRequestsChanged(): void; viewerId?: string };
type Props = Waiting & {
  currentTask: AgentCardView['currentTask'] | undefined;
  title: string;
  terminal: boolean;
  box: RefObject<HTMLElement | null>;
  toolbar: ReactNode;
  /* What else slides out of this window besides its task, each opened by its icon in the bar. */
  panels?: WindowPanel[];
  /* What its strip says about it, once its card has come. */
  agentState?: AgentCardView['state'];
  place?: WindowPlace;
  children: ReactNode;
  onClose(): void;
};

/* Where the window stands among the others: dock is where its strip goes while it is hidden. */
export type WindowPlace = { minimized: boolean; dock: HTMLElement | null; onMinimize(): void; onRestore(): void };
const ALONE: WindowPlace = { minimized: false, dock: null, onMinimize() {}, onRestore() {} };

const TASK_PANEL = 'task';
const BACK_ICON = 'M15 6l-6 6 6 6';

function TaskToggle({ currentId, open, onToggle, panelsId }: { currentId: string | null; open: boolean; onToggle(opener: HTMLElement): void; panelsId: string }) {
  const t = useT();
  const [label, other] = currentId ? [t.window.task, t.window.noTask] : [t.window.noTask, t.window.task];
  return <button className="btn small ghost agent-task-toggle" data-other={other} data-short={t.window.task} type="button" disabled={!currentId} aria-disabled={!currentId} aria-expanded={open} aria-controls={panelsId} aria-label={label} title={label} onClick={e => onToggle(e.currentTarget)}><span>{label}</span></button>;
}

/* A panel's icon in the bar. One that counts what waits in it says the count in its name, and shows it beside the icon, or on
   its corner on a phone; past 99 it shows 99+. */
function PanelToggle({ panel, open, onToggle, panelsId }: { panel: WindowPanel; open: boolean; onToggle(opener: HTMLElement): void; panelsId: string }) {
  const n = panel.count?.n ?? 0;
  const label = panel.count?.label ?? panel.label;
  return (
    <button type="button" className={panel.count ? 'counts' : undefined} data-panel={panel.id} aria-label={label} title={label} aria-expanded={open} aria-controls={panelsId} onClick={e => onToggle(e.currentTarget)}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={panel.icon} />
      </svg>
      {/* The number reads left to right in any language; the count itself stands where the page's direction ends. */}
      {n > 0 && <span className="nav-count panel-count" aria-hidden="true"><span dir="ltr">{n > 99 ? '99+' : n}</span></span>}
    </button>
  );
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

/* A button of the bar that says what it does, or shows only its icon where the bar has no room for the words. both: the word
   and the icon side by side at any width. */
export function WordButton({ label, icon, onClick, both = false }: { label: string; icon: string; onClick(): void; both?: boolean }) {
  return <button className={`btn small ghost bar-word${both ? ' both' : ''}`} type="button" aria-label={label} title={label} onClick={onClick}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={icon} /></svg><span>{label}</span></button>;
}

/* The agent's task as a panel of its window. Links in it open others in its place. Escape is the panels' own here. */
function useTaskPanel(currentId: string | null, { requests, onRequestsChanged, viewerId }: Waiting) {
  const openAgent = useOpenAgent();
  const [taskId, setTaskId] = useState<string | null>(null);
  useEffect(() => { setTaskId(null); }, [currentId]);
  const panels: SidePanel[] = taskId
    ? [{ id: TASK_PANEL, render: close => <TaskPanel key={taskId} taskId={taskId} active={false} onClose={close} onOpen={setTaskId} requests={requests.filter(r => r.task.id === taskId)} viewerId={viewerId} onRequestsChanged={onRequestsChanged} onOpenAgent={openAgent} /> }]
    : [];
  return { panels, showCurrent: () => setTaskId(currentId), show: setTaskId };
}

/* The focus goes to the strip when the person minimized this window; a window another one pushed aside leaves it to that one.
   Says so through what it returns. */
function useWindowFocus(minimized: boolean, box: RefObject<HTMLElement | null>, restore: RefObject<HTMLButtonElement | null>) {
  const wasMinimized = useRef(minimized);
  const toStrip = useRef(false);
  useEffect(() => {
    if (minimized && toStrip.current) restore.current?.focus();
    else if (!minimized && wasMinimized.current) box.current?.focus();
    toStrip.current = false;
    wasMinimized.current = minimized;
  }, [minimized, box, restore]);
  return toStrip;
}

/* A hidden window at the edge of the screen: its name and state, and the cross that closes it. */
function AgentStrip({ title, state, button, onRestore, onClose }: { title: string; state?: AgentCardView['state']; button: Ref<HTMLButtonElement>; onRestore(): void; onClose(): void }) {
  const t = useT();
  const word = state && t.dept.states[state];
  return <div className="agent-strip">
    <button ref={button} className="agent-strip-open" type="button" aria-label={t.window.restoreAgent(title)} title={word ? `${title}: ${word}` : title} onClick={onRestore}>
      {state && <i className={`dot ${state}`} aria-hidden="true" />}
      <span className="agent-strip-name">{title}</span>
      {word && <span className="agent-strip-state">{word}</span>}
    </button>
    <button className="agent-strip-close" type="button" aria-label={t.window.closeAgent(title)} title={t.window.closeAgent(title)} onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg></button>
  </div>;
}

/* Hiding keeps the live terminal, drafts, panels and previous size until the window is restored. */
export function AgentWindowLayout({ currentTask, title, terminal, box, toolbar, panels = [], agentState, place = ALONE, children, onClose, ...waiting }: Props) {
  const t = useT();
  const currentId = currentTask?.id ?? null;
  const task = useTaskPanel(currentId, waiting);
  const { minimized, dock } = place;
  const [full, setFull] = useState(false);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const panelsId = useId();
  const stack = useSidePanels([...panels, ...task.panels], box, !minimized);
  const newest = stack.shown.at(-1);
  const conversation = useRef<HTMLDivElement>(null);
  const covered = usePanelsCover(stack.row, conversation, newest !== undefined);
  const toStrip = useWindowFocus(minimized, box, restoreButton);
  /* A task a panel names opens in the task panel, as the task's own links do. */
  const openTask = (id: string, opener: HTMLElement) => {
    task.show(id);
    stack.open(TASK_PANEL, opener);
  };
  const classes = windowClasses(terminal, newest !== undefined, full);
  return <>
    <aside ref={box} className={classes} aria-label={title} tabIndex={-1} hidden={minimized}>
      <div className="t-bar">
        <WindowControls full={full} onFull={() => setFull(v => !v)} onMinimize={() => { toStrip.current = true; place.onMinimize(); }} onClose={onClose} />
        <span className="agent-window-title">{title}</span>
        {newest && covered && <WordButton label={terminal ? t.window.backToTerminal : t.window.backToConversation} icon={BACK_ICON} onClick={() => stack.close(newest.id)} />}
        {toolbar}
        {panels.map(panel => <PanelToggle key={panel.id} panel={panel} open={stack.isOpen(panel.id)} onToggle={opener => stack.toggle(panel.id, opener)} panelsId={panelsId} />)}
        <TaskToggle currentId={currentId} open={stack.isOpen(TASK_PANEL)} onToggle={opener => { task.showCurrent(); stack.toggle(TASK_PANEL, opener); }} panelsId={panelsId} />
      </div>
      <div className="agent-workspace">
        <WindowTaskContext.Provider value={openTask}>
          <SidePanelRow stack={stack} id={panelsId} />
        </WindowTaskContext.Provider>
        <div ref={conversation} className="agent-conversation">{children}</div>
      </div>
    </aside>
    {minimized && dock && createPortal(<AgentStrip title={title} state={agentState} button={restoreButton} onRestore={place.onRestore} onClose={onClose} />, dock)}
  </>;
}
