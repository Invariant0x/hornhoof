import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { PLAN_PROVIDERS, PROGRAM_NAMES } from '../providers';
import type { ProviderId } from '../types';
import { ProviderMark } from './icons';
import { Edge } from './Edge';

export type FilterGroup<T> = {
  key: string;
  label: string;
  values: (row: T) => string[];
  text: (value: string) => string;
  mark?: (value: string) => ReactNode;
  single?: boolean;
  /* The word of a first button that shows every row again, with their count. */
  all?: string;
};
export function providerFilter<T>(label: string, providers: (row: T) => ProviderId[]): FilterGroup<T> {
  return {
    key: 'provider', label, values: row => providers(row).map(p => PROGRAM_NAMES[p]), text: value => value,
    mark: value => <ProviderMark provider={PLAN_PROVIDERS.find(p => PROGRAM_NAMES[p] === value) ?? null} />,
  };
}

export type Selections = Record<string, string[]>;
/* short: the hint where the whole one would not fit, on a phone. */
export type TableSearch<T> = { placeholder: string; short?: string; text: (row: T) => string; count: (n: number) => string };

const NARROW = '(max-width: 720px)';

/* Whether the screen is a phone's, as it changes. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(NARROW);
    if (!query) return;
    const change = () => setNarrow(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return narrow;
}

type Option = { value: string; count: number };

function optionsFor<T>(rows: readonly T[], group: FilterGroup<T>): Option[] {
  const counts = new Map<string, number>();
  for (const row of rows) for (const value of new Set(group.values(row))) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count }));
}

export function matchesFilters<T>(row: T, groups: FilterGroup<T>[], selected: Selections): boolean {
  return groups.every(group => !selected[group.key]?.length || group.values(row).some(value => selected[group.key]!.includes(value)));
}

type ToolsProps<T> = {
  rows: readonly T[]; groups: FilterGroup<T>[]; selected: Selections; toggle: (key: string, value: string) => void; clear: (key: string) => void;
  query: string; setQuery: (query: string) => void; placeholder: string; short?: string;
};

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return <button className="chipf" type="button" aria-pressed={pressed} onClick={onClick}>{children}</button>;
}

function Group<T>({ rows, group, selected, toggle, clear }: { rows: readonly T[]; group: FilterGroup<T>; selected: string[]; toggle: (value: string) => void; clear: () => void }) {
  const options = optionsFor(rows, group);
  if (options.length < (group.single ? 1 : 2)) return null;
  return <div className={`fgroup${group.all ? ' whole' : ''}`} role="group" aria-label={group.label}><span className="lbl">{group.label}</span>
    {group.all && <Chip pressed={!selected.length} onClick={clear}>{group.all}<span className="n">{rows.length}</span></Chip>}
    {options.map(option => <Chip key={option.value} pressed={selected.includes(option.value)} onClick={() => toggle(option.value)}>{group.mark?.(option.value)}{group.text(option.value)}<span className="n">{option.count}</span></Chip>)}
  </div>;
}

export function TableTools<T>({ rows, groups, selected, toggle, clear, query, setQuery, placeholder, short }: ToolsProps<T>) {
  const t = useT();
  const narrow = useNarrow();
  return <Edge className="tools"><div className="tools-r1"><label className="search"><svg className="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" /><path d="m10 10 4 4" /></svg><span className="sr">{t.tables.search}</span><input type="search" autoComplete="off" placeholder={narrow && short ? short : placeholder} value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    <div className="tools-r2">{groups.map(group => <Group key={group.key} rows={rows} group={group} selected={selected[group.key] ?? []} toggle={value => toggle(group.key, value)} clear={() => clear(group.key)} />)}</div>
  </Edge>;
}
