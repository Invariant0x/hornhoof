import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/en';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { BUILTIN_SKINS, builtinSkin } from '../src/skins/registry';
import { COLOR_TOKENS, type Skin } from '../src/skins/roles';
import { initSkins, skinsState } from '../src/skins/store';
import { builtinFile, parseSkin, SKIN_FILE_LIMIT, skinText } from '../src/skins/validate';
import { ME, mockApi, ORG } from './api-mock';
import { decl } from './css';

const root = document.documentElement;
const own = (name: string, bg = '#010203', base = 'cyberpunk'): Skin => {
  const sample = builtinFile(builtinSkin('cyberpunk')!, { ru: name, en: name });
  return { ...sample, base, colors: { ...sample.colors, bg } };
};
const file = (body: string, name = 'dusk.json') => new File([body], name, { type: 'application/json' });
const EN = { account: 'Account', item: 'Settings', title: 'Settings', add: 'Add from file' };
const RU = { account: 'Аккаунт', item: 'Настройки', title: 'Настройки', add: 'Добавить из файла' };

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

const catalog = (dialog: HTMLElement) => within(dialog).getByRole('region', { name: /^(Skin catalog|Каталог скинов)$/ });
const cards = (dialog: HTMLElement) => within(catalog(dialog)).getAllByRole('listitem');
const titles = (dialog: HTMLElement) => cards(dialog).map(card => within(card).getByRole('heading').textContent);
const pressed = (dialog: HTMLElement) => within(dialog).getAllByRole('button', { pressed: true });
const input = (dialog: HTMLElement) => dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
const addFile = (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, body: string, name = 'dusk.json') => user.upload(input(dialog), file(body, name));

/* What a click on Download gives: the file name and the text of the file. */
function downloads() {
  const saved: { name: string; text: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.href.startsWith('data:application/json;charset=utf-8,')).toBe(true);
    saved.push({ name: this.download, text: decodeURIComponent(this.href.slice(this.href.indexOf(',') + 1)) });
  });
  return saved;
}

function clearPage() {
  delete root.dataset.theme;
  delete root.dataset.scheme;
  delete root.dataset.cut;
  root.removeAttribute('style');
}

beforeEach(() => {
  localStorage.clear();
  clearPage();
  initSkins();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  clearPage();
  initSkins();
});

