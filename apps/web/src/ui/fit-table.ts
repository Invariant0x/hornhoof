/* A table stands as entries when its own columns need more than its frame. A card open below a row spans every column and
   wraps to their width: what it holds, or what spills out of it, does not decide the table's look, so it is left out of the
   measure and shows again at once, before anything is drawn. */
export function fitTable(table: HTMLTableElement): void {
  const host = table.parentElement?.clientWidth ?? 0;
  if (!host) return;
  delete table.dataset.fit;
  const cards = [...table.querySelectorAll<HTMLElement>(':scope > tbody > tr.det')];
  for (const card of cards) card.style.display = 'none';
  const needs = table.scrollWidth;
  for (const card of cards) card.style.removeProperty('display');
  if (needs > host + 0.5) table.dataset.fit = 'entries';
}
