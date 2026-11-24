import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { api } from '../api';
import { useLanguage, useT, type Language, type Messages } from '../i18n';
import { useOpenWindowTask } from '../screens/AgentWindowContext';
import type { EventView, OrchestratorState, ReplyQuote } from '../types';
import { EventMessage, partyName, type MessageEvent } from './AgentMessage';
import { clock } from './subscription';

/* How an agent's window shows it: a chat anyone reads, or its live terminal for those who want the program itself. */
type AgentView = 'chat' | 'terminal';
const VIEW = 'hh-agent-view';
const REPLY_ICON = 'M9 7L4 12l5 5M4 12h11a5 5 0 0 1 5 5v1';
const CANCEL_ICON = 'M7 7l10 10M17 7L7 17';
const LONG_PRESS_MS = 480;
const TOUCH_SLOP_PX = 10;
const SWIPE_REPLY_PX = 36;
const HIGHLIGHT_MS = 1_800;
const JUMP_PAGE = 200;

export type ReplyDraft = { number: number; sender: string; excerpt: string };

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

function cleanText(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

function clipExcerpt(text: string): string {
  return text.length > 180 ? `${text.slice(0, 180).trimEnd()}…` : text;
}

function pictureLabel(item: unknown): string[] {
  if (!item || typeof item !== 'object') return [];
  const name = (item as { name?: unknown }).name;
  return typeof name === 'string' ? [name] : [];
}

export function excerptFromEvent(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const record = data as { text?: unknown; pictures?: unknown };
  const text = cleanText(record.text);
  if (text) return clipExcerpt(text);
  return Array.isArray(record.pictures) ? record.pictures.flatMap(pictureLabel).join(', ') : '';
}

export function buildMessagePayload(text: string, pictures: string[], draft: ReplyDraft | null): Record<string, unknown> {
  const payload: Record<string, unknown> = { text };
  if (pictures.length) payload.pictures = pictures;
  if (draft) payload.replyTo = draft.number;
  return payload;
}

export function quietSender(t: Messages, language: Language, meId: string, message: MessageEvent['message']): string {
  return message.from.id === meId ? t.window.chat.you : partyName(t, language, message.from);
}

export function ChatTaskBadge({ task }: { task: { id: string; number: number } }) {
  const t = useT();
  const openTask = useOpenWindowTask();
  const label = t.window.chat.taskRef(task.number);
  if (!openTask || !task.id) return <span className="chat-task">{label}</span>;
  return (
    <button type="button" className="chat-task chat-task-btn" onClick={e => openTask(task.id, e.currentTarget)}>
      {label}
    </button>
  );
}

export function ChatReplyButton({ number, onReply }: { number: number; onReply(): void }) {
  const t = useT();
  return (
    <button type="button" className="chat-reply-btn" aria-label={t.window.chat.replyTo(number)} title={t.window.chat.reply} onClick={onReply}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={REPLY_ICON} />
      </svg>
      <span>{t.window.chat.reply}</span>
    </button>
  );
}

export function ChatQuoteBox({ quote, meId, onJump }: { quote: ReplyQuote; meId: string; onJump(number: number): void }) {
  const t = useT();
  const { language } = useLanguage();
  const sender = quote.sender.id === meId ? t.window.chat.you : partyName(t, language, quote.sender);
  return (
    <button type="button" className="chat-quote" aria-label={t.window.chat.jumpToQuote(sender, quote.number)} onClick={() => onJump(quote.number)}>
      <span className="chat-quote-head">
        <span className="chat-quote-who">{sender}</span>
        <span className="chat-quote-num" dir="ltr">#{quote.number}</span>
      </span>
      {quote.excerpt && <span className="chat-quote-text">{quote.excerpt}</span>}
    </button>
  );
}

export function ChatReplyBar({ draft, onJump, onCancel }: { draft: ReplyDraft | null; onJump(number: number): void; onCancel(): void }) {
  const t = useT();
  if (!draft) return null;
  return (
    <div className="chat-reply-bar" data-testid="chat-reply-preview">
      <button type="button" className="chat-reply-jump" aria-label={t.window.chat.jumpToQuote(draft.sender, draft.number)} onClick={() => onJump(draft.number)}>
        <span className="chat-quote-head">
          <span className="chat-quote-who">{draft.sender}</span>
          <span className="chat-quote-num" dir="ltr">#{draft.number}</span>
        </span>
        {draft.excerpt && <span className="chat-quote-text">{draft.excerpt}</span>}
      </button>
      <button type="button" className="chat-reply-cancel" aria-label={t.window.chat.cancelReply} title={t.window.chat.cancelReply} onClick={onCancel}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d={CANCEL_ICON} />
        </svg>
      </button>
    </div>
  );
}

type TouchTrack = { x: number; y: number; fired: boolean; timer: ReturnType<typeof setTimeout> | null };

function isInteractiveChild(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, textarea'));
}

function hasTextSelection(): boolean {
  return Boolean(window.getSelection?.()?.toString().trim());
}

function clearLongPressOnMove(cur: TouchTrack, dx: number, dy: number): void {
  if (Math.hypot(dx, dy) <= TOUCH_SLOP_PX || !cur.timer) return;
  clearTimeout(cur.timer);
  cur.timer = null;
}

function isReplySwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) >= SWIPE_REPLY_PX && Math.abs(dx) > Math.abs(dy) * 1.5;
}