describe('the Themes section of the settings', () => {
  it('lives under Appearance & language in Settings, with no row of its own in the account menu, for a person who does not see the whole company too', async () => {
    const user = userEvent.setup();
    renderShell({ ...ME.person, scopeKind: 'listed', isOwner: false });
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.queryByRole('button', { name: /theme/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Themes')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(location.pathname).toBe('/settings');
    expect(within(dialog).getByRole('button', { name: 'Appearance & language' })).toHaveAttribute('aria-current', 'page');
    expect(within(dialog).getByRole('heading', { name: 'Themes', level: 3 })).toBeInTheDocument();
    expect(within(dialog).getByText('Choose your own look. Other members keep their themes.')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Your choice stays in this browser.')).toHaveLength(2);
    expect(catalog(dialog)).toBeInTheDocument();
  });

  it('shows the four built-in skins as cards in the order of the registry, with origin, description and the current one marked', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel']);
    expect(cards(dialog)).toHaveLength(BUILTIN_SKINS.length);
    const [cyberpunk, light] = cards(dialog) as [HTMLElement, HTMLElement];
    expect(within(cyberpunk).getByText('Current')).toBeInTheDocument();
    expect(within(cyberpunk).getByText('Built-in · Default')).toBeInTheDocument();
    expect(within(cyberpunk).getByText('A night console with a cyan accent.')).toBeInTheDocument();
    expect(within(light).getByText('Built-in')).toBeInTheDocument();
    expect(within(light).queryByText('Current')).not.toBeInTheDocument();
    expect(pressed(dialog)).toEqual([within(cyberpunk).getByRole('button', { name: 'Applied: Cyberpunk' })]);
    expect(within(light).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Apply: Light', 'Download: Light']);
    /* Apply and Applied share one place, so the button keeps its size; only the one that is true shows. */
    const shown = (button: HTMLElement) => [...button.querySelectorAll('.swap-label > span:not(.sizer)')].map(label => label.textContent);
    expect(shown(within(light).getByRole('button', { name: 'Apply: Light' }))).toEqual(['Apply']);
    expect(shown(within(cyberpunk).getByRole('button', { name: 'Applied: Cyberpunk' }))).toEqual(['Applied']);
    expect(within(dialog).getByText('No custom skins yet')).toBeInTheDocument();
    expect(within(dialog).getByText('Add a file. Download any built-in skin to use as a sample.')).toBeInTheDocument();
    expect(cards(dialog).map(card => card.querySelector('.skin-preview')!.getAttribute('data-cut'))).toEqual(['bevel', 'bevel', 'bevel', 'steps']);
    expect((cards(dialog)[3]!.querySelector('.skin-preview') as HTMLElement).style.getPropertyValue(COLOR_TOKENS.bg)).toBe('#151523');
  });

  it('applies a skin in one click, at once, keeps focus on its button and says so, and the card and the page agree', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    for (const [name, id] of [['Matrix', 'matrix'], ['Pixel', 'pixel'], ['Light', 'light'], ['Cyberpunk', 'cyberpunk']] as const) {
      await user.click(within(dialog).getByRole('button', { name: `Apply: ${name}` }));
      expect([root.dataset.theme, root.dataset.cut]).toEqual([id, builtinSkin(id)!.shape]);
      expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe(builtinSkin(id)!.colors.bg);
      const button = within(dialog).getByRole('button', { name: `Applied: ${name}` });
      expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(button).toHaveFocus();
      expect(pressed(dialog)).toHaveLength(1);
      expect(within(dialog).getByRole('status')).toHaveTextContent(`“${name}” is now applied.`);
      expect(skinsState().active).toBe(id);
    }
    await user.click(within(dialog).getByRole('button', { name: 'Apply: Matrix' }));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(skinsState().active).toBe('matrix');
    expect(await openThemes(user)).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Applied: Matrix' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches between Appearance & language and Company & access inside Settings at their own addresses', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    await user.click(within(dialog).getByRole('button', { name: 'Company & access' }));
    expect(location.pathname).toBe('/settings/company');
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('region', { name: 'Skin catalog' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Appearance & language' }));
    expect(location.pathname).toBe('/settings');
    expect(catalog(dialog)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(location.pathname).toBe('/');
    expect(screen.getByRole('button', { name: 'Account' })).toHaveFocus();
  });
});

describe('the collection of a person\'s own skins', () => {
  it('adds a file at a time after the skins added before, without applying it, and numbers a name already shown', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    const add = within(dialog).getByRole('button', { name: 'Add from file' });
    expect(input(dialog)).not.toHaveAttribute('multiple');
    await addFile(user, dialog, skinText(own('Dusk')));
    expect(within(dialog).getByRole('status')).toHaveTextContent('“Dusk” was added. You can now apply it.');
    expect(add).toHaveFocus();
    await addFile(user, dialog, skinText(own('Dawn', '#0A0B0C', 'pixel')), 'dawn.json');
    await addFile(user, dialog, skinText(own('Dusk', '#111111')), 'dusk-2.json');
    await addFile(user, dialog, skinText(own('Cyberpunk', '#121212')), 'cyberpunk.json');
    expect(within(dialog).getByRole('status')).toHaveTextContent('“Cyberpunk (2)” was added.');
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Dusk', 'Dawn', 'Dusk (2)', 'Cyberpunk (2)']);
    expect(within(dialog).queryByText('No custom skins yet')).not.toBeInTheDocument();
    const dawn = cards(dialog)[5]!;
    expect(within(dawn).getByText('Custom')).toBeInTheDocument();
    expect(within(dawn).getByText('A skin from your file.')).toBeInTheDocument();
    expect(dawn.querySelector('.skin-preview')!.getAttribute('data-cut')).toBe('steps');
    expect(root.dataset.theme).toBe('cyberpunk');
    await user.click(within(dawn).getByRole('button', { name: 'Apply: Dawn' }));
    expect([root.dataset.theme, root.dataset.cut]).toEqual(['custom-2', 'steps']);
    expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe('#0A0B0C');
    expect(within(dawn).getByText('Current')).toBeInTheDocument();
  });

  it('changes nothing when no file is picked', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    await user.upload(input(dialog), []);
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
    expect(cards(dialog)).toHaveLength(4);
  });

  it.each([
    ['code in a colour', () => {
      const raw = JSON.parse(skinText(own('Bad'))) as { colors: Record<string, string> };
      raw.colors.bg = 'url(https://example.com/x.png)';
      return JSON.stringify(raw);
    }, 'The colors.bg field holds code, a link or hidden characters. Keep only the value and add the file again.'],
    ['a broken file', () => '{"schema_version":', 'Could not read the file. Check that it is JSON and add it again.'],
    ['a file too large', () => ' '.repeat(SKIN_FILE_LIMIT + 1), 'The file is larger than 64 KB. Download a sample and copy your settings into it.'],
    ['a change of spacing', () => JSON.stringify({ ...JSON.parse(skinText(own('Wide'))), spacing: 2 }), '“spacing” would change the grid, sizes or spacing, which stay the same in every theme. Remove it and add the file again.'],
    ['an old version', () => JSON.stringify({ ...JSON.parse(skinText(own('Old'))), schema_version: 1 }), 'This file version is not supported. Download a new sample and copy your settings into it.'],
    ['a font Hornhoof does not carry', () => skinText({ ...own('Font'), fonts: { ...own('Font').fonts, body: ['Comic Sans MS', 'sans-serif'] } }), '“Comic Sans MS” is not supported for “fonts.body”. Choose a font from the sample.'],
    ['text hard to read', () => skinText({ ...own('Dim'), colors: { ...own('Dim').colors, muted: '#30363F' } }), 'Text in “muted” is hard to read on “bg”. Change one of the colors and add the file again.'],
    ['a base that is no skin', () => JSON.stringify({ ...JSON.parse(skinText(own('Neon'))), base: 'neon' }), 'The base field needs a built-in skin: cyberpunk, light, matrix, pixel. Fix the field and add the file again.'],
    ['a see-through text colour', () => skinText({ ...own('Glass'), colors: { ...own('Glass').colors, ink: 'rgba(227, 234, 241, .5)' } }), 'The colors.ink field needs a solid color: only dot, glow, hud, shadow, scrim may be see-through. Fix the field and add the file again.'],
  ])('refuses %s with what to fix, keeps the collection and the skin on, and gives focus back to Add from file', async (_what, body, words) => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    await addFile(user, dialog, skinText(own('Dusk')));
    await user.click(within(dialog).getByRole('button', { name: 'Apply: Dusk' }));
    await addFile(user, dialog, body(), 'bad.json');
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent(`Could not add the skin${words}`);
    expect(alert).toHaveAttribute('class', 'skins-notice');
    expect(alert).toHaveAttribute('data-tone', 'alert');
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Dusk']);
    expect(root.dataset.theme).toBe('custom-1');
    expect(within(dialog).getByRole('button', { name: 'Add from file' })).toHaveFocus();
  });

  it('says the browser could not keep the skin and adds nothing', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    await addFile(user, dialog, skinText(own('Dusk')));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not save the skin in this browser. Free up space or allow storage, then add the file again.');
    expect(cards(dialog)).toHaveLength(4);
  });

  it('keeps the button in place and says the file is being read while it is', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    let finish: (text: string) => void = () => {};
    const slow = file('');
    Object.defineProperty(slow, 'text', { value: () => new Promise<string>(resolve => (finish = resolve)) });
    await user.upload(input(dialog), slow);
    const add = within(dialog).getByRole('button', { name: 'Reading file...' });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Reading the file. Your other skins are still available.');
    expect(within(dialog).getByRole('button', { name: 'Apply: Light' })).toBeEnabled();
    await act(async () => finish(skinText(own('Dusk'))));
    expect(within(dialog).getByRole('button', { name: 'Add from file' })).toBeEnabled();
    expect(within(dialog).getByRole('status')).toHaveTextContent('“Dusk” was added.');
  });

  it('downloads any skin, built in or its own, as a sample file that adds back as the same skin', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    const saved = downloads();
    await user.click(within(dialog).getByRole('button', { name: 'Download: Matrix' }));
    expect(saved[0]!.name).toBe('hornhoof-skin-matrix.json');
    expect(parseSkin(saved[0]!.text)).toEqual({ ok: true, skin: builtinFile(builtinSkin('matrix')!, { ru: 'Матрица', en: 'Matrix' }) });
    await addFile(user, dialog, skinText(own('Dusk')));
    await user.click(within(dialog).getByRole('button', { name: 'Download: Dusk' }));
    expect(saved[1]).toEqual({ name: 'hornhoof-skin-custom-1.json', text: skinText(own('Dusk')) });
    expect(root.dataset.theme).toBe('cyberpunk');
  });

  it('says when a download fails and keeps the catalog', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('blocked');
    });
    await user.click(within(dialog).getByRole('button', { name: 'Download: Pixel' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not download “Pixel”. Try again.');
    expect(cards(dialog)).toHaveLength(4);
  });

  it('removes its own skin at once with Undo; removing the one on gives way to Cyberpunk, and Undo puts both back', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    await addFile(user, dialog, skinText(own('Dusk')));
    await addFile(user, dialog, skinText(own('Dawn')), 'dawn.json');
    expect(cards(dialog).slice(0, 4).every(card => within(card).queryByRole('button', { name: /^Remove/ }) === null)).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Apply: Dusk' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove: Dusk' }));
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Dawn']);
    expect(root.dataset.theme).toBe('cyberpunk');
    expect(within(dialog).getByRole('button', { name: 'Applied: Cyberpunk' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('status')).toHaveTextContent('“Dusk” was removed. “Cyberpunk” is now applied.Undo');
    expect(within(dialog).getByRole('button', { name: 'Apply: Dawn' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Undo' }));
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Dusk', 'Dawn']);
    expect(root.dataset.theme).toBe('custom-1');
    expect(within(dialog).getByRole('status')).toHaveTextContent('“Dusk” was restored.');
    expect(within(dialog).getByRole('button', { name: 'Applied: Dusk' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Remove: Dawn' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('“Dawn” was removed.Undo');
    expect(within(dialog).getByRole('button', { name: 'Applied: Dusk' })).toHaveFocus();
  });
});

describe('the guide in the Themes section', () => {
  it('gives three steps, a request for an AI to copy and why the layout stays, in English', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    const guide = within(dialog).getByRole('region', { name: 'Your own skin in a minute' });
    expect(within(guide).getAllByRole('listitem').map(step => step.textContent)).toEqual(en.skins.steps);
    expect(guide).toHaveTextContent('The grid, spacing and button sizes stay the same in every theme. Words and actions keep their places.');
    await user.click(within(guide).getByRole('button', { name: 'Copy request for AI' }));
    expect(within(guide).getByRole('status')).toHaveTextContent('Request copied');
    expect(await navigator.clipboard.readText()).toBe(en.skins.aiRequest);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(within(guide).getByRole('button', { name: 'Copy request for AI' }));
    expect(within(guide).getByRole('status')).toHaveTextContent('Could not copy the request. Try again.');
  });

  it('is the same section in Russian, with Russian names, texts and errors', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole('button', { name: RU.account }));
    expect(screen.queryByText('Темы')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: RU.item }));
    expect(screen.getByRole('button', { name: 'Оформление и язык' })).toHaveAttribute('aria-current', 'page');
    const dialog = await screen.findByRole('dialog', { name: RU.title });
    expect(titles(dialog)).toEqual(['Киберпанк', 'Светлая', 'Матрица', 'Пиксельная']);
    expect(within(dialog).getByText('Встроенная · По умолчанию')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Включена: Киберпанк' })).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: 'Свой скин за минуту' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Скопировать просьбу для ИИ' })).toBeInTheDocument();
    await addFile(user, dialog, JSON.stringify({ ...JSON.parse(skinText(own('Плохой'))), cut: 3 }), 'bad.json');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Не удалось добавить скинВ поле cut нужно число от 0 до 1,5. Исправьте поле и добавьте файл снова.');
    await addFile(user, dialog, skinText({ ...own('x'), name: { ru: 'Сумерки', en: 'Dusk' } }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('Скин «Сумерки» добавлен. Теперь его можно включить.');
    expect(titles(dialog).at(-1)).toBe('Сумерки');
  });
});

