import { act, fireEvent, screen } from '@testing-library/react';
import { mockApi, SUBS } from './api-mock';

/* What the Subscriptions screen tests share: the install command the node lists answer with, the lists they serve, and
   how they find a plan's row or card and open them. */
export const COMMAND = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join CODE123';

export const lists = (extra: Parameters<typeof mockApi>[0] = {}) => mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  'GET /api/subscriptions': [200, { subscriptions: SUBS }], ...extra });

export const rowOf = (name: string) => screen.queryByRole('article', { name: new RegExp(`^${name}, `) }) ?? screen.getByRole('row', { name: new RegExp(`^${name}\\b`) });
/* Opens every plan's card, as clicks on each row's button do, in one act: the screen renders once for all of them. */
export const openCards = () => {
  const buttons = screen.getAllByRole('button', { name: /^(Open the card of |Открыть карточку )/ });
  act(() => { for (const button of buttons) fireEvent.click(button); });
};
export const openAll = async () => {
  await screen.findByRole('table');
  openCards();
};
