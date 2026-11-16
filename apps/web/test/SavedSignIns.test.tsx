import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { SavedSignIns } from '../src/ui/SavedSignIns';
import { mockApi } from './api-mock';

/* The saved sign-ins on an employee's card: where it opens pages as signed in, who saved each and when, and a revoke with
   one press, as a person takes back a sign-in at once. Nothing of a sign-in itself is ever on the card. */

const PATH = '/api/agents/b1/sign-ins';
const SIGN_INS = [
  { id: 's1', site: 'https://www.artstation.com', source: 'person', savedBy: { id: 'p2', name: 'Clara' }, savedAt: '2026-11-16T15:00:00.000Z' },
  { id: 's2', site: 'https://partner.example', source: 'vault', savedBy: null, savedAt: '2026-11-15T09:30:00.000Z' },
];

function show(routes: Record<string, [number, unknown?]>, language: 'en' | 'ru' = 'en') {
  localStorage.setItem('hh-lang', language);
  const calls = mockApi(routes);
  render(
    <LanguageProvider>
      <SavedSignIns agentId="b1" />
    </LanguageProvider>,
  );
  return { calls };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('SavedSignIns', () => {
  it('lists where the employee is signed in, who saved each sign-in and when', async () => {
    show({ [`GET ${PATH}`]: [200, { signIns: SIGN_INS }] });
    const region = await screen.findByRole('region', { name: 'Saved sign-ins' });
    const items = await within(region).findAllByRole('listitem');
    expect(items.map(i => i.querySelector('.entry-main')!.textContent)).toEqual([
      expect.stringMatching(/^Sign-in to www\.artstation\.com saved by Clara, \S/),
      expect.stringMatching(/^Sign-in to partner\.example saved from the vault, \S/),
    ]);
    expect(within(items[0]!).getByRole('button', { name: 'Revoke the sign-in to www.artstation.com' })).toHaveTextContent('Revoke');
  });

  it('says a sign-in was saved without a name when the person who saved it has left', async () => {
    show({ [`GET ${PATH}`]: [200, { signIns: [{ ...SIGN_INS[0], savedBy: null }] }] });
    const item = await screen.findByRole('listitem');
    expect(item.querySelector('.entry-main')!.textContent).toMatch(/^Sign-in to www\.artstation\.com saved, \S/);
  });

  it('revokes a sign-in with one press, and it leaves the list', async () => {
    const user = userEvent.setup();
    const { calls } = show({ [`GET ${PATH}`]: [200, { signIns: SIGN_INS }], [`DELETE ${PATH}/s1`]: [204] });
    const first = (await screen.findAllByRole('listitem'))[0]!;
    await user.click(within(first).getByRole('button', { name: 'Revoke the sign-in to www.artstation.com' }));
    await vi.waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(calls.filter(c => c.method === 'DELETE').map(c => c.path)).toEqual([`${PATH}/s1`]);
    expect(screen.getByRole('listitem').querySelector('.entry-main')!.textContent).toMatch(/^Sign-in to partner\.example saved from the vault/);
    expect(screen.queryByText(/www\.artstation\.com/)).toBeNull();
  });

  it('keeps a sign-in it could not revoke on the list, and says why', async () => {
    const user = userEvent.setup();
    show({ [`GET ${PATH}`]: [200, { signIns: SIGN_INS }], [`DELETE ${PATH}/s1`]: [403, { error: { code: 'forbidden', message: 'This employee is not on a plan of yours.' } }] });
    const first = (await screen.findAllByRole('listitem'))[0]!;
    await user.click(within(first).getByRole('button', { name: 'Revoke the sign-in to www.artstation.com' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This employee is not on a plan of yours.');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('says when there is no saved sign-in, and when the list could not be read', async () => {
    show({ [`GET ${PATH}`]: [200, { signIns: [] }] });
    expect(await screen.findByText('No saved sign-ins yet.')).toBeInTheDocument();
    cleanup();
    show({ [`GET ${PATH}`]: [500, { error: { code: 'internal', message: 'Something broke.' } }] });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something broke.');
  });

  it('speaks Russian in plain words', async () => {
    show({ [`GET ${PATH}`]: [200, { signIns: SIGN_INS }] }, 'ru');
    const region = await screen.findByRole('region', { name: 'Сохраненные входы' });
    const items = await within(region).findAllByRole('listitem');
    expect(items[0]!.querySelector('.entry-main')!.textContent).toMatch(/^Вход в www\.artstation\.com сохранен: Clara, \S/);
    expect(items[1]!.querySelector('.entry-main')!.textContent).toMatch(/^Вход в partner\.example сохранен из хранилища паролей, \S/);
    expect(within(items[0]!).getByRole('button', { name: 'Отозвать вход в www.artstation.com' })).toHaveTextContent('Отозвать');
  });
});
