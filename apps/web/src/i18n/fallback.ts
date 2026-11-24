/* What a language says where it says nothing is what English says, so a text still being translated shows as English and
   never as a blank. withFallback lays a language over English key by key and tells which keys it lacks. */
const isGroup = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function withFallback<T>(base: T, own: unknown, lacking?: (path: string) => void, path = ''): T {
  if (!isGroup(base)) return (own === undefined ? base : own) as T;
  const given = isGroup(own) ? own : {};
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    const here = path ? `${path}.${key}` : key;
    if (given[key] === undefined) {
      lacking?.(here);
      merged[key] = value;
    } else merged[key] = isGroup(value) ? withFallback(value, given[key], lacking, here) : given[key];
  }
  return merged as T;
}

/* Every text of a language by its path, with what it is: a sentence, or a phrase that takes values. */
export function keyPaths(messages: unknown, path = ''): [string, 'string' | 'function' | 'other'][] {
  if (isGroup(messages)) return Object.entries(messages).flatMap(([key, value]) => keyPaths(value, path ? `${path}.${key}` : key));
  return [[path, typeof messages === 'string' ? 'string' : typeof messages === 'function' ? 'function' : 'other']];
}

/* The paths a language holds that English does not. */
export function extraPaths(base: unknown, own: unknown, path = ''): string[] {
  if (!isGroup(own)) return [];
  const known = isGroup(base) ? base : {};
  return Object.entries(own).flatMap(([key, value]) => {
    const here = path ? `${path}.${key}` : key;
    return key in known ? extraPaths(known[key], value, here) : [here];
  });
}
