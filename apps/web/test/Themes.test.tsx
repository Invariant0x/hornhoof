import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { BUILTIN_SKINS, builtinSkin } from '../src/skins/registry';
import { COLOR_TOKENS, type Skin } from '../src/skins/roles';
import { initSkins, skinsState } from '../src/skins/store';
import { parseSkin, SKIN_FILE_LIMIT, skinText } from '../src/skins/validate';
import { ME, mockApi, ORG } from './api-mock';
import { decl } from './css';

const root = document.documentElement;
const own = (name: string, bg = '#010203'): Skin => ({ ...builtinSkin('neon')!, name, colors: { ...builtinSkin('neon')!.colors, bg } });
const file = (body: string, name = 'dusk.json') => new File([body], name, { type: 'application/json' });
const EN = { account: 'Account', item: /^Themes: /, title: 'Settings', load: 'Load themes' };
const RU = { account: 'Аккаунт', item: /^Темы: /, title: 'Настройки', load: 'Загрузить темы' };

function renderShell(person = ME.person) {
  mockApi({ 'GET /api/org': [200, ORG] });
  return render(
    <LanguageProvider>
      <Shell me={{ ...ME, person }} onSignOut={() => {}} />
    </LanguageProvider>,
  );
}

async function openThemes(user: ReturnType<typeof userEvent.setup>, words = EN) {
  await user.click(screen.getByRole('button', { name: words.account }));
  await user.click(screen.getByRole('button', { name: words.item }));
  return screen.findByRole('dialog', { name: words.title });
}

const cards = (dialog: HTMLElement) => within(within(dialog).getByRole('list', { name: /^(Built-in themes|Встроенные темы)$/ })).getAllByRole('listitem');
const ownCards = (dialog: HTMLElement) => within(within(dialog).getByRole('list', { name: /^(Your themes|Ваши темы)$/ })).queryAllByRole('listitem');
const pressed = (dialog: HTMLElement) => within(dialog).getAllByRole('button', { pressed: true });
const downloaded = (link: HTMLElement) => {
  const href = link.getAttribute('href')!;
  expect(href.startsWith('data:application/json;charset=utf-8,')).toBe(true);
  return decodeURIComponent(href.slice(href.indexOf(',') + 1));
};

function clearPage() {
  delete root.dataset.theme;
  delete root.dataset.scheme;
  root.removeAttribute('style');
}

beforeEach(() => {
  localStorage.clear();
  clearPage();
  initSkins();
});

afterEach(() => {
  localStorage.clear();
  clearPage();
  initSkins();
});

