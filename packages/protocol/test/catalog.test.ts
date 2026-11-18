import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as catalog from '../src/catalog.js';
import * as protocol from '../src/index.js';

const source = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

/* The browser draws the department and company cards from the same catalog the server builds companies from. The catalog
   stands apart from the validators, so the web loads it without them, and the main entry gives the server the very same
   lists. */
describe('the department and company catalog', () => {
  it('is a subpath of its own that imports nothing', () => {
    expect(JSON.parse(source('package.json')).exports['./catalog']).toEqual({ types: './dist/catalog.d.ts', default: './dist/catalog.js' });
    expect(source('src/catalog.ts')).not.toMatch(/^\s*import\b/m);
  });

  it('is the same lists from the main entry', () => {
    expect(protocol.TEMPLATE_KEYS).toBe(catalog.TEMPLATE_KEYS);
    expect(protocol.DEPARTMENT_TEMPLATES).toBe(catalog.DEPARTMENT_TEMPLATES);
    expect(protocol.COMPANY_TEMPLATE_KEYS).toBe(catalog.COMPANY_TEMPLATE_KEYS);
    expect(protocol.COMPANY_TEMPLATES).toBe(catalog.COMPANY_TEMPLATES);
  });
});
