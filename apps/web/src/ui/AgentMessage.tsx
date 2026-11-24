import { useCallback, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { useLanguage, useT, type Language, type Messages } from '../i18n';
import type { EventView, MessageParty } from '../types';
import { isHidden } from './visibility';

export type AgentMessageView = NonNullable<EventView['message']>;
/* A message event that names who wrote to whom; older ones without it show as they did. */
export type MessageEvent = EventView & { kind: 'message'; message: AgentMessageView };
export const messageKey = (event: EventView): number => event.message?.originSeq ?? event.seq;
export const isMessage = (e: EventView): e is MessageEvent => e.kind === 'message' && Boolean(e.message);
type Folding = { opened: ReadonlySet<number>; toggle(seq: number): void };

/* A party as a line names it: the orchestrator and the company's people by a word that fits after "from" and "to" in
   every language, everyone else by name, with the role when it says more than the name. */
export function partyName(t: Messages, language: Language, p: MessageParty): string {
  if (p.kind === 'hornhoof') return t.window.hornhoof;
  if (p.kind === 'agent') return agentPartyName(t, language, p);
  if (p.kind === 'person' && p.id === null) return t.window.people;
  return namedParty(language, p);
}

function agentPartyName(t: Messages, language: Language, p: MessageParty): string {
  if (p.agentKind === 'orchestrator') return t.window.theOrchestrator;
  if (p.id === null) return t.window.hiddenEmployee;
  return namedParty(language, p);
}

function namedParty(language: Language, p: MessageParty): string {
  const role = p.role?.[language];
  return role && role.toLocaleLowerCase(language) !== p.name.toLocaleLowerCase(language) ? `${p.name} (${role})` : p.name;
}

function serviceLine(t: Messages, language: Language, m: AgentMessageView, to: string): string {
  const n = m.notification;
  return t.window.noticeSource(t.notificationSources[n?.source ?? 'service'], n?.tasks.map(t => `#${t.number}`).join(', ') ?? '', n?.detail?.[language] ?? '', to);
}

/* "Message from … to …" for what came in, "Message to … from …" for what went out, and a notice for what Hornhoof said.
   A person's message from Telegram says so, and one their assistant wrote for them names the assistant. */
export function messageLine(t: Messages, language: Language, m: AgentMessageView): string {
  const from = partyName(t, language, m.from);
  const to = partyName(t, language, m.to);
  if (m.direction === 'out') return t.window.messageTo(to, from);
  if (m.from.kind === 'hornhoof') return serviceLine(t, language, m, to);
  const senders = m.senders?.length ? m.senders.map(p => partyName(t, language, p)).join(', ') : from;
  if (m.notification) return t.window.messageVia(senders, to);
  if (m.channel === 'assistant' && m.assistant) return t.window.messageAssistant(from, m.assistant.name, to);
  return m.channel === 'telegram' ? t.window.messageTelegram(from, to) : t.window.messageFrom(from, to);
}

/* One message as a single line that names who wrote to whom; its whole text, service lines too, opens under it. */
export function AgentMessage({
  message,
  text,
  open,
  onToggle,
  number,
  highlighted,
  actions,
}: {
  message: AgentMessageView;
  text: string;
  open: boolean;
  onToggle(): void;
  number?: number;
  highlighted?: boolean;
  actions?: ReactNode;
}) {
  const t = useT();
  const { language } = useLanguage();
  return (
    <div className={`t-m ${message.direction}${highlighted ? ' highlighted' : ''}`} data-msg-number={number}>
      <div className="t-m-top">
        <button className="t-mh" type="button" aria-expanded={open} onClick={onToggle}>
          <i aria-hidden="true">{open ? '▾' : '▸'}</i>
          <span>{messageLine(t, language, message)}</span>
        </button>
        {actions}
      </div>
      {open ? <div className="t-mb">{text}</div> : <span className="t-mf">{t.window.folded(text.split('\n').length)}</span>}
    </div>
  );
}

const isCtrlO = (e: KeyboardEvent) => e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'o';

function conversationHidden(box: HTMLElement | null): boolean {
  return isHidden(box?.querySelector<HTMLElement>('.agent-conversation') ?? box);
}

function typingOutside(el: Element | null, box: HTMLElement | null): boolean {
  return Boolean(el?.closest('input, textarea, select, [contenteditable="true"]') && !box?.contains(el));
}

/* Ctrl+O stays with the live terminal's program, a field elsewhere, or the page while the window is minimized. */
function keyIsElsewhere(target: EventTarget | null, box: HTMLElement | null): boolean {
  if (conversationHidden(box)) return true;
  const el = target instanceof Element ? target : null;
  if (el?.closest('.t-term, .xterm-helper-textarea')) return true;
  return typingOutside(el, box);
}

/* The messages whose text the person opened; the rest stay one line each. While they are on screen (on), Ctrl+O opens
   every folded message, or folds them all once all are open, wherever the focus is, as in Claude Code: on the map that
   opened the window too. */
export function useFolding(seqs: number[], box: RefObject<HTMLElement | null>, on: boolean): Folding {
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const key = on ? seqs.join(',') : '';
  /* The visible log and its shortcut must use the new messages in the same commit. */
  useLayoutEffect(() => {
    const all = key ? key.split(',').map(Number) : [];
    const onKey = (e: KeyboardEvent) => {
      if (!isCtrlO(e) || !all.length || keyIsElsewhere(e.target, box.current)) return;
      e.preventDefault();
      setOpened(now => (all.every(seq => now.has(seq)) ? new Set() : new Set(all)));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [key, box]);
  const toggle = useCallback((seq: number) => {
    setOpened(now => {
      const next = new Set(now);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });
  }, []);
  return { opened, toggle };
}

const textOf = (data: unknown) => {
  const text = (data as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text : '';
};

export function EventMessage({
  event,
  folding,
  highlighted,
  actions,
}: {
  event: MessageEvent;
  folding: Folding;
  highlighted?: boolean;
  actions?: ReactNode;
}) {
  const key = messageKey(event);
  return (
    <AgentMessage
      message={event.message}
      text={textOf(event.data)}
      open={folding.opened.has(key) || Boolean(highlighted)}
      onToggle={() => folding.toggle(key)}
      number={event.number}
      highlighted={highlighted}
      actions={actions}
    />
  );
}
