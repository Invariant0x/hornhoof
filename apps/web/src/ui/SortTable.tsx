import { Fragment, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { guardedResizeObserver } from '../guard';
import { useLanguage, useT } from '../i18n';
import { Edge } from './Edge';
import { fitTable } from './fit-table';
import { matchesFilters, TableTools, type FilterGroup, type Selections, type TableSearch } from './TableTools';
import { nextSort, orderRows, sortRows, type Sort, type SortColumn } from './sort';

/* lead: a narrow column that stands before the name. The name is the first column without it, and opens the card.
   span: for a row whose cell says one thing for this column and the next ones, how many it takes and the label it goes by
   when the table stands as entries. */
type ColumnSpan = { columns: number; label: string };
export type TableColumn<T> = SortColumn<T> & { label: string; cell: (row: T) => ReactNode; className?: string; lead?: true; span?: (row: T) => ColumnSpan | null };
type Props<T> = {
  rows: readonly T[];
  columns: TableColumn<T>[];
  name: (row: T) => string;
  initialSort: Sort;
  card: (row: T) => ReactNode;
  search?: TableSearch<T>;
  filters?: FilterGroup<T>[];
  openIds?: readonly string[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
};
type SortControls<T> = { columns: TableColumn<T>[]; sort: Sort; choose: (column: TableColumn<T>) => void };

function Arrow({ ascending }: { ascending: boolean }) {
  return <span className={`sa-w${ascending ? ' up' : ''}`} aria-hidden="true"><svg className="sa" viewBox="0 0 12 12"><path d="M6 1v9M2 6l4 4 4-4" /></svg></span>;
}

function TableHead<T>({ columns, sort, choose }: SortControls<T>) {
  return <thead><tr>{columns.map(c => <th key={c.key} scope="col" className={c.lead ? c.className : undefined} aria-sort={sort.key === c.key ? (sort.direction === 1 ? 'ascending' : 'descending') : 'none'}>
    <button className={`sorth${sort.key === c.key ? ' on' : ''}`} type="button" onClick={() => choose(c)}>{c.label}<Arrow ascending={(sort.key === c.key ? sort.direction : c.direction) === 1} /></button>
  </th>)}</tr></thead>;
}

function SortBar<T>({ columns, sort, choose }: SortControls<T>) {
  const t = useT();
  return <div className="sortbar" role="group" aria-label={t.tables.sortBy}>
    <span className="lbl">{t.tables.sortBy}</span>
    {columns.map(c => <button key={c.key} className={`sortb${sort.key === c.key ? ' on' : ''}`} type="button" aria-pressed={sort.key === c.key} onClick={() => choose(c)}>
      {c.label}{sort.key === c.key && <><Arrow ascending={sort.direction === 1} /><span className="sr">{`, ${sort.direction === 1 ? t.tables.ascending : t.tables.descending}`}</span></>}
    </button>)}
  </div>;
}

type Cell<T> = { column: TableColumn<T>; index: number; colSpan?: number; label?: string };

/* The label a cell goes by as an entry: none for the name and the state, which need none. */
function entryLabel<T>(column: TableColumn<T>, named: boolean, span: ColumnSpan | null): string | undefined {
  if (named || column.className === 'k-status') return undefined;
  return span?.label ?? column.label;
}

/* The row's cells, each with the column it starts at, how many it takes, and the label it goes by as an entry. */
function rowCells<T>(row: T, columns: TableColumn<T>[], named: number): Cell<T>[] {
  const cells: Cell<T>[] = [];
  for (let index = 0; index < columns.length; ) {
    const column = columns[index]!;
    const span = column.span?.(row) ?? null;
    cells.push({ column, index, colSpan: span?.columns, label: entryLabel(column, index === named, span) });
    index += Math.max(1, span?.columns ?? 1);
  }
  return cells;
}

function TableRow<T>({ row, columns, name, expanded, toggle }: { row: T; columns: TableColumn<T>[]; name: string; expanded: boolean; toggle: () => void }) {
  const t = useT();
  const named = Math.max(0, columns.findIndex(c => !c.lead));
  return <tr className={`rm${expanded ? ' open' : ''}`} aria-label={name} onClick={() => { if (!window.getSelection()?.toString()) toggle(); }}>
    {rowCells(row, columns, named).map(({ column: c, index: i, colSpan, label }) => <td key={c.key} className={i === named ? 'k-name' : c.className} colSpan={colSpan} data-label={label}>
      {i === named ? <button className="rowbtn" type="button" aria-expanded={expanded} aria-label={t.tables.openCard(name)}>
        <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>{c.cell(row)}
      </button> : c.cell(row)}
    </td>)}
  </tr>;
}

function ResultLine({ filtered, count, shown, all, clear }: { filtered: boolean; count: string; shown: number; all: number; clear: () => void }) {
  const t = useT();
  return <p className="result" role="status">{filtered ? <><bdi>{t.tables.shown(shown, all)}</bdi> <button className="linkbtn" type="button" onClick={clear}>{t.tables.clear}</button></> : <bdi>{count}</bdi>}</p>;
}

function useAutoOpen<T extends { id: string }>(openIds: readonly string[] | undefined, rows: readonly T[], setOpen: Dispatch<SetStateAction<Set<string>>>) {
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    const active = new Set(openIds);
    seen.current = new Set([...seen.current].filter(id => active.has(id)));
    const fresh = [...active].filter(id => !seen.current.has(id) && rows.some(r => r.id === id));
    for (const id of fresh) seen.current.add(id);
    if (fresh.length) setOpen(prev => new Set([...prev, ...fresh]));
  }, [openIds, rows, setOpen]);
}

