import type { ModelOption } from './index.js';

/* The efforts a model takes. The program picks the Default model itself, and a model the subscription does not run runs
   on it, so they take only the levels every model that names some takes. It lives apart from the message schemas, so the
   web takes it without the schema library. */
export function effortsOf(models: ModelOption[], model: string | null): string[] {
  const found = model ? models.find(m => m.id === model) : undefined;
  if (found) return found.efforts ?? [];
  const named = models.flatMap(m => (m.efforts?.length ? [m.efforts] : []));
  return named.length ? named[0]!.filter(level => named.every(list => list.includes(level))) : [];
}