describe('the Themes section of the settings', () => {
  it('opens from one row of the account menu that names the theme on now, for a person who does not see the whole company too', async () => {
    const user = userEvent.setup();
    renderShell({ ...ME.person, scopeKind: 'listed', isOwner: false });
    await user.click(screen.getByRole('button', { name: 'Account' }));
    const row = screen.getByRole('button', { name: 'Themes: Cyberpunk' });
    expect(row).toHaveTextContent('ThemesCyberpunk');
    expect(screen.queryByRole('button', { name: 'Company settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Theme' })).not.toBeInTheDocument();
    await user.click(row);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(location.pathname).toBe('/themes');
    expect(within(dialog).getByRole('button', { name: 'Themes' })).toHaveAttribute('aria-current', 'page');
    expect(within(dialog).getByText('On now: Cyberpunk')).toBeInTheDocument();
  });

  it('shows every built-in theme as a card in the order of the registry, the one on pressed', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    expect(cards(dialog)).toHaveLength(BUILTIN_SKINS.length);
    expect(cards(dialog).map(card => within(card).getByRole('heading').textContent)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Neon']);
    expect(pressed(dialog)).toEqual([within(cards(dialog)[0]!).getByRole('button', { name: 'Cyberpunk', description: 'Dark theme, built in' })]);
    expect(within(cards(dialog)[1]!).getByText('Light theme, built in')).toBeInTheDocument();
    expect(within(cards(dialog)[0]!).getByText('Dark theme, built in')).toBeInTheDocument();
  });

  it('switches the theme in one click, at once, and the card, the menu row and the page agree', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    for (const [name, id] of [['Matrix', 'matrix'], ['Pixel', 'pixel'], ['Light', 'light'], ['Neon', 'neon'], ['Cyberpunk', 'cyberpunk']] as const) {
      await user.click(within(dialog).getByRole('button', { name }));
      expect(root.dataset.theme).toBe(id);
      expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe(builtinSkin(id)!.colors.bg);
      expect(pressed(dialog)).toHaveLength(1);
      expect(within(dialog).getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
      expect(within(dialog).getByText(`On now: ${name}`)).toBeInTheDocument();
      expect(skinsState().active).toBe(id);
    }
    await user.click(within(dialog).getByRole('button', { name: 'Matrix' }));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('button', { name: 'Themes: Matrix' })).toBeInTheDocument();
  });

  it('switches between Profile and Themes inside the settings at their own addresses', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    await user.click(within(dialog).getByRole('button', { name: 'Profile' }));
    expect(location.pathname).toBe('/profile');
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('list', { name: 'Built-in themes' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Themes' }));
    expect(location.pathname).toBe('/themes');
    expect(within(dialog).getByRole('list', { name: 'Built-in themes' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(location.pathname).toBe('/');
    expect(screen.getByRole('button', { name: 'Account' })).toHaveFocus();
  });
});

describe('the collection of a person\'s own themes', () => {
  it('loads several files at once and keeps those loaded before, without turning one on', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    expect(within(dialog).getByText('No themes of your own yet. Load a theme file, or download any theme here as a sample.')).toBeInTheDocument();
    const load = within(dialog).getByLabelText('Load themes');
    expect(load).toHaveAttribute('multiple');
    await user.upload(load, [file(skinText(own('Dusk')), 'dusk.json'), file(skinText(own('Dawn', '#0A0B0C')), 'dawn.json')]);
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Added: Dusk, Dawn.');
    await user.upload(load, file(skinText(own('Dusk', '#111111')), 'dusk-2.json'));
    expect(await within(dialog).findByText('Added: Dusk.')).toBeInTheDocument();
    expect(ownCards(dialog).map(card => within(card).getByRole('heading').textContent)).toEqual(['Dusk', 'Dawn', 'Dusk']);
    expect(within(ownCards(dialog)[0]!).getByText('Dark theme, your own')).toBeInTheDocument();
    expect(root.dataset.theme).toBe('cyberpunk');
    await user.click(within(ownCards(dialog)[1]!).getByRole('button', { name: 'Dawn' }));
    expect(root.dataset.theme).toBe('custom-2');
    expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe('#0A0B0C');
    expect(within(dialog).getByText('On now: Dawn')).toBeInTheDocument();
  });

  it('refuses a bad file in plain words with its name, and still adds the good ones beside it', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    const unsafe = JSON.parse(skinText(own('Bad'))) as { colors: Record<string, string> };
    unsafe.colors.bg = 'url(https://example.com/x.png)';
    const layout = { ...JSON.parse(skinText(own('Wide'))), spacing: 2 };
    await user.upload(within(dialog).getByLabelText('Load themes'), [
      file(JSON.stringify(unsafe), 'bad.json'),
      file('{"format":', 'broken.json'),
      file(' '.repeat(SKIN_FILE_LIMIT + 1), 'huge.json'),
      file(JSON.stringify(layout), 'wide.json'),
      file(skinText(own('Dusk')), 'dusk.json'),
    ]);
    const alert = await within(dialog).findByRole('alert');
    expect(within(alert).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'bad.json: colors.bg: this looks like code. Links such as url(), expressions, tags and control or direction characters are not allowed.',
      'broken.json: this file is not JSON. Download a theme as a sample and change its values.',
      'huge.json: the file is too large. A theme file takes up to 16 KB.',
      'wide.json: spacing: a theme cannot change the grid, sizes or gaps. They stay the same in every theme, so screens never move or break.',
    ]);
    expect(within(dialog).getByRole('status')).toHaveTextContent('Added: Dusk.');
    expect(ownCards(dialog)).toHaveLength(1);
    expect(root.dataset.theme).toBe('cyberpunk');
  });

  it('downloads any theme, built in or its own, as a sample file that loads back as the same theme', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    const matrix = within(dialog).getByRole('link', { name: 'Download Matrix' });
    expect(matrix).toHaveTextContent('Download');
    expect(matrix).toHaveAttribute('download', 'hornhoof-skin-matrix.json');
    expect(parseSkin(downloaded(matrix))).toEqual({ ok: true, skin: { ...builtinSkin('matrix')!, id: undefined, name: 'Matrix' } });
    await user.upload(within(dialog).getByLabelText('Load themes'), file(skinText(own('Dusk'))));
    const dusk = await within(dialog).findByRole('link', { name: 'Download Dusk' });
    expect(dusk).toHaveAttribute('download', 'hornhoof-skin-custom-1.json');
    expect(downloaded(dusk)).toBe(skinText(own('Dusk')));
  });

  it('deletes a theme of its own after asking, and a deleted theme that was on gives way to Cyberpunk', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    await user.upload(within(dialog).getByLabelText('Load themes'), [file(skinText(own('Dusk'))), file(skinText(own('Dawn')))]);
    await within(dialog).findByText('Added: Dusk, Dawn.');
    expect(cards(dialog).every(card => within(card).queryByRole('button', { name: /^Delete/ }) === null)).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Dawn' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete Dusk' }));
    expect(within(dialog).getByText('Delete "Dusk" from this browser? A file of it you downloaded keeps working.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Keep' }));
    expect(ownCards(dialog)).toHaveLength(2);
    await user.click(within(dialog).getByRole('button', { name: 'Delete Dawn' }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(ownCards(dialog).map(card => within(card).getByRole('heading').textContent)).toEqual(['Dusk']);
    expect(root.dataset.theme).toBe('cyberpunk');
    expect(within(dialog).getByRole('button', { name: 'Cyberpunk' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByText('On now: Cyberpunk')).toBeInTheDocument();
  });
});

