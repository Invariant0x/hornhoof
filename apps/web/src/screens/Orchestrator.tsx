import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api';
import { errorText, useT, type Messages } from '../i18n';
import { useStream } from '../live';
import { PROVIDER_NAMES } from '../providers';
import type { EventView, Me, OrchestratorState, Org, StructureItem, SubView, TemplateKey } from '../types';
import { StructureCard } from '../ui/StructureCard';
import { orchestratorStatus } from './Map';

const EVENTS = '/api/agents/orchestrator/events';
/* Machines come and go without a message on the stream, so the window asks again now and then. */
const POLL_MS = 15_000;
/* Many lines can arrive in a second while he works; one catch-up covers them. */
const CATCH_UP_MS = 300;

type Applied = { proposalId: string | null; created: { template: TemplateKey | null; name: string | null; products: string[] }[]; removed: { template: TemplateKey | null; name: string | null }[] };
type Proposal = { proposalId: string; brief: string; items: StructureItem[] };
type Todo = { items: { text: string; state: 'todo' | 'doing' | 'done' }[] };

const field = (data: unknown, key: string): string => {
  const v = data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : '';
};

const named = (t: Messages, d: { template: TemplateKey | null; name: string | null }) => d.name ?? (d.template ? t.templates[d.template].name : '');

function reasonText(t: Messages, reason: OrchestratorState['reason'], sub: SubView | null): string {
  if (reason === 'waiting_machine' && sub) return t.map.waitingMachine(sub.owner.name);
  if (reason === 'needs_login' && sub) return t.map.waitingLogin(PROVIDER_NAMES[sub.provider]);
  if (reason === 'machine_offline') return sub?.kind === 'personal' ? t.map.machineOffline(sub.owner.name) : t.window.builtinOffline;
  return t.map.needsSubscription;
}

function failedText(t: Messages, data: unknown): string {
  const failed: Record<string, string> = t.window.failed;
  return failed[field(data, 'error')] ?? t.window.failed.other;
}

type Props = { me: Me; org: Org; onClose(): void };

