import { useState, type ReactNode } from 'react';
import { useLanguage, useT } from '../i18n';
import type { EventView, OrchestratorState } from '../types';
import { clock } from './subscription';

/* How an agent's window shows it: a chat anyone reads, or its live terminal for those who want the program itself. */
type AgentView = 'chat' | 'terminal';
const VIEW = 'hh-agent-view';

function storedView(): AgentView {
  try {
    return localStorage.getItem(VIEW) === 'terminal' ? 'terminal' : 'chat';
  } catch {
    return 'chat';
  }
}

/* The chat, unless the person last chose the terminal in this browser. Each window opens with that last choice. */
export function useAgentView(): [AgentView, () => void] {
  const [view, setView] = useState(storedView);
  const toggle = () => {
    const next = view === 'chat' ? 'terminal' : 'chat';
    setView(next);
    try {
      localStorage.setItem(VIEW, next);
    } catch {
      /* Storage can be blocked; the choice then holds for this window only. */
    }
  };
  return [view, toggle];
}

/* The program's own steps, what it called and its plan, are one quiet line of the chat between the words around them. */
const STEPS: ReadonlySet<EventView['kind']> = new Set(['tool', 'tool_result', 'todo']);
type ChatItem<E extends EventView> = { kind: 'event'; event: E; index: number } | { kind: 'steps'; events: { event: E; index: number }[] };

export function chatItems<E extends EventView>(events: E[]): ChatItem<E>[] {
  const items: ChatItem<E>[] = [];
  events.forEach((event, index) => {
    const last = items.at(-1);
    if (!STEPS.has(event.kind)) items.push({ kind: 'event', event, index });
    else if (last?.kind === 'steps') last.events.push({ event, index });
    else items.push({ kind: 'steps', events: [{ event, index }] });
  });
  return items;
}

/* A call or a plan is a step; a call's result belongs to its call. */
const stepCount = (events: { event: EventView }[]) => Math.max(1, events.filter(({ event }) => event.kind !== 'tool_result').length);

export function ChatSteps({ events, children }: { events: { event: EventView }[]; children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-steps">
      <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <i aria-hidden="true">{open ? '▾' : '▸'}</i>
        <span>{t.window.chat.steps(stepCount(events))}</span>
      </button>
      {open && <div className="chat-steps-list">{children}</div>}
    </div>
  );
}

/* One entry of the chat: a person's words on one side, the agent's on the other, and words to the agent from Hornhoof or
   another agent quietly on the agent's side. Each says who wrote and when. */
export function ChatEntry({ side, who, at, children }: { side: 'person' | 'agent' | 'quiet'; who: string; at: string; children: ReactNode }) {
  const { language } = useLanguage();
  return (
    <article className={`chat-msg ${side}`}>
      <header className="chat-who">
        <span>{who}</span>
        <time dateTime={at}>{clock(language, at)}</time>
      </header>
      <div className="chat-body">{children}</div>
    </article>
  );
}

/* What the agent does now, in plain words, right above where one writes to it. */
export function ChatState({ state, onStop }: { state: OrchestratorState; onStop(): void }) {
  const t = useT();
  const say = t.window.chat;
  const words = state.busy ? say.working : state.queued > 0 ? say.starting : say.asleep;
  return (
    <div className={`chat-state${state.busy ? ' working' : ''}`} role="status" aria-label={say.state}>
      {state.busy && <span className="spinner" aria-hidden="true" />}
      <span>{words}</span>
      {state.busy && state.queued > 0 && <span>{say.queued(state.queued)}</span>}
      {state.busy && (
        <button className="btn small ghost" type="button" onClick={onStop}>
          {t.window.stop}
        </button>
      )}
    </div>
  );
}
