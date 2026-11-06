import { expect, it } from 'vitest';
import { first, second } from '../src/author-sample.js';

it('both give the same', () => {
  expect(first(0)).toBe(1);
  expect(first(3)).toBe(49);
  expect(second(0)).toBe(1);
  expect(second(3)).toBe(49);
});
