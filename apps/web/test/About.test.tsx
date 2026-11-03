import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { ME, mockApi, ORG } from './api-mock';

const PERSON = { ...ME, person: { ...ME.person, scopeKind: 'listed' as const, isOwner: false } };
const VERSION = { version: '0.5.0', commit: 'abc1234' };
type Reply = [number, unknown];

function page(language = 'en', version: Reply | (() => Promise<Reply>) = [200, VERSION]) {
  localStorage.setItem('hh-lang', language);
  mockApi({ 'GET /api/org': [200, ORG], 'GET /api/version': [200, VERSION], 'GET /api/updates/current': version });
  render(<LanguageProvider><Shell me={PERSON} onSignOut={() => {}} /></LanguageProvider>);
  return userEvent.setup();
}

async function open(user: ReturnType<typeof userEvent.setup>, account = 'Account', item = 'About') {
  await user.click(screen.getByRole('button', { name: account }));
  await user.click(screen.getByRole('button', { name: item }));
}

afterEach(() => localStorage.clear());

describe('About from the account menu', () => {
  it('lets a person with department access read the build, author, license and contact links', async () => {
    const user = page();
    await open(user);
    const box = await screen.findByRole('dialog', { name: 'About Hornhoof' });
    expect(await within(box).findByText('0.5.0 (abc1234)')).toBeInTheDocument();
    expect(within(box).getByText('A company where people and agents work together.')).toBeInTheDocument();
    expect(within(box).getByText('Ivan Korol', { exact: true })).toBeInTheDocument();
    expect(within(box).getByText('Copyright (c) 2026 Ivan Korol')).toBeInTheDocument();
    for (const [name, href] of [
      ['MIT', 'https://github.com/Invariant0x/hornhoof/blob/main/LICENSE'],
      ['Source code', 'https://github.com/Invariant0x/hornhoof'],
      ['Report a bug or suggest an idea', 'https://github.com/Invariant0x/hornhoof/issues'],
      ['hornhoof.org', 'https://hornhoof.org'],
    ]) {
      const link = within(box).getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(within(box).getAllByRole('link')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Versions' })).not.toBeInTheDocument();
  });

  it.each(['cross', 'Escape', 'outside'])('closes through %s and returns focus to the account button', async way => {
    const user = page();
    await open(user);
    const box = await screen.findByRole('dialog', { name: 'About Hornhoof' });
    expect(box).toHaveFocus();
    await user.click(within(box).getByText('A company where people and agents work together.'));
    expect(box).toBeInTheDocument();
    if (way === 'cross') await user.click(within(box).getByRole('button', { name: 'Close' }));
    if (way === 'Escape') await user.keyboard('{Escape}');
    if (way === 'outside') await user.click(box.parentElement!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account' })).toHaveFocus();
  });

  it('speaks Russian for a person with department access', async () => {
    const user = page('ru');
    await open(user, 'Аккаунт', 'О программе');
    const box = await screen.findByRole('dialog', { name: 'О программе Hornhoof' });
    expect(await within(box).findByText('0.5.0 (abc1234)')).toBeInTheDocument();
    expect(within(box).getByText('Компания, где люди и агенты работают вместе.')).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: 'Сообщить об ошибке или предложить идею' })).toBeInTheDocument();
    expect(box.textContent).not.toMatch(/[\u0451\u2014]/);
    await user.click(within(box).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps Tab and Shift+Tab inside the open dialog', async () => {
    const user = page();
    await open(user);
    const box = screen.getByRole('dialog', { name: 'About Hornhoof' });
    const close = within(box).getByRole('button', { name: 'Close' });
    const website = within(box).getByRole('link', { name: 'hornhoof.org' });
    await user.tab({ shift: true });
    expect(website).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(website).toHaveFocus();
    await user.tab();
    for (const name of ['MIT', 'Source code', 'Report a bug or suggest an idea', 'hornhoof.org']) {
      await user.tab();
      expect(within(box).getByRole('link', { name })).toHaveFocus();
    }
    await user.tab();
    expect(close).toHaveFocus();
  });

  it('keeps the information available while the version loads', async () => {
    let answer!: (reply: Reply) => void;
    const pending = new Promise<Reply>(resolve => { answer = resolve; });
    const user = page('en', () => pending);
    await open(user);
    const box = screen.getByRole('dialog', { name: 'About Hornhoof' });
    expect(within(box).getByText('Loading…')).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: 'MIT' })).toBeInTheDocument();
    await act(async () => answer([200, VERSION]));
    expect(await within(box).findByText('0.5.0 (abc1234)')).toBeInTheDocument();
  });

  it('explains a version failure and retries when the window is opened again', async () => {
    let fails = true;
    const user = page('en', async () => fails ? [503, {}] : [200, VERSION]);
    await open(user);
    expect(await screen.findByText('The server version could not be loaded. Close this window and open it again to retry.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'MIT' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    fails = false;
    await open(user);
    expect(await within(screen.getByRole('dialog')).findByText('0.5.0 (abc1234)')).toBeInTheDocument();
  });
});
