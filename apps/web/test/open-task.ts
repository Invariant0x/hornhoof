import { screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

/* Opens a task from the Tasks board as a person does: its card's title opens the whole task at the side. */
export async function openFromBoard(user: ReturnType<typeof userEvent.setup>, name: RegExp): Promise<void> {
  const card = await screen.findByRole('article', { name });
  await user.click(within(card).getAllByRole('button')[0]!);
}