describe('the guide in the Themes section', () => {
  it('says how to make a theme from a sample or with an AI, what a file may hold and why the layout stays, in English', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    const guide = within(dialog).getByRole('region', { name: 'How to make a theme of your own' });
    expect(within(guide).getAllByRole('heading').map(heading => heading.textContent)).toEqual(['How to make a theme of your own', 'From a sample', 'With an AI assistant', 'What a theme file may hold', 'Why the layout stays the same']);
    expect(guide).toHaveTextContent('"scheme"');
    expect(guide).toHaveTextContent('"cut"');
    expect(guide).toHaveTextContent('Pixelify Sans');
  });

  it('is the same section in Russian, with Russian names of the themes', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user, RU);
    expect(cards(dialog).map(card => within(card).getByRole('heading').textContent)).toEqual(['Киберпанк', 'Светлая', 'Матрица', 'Пиксельная', 'Неон']);
    expect(within(dialog).getByText('Сейчас: Киберпанк')).toBeInTheDocument();
    const guide = within(dialog).getByRole('region', { name: 'Как сделать свою тему' });
    expect(within(guide).getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Как сделать свою тему', 'По образцу', 'С помощью ИИ', 'Что можно менять в файле темы', 'Почему расположение не меняется']);
    await user.upload(within(dialog).getByLabelText(RU.load), file(JSON.stringify({ ...JSON.parse(skinText(own('Bad'))), cut: 3 }), 'bad.json'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('bad.json: cut: скос углов задается числом от 0 до 1.5.');
  });
});

describe('the look of the Themes section', () => {
  it('paints each card in its own theme from the tokens, and lays the cards and their actions out to fit', () => {
    expect(decl('.skin-swatch', 'background')).toBe('var(--bg)');
    expect(decl('.skin-cards', 'grid-template-columns')).toBe('repeat(auto-fill, minmax(min(100%, 180px), 1fr))');
    expect(decl('.skin-pick', 'min-height')).toBe('44px');
    expect(decl('.skin-card .entry-actions', 'flex-wrap')).toBe('wrap');
    expect(decl('.skin-name', 'overflow-wrap')).toBe('anywhere');
  });
});
