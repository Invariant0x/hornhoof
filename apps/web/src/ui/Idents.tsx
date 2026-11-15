import { Fragment, type ReactNode } from 'react';

/* A sentence with the addresses, accounts and names in it each in a box of its own, left to right in any direction: a
   box moves to the next line whole where it fits a line of its own, instead of breaking at a hyphen or a dot, and breaks
   inside only where it is longer than a line. idents: the values to box, as they stand in text; empty ones are skipped. */
export function Idents({ text, idents }: { text: string; idents: readonly (string | null | undefined)[] }) {
  const values = [...new Set(idents.filter((value): value is string => Boolean(value)))].sort((a, b) => b.length - a.length);
  if (!values.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let rest = text;
  for (let at = 0; rest; at++) {
    const found = values.map(value => ({ value, index: rest.indexOf(value) })).filter(hit => hit.index >= 0).sort((a, b) => a.index - b.index)[0];
    if (!found) {
      parts.push(rest);
      break;
    }
    if (found.index > 0) parts.push(rest.slice(0, found.index));
    parts.push(<bdi key={at} className="ident" dir="ltr">{found.value}</bdi>);
    rest = rest.slice(found.index + found.value.length);
  }
  return <>{parts.map((part, at) => (typeof part === 'string' ? <Fragment key={`t${at}`}>{part}</Fragment> : part))}</>;
}
