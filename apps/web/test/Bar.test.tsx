import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Share } from '../src/ui/Bar';

it('sets a share apart as the words of its language give it, adding no sign of its own', () => {
  const { container } = render(<p><Share>{'42 %'}</Share> <Share>{'%42'}</Share></p>);
  expect([...container.querySelectorAll('.pct')].map(n => n.textContent)).toEqual(['42 %', '%42']);
});
