/* Simple human-friendly quick chat popup for a clicked world resident.
   Uses Hornhoof's real /api/agents/:id/events and /api/agents/:id/messages endpoints,
   filtering out developer terminal tool noise so people converse with agents in plain language. */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT, type Language } from '../i18n';
import { en } from '../i18n/en';
import { ru } from '../i18n/ru';
import { useStream } from '../live';
import type { EventView, OrchestratorState } from '../types';

export type QuickChatDemoFallback = Readonly<{
  greeting: string;
  replyFor: (userText: string) => string;
}>;

export type WorldAgentQuickChatProps = Readonly<{
  agentId: string;
  agentName: string;
  lang?: Language;
  compactDark?: boolean;
  demoFallback?: QuickChatDemoFallback;
}>;

type SimpleMessage = Readonly<{
  id: string;
  side: 'person' | 'agent';
  text: string;
}>;

type EventsResponse = {
  events: EventView[];
  state: OrchestratorState;
};

function eventText(data: unknown): string {
  if (!data || typeof data !== 'object' || !('text' in data)) return '';
  const value = (data as { text?: unknown }).text;
  return typeof value === 'string' ? value.trim() : '';
}

/* Extracts only plain human-to-agent and agent-to-human messages, hiding tool calls,
   terminal logs, internal service notices, and agent-to-agent correspondence. */
function toSimpleMessage(event: EventView): SimpleMessage | null {
  const text = eventText(event.data);
  if (!text) return null;
  const id = `seq-${event.seq}`;
  if (event.kind === 'text') {
    return { id, side: 'agent', text };
  }
  if (event.kind === 'message') {
    const isHuman = Boolean(event.person) || event.message?.from.kind === 'person';
    if (!isHuman) return null;
    return { id, side: 'person', text };
  }
  return null;
}

export function WorldAgentQuickChat({ agentId, agentName, lang, compactDark = false, demoFallback }: WorldAgentQuickChatProps) {
  const ctxT = useT();
  const t = lang === 'ru' ? ru : lang === 'en' ? en : ctxT;
  const qc = t.skins.quickChat;
  const [messages, setMessages] = useState<SimpleMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setProblem(null);
    setDemoMode(false);
    setDraft('');
    setBusy(false);

    void api
      .get<EventsResponse>(`/api/agents/${encodeURIComponent(agentId)}/events?last=40`)
      .then(res => {
        if (!alive) return;
        const parsed = (res?.events ?? []).map(toSimpleMessage).filter((m): m is SimpleMessage => m !== null);
        setMessages(parsed.slice(-20));
        setBusy(Boolean(res?.state?.busy));
      })
      .catch(() => {
        if (!alive) return;
        if (demoFallback) {
          setDemoMode(true);
          setMessages([{ id: `demo-greet-${agentId}`, side: 'agent', text: demoFallback.greeting }]);
        } else {
          setMessages([]);
        }
      });

    return () => {
      alive = false;
    };
  }, [agentId, demoFallback]);

  useStream(msg => {
    if (demoMode) return;
    if (msg.type === 'agent_event' && msg.agentId === agentId) {
      const next = toSimpleMessage(msg.event);
      if (next) {
        setMessages(prev => (prev.some(item => item.id === next.id) ? prev : [...prev, next].slice(-20)));
        if (next.side === 'agent') setBusy(false);
      }
    }
  });

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setProblem(null);
    setDraft('');

    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const outgoing: SimpleMessage = { id: localId, side: 'person', text };
    setMessages(prev => [...prev, outgoing].slice(-20));

    if (demoMode && demoFallback) {
      const reply: SimpleMessage = { id: `${localId}-reply`, side: 'agent', text: demoFallback.replyFor(text) };
      setMessages(prev => [...prev, reply].slice(-20));
      return;
    }

    setSending(true);
    setBusy(true);
    try {
      await api.post(`/api/agents/${encodeURIComponent(agentId)}/messages`, { text });
    } catch (err) {
      setBusy(false);
      setProblem(errorText(t, err));
    } finally {
      setSending(false);
    }
  }

  const boxStyle = compactDark
    ? {
        display: 'grid',
        gap: 6,
        padding: '8px 10px',
        borderRadius: 9,
        background: 'rgba(10, 9, 7, 0.56)',
        border: '1px solid rgba(226, 200, 146, 0.24)',
      }
    : {
        display: 'grid',
        gap: 6,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--surface2)',
        border: '1px solid var(--line)',
      };

  return (
    <section data-testid="world-agent-quick-chat" aria-label={qc.title(agentName)} style={boxStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
        <strong style={{ color: compactDark ? '#F3D28A' : 'var(--ink)' }}>{qc.heading}</strong>
        {demoMode ? (
          <span style={{ color: compactDark ? '#B7A78B' : 'var(--muted)' }}>{qc.demoBadge}</span>
        ) : busy ? (
          <span role="status" style={{ color: compactDark ? '#F3D28A' : 'var(--cyan-ink)' }}>{qc.thinking}</span>
        ) : null}
      </div>

      <div
        ref={logRef}
        role="log"
        aria-label={qc.title(agentName)}
        style={{
          display: 'grid',
          gap: 6,
          maxHeight: 144,
          overflowY: 'auto',
          paddingRight: 2,
          fontSize: 12,
        }}
      >
        {messages.length === 0 ? (
          <p style={{ margin: 0, color: compactDark ? '#B7A78B' : 'var(--muted)' }}>{qc.empty}</p>
        ) : (
          messages.map(msg => (
            <div
              key={msg.id}
              data-chat-side={msg.side}
              style={{
                justifySelf: msg.side === 'person' ? 'end' : 'start',
                maxWidth: '88%',
                padding: '6px 9px',
                borderRadius: 8,
                lineHeight: 1.35,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background:
                  msg.side === 'person'
                    ? compactDark
                      ? 'rgba(217, 166, 72, 0.28)'
                      : 'var(--btn)'
                    : compactDark
                      ? 'rgba(255, 255, 255, 0.08)'
                      : 'var(--surface)',
                color:
                  msg.side === 'person'
                    ? compactDark
                      ? '#FAF0D7'
                      : 'var(--on-btn)'
                    : compactDark
                      ? '#F3EAD7'
                      : 'var(--ink)',
              }}
            >
              {msg.text}
            </div>
          ))
        )}
      </div>

      {problem && (
        <p role="alert" style={{ margin: 0, fontSize: 11, color: compactDark ? '#FF9B85' : 'var(--pink-ink)' }}>
          {problem}
        </p>
      )}

      <form onSubmit={e => void onSubmit(e)} style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          aria-label={qc.inputLabel(agentName)}
          placeholder={qc.placeholder}
          maxLength={1000}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '6px 8px',
            borderRadius: 6,
            border: compactDark ? '1px solid rgba(226, 200, 146, 0.32)' : '1px solid var(--line2)',
            background: compactDark ? 'rgba(20, 17, 13, 0.9)' : 'var(--surface)',
            color: compactDark ? '#F3EAD7' : 'var(--ink)',
            fontSize: 12,
          }}
        />
        <button
          type="submit"
          data-testid="world-quick-chat-send"
          disabled={sending || !draft.trim()}
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            border: 'none',
            background: compactDark ? '#D9A648' : 'var(--btn)',
            color: compactDark ? '#1A140B' : 'var(--on-btn)',
            fontWeight: 700,
            fontSize: 12,
            cursor: sending || !draft.trim() ? 'default' : 'pointer',
            opacity: sending || !draft.trim() ? 0.6 : 1,
          }}
        >
          {qc.send}
        </button>
      </form>
    </section>
  );
}
