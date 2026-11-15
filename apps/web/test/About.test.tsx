import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { ME, mockApi, ORG } from './api-mock';
import { decl } from './css';

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
    expect(within(box).queryByText('Developer')).not.toBeInTheDocument();
    expect(within(box).queryByText('Ivan Korol', { exact: true })).not.toBeInTheDocument();
    expect(within(box).queryByText(/Copyright/)).not.toBeInTheDocument();
    expect(within(box).getByText('Author: Ivan Korol, © 2026')).toBeInTheDocument();
    for (const [name, href] of [
      ['MIT', 'https://github.com/Invariant0x/hornhoof/blob/main/LICENSE'],
      ['Source code', 'https://github.com/Invariant0x/hornhoof'],
      ['hornhoof.org', 'https://hornhoof.org'],
    ]) {
      const link = within(box).getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(within(box).getAllByRole('link')).toHaveLength(3);
    expect(within(box).queryByText('Contact')).not.toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: 'Report a bug or suggest an idea' })).not.toBeInTheDocument();
    expect(within(box).getByRole('region', { name: 'Feedback' })).toBeInTheDocument();
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
    const feedback = within(box).getByRole('region', { name: 'Обратная связь' });
    expect(within(feedback).getByText('Сообщите об ошибке или предложите улучшение. Перед отправкой вы увидите ровно то, что уйдет разработчикам Hornhoof.')).toBeInTheDocument();
    await user.click(within(feedback).getByRole('button', { name: 'Написать разработчикам' }));
    expect(within(box).getByRole('button', { name: 'Далее' })).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: 'Отмена' })).toBeInTheDocument();
    expect(within(box).queryByText('Разработчик')).not.toBeInTheDocument();
    expect(within(box).getByText('Автор: Ivan Korol, © 2026')).toBeInTheDocument();
    expect(box.textContent!).not.toMatch(/[\u0451\u2014]/);
    await user.click(within(box).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps Tab and Shift+Tab inside the open dialog, with the feedback closed and open', async () => {
    const user = page();
    await open(user);
    const box = screen.getByRole('dialog', { name: 'About Hornhoof' });
    const close = within(box).getByRole('button', { name: 'Close' });
    const write = within(box).getByRole('button', { name: 'Write to developers' });
    await user.tab({ shift: true });
    expect(write).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    for (const [role, name] of [['link', 'MIT'], ['link', 'Source code'], ['link', 'hornhoof.org'], ['button', 'Write to developers']] as const) {
      await user.tab();
      expect(within(box).getByRole(role, { name })).toHaveFocus();
    }
    await user.tab();
    expect(close).toHaveFocus();
    await user.click(write);
    expect(within(box).getByRole('button', { name: 'Bug' })).toHaveFocus();
    for (const [role, name] of [['button', 'Improvement'], ['button', 'Idea'], ['textbox', 'Title'], ['textbox', 'What happened, or what you would like'], ['button', 'Next'], ['button', 'Cancel']] as const) {
      await user.tab();
      expect(within(box).getByRole(role, { name })).toHaveFocus();
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
    expect(within(box).getByText('Loading…', { selector: 'dd' })).toBeInTheDocument();
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

  it('stands as Design draws it: description, facts, author, a line, then Feedback closed to one sentence and a secondary button', async () => {
    const user = page();
    await open(user);
    const box = screen.getByRole('dialog', { name: 'About Hornhoof' });
    expect([...box.children].map(child => `${child.tagName.toLowerCase()}${child.className ? `.${child.className.split(' ').join('.')}` : ''}`)).toEqual(['header', 'p', 'dl.facts', 'p.about-author', 'hr.about-sep', 'section.about-feedback']);
    const feedback = within(box).getByRole('region', { name: 'Feedback' });
    expect(within(feedback).getByRole('heading', { level: 3, name: 'Feedback' })).toBeInTheDocument();
    expect(within(feedback).getByText('Report a bug or suggest an improvement. Before anything leaves, you see exactly what goes to Hornhoof developers.')).toBeInTheDocument();
    const write = within(feedback).getByRole('button', { name: 'Write to developers' });
    expect(write).toHaveClass('btn', 'ghost');
    expect(write.parentElement).toHaveClass('form-foot');
    expect(within(feedback).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(feedback).queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('opens the form in place, with Next as the main button and Cancel beside it, and Cancel closes it back to its button', async () => {
    const user = page();
    await open(user);
    const box = screen.getByRole('dialog', { name: 'About Hornhoof' });
    await user.click(within(box).getByRole('button', { name: 'Write to developers' }));
    const next = within(box).getByRole('button', { name: 'Next' });
    const cancel = within(box).getByRole('button', { name: 'Cancel' });
    expect(next).toHaveClass('btn');
    expect(next).not.toHaveClass('ghost');
    expect(cancel).toHaveClass('btn', 'ghost');
    expect(next.parentElement).toBe(cancel.parentElement);
    expect(next.parentElement).toHaveClass('form-foot');
    expect(within(box).getByRole('region', { name: 'Feedback' })).toBeInTheDocument();
    await user.type(within(box).getByLabelText('Title'), 'Froze');
    await user.click(cancel);
    expect(within(box).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(box).getByRole('button', { name: 'Write to developers' })).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'About Hornhoof' })).toBeInTheDocument();
  });

  it('gives its cross a 44 px target, its window 480 px and its text 14 px, its facts and author in their small sizes', () => {
    expect(decl('.icon-btn', 'inline-size')).toBe('44px');
    expect(decl('.icon-btn', 'block-size')).toBe('44px');
    expect(decl('.icon-btn', 'padding')).toBe('0');
    expect(decl('.dialog.about', 'inline-size')).toBe('min(480px, 100%)');
    expect(decl('.dialog.about', 'width')).toBeUndefined();
    expect(decl('.dialog.about', 'font-size')).toBeUndefined();
    expect(decl('.dialog.about', 'gap')).toBe('12px');
    expect(decl('.dialog.about .facts', 'font-size')).toBe('13.5px');
    expect(decl('.dialog.about .about-author', 'font-size')).toBe('12px');
    expect(decl('.about-sep', 'border-block-start')).toBe('1px solid var(--line)');
  });

  it('keeps the same 18 px of room for a scrollbar at its end in every browser, measured on the window', async () => {
    expect(decl('.dialog.about', 'padding')).toBe('18px');
    expect(decl('.dialog.about', 'scrollbar-gutter')).toBe('stable');
    expect(decl('.dialog.about', 'padding-inline-end')).toBe('calc(18px + max(0px, 18px - var(--sb, 0px)))');
    const user = page();
    await open(user);
    const box = screen.getByRole('dialog', { name: 'About Hornhoof' });
    const close = within(box).getByRole('button', { name: 'Close' });
    expect(close).toHaveClass('btn', 'ghost', 'icon-btn');
    expect(close).not.toHaveClass('small');
    /* jsdom draws no scrollbar. */
    expect(box.style.getPropertyValue('--sb')).toBe('0px');
  });
});
