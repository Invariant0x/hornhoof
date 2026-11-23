import type { InstalledThemeView } from '@hornhoof/protocol/themes';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/en';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { BUILTIN_SKINS, builtinSkin } from '../src/skins/registry';
import { COLOR_TOKENS, type Skin } from '../src/skins/roles';
import { initSkins, skinsState } from '../src/skins/store';
import { forgetInstalledTheme } from '../src/themes/installed';
import { THEME_GUIDE_URL } from '../src/ui/Themes';
import { builtinFile, parseSkin, SKIN_FILE_LIMIT, skinText } from '../src/skins/validate';
import { ME, mockApi, ORG } from './api-mock';
import { decl } from './css';

const root = document.documentElement;
const own = (name: string, bg = '#010203', base = 'cyberpunk'): Skin => {
  const sample = builtinFile(builtinSkin('cyberpunk')!, { ru: name, en: name });
  return { ...sample, base, colors: { ...sample.colors, bg } };
};
const file = (body: string, name = 'dusk.json') => new File([body], name, { type: 'application/json' });
const EN = { account: 'Account', item: 'Settings', title: 'Settings', group: 'Company & access', add: 'Upload theme' };
const RU = { account: 'Аккаунт', item: 'Настройки', title: 'Настройки', group: 'Компания и доступ', add: 'Загрузить тему' };

function renderShell(person = ME.person) {
  mockApi({
    'GET /api/org': [200, ORG],
    'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
    'PUT /api/world/theme': body => [200, { theme: (body as { theme: string }).theme, activePack: null, canEdit: true }],
  });
  return render(
    <LanguageProvider>
      <Shell me={{ ...ME, person }} onSignOut={() => {}} />
    </LanguageProvider>,
  );
}

/* Settings opens on Profile; the skins stand in the group after it. */
async function openThemes(user: ReturnType<typeof userEvent.setup>, words = EN) {
  await user.click(screen.getByRole('button', { name: words.account }));
  await user.click(screen.getByRole('button', { name: words.item }));
  const dialog = await screen.findByRole('dialog', { name: words.title });
  await user.click(within(dialog).getByRole('button', { name: words.group }));
  return dialog;
}

