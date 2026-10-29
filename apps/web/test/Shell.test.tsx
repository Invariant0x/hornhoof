import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { ME, mockApi, ORG } from './api-mock';

function renderShell() {
  mockApi({ 'GET /api/org': [200, ORG] });
  return render(
    <LanguageProvider>
      <Shell me={ME} onSignOut={() => {}} />
    </LanguageProvider>,
  );
}

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('Shell', () => {
  it('speaks the saved language and switches it from the account menu', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const user = userEvent.setup();
    renderShell();
    expect(screen.getByRole('button', { name: 'Карта' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Люди' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('ru');
    await user.click(screen.getByRole('button', { name: 'Аккаунт' }));
    await user.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByRole('button', { name: 'Map' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'People' })).toBeInTheDocument();
    expect(localStorage.getItem('hh-lang')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('keeps the theme in the account menu, not in the top bar', async () => {
    const user = userEvent.setup();
    renderShell();
    expect(screen.queryByRole('button', { name: /theme/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('closes the account menu on Escape and on a click outside it', async () => {
    const user = userEvent.setup();
    renderShell();
    const account = screen.getByRole('button', { name: 'Account' });
    await user.click(account);
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
    await user.click(account);
    await act(async () => {
      await user.click(document.body);
    });
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
  });
});
