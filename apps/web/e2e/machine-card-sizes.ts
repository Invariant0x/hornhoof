/// <reference types="node" />
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apart, measured } from './owner-screens-sizes';

/* After every engine drew the cards of machine-card.spec.ts, each of their pieces is as high and as wide in each engine,
   within 1px. What was compared is left beside the results, for Design. */
export default function compareCardSizes(): void {
  const dir = fileURLToPath(new URL('results/machine-card', import.meta.url));
  const all = measured(dir);
  const off = apart(all);
  writeFileSync(`${dir}/sizes-compare.json`, JSON.stringify({ measured: all.length, sizes: all.reduce((n, m) => n + Object.keys(m.sizes).length, 0), apart: off }, null, 2));
  if (off.length) throw new Error(`Pieces of a machine's card differ in size between engines by more than 1px:\n${off.join('\n')}`);
}
