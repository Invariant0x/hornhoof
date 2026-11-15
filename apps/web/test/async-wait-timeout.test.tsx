import { render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { expect, it } from 'vitest';

/* A loaded machine can make a render take longer than Testing Library's default one second wait. */
const LATE_MS = 1100;

function LateButton() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), LATE_MS);
    return () => clearTimeout(timer);
  }, []);
  return shown ? <button>Task</button> : null;
}

it('finds an element that appears a little after one second', async () => {
  render(<LateButton />);
  expect(await screen.findByRole('button', { name: 'Task' })).toBeInTheDocument();
});
