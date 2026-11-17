/* The whole sentences under root that a page right to left would show with their full stop at the wrong end: those with
   no element of their own direction, dir="auto" or a bdi, between them and root. The page itself stays mirrored. */
export function unisolated(root: HTMLElement): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent!.trim();
    const own = node.parentElement!.closest('[dir="auto"], bdi');
    if (/[.?!]$/.test(text) && !(own && root.contains(own))) found.push(text);
  }
  return found;
}
