import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Share } from '../src/ui/Bar';

/* The share as its language writes it, with only the percent sign set apart: the figures stay in the font of their line. */
const parts = (text: string) => {
  const { container } = render(<p><Share>{text}</Share></p>);
  const line = container.querySelector('p')!;
  return { text: line.textContent, signs: [...line.querySelectorAll('.pct')].map(n => n.textContent), elements: line.children.length };
};

it('sets apart only the percent sign, keeping the order and the space its language gives', () => {
  expect(parts('42%')).toEqual({ text: '42%', signs: ['%'], elements: 1 });
  expect(parts('42 %')).toEqual({ text: '42 %', signs: ['%'], elements: 1 });
  expect(parts('%42')).toEqual({ text: '%42', signs: ['%'], elements: 1 });
});

it("sets apart the percent sign of a language that writes its own, and leaves a share without a sign as it is", () => {
  expect(parts('٪٤٢')).toEqual({ text: '٪٤٢', signs: ['٪'], elements: 1 });
  expect(parts('42％')).toEqual({ text: '42％', signs: ['％'], elements: 1 });
  expect(parts('42')).toEqual({ text: '42', signs: [], elements: 0 });
});
