/* Callers supply a nonempty list of validated observations. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : sorted[middle - 1]! + (sorted[middle]! - sorted[middle - 1]!) / 2;
}
