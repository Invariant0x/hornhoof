import { describe, expect, it } from 'vitest';
import { tokenCount } from '../src/ui/token-count';

/* A count of tokens reads whole below a million, and short from there on, as millions and billions of a busy day. */
describe('a count of tokens', () => {
  it.each([
    ['en', 0, '0'], ['en', 999_999, '999,999'], ['en', 1_000_000, '1M'], ['en', 1_254_200, '1.3M'], ['en', 26_250_000, '26.3M'], ['en', 2_345_678_901, '2.3B'],
    ['ru', 999_999, '999 999'], ['ru', 1_254_200, '1,3 млн'], ['ru', 26_250_000, '26,3 млн'], ['ru', 2_345_678_901, '2,3 млрд'],
  ])('in %s writes %d as %s', (language, n, shown) => {
    expect(tokenCount(language, n).replace(/\s/g, ' ')).toBe(shown);
  });
});
