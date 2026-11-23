import type { ReactNode } from 'react';
import { useWorld } from '../skins/use-skin';
import type { ProviderId, SubView } from '../types';

/* True when the active theme renders the original CC0 Ancient Egypt stroke icon set. */
const useEgyptIcons = () => useWorld() === 'egypt';

const EGYPT_SVG = { 'data-icon-set': 'egypt' } as const;

export function AgentIcon({ label }: { label?: string }) {
  const egypt = useEgyptIcons();
  return (
    <svg className="ic" viewBox="0 0 16 16" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} {...(egypt ? EGYPT_SVG : {})}>
      {egypt ? (
        <>
          <path d="M8 2l5.2 3v6L8 14l-5.2-3V5z" />
          <circle cx="8" cy="8" r="2.2" fill="currentColor" />
        </>
      ) : (
        <>
          <rect x="3" y="3" width="10" height="10" rx="1" />
          <rect x="6" y="6" width="4" height="4" />
          <path d="M6 1v2M10 1v2M6 13v2M10 13v2M1 6h2M1 10h2M13 6h2M13 10h2" />
        </>
      )}
    </svg>
  );
}

export function EmployeeMarkIcon() {
  return <svg className="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" /></svg>;
}

export function DiamondMarkIcon() {
  return <svg className="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1 15 8 8 15 1 8Z" /></svg>;
}

export function PersonIcon({ label }: { label?: string }) {
  const egypt = useEgyptIcons();
  return (
    <svg className="ic" viewBox="0 0 16 16" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} {...(egypt ? EGYPT_SVG : {})}>
      {egypt ? (
        <>
          <circle cx="8" cy="4.2" r="2" />
          <path d="M5 6.8h6l1 2.2H4zM3.5 13.5l1.5-4.5h6l1.5 4.5z" />
        </>
      ) : (
        <>
          <circle cx="8" cy="5.2" r="2.9" />
          <path d="M2.6 14.6c0-3.1 2.4-5.3 5.4-5.3s5.4 2.2 5.4 5.3" />
        </>
      )}
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
  const egypt = useEgyptIcons();
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" {...(egypt ? EGYPT_SVG : {})}>
      {egypt ? (
        <path d="M8 2L14.5 13.5H1.5zM8 5.5l-1 2.5 1.5 1-1 2.2" />
      ) : (
        <>
          <path d="M8 1.8l6.4 11.6H1.6z" />
          <path d="M8 6.2v3.4M8 11.4v.2" />
        </>
      )}
    </svg>
  );
}

/* How a connection is paid: arrows going round for a plan's subscription, a stack of coins for an API's tokens. Words
   beside it or the label of what holds it say so. */
export function PayIcon({ kind }: { kind: SubView['kind'] }) {
  const egypt = useEgyptIcons();
  if (egypt) {
    return (
      <svg className="sign" viewBox="0 0 16 16" aria-hidden="true" {...EGYPT_SVG}>
        {kind === 'api_key' ? (
          <>
            <circle cx="8" cy="5.5" r="3" />
            <circle cx="8" cy="10.5" r="3" />
            <path d="M6.5 5.5h3M6.5 10.5h3" />
          </>
        ) : (
          <>
            <circle cx="8" cy="8" r="5" />
            <path d="M8 5.2v5.6M5.8 7.4L8 5.2l2.2 2.2" />
          </>
        )}
      </svg>
    );
  }
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

export type Program = 'claude' | 'codex' | 'kimi' | 'glm' | 'antigravity';
type Protocol = 'anthropic' | 'openai';

/* Company keys run in the program of their maker: Anthropic keys in Claude Code, OpenAI keys in Codex. */
const PROGRAM: Record<ProviderId, Program> = {
  claude: 'claude', anthropic_api: 'claude', codex: 'codex', openai_api: 'codex', kimi: 'kimi', glm: 'glm', antigravity: 'antigravity', openrouter: 'claude', custom_api: 'claude',
};
/* OpenRouter and a compatible API run in the program of the protocol they were given. */
const PROTOCOL_PROGRAM: Record<Protocol, Program> = { anthropic: 'claude', openai: 'codex' };
const PROGRAM_NAMES: Record<Program, string> = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', antigravity: 'Antigravity' };
export const programOf = (provider: ProviderId, protocol?: Protocol | null): Program => (protocol ? PROTOCOL_PROGRAM[protocol] : PROGRAM[provider]);
export const programName = (program: Program): string => PROGRAM_NAMES[program];
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
  return provider ? <ProgramMark program={programOf(provider, protocol)} /> : null;
}

