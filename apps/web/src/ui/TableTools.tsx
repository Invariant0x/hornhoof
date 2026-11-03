import type { ReactNode } from 'react';
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
};
export function providerFilter<T>(label: string, providers: (row: T) => ProviderId[]): FilterGroup<T> {
  return {
    key: 'provider', label, values: row => providers(row).map(p => PROGRAM_NAMES[p]), text: value => value,
    mark: value => <ProviderMark provider={PLAN_PROVIDERS.find(p => PROGRAM_NAMES[p] === value) ?? null} />,
  };
}

export type Selections = Record<string, string[]>;
export type TableSearch<T> = { placeholder: string; text: (row: T) => string; count: (n: number) => string };

type Option = { value: string; count: number };

function optionsFor<T>(rows: readonly T[], group: FilterGroup<T>): Option[] {
  const counts = new Map<string, number>();
  for (const row of rows) for (const value of new Set(group.values(row))) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count }));
}

export function matchesFilters<T>(row: T, groups: FilterGroup<T>[], selected: Selections): boolean {
  return groups.every(group => !selected[group.key]?.length || group.values(row).some(value => selected[group.key]!.includes(value)));
}

export function TableTools<T>({ rows, groups, selected, toggle, query, setQuery, placeholder }: {
  rows: readonly T[]; groups: FilterGroup<T>[]; selected: Selections; toggle: (key: string, value: string) => void; query: string; setQuery: (query: string) => void; placeholder: string;
}) {
  const t = useT();
  return <Edge className="tools"><div className="tools-r1"><label className="search"><svg className="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" /><path d="m10 10 4 4" /></svg><span className="sr">{t.tables.search}</span><input type="search" autoComplete="off" placeholder={placeholder} value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    <div className="tools-r2">{groups.map(group => {
      const options = optionsFor(rows, group);
      if (options.length < (group.single ? 1 : 2)) return null;
      return <div key={group.key} className="fgroup" role="group" aria-label={group.label}><span className="lbl">{group.label}</span>{options.map(option => <button key={option.value} className="chipf" type="button" aria-pressed={Boolean(selected[group.key]?.includes(option.value))} onClick={() => toggle(group.key, option.value)}>{group.mark?.(option.value)}{group.text(option.value)}<span className="n">{option.count}</span></button>)}</div>;
    })}</div>
  </Edge>;
}
