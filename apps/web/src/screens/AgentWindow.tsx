import { commandBlockOpen } from '../ui/CommandBox';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, ApiFailure } from '../api';
import { deptLabel, errorText, useLanguage, useT, type Language, type Messages } from '../i18n';
import { useStream } from '../live';
import { liveOf } from '../org';
import { PROGRAM_NAMES, PROVIDER_NAMES, programName } from '../providers';
import type { AgentCardView, ComputerAccessView, DecidedBy, Decisions, EventView, Me, OrchestratorState, Org, ProviderId, ShownCommand, StaffLine, StructureItem, SubView, TemplateKey, TurnRefusal, WaitingRequest } from '../types';
import { ChatEntry, ChatState, ChatSteps, chatItems, useAgentView } from '../ui/AgentChat';
import { EventMessage, isMessage, messageKey, partyName, useFolding } from '../ui/AgentMessage';
import { AgentCard } from '../ui/AgentCard';
import { AddPicture, PictureTray, SentPictures, useDraftPictures, usePictureDrop } from '../ui/MessagePictures';
import { AgentTerminal } from '../ui/AgentTerminal';
import { useChatScroll } from '../ui/chat-scroll';
import { CommandCard } from '../ui/CommandCard';
import { CEO_DECIDES } from '../ui/DecidedBy';
import { Markdown } from '../ui/Markdown';
import { Inbox, useInboxCount } from '../ui/Inbox';
import { Notebook } from '../ui/Notebook';
import { framedPanel, type WindowPanel } from '../ui/SidePanels';
import { StaffCard } from '../ui/StaffCard';
import { StructureCard } from '../ui/StructureCard';
import { WindowFoot, type WindowNote } from '../ui/WindowNotes';
import { isOpen, machineName } from '../ui/access';
import { orchestratorStatus } from './Map';
import { clock } from './Subscriptions';
import { AgentWindowLayout, WordButton, type WindowPlace } from './AgentWindowLayout';
import { everyVisible, useRenderGuard } from '../guard';

/* The most events the server sends at a time. */
const PAGE = 500;
/* The window keeps the newest lines only, so a long day open leaves the page light; a person reads further back a page at a
   time, and what they asked for stays too. */
const KEEP = 300;
const EARLIER = 200;
/* Machines come and go without a message on the stream, so the window asks again now and then. */
const POLL_MS = 15_000;
/* Many lines can arrive in a second while he works; one catch-up covers them. */
const CATCH_UP_MS = 300;
const NOTEBOOK_ICON = 'M6 4h11v16H6zM9 4v16M12 9h3M12 13h3';
const TERMINAL_ICON = 'M5 7l5 5-5 5M12 17h7';
const CHAT_ICON = 'M4 5h16v11H10l-5 4v-4H4z';
const SEND_ICON = 'M5 12h13M13 6l6 6-6 6';
const CARD_ICON = 'M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6';
const INBOX_ICON = 'M4 13l3-8h10l3 8v6H4zM4 13h5l1 2h4l1-2h5';
const STOP_ICON = 'M7 7h10v10H7z';

type Applied = {
  proposalId: string | null;
  created?: { template: TemplateKey | null; name: string | null; products: string[] }[];
  removed?: { template: TemplateKey | null; name: string | null }[];
  hired?: { id: string; name: string }[];
};
type Proposal = { proposalId: string; brief: string; items: StructureItem[]; materialRevision?: number | null; materialDigest?: string | null };
type StaffProposal = { proposalId: string; kind: 'staff'; department: string; brief: string; people: StaffLine[]; materialRevision?: number | null; materialDigest?: string | null };
type Todo = { items: { text: string; state: 'todo' | 'doing' | 'done' }[] };

const field = (data: unknown, key: string): string => {
  const v = data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : '';
};

/* Claude Code loading its own tools: plumbing, not something he did. */
const LOADER = 'ToolSearch';
type LogEvent = EventView & { kind: Exclude<EventView['kind'], 'program'> };

/* The lines people read: no proposal (the one card shows below the log) and no tool loading, with its result. */
function visible(events: EventView[]): LogEvent[] {
  let call = '';
  return events.filter((e): e is LogEvent => {
    if (e.kind === 'tool') call = field(e.data, 'name');
    if (['proposal', 'program'].includes(e.kind)) return false;
    if (e.kind === 'tool' || e.kind === 'tool_result') return call !== LOADER;
    return true;
  });
}

const named = (t: Messages, d: { template: TemplateKey | null; name: string | null }) => d.name ?? (d.template ? t.templates[d.template].name : '');

/* Why the agent cannot answer, for the reasons that name its plan. */
const PLAN_WAITS: Partial<Record<NonNullable<OrchestratorState['reason']>, (t: Messages, sub: SubView) => string>> = {
  waiting_machine: (t, sub) => t.map.waitingMachine(sub.owner.name),
  needs_login: (t, sub) => t.map.waitingLogin(PROVIDER_NAMES[sub.provider]),
  needs_setup: (t, sub) => t.map.waitingSetup(PROVIDER_NAMES[sub.provider]),
  node_outdated: (t, sub) => t.window.nodeOutdated(sub.owner.name),
};