/* The same mark where the program is already known, as the tracker's executor has it; label: its name and tooltip, the
   program's name by default. */
export function ProgramMark({ program, label = PROGRAM_NAMES[program] }: { program: Program; label?: string }) {
  return (
    <svg className={`pm ${program}`} viewBox="0 0 16 16" role="img" aria-label={label}>
      <title>{label}</title>
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
  if (useEgyptIcons()) {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" {...EGYPT_SVG}>
        <path d="M2 13h12M3.5 10.5h9M5 8h6M6.5 5.5h3M8 3.5l6 9.5H2z" />
        <circle cx="12.5" cy="3.5" r="1.4" />
      </svg>
    );
  }
  return (<svg viewBox="0 0 24 24" aria-hidden="true"><path className="c" d="M7 2.5h8.5L17 4v4.5H8.5L7 7z"/><path d="M12 8.5V11.5M5.75 15v-1.5l2-2h8.5l2 2V15"/><path d="M2 15h6l1.5 1.5v5H3.5L2 20zM14.5 15h6l1.5 1.5v5h-6L14.5 20z"/></svg>);
}

export function SpeedIcon() {
  return (<svg viewBox="0 0 24 24" aria-hidden="true"><path className="gb" pathLength="4" d="M3 17A9 9 0 0 1 21 17"/><path className="gl" pathLength="3" d="M3 17A9 9 0 0 1 18.36 10.64"/><path d="M1.5 21H22.5M12 17l4.2-4.2"/><rect className="kf" x="10.2" y="15.2" width="3.6" height="3.6"/></svg>);
}

/* Lines of a list, for tasks. The icons below stand for a section or a tool when its words do not fit; their names say what
   they are. */
export function ListIcon() {
  if (useEgyptIcons()) {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" {...EGYPT_SVG}>
        <path d="M4 3h9a1.5 1.5 0 0 1 0 3H4a1.5 1.5 0 0 1 0-3zM4 6v7.5a1 1 0 0 0 1 1h7V6M6.5 8.5h3.5M6.5 11h3.5" />
      </svg>
    );
  }
  return (<svg viewBox="0 0 24 24" aria-hidden="true"><rect className="cf" x="2.5" y="4.5" width="3" height="3"/><rect className="cf" x="2.5" y="10.5" width="3" height="3"/><rect className="cf" x="2.5" y="16.5" width="3" height="3"/><path d="M9 6H21.5M9 12H21.5M9 18H21.5"/></svg>);
}

