/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { checkSizes } from './owner-screens-sizes';

/* After every browser drew the lower part of a plan's card, each of its pieces is as high and as wide in each browser,
   within 1px. */
export default function compareSizes(): void {
  checkSizes(fileURLToPath(new URL('results/plan-card-lower', import.meta.url)));
}