/* The orchestrator's terminal: his conversation as it happens, the structure card, and the line to write to him. */
export function OrchestratorWindow({ org, onClose }: Props) {
  const t = useT();
  const [events, setEvents] = useState<EventView[]>([]);
  const [state, setState] = useState<OrchestratorState | null>(null);
  const [text, setText] = useState('');
  /* The hand-made card: null follows the orchestrator (shown while he cannot answer), true or false is the CEO's choice. */
  const [manual, setManual] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const last = useRef(0);
  const mounted = useRef(true);
  const catchUpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentId = org.orchestrator?.id;
  const sub = org.orchestrator?.subscription ?? null;

  /* A line comes once, whether the stream or a catch-up brought it first. */
  const merge = useCallback((more: EventView[]) => {
    if (!more.length) return;
    last.current = Math.max(last.current, ...more.map(e => e.seq));
    setEvents(list => {
      const seen = new Set(list.map(e => e.seq));
      const fresh = more.filter(e => !seen.has(e.seq));
      return fresh.length ? [...list, ...fresh].sort((a, b) => a.seq - b.seq) : list;
    });
  }, []);

  const catchUp = useCallback(async () => {
    try {
      const res = await api.get<{ events: EventView[]; state: OrchestratorState }>(`${EVENTS}?after=${last.current}`);
      if (!mounted.current) return;
      merge(res.events);
      setState(res.state);
    } catch (err) {
      if (mounted.current) setFailure(err);
    }
  }, [merge]);

  const soon = useCallback(() => {
    if (catchUpTimer.current) return;
    catchUpTimer.current = setTimeout(() => {
      catchUpTimer.current = null;
      void catchUp();
    }, CATCH_UP_MS);
  }, [catchUp]);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      await catchUp();
      /* His greeting, when the conversation never began on an empty company; the server decides. */
      const res = await api.post<{ started: boolean }>('/api/agents/orchestrator/start').catch(() => ({ started: false }));
      if (res.started && mounted.current) await catchUp();
    })();
    const poll = setInterval(() => void catchUp(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(poll);
      if (catchUpTimer.current) clearTimeout(catchUpTimer.current);
      catchUpTimer.current = null;
    };
  }, [catchUp]);

  useStream(m => {
    if (m.type === 'agent_event' && m.agentId === agentId) {
      merge([m.event]);
      soon();
    }
    if (m.type === 'working') soon();
    if (m.type === 'reconnected') void catchUp();
  });

  const stop = useCallback(() => {
    if (state?.runningJobId) void api.post(`/api/jobs/${state.runningJobId}/cancel`).catch(setFailure);
  }, [state?.runningJobId]);

  useEffect(() => {
    if (!state?.busy) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && stop();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state?.busy, stop]);

  useLayoutEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, state?.busy]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  async function send() {
    const body = text.trim();
    if (!body || !state?.ready) return;
    setText('');
    setFailure(null);
    try {
      await api.post(`/api/agents/orchestrator/messages`, { text: body });
      void catchUp();
    } catch (err) {
      setText(body);
      setFailure(err);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  }

  /* One card at a time: his newest proposal until it is applied, below his latest line. */
  const shown = events.filter(e => e.kind !== 'proposal');
  const newest = events.findLast(e => e.kind === 'proposal');
  const applied = new Set(events.filter(e => e.kind === 'applied').map(e => (e.data as Applied).proposalId));
  const pending = newest && !applied.has(field(newest.data, 'proposalId')) ? (newest.data as Proposal) : null;
  const ready = state?.ready ?? false;
  const existing = org.departments.flatMap(d => (d.templateKey ? [d.templateKey] : []));
  const byHand = !pending && (manual ?? (state !== null && !ready));
  const offerByHand = !pending && !byHand && !state?.busy && !state?.queued && (!ready || !org.departments.length);
  const where = [org.orchestrator?.model, orchestratorStatus(t, sub), sub?.machine?.hostname].filter(Boolean).join(', ');

  function line(e: EventView, i: number) {
    switch (e.kind) {
      case 'message':
        return (
          <div className="t-u">
            &gt; <em>{e.person?.name ?? ''}:</em> {field(e.data, 'text')}
          </div>
        );
      case 'text':
        return (
          <div className="t-l">
            <i>⏺</i>
            <div>{field(e.data, 'text')}</div>
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
            {a.created.map((d, j) => (
              <div key={`c${j}`} className="t-l">
                <i>⏺</i>
                <div>{t.window.created(named(t, d), d.products.length)}</div>
              </div>
            ))}
            {a.removed.map((d, j) => (
              <div key={`r${j}`} className="t-l">
                <i>⏺</i>
                <div>{t.window.removed(named(t, d))}</div>
              </div>
            ))}
          </div>
        );
      }
      case 'failed':
        return (
          <div className="t-l t-bad">
            <i>⏺</i>
            <div>{failedText(t, e.data)}</div>
          </div>
        );
      case 'stopped':
        return (
          <div className="t-l t-bad">
            <i>⏺</i>
            <div>{t.window.stopped}</div>
          </div>
        );
    }
  }

  return (
    <aside className="orch" aria-label={t.window.title}>
      <div className="t-bar">
        <span className="lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>{t.window.title}</span>
        <button type="button" aria-label={t.window.close} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="t-log" ref={log} role="log">
        <div className="t-wel">
          <div className="w1">
            <i>✻</i> {t.window.title}
          </div>
          <div className="w2">{where}</div>
        </div>
        {shown.map((e, i) => (
          <div key={e.seq} className="t-line">
            {line(e, i)}
          </div>
        ))}
        {pending && <StructureCard key={pending.proposalId} proposal={{ id: pending.proposalId, brief: pending.brief, items: pending.items }} departments={org.departments} onCorrect={() => input.current?.focus()} />}
        {byHand && <StructureCard manual={{ existing }} departments={org.departments} onCorrect={() => input.current?.focus()} onDone={() => setManual(false)} onHide={() => setManual(false)} />}
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
        {offerByHand && (
          <button className="t-link" type="button" onClick={() => setManual(true)}>
            {t.window.pickByHand}
          </button>
        )}
        {failure !== null && (
          <p className="alert" role="alert">
            {errorText(t, failure)}
          </p>
        )}
      </div>
      {state && !ready && <p className="t-why">{reasonText(t, state.reason, sub)}</p>}
      <form
        className="t-in"
        onSubmit={e => {
          e.preventDefault();
          void send();
        }}
      >
        <span aria-hidden="true">&gt;</span>
        <label className="sr" htmlFor="orch-input">
          {t.window.placeholder}
        </label>
        <textarea id="orch-input" ref={input} rows={1} value={text} placeholder={t.window.placeholder} disabled={!ready} onChange={e => setText(e.target.value)} onKeyDown={onKeyDown} />
      </form>
      <div className="t-st">
        <span>{where}</span>
        <span>{t.window.hint}</span>
      </div>
    </aside>
  );
}