/* An i in a cut frame, for what a place is about. */
export function InfoIcon() {
  return (<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2.5h10L21.5 7v10L17 21.5H7L2.5 17V7z"/><path className="c" d="M12 10.5V17.5"/><rect className="cf" x="10.75" y="6.25" width="2.5" height="2.5"/></svg>);
}

/* Two people, one behind the other. */
export function PeopleIcon() {
  if (useEgyptIcons()) {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" {...EGYPT_SVG}>
        <circle cx="8" cy="4.2" r="2" />
        <path d="M5 6.8h6l1 2.2H4zM3.5 13.5l1.5-4.5h6l1.5 4.5z" />
      </svg>
    );
  }
  return (<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 4.5h3L12 6v3l-1.5 1.5h-3L6 9V6z"/><path d="M2.5 21v-3.5L5 15h8l2.5 2.5V21"/><path className="c" d="M15 4.5h1.5L18 6v3l-1.5 1.5H15M18 15h1l2.5 2.5V21"/></svg>);
}

/* A plug, for the subscriptions and keys the company connects. */
export function PlugIcon() {
  if (useEgyptIcons()) {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" {...EGYPT_SVG}>
        <ellipse cx="8" cy="5.5" rx="3.5" ry="2.2" />
        <path d="M4.5 6.5C3.5 8 4 12.5 8 12.5s4.5-4.5 3.5-6M6.5 5.5h3" />
      </svg>
    );
  }
  return (<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 2.5V7M15.5 2.5V7"/><path d="M5 7h14v5l-3.5 3.5h-7L5 12z"/><path className="c" d="M12 15.5V21.5"/></svg>);
}

/* A computer screen on its stand, for machines. */
export function MachineIcon() {
  if (useEgyptIcons()) {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" {...EGYPT_SVG}>
        <circle cx="8" cy="8" r="5.5" />
        <circle cx="8" cy="8" r="1.6" />
        <path d="M8 2.5v3.9M8 9.6v3.9M2.5 8h3.9M9.6 8h3.9M4.1 4.1l2.8 2.8M9.1 9.1l2.8 2.8" />
      </svg>
    );
  }
  return (<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 4H20l1.5 1.5V16h-19z"/><path className="c" d="M12 16V20.5M7 20.5H17"/></svg>);
}

const TRACKER_ICONS = {
  failure: <><path d="M8 2 15 14H1L8 2Z" /><path d="M8 6v3m0 2v1" /></>,
  waits: <><rect x="2" y="4" width="12" height="8" /><path d="m2 4 6 5 6-5" /></>,
  mine: <><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3.5" /></>,
  dates: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8h3" /></>,
  goals: <><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="2.5" /><path d="m10 6 4-4" /></>,
  pipeline: <path d="M2 4h10m-3-2 2 2-2 2M2 8h12m-3-2 2 2-2 2M2 12h10m-3-2 2 2-2 2" />,
  list: <path d="M5 4h9M5 8h9M5 12h9M2 4h.2M2 8h.2M2 12h.2" />,
  board: <path d="M2 3h3v10H2zM6.5 3h3v7h-3zM11 3h3v9h-3z" />,
  branch: <path d="M4 2v5a3 3 0 0 0 3 3h5m-2-2 2 2-2 2M4 7v7" />,
  add: <path d="M8 3v10M3 8h10" />,
  chevron: <path d="m6 3 5 5-5 5" />,
  employees: <><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="2.5" fill="currentColor" /></>,
};

const EGYPT_TRACKER_ICONS: Partial<Record<keyof typeof TRACKER_ICONS, ReactNode>> = {
  failure: <path d="M8 2L14.5 13.5H1.5zM8 5.5l-1 2.5 1.5 1-1 2.2" />,
  waits: <><rect x="2.5" y="4" width="11" height="8" rx="1.5" /><circle cx="8" cy="8" r="1.8" /><path d="M8 9.8v2.7" /></>,
  mine: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2.2" /><path d="M2.5 11.5h11" /></>,
  dates: <path d="M2 12.5h12M3.5 12.5a4.5 4.5 0 0 1 9 0M8 12.5V5.5l3 3.5M8 2.5v1.2" />,
  goals: <path d="M6 14l.8-8.5L8 2.5l1.2 3L10 14zM4 14h8M3 4.5l1.5.5M13 4.5l-1.5.5" />,
  pipeline: <><path d="M12.8 6.5A5.2 5.2 0 0 0 3.5 5M13 3.2v3.3H9.7M3.2 9.5A5.2 5.2 0 0 0 12.5 11M3 12.8V9.5h3.3" /><circle cx="8" cy="8" r="1.5" /></>,
  list: <path d="M2.5 3.5h11v9h-11zM5 6h6M5 8.5h6M5 11h4" />,
  board: <path d="M2 5a1.5 1.5 0 0 1 3 0v8H2zM6.5 4a1.5 1.5 0 0 1 3 0v9h-3zM11 5.5a1.5 1.5 0 0 1 3 0V13h-3z" />,
  branch: <path d="M8 14V8.5M8 8.5L3.5 3.5M8 8.5V3M8 8.5l4.5-5M3 2.5h1M7.5 2h1M12 2.5h1" />,
  employees: <><path d="M8 2l5.2 3v6L8 14l-5.2-3V5z" /><circle cx="8" cy="8" r="2.2" fill="currentColor" /></>,
};

export function TrackerIcon({ name, className }: { name: keyof typeof TRACKER_ICONS; className?: string }) {
  const egypt = useEgyptIcons();
  const glyph = egypt ? (EGYPT_TRACKER_ICONS[name] ?? TRACKER_ICONS[name]) : TRACKER_ICONS[name];
  const tagged = egypt && Boolean(EGYPT_TRACKER_ICONS[name]);
  return <svg className={className ? `ic ${className}` : 'ic'} viewBox="0 0 16 16" aria-hidden="true" {...(tagged ? EGYPT_SVG : {})}>{glyph}</svg>;
}

/* Carved lotus tile in Ancient Egypt, colour swatch in standard themes, for the Theme store heading. */
export function ThemeShopIcon() {
  const egypt = useEgyptIcons();
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" {...(egypt ? EGYPT_SVG : {})}>
      {egypt ? (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" />
          <path d="M8 4.5c1.5 2 2.5 3.5 2.5 5.5H5.5c0-2 1-3.5 2.5-5.5zM5 10.5h6" />
        </>
      ) : (
        <>
          <rect x="2.5" y="2.5" width="5" height="5" />
          <rect x="8.5" y="2.5" width="5" height="5" />
          <rect x="2.5" y="8.5" width="5" height="5" />
          <rect x="8.5" y="8.5" width="5" height="5" />
        </>
      )}
    </svg>
  );
}

