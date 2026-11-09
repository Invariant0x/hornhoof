import { expect, it } from 'vitest';
import { COLORS_WAIT_MS, colorsNotTaken, pastColors } from '../src/providers/antigravity.js';

/* An Enter that reached agy's terms would tick or untick the box there, so the node presses on the colors once per agy. */
it('presses Enter on the colors once per agy, however long agy then takes to show its terms', async () => {
  const colors = 'Welcome to Antigravity CLI!\n Choose your color scheme:\n > terminal\n   light\n   dark\n [Next]';
  const terms = 'Terms of Service & Data Use\n > [x] Yes, I agree\n [Previous]      [Done]';
  let enters = 0;
  const enter = async () => { enters += 1; };
  const pressed = { at: -Infinity };
  expect(await pastColors(colors, enter, pressed, 1000)).toBe('colors');
  expect(colorsNotTaken('colors', pressed, 1000 + COLORS_WAIT_MS - 1)).toBe(false);
  expect(await pastColors(colors, enter, pressed, 1000 + 10 * COLORS_WAIT_MS)).toBe('colors');
  expect(enters).toBe(1);
  /* An agy that still shows the colors then did not take the Enter. */
  expect(colorsNotTaken('colors', pressed, 1000 + COLORS_WAIT_MS)).toBe(true);
  expect(await pastColors(terms, enter, pressed, 1000 + 11 * COLORS_WAIT_MS)).toBe('terms');
  expect(colorsNotTaken('terms', pressed, 1000 + 11 * COLORS_WAIT_MS)).toBe(false);
  expect(enters).toBe(1);
});
