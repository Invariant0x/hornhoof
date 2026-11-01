import type { ModelOption, ProviderId } from './index.js';

/* The efforts a model takes. The program picks the Default model itself, and a model the subscription does not run runs
   on it, so they take only the levels every model that names some takes. It lives apart from the message schemas, so the
   web takes it without the schema library. */
export function effortsOf(models: ModelOption[], model: string | null): string[] {
  const found = model ? models.find(m => m.id === model) : undefined;
  if (found) return found.efforts ?? [];
  const named = models.flatMap(m => (m.efforts?.length ? [m.efforts] : []));
  return named.length ? named[0]!.filter(level => named.every(list => list.includes(level))) : [];
}

/* The level Kimi and Codex run at when nobody picked one, as the CEO asked: the most their model takes. A model that names
   no levels runs Kimi at max, and Codex, which may not take max, at its program's own. The others stay at their default. */
export function topEffort(provider: ProviderId, efforts: string[]): string | null {
  if (provider !== 'kimi' && provider !== 'codex') return null;
  if (efforts.includes('max')) return 'max';
  return efforts[efforts.length - 1] ?? (provider === 'kimi' ? 'max' : null);
}
