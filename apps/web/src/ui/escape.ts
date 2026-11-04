/* Overlays consume Escape before the agent window can use it to stop work. */
export function takeEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  event.preventDefault();
  return true;
}
