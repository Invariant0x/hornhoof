import { expect, it } from 'vitest';
import { route } from '../src/author-sample.js';

it('routes one', () => {
  expect(route(1)).toBe(1);
});
