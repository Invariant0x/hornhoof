import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api';
import { deptLabel, errorText, useLanguage, useT, type Messages } from '../i18n';
import { useStream } from '../live';
import { PROGRAM_NAMES, PROVIDER_NAMES } from '../providers';
import type { AgentCardView, ComputerView, DecidedBy, Decisions, EventView, Me, OrchestratorState, Org, ShownCommand, StaffLine, StructureItem, SubView, TemplateKey } from '../types';
import { EventMessage, isMessage, MessageFrame, useFolding } from '../ui/AgentMessage';
import { AgentTerminal } from '../ui/AgentTerminal';
import { CommandCard } from '../ui/CommandCard';
import { CEO_DECIDES } from '../ui/DecidedBy';
import { ComputerCard, isOpen } from '../ui/ComputerCard';
import { Markdown } from '../ui/Markdown';
import { Notebook } from '../ui/Notebook';
import { StaffCard } from '../ui/StaffCard';
import { StructureCard } from '../ui/StructureCard';
import { orchestratorStatus } from './Map';
import { clock } from './Subscriptions';

/* The most events the server sends at a time. */
const PAGE = 500;
/* Machines come and go without a message on the stream, so the window asks again now and then. */
const POLL_MS = 15_000;
/* Many lines can arrive in a second while he works; one catch-up covers them. */
const CATCH_UP_MS = 300;

type Applied = {
  proposalId: string | null;
  created?: { template: TemplateKey | null; name: string | null; products: string[] }[];
  removed?: { template: TemplateKey | null; name: string | null }[];
  hired?: { id: string; name: string }[];
};
type Proposal = { proposalId: string; brief: string; items: StructureItem[] };
type StaffProposal = { proposalId: string; kind: 'staff'; department: string; brief: string; people: StaffLine[] };
type Todo = { items: { text: string; state: 'todo' | 'doing' | 'done' }[] };

const field = (data: unknown, key: string): string => {
  const v = data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : '';
};

/* Claude Code loading its own tools: plumbing, not something he did. */
const LOADER = 'ToolSearch';

/* The lines people read: no proposal (the one card shows below the log) and no tool loading, with its result. */
function visible(events: EventView[]): EventView[] {
  let call = '';
  return events.filter(e => {
    if (e.kind === 'tool') call = field(e.data, 'name');
    if (['proposal', 'program'].includes(e.kind)) return false;
    if (e.kind === 'tool' || e.kind === 'tool_result') return call !== LOADER;
    return true;
  });
}

const named = (t: Messages, d: { template: TemplateKey | null; name: string | null }) => d.name ?? (d.template ? t.templates[d.template].name : '');

function reasonText(t: Messages, reason: OrchestratorState['reason'], sub: SubView | null): string {
  if (reason === 'waiting_machine' && sub) return t.map.waitingMachine(sub.owner.name);
  if (reason === 'needs_login' && sub) return t.map.waitingLogin(PROVIDER_NAMES[sub.provider]);
  if (reason === 'node_outdated' && sub) return t.window.nodeOutdated(sub.owner.name);
  if (reason === 'machine_offline') return sub?.kind === 'personal' ? t.map.machineOffline(sub.owner.name) : t.window.builtinOffline;
  return t.map.needsSubscription;
}

function failedText(t: Messages, data: unknown, employee: boolean): string {
  const failed: Record<string, string> = employee ? { ...t.window.failed, ...t.window.failedEmployee } : t.window.failed;
  return failed[field(data, 'error')] ?? t.window.failed.other;
}

/* A department the CEO asked to staff: at says when, so asking again about the same department counts. */
export type StaffAsk = { id: string; name: string; at: number };

/* agentId: 'orchestrator' or an employee's id. staff: the CEO's "+ Hire", for the orchestrator's window only. */
type Props = { me: Me; org: Org; agentId: string; staff?: StaffAsk | null; onClose(): void; onCard?(): void };

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
      d => live && setRight(rightIn(d, id, fallback)),
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
   are the CEO's alone. Access to the computer the server runs on: the orchestrator asks, people of the whole company
   see it, and the CEO's or the delegate's screen opens or closes it. */