function reasonText(t: Messages, reason: OrchestratorState['reason'], sub: SubView | null): string {
  const waits = reason && sub ? PLAN_WAITS[reason]?.(t, sub) : undefined;
  if (waits) return waits;
  if (reason === 'machine_offline') return sub?.kind === 'personal' ? t.map.machineOffline(sub.owner.name) : t.window.builtinOffline;
  return t.map.needsSubscription;
}

function browserWarning(t: Messages, reason: string, sub: SubView | null): string {
  return sub?.kind === 'personal' ? t.window.browserFailed(sub.owner.name, reason) : t.window.builtinBrowserFailed(reason);
}

function failedText(t: Messages, data: unknown, employee: boolean): string {
  const failed: Record<string, string> = employee ? { ...t.window.failed, ...t.window.failedEmployee } : t.window.failed;
  return failed[field(data, 'error')] ?? t.window.failed.other;
}

/* A department the CEO asked to staff: at says when, so asking again about the same department counts. */
export type StaffAsk = { id: string; name: string; at: number };

/* Until its card comes the company names an agent: a strip with no name could not be told from the others. */
function listedName(org: Org, agentId: string): string {
  return org.departments.flatMap(d => d.employees).find(e => e.id === agentId)?.name ?? '';
}

function windowTitle(t: Messages, language: Language, org: Org, agentId: string, card: AgentCardView | null): string {
  const role = card?.role?.title[language];
  return agentId === 'orchestrator' ? t.window.title : card ? [card.name, role !== card.name && role].filter(Boolean).join(', ') : listedName(org, agentId);
}

/* agentId: 'orchestrator' or an employee's id. staff: the CEO's "+ Hire", for the orchestrator's window only. */
/* onOpenMachine: shows a machine's card in Machines, where its access is opened and closed. */
type Props = { me: Me; org: Org; agentId: string; staff?: StaffAsk | null; onClose(): void; place?: WindowPlace; requests?: WaitingRequest[]; onRequestsChanged?(): void; onOpenMachine?(id: string): void };

type CardRight = { id: string; canAnswer: boolean };

/* What /api/requests says of the card, or the fallback for a card it no longer lists. */
const rightIn = (d: Decisions, id: string, fallback: boolean): CardRight => ({ id, canAnswer: d.proposals.find(p => p.id === id)?.canAnswer ?? fallback });

/* An answer counts only for the card it was given for. */
const rightFor = (right: CardRight | null, id: string | null, fallback: boolean): boolean => (right?.id === id ? right.canAnswer : fallback);

/* Whether this person takes the orchestrator's open card, as /api/requests says of that card; until it says, or for a card
   it no longer lists, as /api/me says of the CEO's decisions. */
