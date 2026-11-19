import { useT } from '../i18n';
import { priorityOf } from '../tracker';
import type { AgentRef, PersonRef, TaskLine } from '../types';
import { PriorityArrow, type Program } from './icons';
import { employeeKind, WorkerMark } from './WorkerMark';

const PALETTE = ['accent', 'warning', 'attention', 'success', 'blue', 'violet'] as const;
type Tone = (typeof PALETTE)[number];

const departments: Partial<Record<string, Tone>> = {
  marketing: 'warning', sales: 'attention', business_development: 'violet', support: 'blue',
  development: 'accent', operations: 'success', design: 'violet', finance: 'success',
};

function toneOf(id: string): Tone {
  let hash = 0;
  for (const char of id) hash = (Math.imul(31, hash) + char.codePointAt(0)!) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

/* The first letters of the name's first words; a name of fewer words gives the first letters of its first word, as the
   mockup's LR for Lead Researcher and BR for Bruno. */
function initials(name: string, count: number): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= count ? words.slice(0, count).map(word => Array.from(word)[0]!) : Array.from(words[0] ?? '').slice(0, count);
  return letters.join('').toLocaleUpperCase();
}

export function DepartmentMark({ id, name, template }: { id: string; name: string; template?: string | null }) {
  return <span className="tr-mark tr-dept-mark" data-tone={departments[template ?? id] ?? toneOf(id)} aria-hidden="true">{initials(name, 1)}</span>;
}

export function PersonMark({ person, decorative = false }: { person: PersonRef; decorative?: boolean }) {
  return (
    <>
      <span className="tr-mark tr-avatar" data-tone={toneOf(person.id)} role={decorative ? undefined : 'img'} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : person.name} title={person.name}>
        {initials(person.name, 1)}
      </span>
      {!decorative && <span className="tr-id-name" aria-hidden="true" dir="auto">{person.name}</span>}
    </>
  );
}

export function ExecutorMark({ agent, program, turnkey }: { agent: AgentRef; program?: Program | null; turnkey?: boolean }) {
  const words = useT().workers;
  const kind = agent.kind === 'worker' || agent.kind === 'head' ? employeeKind(turnkey) : undefined;
  const detail = kind && words[kind];
  return (
    <>
      <span className="tr-mark tr-executor" data-program={program ?? 'other'} data-worker-kind={kind}
        role="img" aria-label={agent.name} aria-description={detail} title={detail ? `${agent.name}. ${detail}` : agent.name}>
        {initials(agent.name, 2)}
        {kind === 'generalist' && <WorkerMark kind={kind} decorative />}
      </span>
      <span className="tr-id-name" aria-hidden="true" dir="auto">{agent.name}</span>
    </>
  );
}

export function PriorityWord({ task }: { task: TaskLine }) {
  const t = useT();
  const priority = priorityOf(task);
  return <span className={`tr-priority ${priority}`}><PriorityArrow />{t.tracker.priority[priority]}</span>;
}
