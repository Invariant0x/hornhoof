import type { ReactNode } from 'react';
import type { ProviderId } from '../types';

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

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 30 30" aria-hidden="true">
      <path className="mk-dome" d="M 5 20 A 10 10 0 0 1 25 20" />
      <path className="mk-base" d="M 2 24.5 L 28 24.5" />
      <circle className="mk-dot" cx="15" cy="16" r="2.4" />
    </svg>
  );
}

type Program = 'claude' | 'codex' | 'kimi' | 'glm';

/* Company keys run in the program of their maker: Anthropic keys in Claude Code, OpenAI keys in Codex. */
const PROGRAM: Record<ProviderId, Program> = { claude: 'claude', anthropic_api: 'claude', codex: 'codex', openai_api: 'codex', kimi: 'kimi', glm: 'glm' };
const PROGRAM_NAMES: Record<Program, string> = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM' };
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
};

/* The program an agent works in, next to its name; the name is its label and tooltip. */
export function ProviderMark({ provider }: { provider: ProviderId | null }) {
  if (!provider) return null;
  const program = PROGRAM[provider];
  return (
    <svg className={`pm ${program}`} viewBox="0 0 16 16" role="img" aria-label={PROGRAM_NAMES[program]}>
      <title>{PROGRAM_NAMES[program]}</title>
      {MARKS[program]}
    </svg>
  );
}