export function useReplyGestures(onReply?: () => void) {
  const touch = useRef<TouchTrack | null>(null);
  const stopTouch = useCallback(() => {
    if (touch.current?.timer) clearTimeout(touch.current.timer);
    touch.current = null;
  }, []);
  useEffect(() => stopTouch, [stopTouch]);

  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    if (!onReply || isInteractiveChild(e.target) || hasTextSelection()) return;
    e.preventDefault();
    onReply();
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (!onReply || e.pointerType !== 'touch' || isInteractiveChild(e.target)) return;
    stopTouch();
    const timer = setTimeout(() => {
      if (!touch.current || touch.current.fired) return;
      touch.current.fired = true;
      onReply();
    }, LONG_PRESS_MS);
    touch.current = { x: e.clientX, y: e.clientY, fired: false, timer };
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const cur = touch.current;
    if (!onReply || !cur || cur.fired) return;
    const dx = e.clientX - cur.x;
    const dy = e.clientY - cur.y;
    clearLongPressOnMove(cur, dx, dy);
    if (isReplySwipe(dx, dy)) {
      cur.fired = true;
      onReply();
    }
  };

  return { onContextMenu, onPointerDown, onPointerMove, onPointerUp: stopTouch, onPointerCancel: stopTouch };
}

export type EntryReplyProps = {
  number?: number;
  task?: { id: string; number: number };
  quote?: ReplyQuote;
  meId?: string;
  highlighted?: boolean;
  onReply?(): void;
  onJump?(number: number): void;
};

type ChatEntryProps = EntryReplyProps & {
  side: 'person' | 'agent' | 'quiet';
  who: string;
  at: string;
  children: ReactNode;
};

/* One entry of the chat: a person's words on one side, the agent's on the other, and words to the agent from Hornhoof or
   another agent quietly on the agent's side. Each says who wrote and when, with its message number and reply controls. */
export function ChatEntry({ side, who, at, number, task, quote, meId, highlighted, onReply, onJump, children }: ChatEntryProps) {
  const { language } = useLanguage();
  const gestures = useReplyGestures(onReply);
  const cls = `chat-msg ${side}${highlighted ? ' highlighted' : ''}`;
  return (
    <article className={cls} data-msg-number={number} {...gestures}>
      <header className="chat-who">
        <span>{who}</span>
        {number !== undefined && (
          <span className="chat-num" dir="ltr">
            #{number}
          </span>
        )}
        {task && <ChatTaskBadge task={task} />}
        <time dateTime={at}>{clock(language, at)}</time>
        {onReply && number !== undefined && <ChatReplyButton number={number} onReply={onReply} />}
      </header>
      <div className="chat-body">
        {quote && meId && onJump && <ChatQuoteBox quote={quote} meId={meId} onJump={onJump} />}
        {children}
      </div>
    </article>
  );
}

type QuietFolding = Parameters<typeof EventMessage>[0]['folding'];