function useCardRight(id: string | null, fallback: boolean): boolean {
  const [right, setRight] = useState<CardRight | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    api.get<Decisions>('/api/requests').then(
      d => live && d && setRight(rightIn(d, id, fallback)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [id, fallback]);
  return rightFor(right, id, fallback);
}

/* The cards are the CEO's decisions: someone else reads them without their buttons. The orchestrator's open card goes by
   what /api/requests says of it, the hand-made ones by what /api/me says of the CEO's decisions. */
function useCardLocks(me: Me, open: unknown): { cardLock?: DecidedBy; handLock?: DecidedBy } {
  const decidesCompany = me.canDecideCompany ?? me.person.isOwner;
  const cardRight = useCardRight(open ? field(open, 'proposalId') : null, decidesCompany);
  return { cardLock: cardRight ? undefined : CEO_DECIDES, handLock: decidesCompany ? undefined : CEO_DECIDES };
}

/* What the orchestrator's window shows a person besides the conversation. The machine commands he asked Hornhoof for
   are the CEO's alone. Computer access to the company's machines: the orchestrator asks for one, its owner's screen opens
   it, and the server answers each person with the machines that are theirs to see. */
const cardsFor = (me: Me, orchestrator: boolean) => ({ ownsCommands: orchestrator && me.person.isOwner, seesComputer: orchestrator });

/* Loads them; null for what this person does not get, or what did not load. */
const loadCards = (ownsCommands: boolean, seesComputer: boolean) =>
  Promise.all([
    ownsCommands ? api.get<{ commands: ShownCommand[] }>('/api/nodes/commands').catch(() => null) : null,
    seesComputer ? api.get<{ views: ComputerAccessView[] }>('/api/machines/access').catch(() => null) : null,
  ]);

/* Computer access changed, here or on another screen: what the window shows of it loads again. */
function useComputerChanges(load: () => Promise<void>): void {
  useStream(m => {
    if (m.type === 'computer') void load();
  });
}

/* A task takes Escape before the terminal; a minimized agent leaves the rest of the screen alone. */
function stopOnEscape(e: globalThis.KeyboardEvent, box: HTMLElement | null, stop: () => void): void {
  if (e.key === 'Escape' && !e.defaultPrevented && !box?.hidden) stop();
}

/* Words a person wrote to the agent, as the chat shows them on the person's side. A notice Hornhoof passed on is not. */
function personWords(e: LogEvent): boolean {
  if (e.kind !== 'message') return false;
  if (!isMessage(e)) return e.person !== null;
  return e.message.direction === 'in' && e.message.from.kind === 'person' && !e.message.notification;
}

/* Who wrote a message no person typed: the orchestrator, an employee by its name, or Hornhoof itself. */
const messageAuthor = (t: Messages, from: string, name: string) => (from === 'orchestrator' ? t.window.orchestrator : from === 'agent' && name ? name : t.window.hornhoof);

/* What the orchestrator asked of a machine, what its owner did about it, and what the machine itself refused. */
function computerLine(t: Messages, language: Language, e: EventView): string {
  const who = e.person?.name ?? t.window.hornhoof;
  const machine = field(e.data, 'machine') || t.window.computerServer;
  switch (field(e.data, 'state')) {
    case 'asked':
      return t.window.computerAsked(field(e.data, 'reason'), machine);
    case 'opened':
      return t.window.computerOpened(who, clock(language, field(e.data, 'until')) ?? '', machine);
    case 'closed':
      return t.window.computerClosed(who, machine);
    case 'refused':
      return t.window.computerRefused(machine);
    default:
      return t.window.computerDeclined(who, machine);
  }
}

/* What an agent said, and the files it attached: a file sent on its own comes without words. */
function AgentWords({ data }: { data: unknown }) {
  const text = field(data, 'text');
  return (
    <>
      {text ? <Markdown text={text} /> : null}
      <SentPictures data={data} />
    </>
  );
}

function TodoLine({ todo }: { todo: Todo }) {
  return (
    <div className="t-l t-plan">
      <i>⏺</i>
      <div>
        {todo.items.map((item, j) => (
          <div key={j}>
            {item.state === 'done' ? '☒' : '☐'} {item.state === 'doing' ? <b>{item.text}</b> : <span>{item.text}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* What applying a card did: the departments it made and removed, and the people it hired. */
const appliedLines = (t: Messages, applied: Applied): string[] => [
  ...(applied.created ?? []).map(d => t.window.created(named(t, d), d.products.length)),
  ...(applied.removed ?? []).map(d => t.window.removed(named(t, d))),
  ...(applied.hired ?? []).map(h => t.window.hiredLine(h.name)),
];

/* The switch between the chat and the terminal names and draws what it opens, in every window and at every width. */
function WindowToolbar({ t, terminal, state, stop, onToggle }: { t: Messages; terminal: boolean; state: OrchestratorState | null; stop(): void; onToggle(): void }) {
  return (
    <>
      {terminal && state?.busy && <WordButton label={t.window.stop} icon={STOP_ICON} onClick={stop} />}
      <WordButton label={terminal ? t.window.showChat : t.window.showTerminal} icon={terminal ? CHAT_ICON : TERMINAL_ICON} onClick={onToggle} both />
    </>
  );
}

/* The program the window names: its subscription's, an API's by its protocol, else the one the map knows. */
const windowProgram = (sub: SubView | null, provider: ProviderId | null | undefined): string => (sub ? programName(sub) : provider ? PROGRAM_NAMES[provider] : 'Claude');

/* The terminal view until the agent's state comes, and of an agent whose terminal cannot show now: a program that sleeps
   wakes when someone writes. */
function TerminalPlace({ t, state, program }: { t: Messages; state: OrchestratorState | null; program: string }) {
  return (
    <div className="t-term">
      <div className="t-load" role="status" aria-label={t.window.showTerminal}>
        {state ? (
          <p>{state.ready && !state.busy ? t.window.noTerminal.asleep(program) : t.window.noTerminal.away}</p>
        ) : (
          <>
            <span className="spinner" aria-hidden="true" />
            <span>{t.window.opening(program)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function WindowAfter({ offerByHand, needsOrchestrator, failure, t, onPickByHand }: { offerByHand: boolean; needsOrchestrator: boolean; failure: unknown; t: Messages; onPickByHand(): void }) {
  return (
    <>
      {offerByHand && (
        <button className="t-link" type="button" onClick={onPickByHand}>
          {t.window.pickByHand}
        </button>
      )}
      {needsOrchestrator && <p className="t-why">{t.window.connectForStaff}</p>}
      {failure !== null && (
        <p className="alert" role="alert">
          {errorText(t, failure)}
        </p>
      )}
    </>
  );
}

/* An agent's window: its conversation as a chat with a line to write in, or its live terminal when its node shows one and
   the person chose it; and the orchestrator's cards. Whoever reaches this window may write: the server opens the agent's
   conversation and takes a message by the same rule. */
/* What keeps the agent from answering now, or what happened to the last words it took. The machine's memory has a
   column of its own. */
function stateNotes(t: Messages, language: Language, state: OrchestratorState, ready: boolean, sub: SubView | null): WindowNote[] {
  const w = t.window.notes;
  const notes: (WindowNote | false | null)[] = [
    !ready && { id: 'reason', word: w.wait, text: reasonText(t, state.reason, sub), tone: 'wait' },
    state.turnRefused ? { id: 'refused', word: w.notSent, text: t.window.turnRefused[state.turnRefused], tone: 'bad' } : null,
    state.browserError ? { id: 'browser', word: w.heads, text: browserWarning(t, state.browserError, sub), tone: 'wait' } : null,
    state.limitUntil ? { id: 'limit', word: w.wait, text: t.window.limitUntil(clock(language, state.limitUntil)!), tone: 'wait' } : null,
    !state.limitUntil && state.budgetUntil ? { id: 'budget', word: w.wait, text: t.window.budgetUntil(clock(language, state.budgetUntil)!), tone: 'wait' } : null,
    state.machineDrain ? { id: 'drain', word: w.wait, text: t.window.machineDrain, tone: 'wait' } : null,
  ];
  return notes.filter((note): note is WindowNote => Boolean(note));
}

const memoryNote = (t: Messages, state: OrchestratorState): WindowNote | null =>
  state.memoryWait ? { id: 'memory', word: t.window.notes.memory, text: t.window.memoryWait, tone: 'wait' } : null;

/* Access to machines is opened and closed in Machines: here only a note of each machine the orchestrator asks for, and
   one of the machines open to it, each with the way to that place. */
function accessNotes(t: Messages, language: Language, views: ComputerAccessView[], open: (id: string) => void): WindowNote[] {
  const w = t.window.notes;
  const link = (label: string, id: string) => ({ label, href: `/machines/${id}`, onOpen: () => open(id) });
  const asked: WindowNote[] = views.filter(view => !isOpen(view) && view.asked).map(view => ({
    id: `asks-${view.machine.id}`, word: w.asks, text: w.asksFor(machineName(t, view.machine), view.asked!.reason), tone: 'access', link: link(w.answer, view.machine.id),
  }));
  const opened = views.filter(isOpen);
  const first = opened[0];
  if (!first) return asked;
  const text = opened.length === 1 ? t.window.computerOpenUntil(machineName(t, first.machine), clock(language, first.until) ?? '') : w.openOn(opened.length);
  return [...asked, { id: 'open', word: w.access, text, tone: 'access', link: link(w.manage, first.machine.id) }];
}

function applyLoadedCard(mounted: boolean, card: AgentCardView | null, save: (c: AgentCardView) => void): void {
  if (mounted && card) save(card);
}

function readyEvents<T>(mounted: boolean, res: T | null): res is T {
  return mounted && res !== null;
}

export function AgentWindow({ me, org, agentId, staff = null, onClose, place, requests = [], onRequestsChanged = () => {}, onOpenMachine = () => {} }: Props) {
  useRenderGuard('agent-window');
  const t = useT();
  const { language } = useLanguage();
  const orchestrator = agentId === 'orchestrator';
  const path = `/api/agents/${agentId}`;
  const [card, setCard] = useState<AgentCardView | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [state, setState] = useState<OrchestratorState | null>(null);
  /* The chat shows once its whole history is in: drawn a page at a time from the oldest, it would open on old lines and run
     down to the newest. */
  const [historyIn, setHistoryIn] = useState(false);
  /* Whether the server may have lines older than the oldest kept here, and how many the window keeps now. */
  const [older, setOlder] = useState(false);
  const [readingOlder, setReadingOlder] = useState(false);
  const keep = useRef(KEEP);
  const [text, setText] = useState('');
  /* The hand-made card: null follows the orchestrator (shown while he cannot answer), true or false is the CEO's choice. */
  const [manual, setManual] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  /* The department to staff by hand, when the orchestrator could not answer the CEO's "+ Hire". */
  const [staffByHand, setStaffByHand] = useState<{ id: string; name: string } | null>(null);
  /* The chat shows unless the person chose the terminal. */
  const [view, toggleView] = useAgentView();
  const [noTerminal, setNoTerminal] = useState(false);
  /* The machine commands he asked Hornhoof for. They are the CEO's alone: only the CEO's screen gets them, and shows them
     here, apart from his conversation. */
  const [commands, setCommands] = useState<ShownCommand[]>([]);
  const { ownsCommands, seesComputer } = cardsFor(me, orchestrator);
  const [computer, setComputer] = useState<ComputerAccessView[]>([]);
  /* What the terminal has to say, at the foot of the window with the other notes. */
  const [termNotes, setTermNotes] = useState<WindowNote[]>([]);
  const asked = useRef<number | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLElement>(null);
  const last = useRef(0);
  const mounted = useRef(true);
  const catchUpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Catch-ups run side by side and can answer out of order; a state older than the one shown is dropped. */
  const catchUps = useRef(0);
  const stateFrom = useRef(0);
  const liveId = orchestrator ? org.orchestrator?.id : agentId;
  /* The department whose notebook a head keeps. */
  const headOf = card?.kind === 'head' ? (card.department?.id ?? null) : null;
  const keepsInbox = card !== null && card.kind !== 'assistant';
  const [unreadLetters, heardUnread] = useInboxCount(agentId, liveId, keepsInbox ? card.inboxUnread : undefined);
  const sub = orchestrator ? (org.orchestrator?.subscription ?? null) : (card?.subscription ?? null);
  const model = orchestrator ? org.orchestrator?.model : card?.model;
  const machine = orchestrator ? org.orchestrator?.machine : card?.machine;
  const title = windowTitle(t, language, org, agentId, card);
  const placeholder = orchestrator ? t.window.placeholder : t.window.writeTo(card?.name ?? '');

  /* Every agent's current task comes from its card; the company supplies the orchestrator's other details. */
  const loadCard = useCallback(() => {
    api.get<AgentCardView>(path).then(
      c => applyLoadedCard(mounted.current, c, setCard),
      err => mounted.current && setFailure(err),
    );
  }, [path]);

  /* A line comes once, whether the stream or a catch-up brought it first. */
  const merge = useCallback((more: EventView[]) => {
    if (!more.length) return;
    setEvents(list => {
      const bySeq = new Map(list.map(e => [messageKey(e), e]));
      for (const event of more) {
        const key = messageKey(event);
        const before = bySeq.get(key);
        if ((event.message?.revision ?? 0) >= (before?.message?.revision ?? 0)) bySeq.set(key, event);
      }
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    });
  }, []);

  const loadCommands = useCallback(async () => {
    const [res, access] = await loadCards(ownsCommands, seesComputer);
    if (!mounted.current) return;
    if (res) setCommands(res.commands.filter(commandBlockOpen));
    if (access) setComputer(access.views);
  }, [ownsCommands, seesComputer]);

  const hideCommand = (id: string) =>
    api.post(`/api/nodes/commands/${id}/hide`).then(
      () => mounted.current && setCommands(list => list.filter(c => c.id !== id)),
      err => mounted.current && setFailure(err),
    );

  /* History comes in order, a page at a time, and only it moves the cursor: a live line never skips what came before it. A
     window with no line yet takes the newest ones only. */
  const catchUp = useCallback(async () => {
    try {
      for (;;) {
        const n = ++catchUps.current;
        const fresh = last.current === 0;
        const res = await api.get<{ events: EventView[]; state: OrchestratorState }>(fresh ? `${path}/events?last=${KEEP}` : `${path}/events?after=${last.current}`);
        if (!readyEvents(mounted.current, res)) return;
        merge(res.events);
        if (n > stateFrom.current) {
          stateFrom.current = n;
          setState(res.state);
        }
        if (res.events.length) last.current = Math.max(last.current, ...res.events.map(e => e.seq));
        if (fresh && res.events.length === KEEP) setOlder(true);
        if (fresh || res.events.length < PAGE) {
          setHistoryIn(true);
          break;
        }
      }
    } catch (err) {
      if (mounted.current) {
        setFailure(err);
        /* The server no longer lets this person reach the agent: nothing of it stays open, its line to write included. */
        if (err instanceof ApiFailure && err.status === 403) setState(null);
      }
    }
    await loadCommands();
  }, [loadCommands, merge, path]);

  /* Past what it keeps, the oldest lines go; the server still has them for the person who asks. */
  useEffect(() => {
    if (events.length <= keep.current) return;
    setEvents(list => list.slice(-keep.current));
    setOlder(true);
  }, [events]);

  /* Where the person reads, as far from the end as before the older lines came above it. */
  const fromEnd = useRef<number | null>(null);
  const earlier = async (log: HTMLElement | null) => {
    const first = events[0];
    if (!first) return;
    setReadingOlder(true);
    try {
      const res = await api.get<{ events: EventView[] }>(`${path}/events?last=${EARLIER}&before=${first.seq}`);
      if (!mounted.current) return;
      fromEnd.current = log ? log.scrollHeight - log.scrollTop : null;
      keep.current += res.events.length;
      merge(res.events);
      setOlder(res.events.length === EARLIER);
    } catch (err) {
      if (mounted.current) setFailure(err);
    } finally {
      if (mounted.current) setReadingOlder(false);
    }
  };

  const soon = useCallback(() => {
    if (catchUpTimer.current) return;
    catchUpTimer.current = setTimeout(() => {
      catchUpTimer.current = null;
      void catchUp();
    }, CATCH_UP_MS);
  }, [catchUp]);

  /* His greeting, when the conversation never began on an empty company; the server decides. Employees wait to be written to. */
  const greet = useCallback(async () => {
    if (!orchestrator) return;
    const res = await api.post<{ started: boolean }>('/api/agents/orchestrator/start').catch(() => ({ started: false }));
    if (res.started && mounted.current) await catchUp();
  }, [catchUp, orchestrator]);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      const history = catchUp();
      loadCard();
      await history;
      await greet();
    })();
    const stopPoll = everyVisible(() => void catchUp(), POLL_MS);
    return () => {
      mounted.current = false;
      stopPoll();
      if (catchUpTimer.current) clearTimeout(catchUpTimer.current);
      catchUpTimer.current = null;
    };
  }, [catchUp, greet, loadCard]);

  /* He may become able to answer while the window is open, as when the machine comes up after setup. */
  const wasReady = useRef<boolean | null>(null);
  const canAnswer = state?.ready ?? null;
  useEffect(() => {
    if (canAnswer === null) return;
    if (wasReady.current === false && canAnswer) void greet();
    wasReady.current = canAnswer;
  }, [canAnswer, greet]);

  useComputerChanges(loadCommands);

  useStream(m => {
    if (m.type === 'agent_event' && m.agentId === liveId) {
      merge([m.event]);
      soon();
    }
    if (m.type === 'working') soon();
    if (['org', 'task', 'working'].includes(m.type)) loadCard();
    if (m.type === 'reconnected') {
      loadCard();
      void catchUp();
    }
  });

  /* "+ Hire": once it is known whether he can answer, he is asked to staff the department, or its default roster shows. */
  useLayoutEffect(() => {
    if (!staff || !state || asked.current === staff.at) return;
    asked.current = staff.at;
    if (!state.ready) {
      setStaffByHand({ id: staff.id, name: staff.name });
      return;
    }
    setStaffByHand(null);
    api.post(`${path}/messages`, { text: t.dept.staffAsk(staff.name) }).then(
      () => void catchUp(),
      err => mounted.current && setFailure(err),
    );
  }, [staff, state, path, t, catchUp]);

  const stop = useCallback(() => {
    if (state?.runningJobId) void api.post(`${path}/stop`).catch(setFailure);
  }, [state?.runningJobId, path]);

  useEffect(() => {
    if (!state?.busy) return;
    const onKey = (e: globalThis.KeyboardEvent) => stopOnEscape(e, box.current, stop);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state?.busy, stop]);

  /* Until its state and card come, the window cannot tell a terminal from a conversation, nor whether the agent can work. */
  const known = state !== null && (orchestrator || card !== null);
  const pictures = useDraftPictures(path);
  const hasTerminal = Boolean(state?.terminal) && !noTerminal;
  const terminal = view === 'terminal';
  /* The map already knows an employee's program, before its card comes. */
  const provider = sub?.provider ?? org.departments.flatMap(d => d.employees).find(e => e.id === agentId)?.provider;
  const program = windowProgram(sub, provider);
  /* The terminal opens as soon as the agent's state says it can, without waiting for the card. */
  const opens = terminal && state !== null;
  const chat = known && !terminal && historyIn;
  /* A terminal takes its words and pictures itself; only a window without one has a line to write in. */
  const dragging = usePictureDrop(box, chat, state?.ready ?? false, pictures.add);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  /* Where the person types: the live terminal's own line, or the log's. */
  function focusLine() {
    (input.current ?? box.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea'))?.focus();
  }

  async function send() {
    const body = text.trim();
    const withPictures = pictures.drafts.length > 0;
    if ((!body && !withPictures) || !state?.ready || pictures.sending) return;
    setText('');
    setFailure(null);
    try {
      await pictures.deliver(ids => api.post(`${path}/messages`, ids.length ? { text: body, pictures: ids } : { text: body }));
      void catchUp();
    } catch (err) {
      /* The person may have started the next message meanwhile; that one stays. */
      setText(now => now || body);
      /* Next to the pictures it is about, which stay. */
      if (withPictures) pictures.setRefused(err);
      else setFailure(err);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  }

  const hasPictures = pictures.drafts.length > 0;
  useLayoutEffect(() => {
    if (hasPictures) input.current?.focus();
  }, [hasPictures]);
  /* One card at a time: his newest proposal until it is applied, below his latest line. */
  const shown = visible(events);
  /* Messages between agents, and Hornhoof's, fold to a line each; a person's words show whole. */
  const messages = shown.filter(isMessage).filter(e => !personWords(e));
  /* Only the chat folds messages; the live terminal has the whole window, and its program has Ctrl+O. */
  const folding = useFolding(messages.map(messageKey), box, !terminal);
  const newest = events.findLast(e => e.kind === 'proposal');
  const applied = new Set(events.filter(e => e.kind === 'applied').map(e => (e.data as Applied).proposalId));
  const open = newest && !applied.has(field(newest.data, 'proposalId')) ? newest.data : null;
  const pending = open && field(open, 'kind') !== 'staff' ? (open as Proposal) : null;
  const staffing = open && field(open, 'kind') === 'staff' ? (open as StaffProposal) : null;
  const staffDept = staffing && org.departments.find(d => d.id === staffing.department);
  const ready = state?.ready ?? false;
  const existing = org.departments.flatMap(d => (d.templateKey ? [d.templateKey] : []));
  /* The by-hand card builds the structure of a company that has none but the Operations every company starts with; a
     company that has other departments (made from a template, or built earlier) is past that, so it does not offer more. */
  const empty = org.departments.every(d => d.templateKey === 'operations');
  const byHand = orchestrator && !open && !staffByHand && empty && (manual ?? (state !== null && !ready));
  const offerByHand = orchestrator && !open && !byHand && !staffByHand && !state?.busy && !state?.queued && empty;
  /* A company that has departments but no orchestrator yet waits for a subscription, so he can staff them. */
  const needsOrchestrator = orchestrator && !open && !staffByHand && !empty && state !== null && !ready && !state.busy && !state.queued;
  const where = [model || t.agent.default, orchestratorStatus(t, sub), machine?.hostname].filter(Boolean).join(', ');
  const { cardLock, handLock } = useCardLocks(me, open);

  const cards = (
    <>
      {pending && <StructureCard key={pending.proposalId} proposal={{ id: pending.proposalId, brief: pending.brief, items: pending.items, ...{ materialRevision: pending.materialRevision, materialDigest: pending.materialDigest } }} departments={org.departments} onCorrect={focusLine} locked={cardLock} />}
      {staffing && (
        <StaffCard key={staffing.proposalId} department={{ id: staffing.department, name: staffDept ? deptLabel(t, staffDept) : '' }} proposal={{ id: staffing.proposalId, brief: staffing.brief, people: staffing.people, ...{ materialRevision: staffing.materialRevision, materialDigest: staffing.materialDigest } }} onCorrect={focusLine} locked={cardLock} />
      )}
      {!open && staffByHand && <StaffCard key={`hand-${staffByHand.id}`} department={staffByHand} onDone={() => setStaffByHand(null)} onHide={() => setStaffByHand(null)} locked={handLock} />}
      {byHand && <StructureCard manual={{ existing }} departments={org.departments} onCorrect={focusLine} onDone={() => setManual(false)} onHide={() => setManual(false)} locked={handLock} />}
      {commands.map(c => (
        <CommandCard key={c.id} shown={c} onDone={() => void hideCommand(c.id)} />
      ))}
    </>
  );
  const after = <WindowAfter offerByHand={offerByHand} needsOrchestrator={needsOrchestrator} failure={failure} t={t} onPickByHand={() => setManual(true)} />;
  const hasCards = Boolean(pending || staffing || (!open && staffByHand) || byHand || offerByHand || needsOrchestrator || failure !== null || commands.length);
  const { log, onScroll } = useChatScroll(chat && !place?.minimized, `${events.length} ${state?.busy} ${commands.length} ${hasCards}`);
  useLayoutEffect(() => {
    const el = log.current;
    if (fromEnd.current === null || !el) return;
    el.scrollTop = el.scrollHeight - fromEnd.current;
    fromEnd.current = null;
  }, [events, log]);

  const agentName = orchestrator ? t.window.orchestrator : card?.name || listedName(org, agentId);
  const authorOf = (e: LogEvent): string => {
    if (!isMessage(e)) return e.person?.id === me.person.id ? t.window.chat.you : (e.person?.name ?? '');
    const name = e.message.from.id === me.person.id ? t.window.chat.you : partyName(t, language, e.message.from);
    if (e.message.channel === 'assistant' && e.message.assistant) return t.window.chat.viaAssistant(name, e.message.assistant.name);
    return e.message.channel === 'telegram' ? t.window.chat.viaTelegram(name) : name;
  };

  /* A step of the program's work, as its terminal would show it, inside the chat's folded line of steps. */
  function step(e: LogEvent, i: number) {
    if (e.kind === 'todo') return <TodoLine todo={e.data as Todo} />;
    if (e.kind === 'tool_result') {
      return (
        <div className={`t-r${shown[i - 1]?.kind === 'tool' ? '' : ' alone'}`}>
          <span />
          <span>⎿</span>
          <div>{field(e.data, 'summary')}</div>
        </div>
      );
    }
    return (
      <div className="t-l t-t">
        <i>⏺</i>
        <div>
          <b>{field(e.data, 'name')}</b>({field(e.data, 'input')})
        </div>
      </div>
    );
  }

  function message(e: LogEvent) {
    if (personWords(e)) {
      return (
        <ChatEntry side="person" who={authorOf(e)} at={e.at}>
          <div className="chat-text">{field(e.data, 'text')}</div>
          <SentPictures data={e.data} />
        </ChatEntry>
      );
    }
    if (isMessage(e)) {
      return (
        <div className="chat-quiet">
          <EventMessage event={e} folding={folding} />
          <SentPictures data={e.data} />
        </div>
      );
    }
    return (
      <ChatEntry side="quiet" who={messageAuthor(t, field(e.data, 'from'), field(e.data, 'name'))} at={e.at}>
        <div className="chat-text">{field(e.data, 'text')}</div>
        <SentPictures data={e.data} />
      </ChatEntry>
    );
  }

  /* What happened besides words: a line across the chat, in red for what went wrong. */
  const note = (text: ReactNode, bad = false) => <div className={`chat-note${bad ? ' bad' : ''}`}>{text}</div>;

  function chatLine(e: LogEvent) {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- steps fold apart, proposals and typed events are not chat lines
    switch (e.kind) {
      case 'message':
        return message(e);
      case 'text':
        return (
          <ChatEntry side="agent" who={agentName} at={e.at}>
            <AgentWords data={e.data} />
          </ChatEntry>
        );
      case 'applied':
        return <>{appliedLines(t, e.data as Applied).map((text, j) => <div key={j}>{note(text)}</div>)}</>;
      case 'failed':
        return note(failedText(t, e.data, !orchestrator), true);
      case 'turn_refused':
        return note(t.window.turnRefused[(e.data as { reason: TurnRefusal }).reason], true);
      case 'input_left':
        return note(
          <>
            {t.window.inputLeft.kept} {e.person ? t.window.inputLeft.by(e.person.name) : t.window.inputLeft.nobody}
            <div className="t-left">{field(e.data, 'text')}</div>
          </>,
        );
      case 'stopped':
        return note(t.window.stopped, true);
      case 'computer':
        return note(computerLine(t, language, e));
    }
  }

  /* The orchestrator's notebook is the company's, a head's its department's. Every employee but a person's assistant, which
     answers its owner alone, keeps an inbox. */
  const inbox: WindowPanel = {
    id: 'inbox',
    label: t.agentInbox.panel,
    icon: INBOX_ICON,
    count: { n: unreadLetters, label: t.agentInbox.button(unreadLetters) },
    render: close => <Inbox agentId={agentId} liveId={liveId} hasDepartment={Boolean(card?.department)} onClose={close} onUnread={heardUnread} />,
  };
  const sidePanels: WindowPanel[] = [
    ...(keepsInbox ? [inbox] : []),
    ...(orchestrator || headOf ? [framedPanel('notebook', t.window.notebook, NOTEBOOK_ICON, <Notebook departmentId={orchestrator ? null : headOf} />)] : []),
    { id: 'card', label: t.window.card, icon: CARD_ICON, render: close => <AgentCard agentId={agentId} {...liveOf(org, agentId)} onClose={close} onRemoved={onClose} /> },
  ];

  return (
    <AgentWindowLayout currentTask={card?.currentTask} box={box} terminal={terminal} title={title} onClose={onClose} agentState={card?.state} place={place} requests={requests} onRequestsChanged={onRequestsChanged} panels={sidePanels} toolbar={<WindowToolbar t={t} terminal={terminal} state={state} stop={stop} onToggle={toggleView} />}>
      {terminal && state === null && failure === null && <TerminalPlace t={t} state={null} program={program} />}
      {((!known && !opens && !(terminal && failure === null)) || (!terminal && !historyIn)) && (
        <div className="t-log" aria-busy="true">
          {failure !== null && (
            <p className="alert" role="alert">
              {errorText(t, failure)}
            </p>
          )}
        </div>
      )}
      {opens && hasTerminal && <AgentTerminal path={`/api/agents/${agentId}/terminal`} program={program} onGone={() => setNoTerminal(true)} onNotes={setTermNotes} />}
      {opens && !hasTerminal && <TerminalPlace t={t} state={state} program={program} />}
      {opens && !known && failure !== null && (
        <p className="alert" role="alert">
          {errorText(t, failure)}
        </p>
      )}
      {known && terminal && hasCards && (
        <div className="t-cards">
          {cards}
          {after}
        </div>
      )}
      {chat && (
        <div className="t-log chat" ref={log} role="log" aria-label={t.window.chat.conversation} onScroll={onScroll}>
          {older && (
            <div className="entry-actions chat-earlier">
              <button className="btn small ghost" type="button" disabled={readingOlder} onClick={() => void earlier(log.current)}>
                {t.window.chat.earlier}
              </button>
            </div>
          )}
          {ready && !shown.length && <p className="chat-empty">{t.window.chat.empty}</p>}
          {chatItems(shown).map(item =>
            item.kind === 'steps' ? (
              <ChatSteps key={`steps-${messageKey(item.events[0]!.event)}`} events={item.events}>
                {item.events.map(({ event, index }) => (
                  <div key={messageKey(event)} className="t-line">
                    {step(event, index)}
                  </div>
                ))}
              </ChatSteps>
            ) : (
              <div key={messageKey(item.event)} className="t-line">
                {chatLine(item.event)}
              </div>
            ),
          )}
          {cards}
          {after}
        </div>
      )}
      {known && (
        <WindowFoot
          label={t.window.notes.label}
          memory={memoryNote(t, state)}
          notes={[...(terminal ? termNotes : []), ...stateNotes(t, language, state, ready, sub), ...accessNotes(t, language, computer, onOpenMachine)]}
        />
      )}
      {chat && (ready || state.busy) && <ChatState state={state} onStop={stop} />}
      {dragging && (
        <div className="t-drop" role="status">
          {t.window.dropPictures}
        </div>
      )}
      {known && pictures.refused !== null && (
        <p className="alert t-refused" role="alert">
          {errorText(t, pictures.refused)}
        </p>
      )}
      {chat && (
        <form
          className="t-in chat-in"
          onSubmit={e => {
            e.preventDefault();
            void send();
          }}
        >
          <PictureTray drafts={pictures.drafts} sending={pictures.sending} onRemove={d => { pictures.remove(d); input.current?.focus(); }} onBroken={pictures.asFile} />
          <label className="sr" htmlFor={`input-${agentId}`}>
            {placeholder}
          </label>
          <textarea id={`input-${agentId}`} ref={input} rows={1} value={text} placeholder={placeholder} disabled={!ready} onChange={e => setText(e.target.value)} onKeyDown={onKeyDown} />
          <AddPicture id={`picture-${agentId}`} disabled={!ready} onFiles={pictures.add} />
          <button className="chat-send" type="submit" aria-label={t.window.chat.send} title={t.window.chat.send} disabled={!ready || pictures.sending}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={SEND_ICON} />
            </svg>
          </button>
        </form>
      )}
      <div className="t-st">
        {known && <span>{where}</span>}
        {chat && <span>{t.window.hint}</span>}
      </div>
    </AgentWindowLayout>
  );
}
