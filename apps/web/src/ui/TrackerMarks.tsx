import { useT } from '../i18n';
import { priorityOf } from '../tracker';
import type { AgentRef, PersonRef, TaskLine } from '../types';
import { PriorityArrow, type Program } from './icons';

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

function initials(name: string, count: number): string {
  return name.trim().split(/\s+/).slice(0, count).map(word => Array.from(word)[0] ?? '').join('').toLocaleUpperCase();
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

export function ExecutorMark({ agent, program }: { agent: AgentRef; program?: Program | null }) {
  return (
    <>
      <span className="tr-mark tr-executor" data-program={program ?? 'other'} role="img" aria-label={agent.name} title={agent.name}>{initials(agent.name, 2)}</span>
      <span className="tr-id-name" aria-hidden="true" dir="auto">{agent.name}</span>
    </>
  );
}

export function PriorityWord({ task }: { task: TaskLine }) {
  const t = useT();
  const priority = priorityOf(task);
  return <span className={`tr-priority ${priority}`}><PriorityArrow />{t.tracker.priority[priority]}</span>;
}
