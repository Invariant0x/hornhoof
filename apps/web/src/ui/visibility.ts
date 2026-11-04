/* A mounted conversation can be hidden by a narrow task view or by its minimized window. */
function cssHidden(element: HTMLElement): boolean {
  if (getComputedStyle(element).display === 'none') return true;
  return element.parentElement ? cssHidden(element.parentElement) : false;
}

export function isHidden(element: HTMLElement | null | undefined): boolean {
  if (!element) return false;
  if (element.closest('[hidden]')) return true;
  return cssHidden(element);
}