const cardsFor = (me: Me, orchestrator: boolean) => ({ ownsCommands: orchestrator && me.person.isOwner, seesComputer: orchestrator && me.person.scopeKind === 'company' });

/* Loads them; null for what this person does not get, or what did not load. */
const loadCards = (ownsCommands: boolean, seesComputer: boolean) =>
  Promise.all([
    ownsCommands ? api.get<{ commands: ShownCommand[] }>('/api/nodes/commands').catch(() => null) : null,
    seesComputer ? api.get<ComputerView>('/api/computer').catch(() => null) : null,
  ]);

/* The request for the computer changed, here or on another of the CEO's screens: what the window shows of it loads again. */
function useComputerChanges(load: () => Promise<void>): void {
  useStream(m => {
    if (m.type === 'computer') void load();
  });
}

/* An agent's window: its live terminal when its node shows one, or its conversation as a log with a line to write to it;
   and the orchestrator's cards. */
export function AgentWindow({ me, org, agentId, staff = null, onClose, onCard }: Props) {
  const t = useT();
  const { language } = useLanguage();
  const orchestrator = agentId === 'orchestrator';
  const path = `/api/agents/${agentId}`;
  const [card, setCard] = useState<AgentCardView | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [state, setState] = useState<OrchestratorState | null>(null);
  const [text, setText] = useState('');
  /* The hand-made card: null follows the orchestrator (shown while he cannot answer), true or false is the CEO's choice. */
  const [manual, setManual] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  /* The department to staff by hand, when the orchestrator could not answer the CEO's "+ Hire". */
  const [staffByHand, setStaffByHand] = useState<{ id: string; name: string } | null>(null);
  /* The terminal shows unless the person asked for the log or the node could not show one. */
  const [asLog, setAsLog] = useState(false);
  /* The orchestrator's window shows the company notebook in place of his conversation while this is on, a head's its
     department's. */
  const [notebook, setNotebook] = useState(false);
  const [noTerminal, setNoTerminal] = useState(false);
  /* The machine commands he asked Hornhoof for. They are the CEO's alone: only the CEO's screen gets them, and shows them
     here, apart from his conversation. */
  const [commands, setCommands] = useState<ShownCommand[]>([]);
  const { ownsCommands, seesComputer } = cardsFor(me, orchestrator);
  const [computer, setComputer] = useState<ComputerView | null>(null);
  const asked = useRef<number | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const last = useRef(0);
  const mounted = useRef(true);
  const catchUpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Catch-ups run side by side and can answer out of order; a state older than the one shown is dropped. */
  const catchUps = useRef(0);
  const stateFrom = useRef(0);
  const liveId = orchestrator ? org.orchestrator?.id : agentId;
  /* The department whose notebook a head keeps. */
  const headOf = card?.kind === 'head' ? (card.department?.id ?? null) : null;
  const sub = orchestrator ? (org.orchestrator?.subscription ?? null) : (card?.subscription ?? null);
  const model = orchestrator ? org.orchestrator?.model : card?.model;
  const machine = orchestrator ? org.orchestrator?.machine : card?.machine;
  const role = card?.role?.title[language];
  const title = orchestrator ? t.window.title : card ? [card.name, role !== card.name && role].filter(Boolean).join(', ') : '';
  const placeholder = orchestrator ? t.window.placeholder : t.window.writeTo(card?.name ?? '');

  /* An employee's name, role and subscription come from its card; the orchestrator's from the company. */
  const loadCard = useCallback(() => {
    if (orchestrator) return;
    api.get<AgentCardView>(path).then(
      c => mounted.current && setCard(c),
      err => mounted.current && setFailure(err),
    );
  }, [orchestrator, path]);

  /* A line comes once, whether the stream or a catch-up brought it first. */
  const merge = useCallback((more: EventView[]) => {
    if (!more.length) return;
    setEvents(list => {
      const seen = new Set(list.map(e => e.seq));
      const fresh = more.filter(e => !seen.has(e.seq));
      return fresh.length ? [...list, ...fresh].sort((a, b) => a.seq - b.seq) : list;
    });
  }, []);

  const loadCommands = useCallback(async () => {
    const [res, access] = await loadCards(ownsCommands, seesComputer);
    if (!mounted.current) return;
    if (res) setCommands(res.commands);
    if (access) setComputer(access);
  }, [ownsCommands, seesComputer]);

  const hideCommand = (id: string) =>
    api.post(`/api/nodes/commands/${id}/hide`).then(
      () => mounted.current && setCommands(list => list.filter(c => c.id !== id)),
      err => mounted.current && setFailure(err),
    );

  /* History comes in order, a page at a time, and only it moves the cursor: a live line never skips what came before it. */
  const catchUp = useCallback(async () => {
    try {
      for (;;) {
        const n = ++catchUps.current;
        const res = await api.get<{ events: EventView[]; state: OrchestratorState }>(`${path}/events?after=${last.current}`);
        if (!mounted.current) return;
        merge(res.events);
        if (n > stateFrom.current) {
          stateFrom.current = n;
          setState(res.state);
        }
        if (res.events.length) last.current = Math.max(last.current, ...res.events.map(e => e.seq));
        if (res.events.length < PAGE) break;
      }
    } catch (err) {
      if (mounted.current) setFailure(err);
    }
    await loadCommands();
  }, [loadCommands, merge, path]);

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
    loadCard();
    (async () => {
      await catchUp();
      await greet();
    })();
    const poll = setInterval(() => void catchUp(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(poll);
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
    if (m.type === 'org') loadCard();
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
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && stop();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state?.busy, stop]);

  /* Until its state and card come, the window cannot tell a terminal from a conversation, nor whether the agent can work. */
  const known = state !== null && (orchestrator || card !== null);

  useLayoutEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, state?.busy, asLog, known]);

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
    if (!body || !state?.ready) return;
    setText('');
    setFailure(null);
    try {
      await api.post(`${path}/messages`, { text: body });
      void catchUp();
    } catch (err) {
      /* The person may have started the next message meanwhile; that one stays. */
      setText(now => now || body);
      setFailure(err);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  }

  /* One card at a time: his newest proposal until it is applied, below his latest line. */
  const shown = visible(events);
  const messages = shown.filter(isMessage);
  const folding = useFolding(messages.map(e => e.seq), box);
  const newest = events.findLast(e => e.kind === 'proposal');
  const applied = new Set(events.filter(e => e.kind === 'applied').map(e => (e.data as Applied).proposalId));
  const open = newest && !applied.has(field(newest.data, 'proposalId')) ? newest.data : null;
  const pending = open && field(open, 'kind') !== 'staff' ? (open as Proposal) : null;
  const staffing = open && field(open, 'kind') === 'staff' ? (open as StaffProposal) : null;
  const staffDept = staffing && org.departments.find(d => d.id === staffing.department);
  const ready = state?.ready ?? false;
  const existing = org.departments.flatMap(d => (d.templateKey ? [d.templateKey] : []));
  /* The by-hand card builds the structure of a company that has none; a company that already has departments (made
     from a template, or built earlier) is past that, so it does not offer more departments. */
  const empty = !org.departments.length;
  const byHand = orchestrator && !open && !staffByHand && empty && (manual ?? (state !== null && !ready));
  const offerByHand = orchestrator && !open && !byHand && !staffByHand && !state?.busy && !state?.queued && empty;
  /* A company that has departments but no orchestrator yet waits for a subscription, so he can staff them. */
  const needsOrchestrator = orchestrator && !open && !staffByHand && !empty && state !== null && !ready && !state.busy && !state.queued;
  const where = [model || t.agent.default, orchestratorStatus(t, sub), machine?.hostname].filter(Boolean).join(', ');
  const hasTerminal = Boolean(state?.terminal) && !noTerminal;
  const terminal = hasTerminal && !asLog;
  const { cardLock, handLock } = useCardLocks(me, open);

  const cards = (
    <>
      {pending && <StructureCard key={pending.proposalId} proposal={{ id: pending.proposalId, brief: pending.brief, items: pending.items }} departments={org.departments} onCorrect={focusLine} locked={cardLock} />}
      {staffing && (
        <StaffCard key={staffing.proposalId} department={{ id: staffing.department, name: staffDept ? deptLabel(t, staffDept) : '' }} proposal={{ id: staffing.proposalId, brief: staffing.brief, people: staffing.people }} onCorrect={focusLine} locked={cardLock} />
      )}
      {!open && staffByHand && <StaffCard key={`hand-${staffByHand.id}`} department={staffByHand} onDone={() => setStaffByHand(null)} onHide={() => setStaffByHand(null)} locked={handLock} />}
      {byHand && <StructureCard manual={{ existing }} departments={org.departments} onCorrect={focusLine} onDone={() => setManual(false)} onHide={() => setManual(false)} locked={handLock} />}
      {commands.map(c => (
        <CommandCard key={c.id} shown={c} onDone={() => void hideCommand(c.id)} />
      ))}
      {computer && <ComputerCard view={computer} onChange={next => mounted.current && setComputer(next)} onFailure={err => mounted.current && setFailure(err)} />}
    </>
  );
  const after = (
    <>
      {offerByHand && (
        <button className="t-link" type="button" onClick={() => setManual(true)}>
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
  const hasCards = Boolean(pending || staffing || (!open && staffByHand) || byHand || offerByHand || needsOrchestrator || failure !== null || commands.length || (computer && (isOpen(computer) || computer.asked)));

  /* Who wrote a message no person typed: the orchestrator, an employee by its name, or Hornhoof itself. */
  const author = (from: string, name: string) => (from === 'orchestrator' ? t.window.orchestrator : from === 'agent' && name ? name : t.window.hornhoof);

  /* What the orchestrator asked of the computer, and what the CEO did about it. */
  function computerLine(e: EventView): string {
    const who = e.person?.name ?? t.window.hornhoof;
    const machine = field(e.data, 'machine') || t.window.computerServer;
    switch (field(e.data, 'state')) {
      case 'asked':
        return t.window.computerAsked(field(e.data, 'reason'), machine);
      case 'opened':
        return t.window.computerOpened(who, clock(language, field(e.data, 'until')) ?? '', machine);
      case 'closed':
        return t.window.computerClosed(who, machine);
      default:
        return t.window.computerDeclined(who, machine);
    }
  }

  function line(e: EventView, i: number) {
    switch (e.kind) {
      case 'message':
        if (isMessage(e)) return <EventMessage event={e} folding={folding} />;
        return (
          <div className="t-u">
            &gt; <em>{e.person?.name ?? author(field(e.data, 'from'), field(e.data, 'name'))}:</em> {field(e.data, 'text')}
          </div>
        );
      case 'text':
        return (
          <div className="t-l">
            <i>⏺</i>
            <Markdown text={field(e.data, 'text')} />
          </div>
        );
      case 'tool':
        return (
          <div className="t-l t-t">
            <i>⏺</i>
            <div>
              <b>{field(e.data, 'name')}</b>({field(e.data, 'input')})
            </div>
          </div>
        );
      case 'tool_result':
        return (
          <div className={`t-r${shown[i - 1]?.kind === 'tool' ? '' : ' alone'}`}>
            <span />
            <span>⎿</span>
            <div>{field(e.data, 'summary')}</div>
          </div>
        );
      case 'todo':
        return (
          <div className="t-l t-plan">
            <i>⏺</i>
            <div>
              {(e.data as Todo).items.map((item, j) => (
                <div key={j}>
                  {item.state === 'done' ? '☒' : '☐'} {item.state === 'doing' ? <b>{item.text}</b> : <span>{item.text}</span>}
                </div>
              ))}
            </div>
          </div>
        );
      case 'applied': {
        const a = e.data as Applied;
        return (
          <div className="t-done">
            {(a.created ?? []).map((d, j) => (
              <div key={`c${j}`} className="t-l">
                <i>⏺</i>
                <div>{t.window.created(named(t, d), d.products.length)}</div>
              </div>
            ))}
            {(a.removed ?? []).map((d, j) => (
              <div key={`r${j}`} className="t-l">
                <i>⏺</i>
                <div>{t.window.removed(named(t, d))}</div>
              </div>
            ))}
            {(a.hired ?? []).map(h => (
              <div key={h.id} className="t-l">
                <i>⏺</i>
                <div>{t.window.hiredLine(h.name)}</div>
              </div>
            ))}
          </div>
        );
      }
      case 'failed':
        return (
          <div className="t-l t-bad">
            <i>⏺</i>
            <div>{failedText(t, e.data, !orchestrator)}</div>
          </div>
        );
      case 'stopped':
        return (
          <div className="t-l t-bad">
            <i>⏺</i>
            <div>{t.window.stopped}</div>
          </div>
        );
      case 'computer':
        return (
          <div className="t-l">
            <i>⏺</i>
            <div>{computerLine(e)}</div>
          </div>
        );
    }
  }

  return (
    <aside ref={box} className={`orch${terminal ? ' term' : ''}`} aria-label={title}>
      <div className="t-bar">
        <span className="lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>{title}</span>
        {terminal && state?.busy && (
          <button className="btn small ghost" type="button" onClick={stop}>
            {t.window.stop}
          </button>
        )}
        {hasTerminal && (
          <button type="button" aria-label={asLog ? t.window.showTerminal : t.window.showLog} title={asLog ? t.window.showTerminal : t.window.showLog} onClick={() => setAsLog(v => !v)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={asLog ? 'M5 7l5 5-5 5M12 17h7' : 'M5 6h14M5 10h14M5 14h9M5 18h11'} />
            </svg>
          </button>
        )}
        {(orchestrator || headOf) && (
          <button type="button" aria-label={t.window.notebook} title={t.window.notebook} aria-pressed={notebook} onClick={() => setNotebook(v => !v)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 4h11v16H6zM9 4v16M12 9h3M12 13h3" />
            </svg>
          </button>
        )}
        {onCard && (
          <button type="button" aria-label={t.window.card} onClick={onCard}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6" />
            </svg>
          </button>
        )}
        <button type="button" aria-label={t.window.close} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {notebook && <Notebook departmentId={orchestrator ? null : headOf} />}
      {!notebook && !known && (
        <div className="t-log" aria-busy="true">
          {failure !== null && (
            <p className="alert" role="alert">
              {errorText(t, failure)}
            </p>
          )}
        </div>
      )}
      {!notebook && known && terminal && (
        <>
          <MessageFrame events={messages} folding={folding} />
          <AgentTerminal path={`/api/agents/${agentId}/terminal`} program={sub ? PROGRAM_NAMES[sub.provider] : 'Claude'} onGone={() => setNoTerminal(true)} />
        </>
      )}
      {!notebook && known && terminal && hasCards && (
        <div className="t-cards">
          {cards}
          {after}
        </div>
      )}
      {!notebook && known && !terminal && (
        <div className="t-log" ref={log} role="log">
          <div className="t-wel">
            <div className="w1">
              <i>✻</i> {title}
            </div>
            <div className="w2">{where}</div>
          </div>
          {shown.map((e, i) => (
            <div key={e.seq} className="t-line">
              {line(e, i)}
            </div>
          ))}
          {cards}
          {state?.busy && (
            <div className="t-sp">
              <i>✻</i>
              <div>
                {t.window.working} <span>{t.window.escToStop}</span>
                {state.queued > 0 && <span className="t-q">{t.window.waiting(state.queued)}</span>}
                <button className="btn small ghost" type="button" onClick={stop}>
                  {t.window.stop}
                </button>
              </div>
            </div>
          )}
          {after}
        </div>
      )}
      {known && !ready && <p className="t-why">{reasonText(t, state.reason, sub)}</p>}
      {known && state?.limitUntil && <p className="t-why">{t.window.limitUntil(clock(language, state.limitUntil)!)}</p>}
      {known && !state?.limitUntil && state?.budgetUntil && <p className="t-why">{t.window.budgetUntil(clock(language, state.budgetUntil)!)}</p>}
      {/* A live terminal has its own line to type in; the log needs this one. */}
      {known && !terminal && (
        <form
          className="t-in"
          onSubmit={e => {
            e.preventDefault();
            void send();
          }}
        >
          <span aria-hidden="true">&gt;</span>
          <label className="sr" htmlFor={`input-${agentId}`}>
            {placeholder}
          </label>
          <textarea id={`input-${agentId}`} ref={input} rows={1} value={text} placeholder={placeholder} disabled={!ready} onChange={e => setText(e.target.value)} onKeyDown={onKeyDown} />
        </form>
      )}
      <div className="t-st">
        {known && <span>{where}</span>}
        {known && !terminal && <span>{t.window.hint}</span>}
      </div>
    </aside>
  );
}