const catalog = (dialog: HTMLElement) => within(dialog).getByRole('region', { name: /^(Theme catalog|Каталог тем)$/ });
const cards = (dialog: HTMLElement) => within(catalog(dialog)).getAllByRole('listitem');
const titles = (dialog: HTMLElement) => cards(dialog).map(card => within(card).getByRole('heading').textContent);
/* The card that says it is on: the state in its name row, not a button. */
const applied = (dialog: HTMLElement) => cards(dialog).filter(card => within(card).queryByText(/^(Applied|Включена)$/) !== null);
const state = (card: HTMLElement) => within(card).getByText(/^(Applied|Включена)$/);
const labels = (card: HTMLElement) => within(card).getAllByRole('button').map(button => button.getAttribute('aria-label'));
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
  delete root.dataset.world;
  delete root.dataset.surface;
  delete root.dataset.grain;
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
  it('lives under Company & access for the CEO only, with no personal theme picker under Appearance & language or for non-CEO members', async () => {
    const user = userEvent.setup();
    const { unmount } = renderShell({ ...ME.person, scopeKind: 'listed', isOwner: false });
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.queryByRole('button', { name: /theme/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Themes')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const listedDialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(location.pathname).toBe('/settings/profile');
    await user.click(within(listedDialog).getByRole('button', { name: 'Appearance & language' }));
    expect(location.pathname).toBe('/settings');
    expect(within(listedDialog).queryByRole('region', { name: 'Theme catalog' })).not.toBeInTheDocument();
    unmount();

    history.replaceState(null, '', '/');
    renderShell(ME.person);
    const dialog = await openThemes(user);
    expect(location.pathname).toBe('/settings/company');
    expect(within(dialog).getByRole('button', { name: 'Company & access' })).toHaveAttribute('aria-current', 'page');
    expect(within(dialog).getByRole('heading', { name: 'Theme store', level: 4 })).toBeInTheDocument();
    expect(within(dialog).getByText('Choose one theme or world for the whole company. All members see it and all agents receive its world skills.')).toBeInTheDocument();
    expect(within(dialog).getByText('Only the CEO can change the company theme.')).toBeInTheDocument();
    expect(catalog(dialog)).toBeInTheDocument();
  });

  it('shows the five built-in themes including Ancient Egypt as cards in the order of the registry, with origin, description and the one on marked by a state, not a button', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Ancient Egypt']);
    expect(cards(dialog)).toHaveLength(BUILTIN_SKINS.length);
    const [cyberpunk, light, , , egypt] = cards(dialog) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(within(cyberpunk).queryByText('Current')).not.toBeInTheDocument();
    expect(applied(dialog)).toEqual([cyberpunk]);
    expect(within(cyberpunk).getByText('Built-in · Default')).toBeInTheDocument();
    expect(within(cyberpunk).getByText('A night console with a cyan accent.')).toBeInTheDocument();
    expect(within(light).getByText('Built-in')).toBeInTheDocument();
    expect(within(egypt).getByText('Built-in · Game world')).toBeInTheDocument();
    expect(within(egypt).getByText('Warm papyrus, sandstone and an isometric desert map.')).toBeInTheDocument();
    expect(egypt.querySelector('.skin-preview')!.getAttribute('data-world')).toBe('egypt');
    expect(labels(cyberpunk)).toEqual(['Download: Cyberpunk']);
    /* The card on keeps the room of Apply, unseen and out of reach, so its buttons stand where every card has them. */
    const room = cyberpunk.querySelector('.skin-actions > .skin-apply-room')!;
    expect(room).toHaveAttribute('aria-hidden', 'true');
    expect(room.tagName).toBe('SPAN');
    expect(room.textContent).toBe('Apply');
    expect(light.querySelector('.skin-apply-room')).toBeNull();
    expect(decl('.skin-apply-room', 'visibility')).toBe('hidden');
    expect(labels(light)).toEqual(['Apply: Light', 'Download: Light']);
    expect(within(dialog).queryAllByRole('button', { pressed: true }).map(button => button.textContent)).toEqual(['All']);
    /* No button on a card is filled: Apply is as quiet as Download. */
    expect(cards(dialog).flatMap(card => within(card).getAllByRole('button')).every(button => button.classList.contains('ghost'))).toBe(true);
    expect(within(dialog).getByText('No custom themes yet')).toBeInTheDocument();
    expect(within(dialog).getByText('Upload a theme as a .zip, or a skin file as a .json. Download any built-in skin to use as a sample.')).toBeInTheDocument();
    /* One way in for a theme of any kind: Upload theme takes an archive and a skin file alike (Design, #1960). */
    expect(within(dialog).getAllByRole('button', { name: /^(Upload theme|Add from file)$/ })).toEqual([within(dialog).getByRole('button', { name: 'Upload theme' })]);
    expect(dialog.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(input(dialog).accept.split(',')).toEqual(['.zip', 'application/zip', '.json', 'application/json']);
    expect(cards(dialog).map(card => card.querySelector('.skin-preview')!.getAttribute('data-cut'))).toEqual(['bevel', 'bevel', 'bevel', 'steps', 'bevel']);
    expect((cards(dialog)[3]!.querySelector('.skin-preview') as HTMLElement).style.getPropertyValue(COLOR_TOKENS.bg)).toBe('#151523');
  });

  it('filters the theme store by category and switches to Ancient Egypt and back without leaving a trace', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    await user.click(within(dialog).getByRole('button', { name: 'Game worlds' }));
    expect(titles(dialog)).toEqual(['Ancient Egypt']);
    await user.click(within(dialog).getByRole('button', { name: 'Classic' }));
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel']);
    await user.click(within(dialog).getByRole('button', { name: 'Custom' }));
    expect(within(dialog).getByText('No custom themes yet')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'All' }));
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Ancient Egypt']);

    await user.click(within(dialog).getByRole('button', { name: 'Apply: Ancient Egypt' }));
    expect([root.dataset.theme, root.dataset.world, root.dataset.surface]).toEqual(['egypt', 'egypt', 'papyrus']);
    /* Ivan's correction: Cyberpunk stays an equal card in the store, with no separate Back to Cyberpunk banner or button. */
    expect(within(dialog).queryByText(/Return to Cyberpunk|Вернуться к Киберпанку/i)).not.toBeInTheDocument();
    /* Egypt card explains the game world's weight and reduced-motion support, and previews contain no SVG <text>. */
    expect(within(dialog).getByText('Uses an isometric game world that is heavier on older or low-spec machines. Respects reduced motion.')).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/3D/);
    expect(dialog.querySelectorAll('.skin-preview svg text')).toHaveLength(0);
    /* Papyrus map-grain toggle appears under Egypt and leaves no trace when switching back. */
    const grain = within(dialog).getByRole('checkbox', { name: 'Papyrus grain on map background' });
    expect(grain).toBeChecked();
    await user.click(grain);
    expect(grain).not.toBeChecked();
    expect(root.dataset.grain).toBe('off');

    await user.click(within(dialog).getByRole('button', { name: 'Apply: Cyberpunk' }));
    expect(root.dataset.theme).toBe('cyberpunk');
    expect(root.dataset.world).toBeUndefined();
    expect(root.dataset.surface).toBeUndefined();
    expect(root.dataset.grain).toBeUndefined();
    expect(within(dialog).queryByRole('checkbox', { name: 'Papyrus grain on map background' })).not.toBeInTheDocument();
  });

  it('applies a skin in one click, at once, moves focus to its state and says so, and the card and the page agree', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    for (const [name, id] of [['Matrix', 'matrix'], ['Pixel', 'pixel'], ['Ancient Egypt', 'egypt'], ['Light', 'light'], ['Cyberpunk', 'cyberpunk']] as const) {
      await user.click(within(dialog).getByRole('button', { name: `Apply: ${name}` }));
      expect([root.dataset.theme, root.dataset.cut]).toEqual([id, builtinSkin(id)!.shape]);
      expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe(builtinSkin(id)!.colors.bg);
      const card = cards(dialog).find(item => within(item).getByRole('heading').textContent === name)!;
      expect(applied(dialog)).toEqual([card]);
      expect(state(card)).toHaveFocus();
      expect(labels(card)).toEqual([`Download: ${name}`]);
      expect(within(dialog).getByRole('status')).toHaveTextContent(`“${name}” is now applied.`);
      expect(skinsState().active).toBe(id);
    }
    await user.click(within(dialog).getByRole('button', { name: 'Apply: Matrix' }));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(skinsState().active).toBe('matrix');
    expect(await openThemes(user)).toBeInTheDocument();
    expect(applied(screen.getByRole('dialog')).map(card => within(card).getByRole('heading').textContent)).toEqual(['Matrix']);
  });

  it('switches between Profile and Company & access inside Settings at their own addresses', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    expect(location.pathname).toBe('/settings/company');
    await user.click(within(dialog).getByRole('button', { name: 'Profile' }));
    expect(location.pathname).toBe('/settings/profile');
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('region', { name: 'Theme catalog' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Company & access' }));
    expect(location.pathname).toBe('/settings/company');
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
    const add = within(dialog).getByRole('button', { name: 'Upload theme' });
    expect(input(dialog)).not.toHaveAttribute('multiple');
    await addFile(user, dialog, skinText(own('Dusk')));
    expect(within(dialog).getByRole('status')).toHaveTextContent('“Dusk” was added. You can now apply it.');
    expect(add).toHaveFocus();
    await addFile(user, dialog, skinText(own('Dawn', '#0A0B0C', 'pixel')), 'dawn.json');
    await addFile(user, dialog, skinText(own('Dusk', '#111111')), 'dusk-2.json');
    await addFile(user, dialog, skinText(own('Cyberpunk', '#121212')), 'cyberpunk.json');
    expect(within(dialog).getByRole('status')).toHaveTextContent('“Cyberpunk (2)” was added.');
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Ancient Egypt', 'Dusk', 'Dawn', 'Dusk (2)', 'Cyberpunk (2)']);
    expect(within(dialog).queryByText('No custom themes yet')).not.toBeInTheDocument();
    const dawn = cards(dialog)[6]!;
    expect(within(dawn).getByText('Custom')).toBeInTheDocument();
    expect(within(dawn).getByText('A skin from your file.')).toBeInTheDocument();
    expect(dawn.querySelector('.skin-preview')!.getAttribute('data-cut')).toBe('steps');
    expect(root.dataset.theme).toBe('cyberpunk');
    await user.click(within(dawn).getByRole('button', { name: 'Apply: Dawn' }));
    expect([root.dataset.theme, root.dataset.cut]).toEqual(['custom-2', 'steps']);
    expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe('#0A0B0C');
    expect(applied(dialog)).toEqual([dawn]);
  });

  it('changes nothing when no file is picked', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    await user.upload(input(dialog), []);
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
    expect(cards(dialog)).toHaveLength(5);
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
    ['a base that is no skin', () => JSON.stringify({ ...JSON.parse(skinText(own('Neon'))), base: 'neon' }), 'The base field needs a built-in skin: cyberpunk, light, matrix, pixel, egypt. Fix the field and add the file again.'],
    ['a see-through text colour', () => skinText({ ...own('Glass'), colors: { ...own('Glass').colors, ink: 'rgba(227, 234, 241, .5)' } }), 'The colors.ink field needs a solid color: only dot, glow, hud, shadow, scrim may be see-through. Fix the field and add the file again.'],
  ])('refuses %s with what to fix, keeps the collection and the skin on, and gives focus back to Upload theme', async (_what, body, words) => {
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
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Ancient Egypt', 'Dusk']);
    expect(root.dataset.theme).toBe('custom-1');
    expect(within(dialog).getByRole('button', { name: 'Upload theme' })).toHaveFocus();
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
    expect(cards(dialog)).toHaveLength(5);
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
    expect(within(dialog).getByRole('button', { name: 'Upload theme' })).toBeEnabled();
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
    expect(cards(dialog)).toHaveLength(5);
  });

  it('removes its own skin at once with Undo; removing the one on gives way to Cyberpunk, and Undo puts both back', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    await addFile(user, dialog, skinText(own('Dusk')));
    await addFile(user, dialog, skinText(own('Dawn')), 'dawn.json');
    expect(cards(dialog).slice(0, 5).every(card => within(card).queryByRole('button', { name: /^Remove/ }) === null)).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Apply: Dusk' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove: Dusk' }));
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Ancient Egypt', 'Dawn']);
    expect(root.dataset.theme).toBe('cyberpunk');
    expect(applied(dialog)).toEqual([cards(dialog)[0]]);
    expect(within(dialog).getByRole('status')).toHaveTextContent('“Dusk” was removed. “Cyberpunk” is now applied.Undo');
    expect(within(dialog).getByRole('button', { name: 'Apply: Dawn' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Undo' }));
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Ancient Egypt', 'Dusk', 'Dawn']);
    expect(root.dataset.theme).toBe('custom-1');
    expect(within(dialog).getByRole('status')).toHaveTextContent('“Dusk” was restored.');
    expect(state(cards(dialog)[5]!)).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Remove: Dawn' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('“Dawn” was removed.Undo');
    expect(state(cards(dialog)[5]!)).toHaveFocus();
  });
});

