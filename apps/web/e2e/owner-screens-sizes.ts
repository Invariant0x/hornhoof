/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* After every browser drew the screens a person who runs a department keeps, each of their pieces is as high and as wide
   in each browser, within 1px. Each test leaves what it measured in a sizes.json of its own; a look drawn by one browser
   only is compared with none. */
export type Measured = { browser: string; look: string; screen: string; sizes: Record<string, number> };

function measured(dir: string): Measured[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap(entry => (entry === 'sizes.json' ? (JSON.parse(readFileSync(join(dir, entry), 'utf8')) as Measured[]) : entry.includes('.') ? [] : measured(join(dir, entry))));
}

export function apart(all: readonly Measured[]): string[] {
  const places = new Map<string, Measured[]>();
  for (const m of all) places.set(`${m.screen} ${m.look}`, [...(places.get(`${m.screen} ${m.look}`) ?? []), m]);
  return [...places].flatMap(([place, ms]) => {
    const pieces = new Set(ms.flatMap(m => Object.keys(m.sizes)));
    return [...pieces].flatMap(piece => {
      const values = ms.map(m => m.sizes[piece] ?? NaN);
      const spread = Math.max(...values) - Math.min(...values);
      return spread > 1 || Number.isNaN(spread) ? [`${place}, ${piece}: ${ms.map(m => `${m.browser} ${m.sizes[piece] ?? 'none'}`).join(', ')}`] : [];
    });
  });
}

export function checkSizes(dir: string): void {
  const off = apart(measured(dir));
  if (off.length) throw new Error(`Pieces of the owner's screens differ in size between browsers by more than 1px:\n${off.join('\n')}`);
}

export default function compareSizes(): void {
  checkSizes(fileURLToPath(new URL('results/owner-screens', import.meta.url)));
}
