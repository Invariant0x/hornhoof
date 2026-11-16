import type { ReactNode } from 'react';
import type { ProviderId, SubView } from '../types';

export function AgentIcon({ label }: { label?: string }) {
  return (
    <svg className="ic" viewBox="0 0 16 16" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <rect x="3" y="3" width="10" height="10" rx="1" />
      <rect x="6" y="6" width="4" height="4" />
      <path d="M6 1v2M10 1v2M6 13v2M10 13v2M1 6h2M1 10h2M13 6h2M13 10h2" />
    </svg>
  );
}

export function PersonIcon({ label }: { label?: string }) {
  return (
    <svg className="ic" viewBox="0 0 16 16" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <circle cx="8" cy="5.2" r="2.9" />
      <path d="M2.6 14.6c0-3.1 2.4-5.3 5.4-5.3s5.4 2.2 5.4 5.3" />
    </svg>
  );
}

/* The deputy CEO's sign: a boss's top hat, with its brim and band. */
export function DeputyIcon() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 12.5h13" />
      <path d="M4.5 12.5V4.2c0-.4.3-.7.7-.7h5.6c.4 0 .7.3.7.7v8.3" />
      <path d="M4.5 9.8h7" />
    </svg>
  );
}

/* A pencil, by the heading of a form that changes a person. */
export function EditIcon() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.8 2.8l2.4 2.4L5.6 12.8H3.2v-2.4z" />
      <path d="M9.2 4.4l2.4 2.4" />
    </svg>
  );
}

/* Two figures, by the heading of the card that hires into a department. */
export function StaffIcon() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="6" cy="5.4" r="2.4" />
      <path d="M1.6 13.6c0-2.6 2-4.4 4.4-4.4s4.4 1.8 4.4 4.4" />
      <path d="M10.6 3.2a2.4 2.4 0 0 1 0 4.4M12 9.6c1.5.6 2.4 2 2.4 4" />
    </svg>
  );
}

/* A key, by the line that says whether an assistant has one. */
export function KeyIcon() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="5" cy="8" r="2.8" />
      <path d="M7.8 8h6.4M12 8v2.4M14.2 8v1.6" />
    </svg>
  );
}

/* A triangle with a mark, at the start of a warning line. */
export function AlertIcon() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.8l6.4 11.6H1.6z" />
      <path d="M8 6.2v3.4M8 11.4v.2" />
    </svg>
  );
}

/* How a connection is paid: arrows going round for a plan's subscription, a stack of coins for an API's tokens. Words
   beside it or the label of what holds it say so. */
export function PayIcon({ kind }: { kind: SubView['kind'] }) {
  return (
    <svg className="sign" viewBox="0 0 24 24" aria-hidden="true">
      {kind === 'api_key'
        ? <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>
        : <><path d="M4 12a8 8 0 0 1 13.7-5.6L20 9" /><path d="M20 4v5h-5" /><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15" /><path d="M4 20v-5h5" /></>}
    </svg>
  );
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 30 30" aria-hidden="true">
      <path className="mk-dome" d="M 5 20 A 10 10 0 0 1 25 20" />
      <path className="mk-base" d="M 2 24.5 L 28 24.5" />
      <circle className="mk-dot" cx="15" cy="16" r="2.4" />
    </svg>
  );
}

type Program = 'claude' | 'codex' | 'kimi' | 'glm' | 'antigravity';
type Protocol = 'anthropic' | 'openai';

/* Company keys run in the program of their maker: Anthropic keys in Claude Code, OpenAI keys in Codex. */
const PROGRAM: Record<ProviderId, Program> = {
  claude: 'claude', anthropic_api: 'claude', codex: 'codex', openai_api: 'codex', kimi: 'kimi', glm: 'glm', antigravity: 'antigravity', openrouter: 'claude', custom_api: 'claude',
};
/* OpenRouter and a compatible API run in the program of the protocol they were given. */
const PROTOCOL_PROGRAM: Record<Protocol, Program> = { anthropic: 'claude', openai: 'codex' };
const PROGRAM_NAMES: Record<Program, string> = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', antigravity: 'Antigravity' };
const programOf = (provider: ProviderId, protocol?: Protocol | null): Program => (protocol ? PROTOCOL_PROGRAM[protocol] : PROGRAM[provider]);
const MARKS: Record<Program, ReactNode> = {
  claude: <path d="M8 1.6v3.6M8 10.8v3.6M1.6 8h3.6M10.8 8h3.6M3.5 3.5l2.5 2.5M10 10l2.5 2.5M12.5 3.5 10 6M6 10l-2.5 2.5" />,
  codex: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" />
      <path d="M4.6 6.2 6.9 8l-2.3 1.8M8.6 10.2h2.8" />
    </>
  ),
  kimi: <path className="fill" d="M10.2 1.9a6.3 6.3 0 1 0 3.9 9.4 5 5 0 0 1-3.9-9.4z" />,
  glm: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5.4 5.4h5.2l-5.2 5.2h5.2" />
    </>
  ),
  antigravity: <path d="M2.5 14V8.5a5.5 5.5 0 0 1 11 0V14M6 14V9.5a2 2 0 0 1 4 0V14" />,
};

/* The program an agent works in, next to its name; the name is its label and tooltip. */
/* protocol: an API connection's, which decides its program. */
export function ProviderMark({ provider, protocol }: { provider: ProviderId | null; protocol?: Protocol | null }) {
  if (!provider) return null;
  const program = programOf(provider, protocol);
  return (
    <svg className={`pm ${program}`} viewBox="0 0 16 16" role="img" aria-label={PROGRAM_NAMES[program]}>
      <title>{PROGRAM_NAMES[program]}</title>
      {MARKS[program]}
    </svg>
  );
}

export function BackIcon() {
  return (<svg viewBox="0 0 24 24" aria-hidden="true"><path className="c" d="M4.5 12H20"/><path d="M11 5 4 12l7 7"/></svg>);
}

export function TreeIcon() {
  return (<svg viewBox="0 0 24 24" aria-hidden="true"><path className="t" d="M1.5 5H22.5"/><path className="c" d="M10 5V10.5L11.5 12H17M4.5 5V17.5L6 19H17"/><rect className="cf" x="17" y="10" width="4" height="4"/><rect className="cf" x="17" y="17" width="4" height="4"/></svg>);
}

export function MapIcon() {
  return (<svg viewBox="0 0 24 24" aria-hidden="true"><path className="c" d="M7 2.5h8.5L17 4v4.5H8.5L7 7z"/><path d="M12 8.5V11.5M5.75 15v-1.5l2-2h8.5l2 2V15"/><path d="M2 15h6l1.5 1.5v5H3.5L2 20zM14.5 15h6l1.5 1.5v5h-6L14.5 20z"/></svg>);
}

export function SpeedIcon() {
  return (<svg viewBox="0 0 24 24" aria-hidden="true"><path className="gb" pathLength="4" d="M3 17A9 9 0 0 1 21 17"/><path className="gl" pathLength="3" d="M3 17A9 9 0 0 1 18.36 10.64"/><path d="M1.5 21H22.5M12 17l4.2-4.2"/><rect className="kf" x="10.2" y="15.2" width="3.6" height="3.6"/></svg>);
}
