import type { ModelOption } from './index.js';

export const ROLE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type RoleEffort = (typeof ROLE_EFFORTS)[number];
export const ORCHESTRATOR_EFFORT: RoleEffort = 'xhigh';
const EFFORT_ORDER = [...ROLE_EFFORTS, 'ultra'];

/* The efforts a model takes. The program picks the Default model itself, and a model the subscription does not run runs
   on it, so they take only the levels every model that names some takes. It lives apart from the message schemas, so the
   web takes it without the schema library. */
export function effortsOf(models: ModelOption[], model: string | null): string[] {
  const found = model ? models.find(m => m.id === model) : undefined;
  if (found) return found.efforts ?? [];
  const named = models.flatMap(m => (m.efforts?.length ? [m.efforts] : []));
  return named.length ? named[0]!.filter(level => named.every(list => list.includes(level))) : [];
}

/* A person's pick stays while the model takes it. Otherwise fit the role down to a supported level, or its lowest.
   With no role level or no known model levels, leave the program to choose. */
export function effortFor(chosen: string | null, efforts: string[] = [], roleEffort: string | null = null): string | null {
  if (chosen && (!efforts.length || efforts.includes(chosen))) return chosen;
  if (!roleEffort || !efforts.length) return null;
  const ordered = EFFORT_ORDER.filter(level => efforts.includes(level));
  const fitted = ordered.filter(level => EFFORT_ORDER.indexOf(level) <= EFFORT_ORDER.indexOf(roleEffort));
  return fitted.at(-1) ?? ordered[0] ?? null;
}
