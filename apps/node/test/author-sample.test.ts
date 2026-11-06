import { expect, it } from 'vitest';
import { grade } from '../src/author-sample.js';

it('grades a score', () => {
  expect(grade(-1)).toBe('none');
  expect(grade(60)).toBe('high');
  expect(grade(10)).toBe('low');
});