export function ChatQuietEntry({
  event,
  folding,
  number,
  task,
  quote,
  meId,
  highlighted,
  onReply,
  onJump,
  children,
}: EntryReplyProps & { event: MessageEvent; folding: QuietFolding; children: ReactNode }) {
  const gestures = useReplyGestures(onReply);
  const actions =
    number !== undefined || task ? (
      <span className="chat-quiet-meta">
        {number !== undefined && (
          <span className="chat-num" dir="ltr">
            #{number}
          </span>
        )}
        {task && <ChatTaskBadge task={task} />}
        {onReply && number !== undefined && <ChatReplyButton number={number} onReply={onReply} />}
      </span>
    ) : undefined;
  return (
    <div className="chat-quiet" {...gestures}>
      {quote && meId && onJump && <ChatQuoteBox quote={quote} meId={meId} onJump={onJump} />}
      <EventMessage event={event} folding={folding} highlighted={highlighted} actions={actions} />
      {children}
    </div>
  );
}

type ReplyHookInput = {
  path: string;
  events: EventView[];
  box: RefObject<HTMLElement | null>;
  input: RefObject<HTMLTextAreaElement | null>;
  keep: RefObject<number>;
  merge(more: EventView[]): void;
  setOlder(older: boolean): void;
  setFailure(err: unknown): void;
};

function scrollMessageIntoView(root: HTMLElement | null, targetNumber: number): boolean {
  const el = root?.querySelector<HTMLElement>(`[data-msg-number="${targetNumber}"]`);
  if (!el) return false;
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView?.({ block: 'center', behavior: reduced ? 'instant' : 'smooth' });
  return true;
}

async function fetchOlderUntilTarget(path: string, startSeq: number, targetNumber: number) {
  let cursor = startSeq;
  const loaded: EventView[] = [];
  let lastBatch = 0;
  while (cursor > 1) {
    const res = await api.get<{ events: EventView[] }>(`${path}/events?last=${JUMP_PAGE}&before=${cursor}`);
    lastBatch = res.events.length;
    if (!lastBatch) break;
    loaded.unshift(...res.events);
    cursor = res.events[0]!.seq;
    if (res.events.some(e => e.number === targetNumber) || lastBatch < JUMP_PAGE) break;
  }
  return { loaded, moreOlder: lastBatch === JUMP_PAGE };
}

export function useChatReplies({ path, events, box, input, keep, merge, setOlder, setFailure }: ReplyHookInput) {
  const [draft, setDraft] = useState<ReplyDraft | null>(null);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [pendingScroll, setPendingScroll] = useState<number | null>(null);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    setDraft(null);
    setHighlighted(null);
    setPendingScroll(null);
  }, [path]);

  useEffect(() => {
    if (!draft) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || box.current?.hidden) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setDraft(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [draft, box]);

  useEffect(() => {
    if (highlighted === null) return;
    const timer = setTimeout(() => setHighlighted(now => (now === highlighted ? null : now)), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlighted]);

  useLayoutEffect(() => {
    if (pendingScroll !== null && scrollMessageIntoView(box.current, pendingScroll)) setPendingScroll(null);
  }, [pendingScroll, events, box]);

  const startReply = useCallback(
    (event: EventView, sender: string) => {
      if (event.number === undefined) return;
      setDraft({ number: event.number, sender, excerpt: excerptFromEvent(event.data) });
      input.current?.focus();
    },
    [input],
  );

  const jumpTo = useCallback(
    async (targetNumber: number) => {
      if (!eventsRef.current.some(e => e.number === targetNumber)) {
        try {
          const { loaded, moreOlder } = await fetchOlderUntilTarget(path, eventsRef.current[0]?.seq ?? 0, targetNumber);
          if (loaded.length) {
            keep.current += loaded.length;
            merge(loaded);
            setOlder(moreOlder);
          }
        } catch (err) {
          setFailure(err);
          return;
        }
      }
      setHighlighted(targetNumber);
      setPendingScroll(targetNumber);
    },
    [keep, merge, path, setFailure, setOlder],
  );

  const takeDraft = () => {
    setDraft(null);
    return draft;
  };
  const restoreDraft = (prev: ReplyDraft | null) => {
    if (prev) setDraft(now => now ?? prev);
  };
  const cancel = () => setDraft(null);
  const jump = (targetNumber: number) => void jumpTo(targetNumber);
  const entryProps = (event: EventView, who: string, meId: string): EntryReplyProps => ({
    number: event.number,
    task: event.task,
    quote: event.replyTo,
    meId,
    highlighted: highlighted !== null && highlighted === event.number,
    onReply: () => startReply(event, who),
    onJump: jump,
  });

  return { draft, cancel, takeDraft, restoreDraft, jump, entryProps };
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
