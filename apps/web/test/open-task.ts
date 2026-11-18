import { screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';

const FOUND = new RegExp(`^(${en.tracker.search.results}|${ru.tracker.search.results})$`);

/* Opens a task from the tracker as a person does: finds it by its number and clicks its title, which opens its card at the side. */
export async function openFromTracker(user: ReturnType<typeof userEvent.setup>, number: number): Promise<void> {
  const search = await screen.findByRole('searchbox');
  await user.clear(search);
  await user.type(search, String(number));
  const row = await within(await screen.findByRole('region', { name: FOUND })).findByRole('listitem', { name: new RegExp(`^#${number} `) });
  await user.click(within(row).getAllByRole('button')[0]!);
}

export async function openTaskAction(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement, action?: string): Promise<void> {
  const card = within(panel);
  const trigger = await card.findByRole('button', { name: new RegExp(`^(${en.tasks.taskActions}|${ru.tasks.taskActions})$`) });
  if (trigger.getAttribute('aria-expanded') === 'false') await user.click(trigger);
  else await user.click(card.getByRole('button', { name: new RegExp(`^(${en.tasks.backToActions}|${ru.tasks.backToActions})$`) }));
  if (action) await user.click(card.getByRole('button', { name: action }));
}
