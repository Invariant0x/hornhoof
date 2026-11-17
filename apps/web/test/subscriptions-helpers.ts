import { act, configure, fireEvent, getConfig, screen } from '@testing-library/react';
import rawUserEvent from '@testing-library/user-event';
import { afterEach, beforeEach, vi } from 'vitest';
import { mockApi, SUBS } from './api-mock';
import { eventually } from '../../../test-support/eventually.mjs';

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
  await waitFor(() => screen.getByRole('table'));
  openCards();
};

/* All waits and screen refreshes use the test clock; cleanup runs before it is restored. */
const asyncWrapper = getConfig().asyncWrapper;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  configure({ asyncWrapper: async callback => {
    let result: unknown;
    await act(async () => { result = await callback(); });
    return result;
  } });
});
afterEach(() => { configure({ asyncWrapper }); vi.useRealTimers(); });

/* Flush React and wait for the state on event-loop turns, with no deadline or timer poll. */
export async function waitFor<T>(check: () => T): Promise<T> {
  let result!: T;
  await eventually(async () => {
    await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
    try { result = check(); return true; } catch { return false; }
  });
  return result;
}

/* Keep each click and each typed character, with no pause on the machine's clock. */
export const userEvent = {
  click: (element: Element) => rawUserEvent.click(element, { delay: null }),
  clear: (element: Element) => rawUserEvent.setup({ delay: null }).clear(element),
  type: (element: Element, text: string) => rawUserEvent.type(element, text, { delay: null }),
  selectOptions: (element: Element, values: string) => rawUserEvent.selectOptions(element, values, { delay: null }),
  setup: () => rawUserEvent.setup({ delay: null }),
};
