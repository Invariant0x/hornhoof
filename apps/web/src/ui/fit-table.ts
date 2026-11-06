export function fitTable(table: HTMLTableElement): void {
  const host = table.parentElement?.clientWidth ?? 0;
  if (!host) return;
  delete table.dataset.fit;
  if (table.scrollWidth > host + 0.5) table.dataset.fit = 'entries';
}
