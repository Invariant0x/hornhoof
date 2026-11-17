import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NameWithSign } from '../src/ui/Cards';

/* A sign after a name's last letter: the name reads whole, and only its last letter stands with the sign where no line
   break parts them, so the rest of the name wraps as ever. */
describe('NameWithSign', () => {
  it.each([
    ['Claude Max', 'x'],
    ['Northern region gateway ••••M3N4', '4'],
    ['Acme 🦊', '🦊'],
    ['K', 'K'],
  ])('keeps %j whole and holds its last letter %j with the sign', (name, last) => {
    const { container } = render(<b><NameWithSign name={name} sign={<i role="img" aria-label="sign" />} /></b>);
    const held = container.querySelector('.name-end')!;
    expect(container.textContent).toBe(name);
    expect(held.textContent).toBe(last);
    expect(held.lastElementChild).toHaveAttribute('aria-label', 'sign');
  });
});
