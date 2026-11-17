type Direction = 1 | -1;
export type Sort = { key: string; direction: Direction };
type Value = string | number;
type SortValue = Value | readonly Value[] | null;
export type SortColumn<T> = { key: string; direction: Direction; value: (row: T) => SortValue };

export function nextSort<T>(sort: Sort, column: SortColumn<T>): Sort {
  return { key: column.key, direction: sort.key === column.key ? (sort.direction === 1 ? -1 : 1) : column.direction };
}

function compare(a: SortValue, b: SortValue, language: string): number {
  const left = Array.isArray(a) ? a : [a];
  const right = Array.isArray(b) ? b : [b];
  for (let i = 0; i < left.length; i++) {
    const x = left[i], y = right[i];
    const difference = typeof x === 'string' ? x.localeCompare(String(y), language) : Number(x) - Number(y);
    if (difference) return difference;
  }
  return 0;
}

export function sortRows<T>(rows: readonly T[], column: SortColumn<T>, direction: Direction, name: (row: T) => string, language: string): T[] {
  return [...rows].sort((a, b) => {
    const x = column.value(a), y = column.value(b);
    const tie = () => name(a).localeCompare(name(b), language);
    if (x === null || y === null) return Number(x === null) - Number(y === null) || tie();
    return compare(x, y, language) * direction || tie();
  });
}

/* An open card anchors the list while refreshed values change around it. */
export function orderRows<T extends { id: string }>(sorted: readonly T[], previous: readonly string[], held: boolean): T[] {
  if (!held) return [...sorted];
  const byId = new Map(sorted.map(row => [row.id, row]));
  const kept = previous.flatMap(id => { const row = byId.get(id); return row ? [row] : []; });
  const seen = new Set(previous);
  return [...kept, ...sorted.filter(row => !seen.has(row.id))];
}
