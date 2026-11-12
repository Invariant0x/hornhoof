import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Settings } from '../src/screens/Settings';
import { Shell } from '../src/screens/Shell';
import { initTheme } from '../src/theme';
import { COLOR_TOKENS, parseTemplate, sampleOf, TEMPLATE_LIMIT } from '../src/theme-template';
import { ME, mockApi, ORG } from './api-mock';

const root = document.documentElement;
const NEON = { format: 'hornhoof-theme', version: 1, name: 'Neon', base: 'cyberpunk', colors: { bg: '#010203' } };
const file = (body: string, name = 'neon.json') => new File([body], name, { type: 'application/json' });

function renderShell(person = ME.person) {
  mockApi({ 'GET /api/org': [200, ORG], 'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }], 'GET /api/repo-host': [200, { host: null }] });
  return render(
    <LanguageProvider>
      <Shell me={{ ...ME, person }} onSignOut={() => {}} />
    </LanguageProvider>,
  );
}

async function openTemplateWindow(user: ReturnType<typeof userEvent.setup>, names = { account: 'Account', item: 'Custom template…', title: 'Custom template' }) {
  await user.click(screen.getByRole('button', { name: names.account }));
  await user.click(screen.getByRole('button', { name: names.item }));
  return screen.findByRole('dialog', { name: names.title });
}

const themeButtons = () => within(screen.getByRole('group', { name: 'Theme' })).getAllByRole('button');

beforeEach(() => {
  delete root.dataset.theme;
  root.removeAttribute('style');
  initTheme();
});

afterEach(() => {
  delete root.dataset.theme;
  root.removeAttribute('style');
  localStorage.clear();
  initTheme();
});

describe('choosing a theme', () => {
  it('offers the four themes in the account menu and repaints the page at once', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(themeButtons().map(b => b.textContent)).toEqual(['Light', 'Dark', 'Matrix', 'Cyberpunk']);
    for (const [name, id] of [['Matrix', 'matrix'], ['Cyberpunk', 'cyberpunk'], ['Light', 'light'], ['Dark', 'dark']]) {
      await user.click(screen.getByRole('button', { name }));
      expect(root.dataset.theme).toBe(id);
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
      expect(themeButtons().filter(b => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    }
  });

  it('names the themes and the custom template in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const user = userEvent.setup();
    renderShell();
    const dialog = await openTemplateWindow(user, { account: 'Аккаунт', item: 'Свой шаблон…', title: 'Свой шаблон' });
    await user.upload(within(dialog).getByLabelText('Загрузить шаблон'), file(JSON.stringify(NEON)));
    expect(await within(dialog).findByText('Включен ваш шаблон «Neon».')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Выгрузить шаблон' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Сбросить шаблон' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Готово' }));
    await user.click(screen.getByRole('button', { name: 'Аккаунт' }));
    const group = screen.getByRole('group', { name: 'Тема' });
    expect(within(group).getAllByRole('button').map(b => b.textContent)).toEqual(['Светлая', 'Темная', 'Матрица', 'Киберпанк', 'Свой шаблон']);
  });
});

describe('a custom template', () => {
  it('loads from a file for anyone, turns on at once and becomes a fifth choice in the menu', async () => {
    const user = userEvent.setup();
    renderShell({ ...ME.person, scopeKind: 'listed', isOwner: false });
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.queryByRole('button', { name: 'Company settings' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    const dialog = await openTemplateWindow(user);
    expect(within(dialog).getByText('No template is loaded. A built-in theme is on.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Reset template' })).not.toBeInTheDocument();
    await user.upload(within(dialog).getByLabelText('Load template'), file(JSON.stringify(NEON)));
    expect(await within(dialog).findByText('Your template "Neon" is on.')).toBeInTheDocument();
    expect(root.dataset.theme).toBe('cyberpunk');
    expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe('#010203');
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('button', { name: 'Custom template' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe('');
    await user.click(screen.getByRole('button', { name: 'Custom template' }));
    expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe('#010203');
  });

  it('explains in plain words why a file was refused, and keeps the theme', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Matrix' }));
    await user.click(screen.getByRole('button', { name: 'Account' }));
    const dialog = await openTemplateWindow(user);
    const load = within(dialog).getByLabelText('Load template');
    await user.upload(load, file(JSON.stringify({ ...NEON, colors: { bg: 'url(https://example.com/x.png)' } })));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('colors.bg: this looks like code. Links such as url(), expressions, tags and control characters are not allowed.');
    expect(root.dataset.theme).toBe('matrix');
    expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe('');
    await user.upload(load, file('{"format":'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This file is not JSON. Download a template as a sample and change its values.');
    await user.upload(load, file(' '.repeat(TEMPLATE_LIMIT + 1)));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The file is too large. A template takes up to 64 KB.');
    await user.upload(load, file(JSON.stringify(NEON)));
    expect(await within(dialog).findByText('Your template "Neon" is on.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains a refusal in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const user = userEvent.setup();
    renderShell();
    const dialog = await openTemplateWindow(user, { account: 'Аккаунт', item: 'Свой шаблон…', title: 'Свой шаблон' });
    await user.upload(within(dialog).getByLabelText('Загрузить шаблон'), file(JSON.stringify({ ...NEON, cut: 3 })));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('cut: скос углов задается числом от 0 до 1.5.');
  });

  it('downloads the theme that is on as a sample to start from', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Cyberpunk' }));
    await user.click(screen.getByRole('button', { name: 'Account' }));
    const dialog = await openTemplateWindow(user);
    const link = within(dialog).getByRole('link', { name: 'Download template' });
    expect(link).toHaveAttribute('download', 'hornhoof-theme-cyberpunk.json');
    const href = link.getAttribute('href')!;
    expect(href.startsWith('data:application/json;charset=utf-8,')).toBe(true);
    expect(parseTemplate(decodeURIComponent(href.slice(href.indexOf(',') + 1)))).toEqual({ ok: true, template: sampleOf('cyberpunk') });
    await user.upload(within(dialog).getByLabelText('Load template'), file(JSON.stringify(NEON)));
    expect(await within(dialog).findByRole('link', { name: 'Download template' })).toHaveAttribute('download', 'hornhoof-theme-custom.json');
  });

  it('resets back to the built-in theme the template was made from', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openTemplateWindow(user);
    await user.upload(within(dialog).getByLabelText('Load template'), file(JSON.stringify(NEON)));
    await user.click(await within(dialog).findByRole('button', { name: 'Reset template' }));
    expect(within(dialog).getByText('No template is loaded. A built-in theme is on.')).toBeInTheDocument();
    expect(root.dataset.theme).toBe('cyberpunk');
    expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe('');
    expect(localStorage.getItem('hh-theme-custom')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(themeButtons().map(b => b.textContent)).toEqual(['Light', 'Dark', 'Matrix', 'Cyberpunk']);
    expect(screen.getByRole('button', { name: 'Cyberpunk' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is the same block beside the theme choice in company settings', async () => {
    mockApi({ 'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }], 'GET /api/repo-host': [200, { host: null }] });
    const user = userEvent.setup();
    render(<Settings me={ME} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Company settings' });
    expect(themeButtons().map(b => b.textContent)).toEqual(['Light', 'Dark', 'Matrix', 'Cyberpunk']);
    await user.click(within(dialog).getByRole('button', { name: 'Matrix' }));
    expect(root.dataset.theme).toBe('matrix');
    expect(within(dialog).getByRole('link', { name: 'Download template' })).toHaveAttribute('download', 'hornhoof-theme-matrix.json');
    await user.upload(within(dialog).getByLabelText('Load template'), file(JSON.stringify(NEON)));
    expect(await within(dialog).findByText('Your template "Neon" is on.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Custom template' })).toHaveAttribute('aria-pressed', 'true');
  });
});
