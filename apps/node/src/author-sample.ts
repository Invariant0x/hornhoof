export function first(x: number): number {
  const doubled = x * 2;
  const shifted = doubled + 1;
  const squared = shifted * shifted;
  return squared > 10 ? squared : shifted;
}
export function second(y: number): number {
  const doubled = y * 2;
  const shifted = doubled + 1;
  const squared = shifted * shifted;
  return squared > 10 ? squared : shifted;
}
