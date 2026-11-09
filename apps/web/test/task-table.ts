import { screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

/* Opens a task from the Tasks table as a person does: its row opens in place, and the button there opens the whole task at
   the side. */
export async function openFromTable(user: ReturnType<typeof userEvent.setup>, name: RegExp): Promise<void> {
  const row = await screen.findByRole('row', { name });
  const toggle = within(row).getByRole('button');
  if (toggle.getAttribute('aria-expanded') !== 'true') await user.click(toggle);
  await user.click(within(row.nextElementSibling as HTMLElement).getByRole('button', { name: /^(Open the task|Открыть задачу)$/ }));
}