describe('the look of the Themes section', () => {
  it('paints each preview in its own skin from the tokens, and lays the catalog, cards and actions out to fit', () => {
    expect(decl('.skin-preview', 'background')).toBe('var(--bg)');
    expect(decl('.skin-cards', 'grid-template-columns')).toBe('repeat(auto-fit, minmax(min(100%, 280px), 1fr))');
    expect(decl('.skins .btn', 'min-height')).toBe('44px');
    expect(decl('.skins .btn', 'white-space')).toBe('normal');
    expect(decl('.skin-card-head', 'flex-wrap')).toBe('wrap');
    expect(decl('.skins-add .btn', 'width')).toBe('180px');
    expect(decl('.swap-label > .sizer', 'visibility')).toBe('hidden');
    /* The line of what was done marks its kind at its start only: the shared .status and .alert classes would frame it. */
    expect(decl('.skins-notice', 'border-inline-start')).toBe('4px solid var(--line2)');
    expect(decl(".skins-notice[data-tone='alert']", 'border-inline-start-color')).toBe('var(--pink-ink)');
    expect(decl('.settings-body', 'grid-template-columns')).toBe('180px minmax(0, 1fr)');
    expect(decl('.settings-body', 'grid-template-columns', '(max-width: 760px)')).toBe('minmax(0, 1fr)');
  });
});