/* A theme the company uploaded as one archive (docs/theme-archive.md): the CEO uploads it, the server checks and keeps it,
   and its card stands in the store with its licence, to be applied like any theme, or deleted after a second ask. */
describe('themes uploaded as an archive', () => {
  const BASE = '/api/themes/files/night-shift/1.0.0/';
  /* The look of an archive: a skin with no id of a built-in one, here Pixel's on another ground. */
  const pixel = builtinSkin('pixel')!;
  const LOOK = { ...Object.fromEntries(Object.entries(pixel).filter(([key]) => key !== 'id')), colors: { ...pixel.colors, bg: '#0A0B0C' } };
  const VIEW: InstalledThemeView = {
    id: 'night-shift', version: '1.0.0', name: { en: 'Night shift', ru: 'Ночная смена' }, description: { en: 'For the night.', ru: 'Для ночи.' }, author: 'Test',
    license: 'CC0-1.0', engine: 'none', languages: ['en', 'ru'], base: BASE, cover: null, shots: [], licenseFile: `${BASE}LICENSE`, hasWorld: false, worldLeftOut: null,
    hasKit: false, size: 2048, installedAt: '2026-11-23T10:00:00.000Z',
  };
  const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'night-shift.zip', { type: 'application/zip' });
  const upload = (dialog: HTMLElement) => dialog.querySelector<HTMLInputElement>('input[data-upload-input]')!;

  function renderStore(routes: Record<string, Parameters<typeof mockApi>[0][string]>, view: InstalledThemeView = VIEW) {
    let themes: InstalledThemeView[] = [];
    const calls = mockApi({
      'GET /api/org': [200, ORG],
      'GET /api/link': [200, { link: null, domain: 'hornhoof.org' }],
      'GET /api/world/theme': [200, { theme: 'cyberpunk', activePack: null, canEdit: true }],
      'PUT /api/world/theme': body => [200, { theme: (body as { theme: string }).theme, activePack: null, canEdit: true }],
      'GET /api/themes': () => [200, { themes }],
      'POST /api/themes': () => {
        themes = [view];
        return [201, { themes }];
      },
      'GET /api/themes/night-shift/look': [200, { id: VIEW.id, version: VIEW.version, base: BASE, look: LOOK, fonts: [], kit: null, world: null }],
      'DELETE /api/themes/night-shift': () => {
        themes = [];
        return [200, { themes }];
      },
      ...routes,
    });
    render(
      <LanguageProvider>
        <Shell me={ME} onSignOut={() => {}} />
      </LanguageProvider>,
    );
    return calls;
  }

  afterEach(() => forgetInstalledTheme(VIEW.id));

  it('installs an archive the CEO uploads: its card comes into the store with its licence, focused, and applies like any theme', async () => {
    const user = userEvent.setup();
    const calls = renderStore({});
    const dialog = await openThemes(user);
    await user.upload(upload(dialog), zip);
    const card = await within(catalog(dialog)).findByText('Night shift');
    const item = card.closest('li')!;
    expect(within(dialog).getByRole('status')).toHaveTextContent('Night shift is installed. Apply it in its card to turn it on for the company.');
    expect(within(item).getByText('Uploaded')).toBeInTheDocument();
    const licence = within(item).getByRole('link', { name: 'License: CC0-1.0' });
    expect([licence.getAttribute('href'), licence.getAttribute('target'), licence.getAttribute('rel')]).toEqual([`${BASE}LICENSE`, '_blank', 'noopener noreferrer']);
    expect(within(item).getByRole('button', { name: 'Apply: Night shift' })).toHaveFocus();
    expect(labels(item)).toEqual(['Apply: Night shift', 'Remove: Night shift']);
    expect(calls.filter(call => call.method === 'POST').map(call => call.path)).toEqual(['/api/themes']);

    await user.click(within(item).getByRole('button', { name: 'Apply: Night shift' }));
    expect(calls.filter(call => call.method === 'PUT' && call.path === '/api/world/theme').map(call => call.body)).toEqual([{ theme: 'night-shift' }]);
    expect(root.dataset.theme).toBe('night-shift');
    expect(root.style.getPropertyValue(COLOR_TOKENS.bg)).toBe('#0A0B0C');
  });

  it('says what is wrong with a refused archive and where, and gives the focus back to Upload theme', async () => {
    const user = userEvent.setup();
    renderStore({
      'POST /api/themes': [422, { error: { code: 'validation', message: 'Refused.', reason: 'theme_refused', details: { problem: { code: 'file_script', path: 'ui/kit/run.js' } } } }],
    });
    const dialog = await openThemes(user);
    await user.upload(upload(dialog), zip);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('The theme was not installed');
    expect(alert).toHaveTextContent('ui/kit/run.js is a script, a page or a style sheet. A theme holds no code: remove it.');
    expect(within(dialog).getByRole('button', { name: 'Upload theme' })).toHaveFocus();
    expect(within(catalog(dialog)).queryByText('Night shift')).toBeNull();
  });

  it('deletes an uploaded theme only after a second ask, and a theme that was on gives way to Cyberpunk', async () => {
    const user = userEvent.setup();
    const calls = renderStore({});
    const dialog = await openThemes(user);
    await user.upload(upload(dialog), zip);
    await user.click(await within(dialog).findByRole('button', { name: 'Apply: Night shift' }));
    const item = within(catalog(dialog)).getByText('Night shift').closest('li')!;
    await user.click(within(item).getByRole('button', { name: 'Remove: Night shift' }));
    const ask = within(item).getByRole('group', { name: 'Delete Night shift with all its files? If it is on, the company goes back to Cyberpunk.' });
    await user.click(within(ask).getByRole('button', { name: 'Keep it' }));
    expect(calls.some(call => call.method === 'DELETE')).toBe(false);
    await user.click(within(item).getByRole('button', { name: 'Remove: Night shift' }));
    await user.click(within(item).getByRole('button', { name: 'Delete theme' }));
    expect(calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual(['/api/themes/night-shift']);
    expect(within(catalog(dialog)).queryByText('Night shift')).toBeNull();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Night shift is deleted.');
    expect(skinsState().active).toBe('cyberpunk');
  });

  /* Uploaded themes are the company's own: they stand with a person's own skins under Custom, not among the built-in ones. */
  it('puts an uploaded theme in the Custom group, and says there are no custom themes only while there are none', async () => {
    const user = userEvent.setup();
    renderStore({});
    const dialog = await openThemes(user);
    expect(within(dialog).getByText('No custom themes yet')).toBeInTheDocument();
    await user.upload(upload(dialog), zip);
    await within(catalog(dialog)).findByText('Night shift');
    expect(within(dialog).queryByText('No custom themes yet')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Custom' }));
    expect(titles(dialog)).toEqual(['Night shift']);
    await user.click(within(dialog).getByRole('button', { name: 'Classic' }));
    expect(titles(dialog)).toEqual(['Cyberpunk', 'Light', 'Matrix', 'Pixel']);
    await user.click(within(dialog).getByRole('button', { name: 'Game worlds' }));
    expect(titles(dialog)).toEqual(['Ancient Egypt']);
  });

  /* A person gets a world with all its own art or none (#1972): the store kept this theme as its interface alone. */
  it('shows a world theme installed without its world as interface only, says why on its card, and puts on no world', async () => {
    const user = userEvent.setup();
    renderStore({}, { ...VIEW, engine: 'iso2d', hasWorld: false, worldLeftOut: 'art_missing' });
    const dialog = await openThemes(user);
    await user.upload(upload(dialog), zip);
    const item = (await within(catalog(dialog)).findByText('Night shift')).closest('li')!;
    expect(within(item).getByText('Uploaded')).toBeInTheDocument();
    expect(within(item).getByText('Interface only: its world does not bring all its own art, so the company keeps the schematic map.')).toBeInTheDocument();
    expect(item.querySelector('.skin-perf-note')).toBeNull();
    await user.click(within(item).getByRole('button', { name: 'Apply: Night shift' }));
    expect(root.dataset.theme).toBe('night-shift');
    expect(root.dataset.world).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Game worlds' }));
    expect(titles(dialog)).toEqual(['Ancient Egypt']);
  });

  it('takes a skin file through the same Upload theme, kept in this browser and never sent to the server', async () => {
    const user = userEvent.setup();
    const calls = renderStore({});
    const dialog = await openThemes(user);
    await user.upload(upload(dialog), file(skinText(own('Dusk'))));
    expect(within(dialog).getByRole('status')).toHaveTextContent('“Dusk” was added. You can now apply it.');
    expect(within(dialog).getByRole('button', { name: 'Upload theme' })).toHaveFocus();
    expect(calls.filter(call => call.method === 'POST')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Custom' }));
    expect(titles(dialog)).toEqual(['Dusk']);
  });
});

describe('the guide in the Themes section', () => {
  it('says what each kind of theme holds, links the guide in a new tab, and gives a request for an AI to copy, in English', async () => {
    const user = userEvent.setup();
    renderShell();
    const dialog = await openThemes(user);
    const guide = within(dialog).getByRole('region', { name: 'Make your own theme: interface only, or a whole world' });
    expect(within(guide).queryAllByRole('listitem')).toEqual([]);
    expect(guide).toHaveTextContent(en.skins.guideText);
    const link = within(guide).getByRole('link', { name: 'Open the theme guide' });
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual([THEME_GUIDE_URL, '_blank', 'noopener noreferrer']);
    expect(THEME_GUIDE_URL).toBe('https://github.com/Invariant0x/hornhoof/blob/main/docs/theme-archive.md');
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
    expect(screen.getByRole('button', { name: 'Профиль' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: RU.group }));
    expect(screen.getByRole('button', { name: 'Компания и доступ' })).toHaveAttribute('aria-current', 'page');
    const dialog = await screen.findByRole('dialog', { name: RU.title });
    expect(titles(dialog)).toEqual(['Киберпанк', 'Светлая', 'Матрица', 'Пиксельная', 'Древний Египет']);
    expect(within(dialog).getByText('Встроенная · По умолчанию')).toBeInTheDocument();
    expect(state(cards(dialog)[0]!)).toHaveTextContent('Включена');
    expect(within(dialog).getByRole('button', { name: 'Включить: Светлая' })).toBeInTheDocument();
    const guide = within(dialog).getByRole('region', { name: 'Своя тема: только интерфейс или целый мир' });
    expect(within(guide).getByRole('link', { name: 'Открыть руководство по темам' })).toHaveAttribute('href', THEME_GUIDE_URL);
    expect(within(dialog).getByRole('button', { name: 'Игровые миры' })).toBeInTheDocument();
    expect(within(dialog).getByText('Встроенная · Игровой мир')).toBeInTheDocument();
    expect(within(dialog).getByText('Своих тем пока нет')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Загрузить тему' })).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/3D/);
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
    /* Two columns where the place is wide, one where it is narrow; an odd last card takes the whole row. */
    expect(decl('.skin-wrap', 'container')).toBe('skins / inline-size');
    expect(decl('.skin-cards', 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))');
    expect(decl('.skin-cards', 'gap')).toBe('16px');
    expect(decl('.skin-cards', 'grid-template-columns', 'skins (max-width: 559px)')).toBe('minmax(0, 1fr)');
    expect(decl('.skin-cards > :last-child:nth-child(odd)', 'grid-column')).toBe('1 / -1');
    expect(decl('.skin-card[data-current]', 'border-color')).toBe('var(--cyan)');
    expect(decl('.skin-state', 'border')).toBe('1px solid var(--ok)');
    expect(decl('.skin-state', 'color')).toBe('var(--ok)');
    expect(decl('.skin-state::before', 'background')).toBe('currentColor');
    expect(decl('.skin-actions', 'justify-content')).toBe('flex-end');
    expect(decl('.skins .btn', 'min-height')).toBe('44px');
    expect(decl('.skins .btn', 'white-space')).toBe('normal');
    expect(decl('.skin-card-head', 'flex-wrap')).toBe('wrap');
    /* The heading's text and the hint on top, then the one button under them at the end edge (Design, #1960), the hint
       a step of the 8 px scale above it, out of the way of its focus ring. */
    expect(decl('.skins-head', 'display')).toBe('grid');
    expect(decl('.skins-adds', 'justify-items')).toBe('end');
    expect(decl('.skins-adds', 'gap')).toBe('8px');
    expect(decl('.skins-adds .btn', 'width')).toBe('180px');
    expect(decl('.swap-label > .sizer', 'visibility')).toBe('hidden');
    /* The line of what was done marks its kind at its start only: the shared .status and .alert classes would frame it. */
    expect(decl('.skins-notice', 'border-inline-start')).toBe('4px solid var(--line2)');
    expect(decl(".skins-notice[data-tone='alert']", 'border-inline-start-color')).toBe('var(--pink-ink)');
    expect(decl('.settings-body', 'grid-template-columns')).toBe('200px minmax(0, 1fr)');
    expect(decl('.settings-main', 'max-inline-size')).toBe('880px');
    expect(decl('.dialog.settings-window', 'width')).toBe('min(1160px, 100%)');
    expect(decl('.settings-body', 'grid-template-columns', '(max-width: 760px)')).toBe('minmax(0, 1fr)');
  });
});