function useRoutedOpen(selectedId: string | null | undefined, setOpen: Dispatch<SetStateAction<Set<string>>>) {
  const routed = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId === undefined) return;
    const previous = routed.current;
    routed.current = selectedId;
    setOpen(open => {
      const next = new Set(open);
      if (previous) next.delete(previous);
      if (selectedId) next.add(selectedId);
      return next;
    });
  }, [selectedId, setOpen]);
}

/* A table that needs more than its frame by whole words stands as entries, as on a phone, before a phone's width:
   measured again as the frame changes, the rows shown change, and the fonts come. A change of the frame is measured in
   the next frame: turning into entries inside the observer would change the frame it is watching. */
export function useEntriesFit(frame: RefObject<HTMLDivElement | null>, shown: string) {
  useLayoutEffect(() => {
    const host = frame.current;
    const table = host?.querySelector('table');
    if (!host || !table) return;
    const measure = () => fitTable(table);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    let next = 0;
    const observer = guardedResizeObserver(() => {
      cancelAnimationFrame(next);
      next = requestAnimationFrame(measure);
    }, 'table');
    observer.observe(host);
    void document.fonts?.ready.then(measure);
    return () => {
      cancelAnimationFrame(next);
      observer.disconnect();
    };
  }, [frame, shown]);
}

function visibleRows<T extends { id: string }>(rows: readonly T[], selectedId: string | null | undefined, needle: string, search: TableSearch<T> | undefined, language: string, filters: FilterGroup<T>[], selected: Selections): T[] {
  return rows.filter(row => row.id === selectedId || ((!needle || search?.text(row).toLocaleLowerCase(language).includes(needle)) && matchesFilters(row, filters, selected)));
}

export function SortTable<T extends { id: string }>({ rows, columns, name, initialSort, card, search, filters = [], openIds, selectedId, onSelect }: Props<T>) {
  const t = useT();
  const { language } = useLanguage();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Selections>({});
  const [sort, setSort] = useState(initialSort);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [order, setOrder] = useState<string[]>([]);
  useRoutedOpen(selectedId, setOpen);
  const column = columns.find(c => c.key === sort.key) ?? columns[0]!;
  const sorted = sortRows(rows, column, sort.direction, name, language);
  const held = rows.some(r => open.has(r.id));
  const ordered = orderRows(sorted, order, held);
  const needle = query.trim().toLocaleLowerCase(language);
  const visible = visibleRows(ordered, selectedId, needle, search, language, filters, selected);
  const filtered = Boolean(needle || Object.values(selected).some(values => values.length));
  const frame = useRef<HTMLDivElement>(null);
  useEntriesFit(frame, `${language} ${visible.map(r => r.id).join(' ')}`);

  /* Record additions and removals after each refresh, keeping all surviving cards and their places. */
  useEffect(() => {
    setOrder(previous => orderRows(rows, previous, true).map(r => r.id));
    setOpen(previous => new Set([...previous].filter(id => rows.some(r => r.id === id))));
  }, [rows]);
  useAutoOpen(openIds, rows, setOpen);

  function toggleFilter(key: string, value: string) {
    setSelected(previous => {
      const values = previous[key] ?? [];
      return { ...previous, [key]: values.includes(value) ? values.filter(v => v !== value) : [...values, value] };
    });
  }

  function toggle(id: string) {
    onSelect?.(open.has(id) ? null : id);
    setOrder(ordered.map(r => r.id));
    setOpen(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function choose(column: TableColumn<T>) {
    const next = nextSort(sort, column);
    setSort(next);
    setOrder(sortRows(rows, column, next.direction, name, language).map(r => r.id));
  }

  return <>
    {search && <>
      <TableTools rows={rows} groups={filters} selected={selected} toggle={toggleFilter} clear={key => setSelected(previous => ({ ...previous, [key]: [] }))} query={query} setQuery={setQuery} placeholder={search.placeholder} short={search.short} />
      <ResultLine filtered={filtered} count={search.count(rows.length)} shown={visible.length} all={rows.length} clear={() => { setQuery(''); setSelected({}); }} />
    </>}
    {search && visible.length === 0 && <p className="nothing">{t.tables.noMatch}</p>}
    <Edge className="tbl-frame"><div className="tbl" ref={frame}>
      <SortBar columns={columns} sort={sort} choose={choose} />
      <table className="dt">
        <TableHead columns={columns} sort={sort} choose={choose} />
        <tbody>{visible.map(row => <Fragment key={row.id}>
          <TableRow row={row} columns={columns} name={name(row)} expanded={open.has(row.id)} toggle={() => toggle(row.id)} />
          {open.has(row.id) && <tr className="det"><td colSpan={columns.length}>{card(row)}</td></tr>}
        </Fragment>)}</tbody>
      </table>
    </div></Edge>
  </>;
}
