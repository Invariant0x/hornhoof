/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { checkSizes } from './owner-screens-sizes';

export default function compareSortTableSizes(): void {
  checkSizes(fileURLToPath(new URL('results/sort-tables', import.meta.url)));
}