/* Double crown and crook in Ancient Egypt, hub ring in standard themes, for the Orchestrator / Pharaoh. */
export function OrchestratorIcon() {
  const egypt = useEgyptIcons();
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" {...(egypt ? EGYPT_SVG : {})}>
      {egypt ? (
        <path d="M4 13h8M5 13V7l3-4.5L11 7v6M6.5 9h3M3.5 8.5l1.5 1M12.5 8.5l-1.5 1" />
      ) : (
        <>
          <circle cx="8" cy="8" r="5.5" strokeDasharray="3 2" />
          <circle cx="8" cy="8" r="2" />
        </>
      )}
    </svg>
  );
}

/* Temple portico in Ancient Egypt, building block in standard themes, for departments. */
export function DepartmentIcon() {
  const egypt = useEgyptIcons();
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" {...(egypt ? EGYPT_SVG : {})}>
      {egypt ? (
        <path d="M2 5h12L13 3H3zM2 13.5h12M4.5 5v8.5M8 5v8.5M11.5 5v8.5" />
      ) : (
        <>
          <rect x="3" y="3" width="10" height="10" />
          <path d="M6 3v10" />
        </>
      )}
    </svg>
  );
}

/* Mason set-square and plumb in Ancient Egypt, cogwheel in standard themes, for Settings. */
export function SettingsIcon() {
  const egypt = useEgyptIcons();
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" {...(egypt ? EGYPT_SVG : {})}>
      {egypt ? (
        <>
          <path d="M3 13V3h2.5v7.5H13V13zM8.5 3.5v6" />
          <path d="M7.3 9.5h2.4l-1.2 2z" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="2.5" />
          <path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4" />
        </>
      )}
    </svg>
  );
}

/* Speech cartouche in Ancient Egypt, chat bubble in standard themes, for Conversation. */
export function ConversationIcon() {
  const egypt = useEgyptIcons();
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" {...(egypt ? EGYPT_SVG : {})}>
      {egypt ? (
        <>
          <rect x="2.5" y="3.5" width="11" height="7" rx="3.5" />
          <path d="M4.5 12.5h7M6 7h4" />
        </>
      ) : (
        <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" />
      )}
    </svg>
  );
}

/* Clay tablet and reed stylus in Ancient Egypt, prompt in standard themes, for Terminal. */
export function TerminalIcon() {
  const egypt = useEgyptIcons();
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" {...(egypt ? EGYPT_SVG : {})}>
      {egypt ? (
        <path d="M3 3h8l2 2v8H3zM5.5 6.5l2 1.8-2 1.7M8.5 10h2.5" />
      ) : (
        <path d="M3 5l3 3-3 3M8 11h5" />
      )}
    </svg>
  );
}

/* Reed pen and papyrus in Ancient Egypt, notepad in standard themes, for Notebook. */
export function NotebookIcon() {
  const egypt = useEgyptIcons();
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" {...(egypt ? EGYPT_SVG : {})}>
      {egypt ? (
        <path d="M3 3h7v10H3zM5 6h3M5 8.5h3M11.5 12.5l2-7.5-1.5-.5-2 7.5z" />
      ) : (
        <>
          <rect x="3" y="2.5" width="10" height="11" />
          <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
        </>
      )}
    </svg>
  );
}

export function PriorityArrow() {
  return <svg className="ic tr-priority-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="m8 3 5 10H3z" /></svg>;
}

const FALLBACK_ICONS = {
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
  down: <path d="M8 3v10M4 9l4 4 4-4" />,
  remove: <path d="M3 4.5h10M6 4.5v-2h4v2M4.5 4.5l.5 9h6l.5-9M7 7v4m2-4v4" />,
  add: <path d="M8 3v10M3 8h10" />,
};

/* The signs on a fallback plan's buttons, whose names say the rest: higher, lower, away, and add one more. */
export function FallbackIcon({ name }: { name: keyof typeof FALLBACK_ICONS }) {
  return <svg className="ic" viewBox="0 0 16 16" aria-hidden="true" focusable="false">{FALLBACK_ICONS[name]}</svg>;
}
