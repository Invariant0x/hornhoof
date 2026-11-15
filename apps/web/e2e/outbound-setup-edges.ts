/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* After every browser drew the outbound setup, its column stands at the same place in each of them, in Settings and on
   the department's screen, within 1px: the room for a scrollbar is the same whether a browser's bar takes room or not.
   Each test leaves where it measured in an edges.json of its own; a look drawn by one browser only is compared with none. */
export type Measured = { browser: string; look: string; screen: string; left: number; right: number };

const RESULTS = fileURLToPath(new URL('results/outbound-setup', import.meta.url));

function measured(dir: string): Measured[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap(entry => (entry === 'edges.json' ? (JSON.parse(readFileSync(join(dir, entry), 'utf8')) as Measured[]) : entry.includes('.') ? [] : measured(join(dir, entry))));
}

export function apart(all: readonly Measured[]): string[] {
  const places = new Map<string, Measured[]>();
  for (const m of all) places.set(`${m.screen} ${m.look}`, [...(places.get(`${m.screen} ${m.look}`) ?? []), m]);
  return [...places].flatMap(([place, ms]) => {
    const spread = (side: 'left' | 'right') => Math.max(...ms.map(m => m[side])) - Math.min(...ms.map(m => m[side]));
    return spread('left') > 1 || spread('right') > 1 ? [`${place}: ${ms.map(m => `${m.browser} ${m.left}…${m.right}`).join(', ')}`] : [];
  });
}

export default function compareEdges(): void {
  const off = apart(measured(RESULTS));
  if (off.length) throw new Error(`The column of the outbound setup stands apart between browsers by more than 1px:\n${off.join('\n')}`);
}
